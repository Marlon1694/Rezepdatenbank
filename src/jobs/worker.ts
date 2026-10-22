import {
  nextQueuedJob,
  updateJob,
  requeueStaleJobs,
  staleDrafts,
  deleteJob,
  createChildJob,
  childrenOf,
  type Job,
} from "./store.ts";
import { runPipeline, runPhotoPipeline } from "./pipeline.ts";
import {
  photoPaths,
  photoOwner,
  removePhotos,
  expiredPhotoDirs,
  uploadsSize,
} from "./uploads.ts";
import { getConfig } from "../config.ts";
import type { PhotoReading } from "../extract/photo.ts";

/**
 * In-Process-Worker mit Nebenlaeufigkeit 1.
 *
 * Bei ein paar Rezepten am Tag braucht es dafuer weder Redis noch BullMQ - ein
 * zweiter Dienst waere hier reiner Betriebsaufwand ohne Gegenwert.
 */

let running = false;
let timer: NodeJS.Timeout | undefined;

const POLL_INTERVAL_MS = 2000;

/**
 * Teilt ein gelesenes Rezept dem richtigen Ausschnitt der Bilder zu.
 *
 * Die Indizes aus der Lesestufe gelten fuer den ganzen Stapel. Das Kind kennt
 * aber nur seine eigenen Bilder, also muessen sie umgerechnet werden - sonst
 * zeigte "Titelbild ist Bild 7" bei einem Kind mit zwei Bildern ins Leere.
 */
export function childPhotos(
  reading: PhotoReading,
  allePhotos: string[],
): { photos: string[]; reading: PhotoReading } {
  const indizes = reading.bildIndizes.filter((i) => i >= 0 && i < allePhotos.length);
  const genutzt = indizes.length ? indizes : allePhotos.map((_, i) => i);

  const neuerGerichtIndex =
    reading.gerichtBildIndex !== undefined ? genutzt.indexOf(reading.gerichtBildIndex) : -1;

  return {
    photos: genutzt.map((i) => allePhotos[i] as string),
    reading: {
      ...reading,
      bildIndizes: genutzt.map((_, k) => k),
      ...(neuerGerichtIndex >= 0
        ? { gerichtBildIndex: neuerGerichtIndex, zeigtGericht: true }
        : { gerichtBildIndex: undefined, zeigtGericht: false }),
    },
  };
}

/**
 * Die Bilder sind in Notion angekommen - auf der Platte haben sie damit nur
 * noch fuer einen zweiten Anlauf einen Zweck.
 *
 * Bei einem Stapel haengen mehrere Rezepte an denselben Bildern. Geloescht
 * wird deshalb erst, wenn kein Geschwisterkind sie noch braucht: Ein
 * fehlgeschlagenes Rezept soll sich erneut versuchen lassen.
 */
export function photosStillNeeded(fertigerJobId: string, beteiligte: Job[]): boolean {
  return beteiligte.some(
    (j) =>
      j.id !== fertigerJobId &&
      // "failed" zaehlt mit: Ein fehlgeschlagenes Rezept soll sich erneut
      // versuchen lassen, und dafuer braucht es seine Bilder noch.
      (j.status === "queued" || j.status === "running" || j.status === "failed"),
  );
}

async function cleanupAfterSuccess(job: Job): Promise<void> {
  if (job.kind !== "foto" || !getConfig().deletePhotosAfterSuccess) return;

  const besitzer = photoOwner(job);
  // Bei einem Stapel haengen alle Geschwister an denselben Bildern. Der
  // Elternteil selbst ist zu diesem Zeitpunkt immer schon fertig - er hat die
  // Aufteilung gemacht und nichts mehr vor.
  const beteiligte = besitzer === job.id ? [job, ...childrenOf(job.id)] : childrenOf(besitzer);

  if (photosStillNeeded(job.id, beteiligte)) return;

  await removePhotos(besitzer).catch(() => {});
  for (const j of beteiligte) {
    if (!j.photosDeleted) updateJob(j.id, { photosDeleted: true });
  }
  if (!job.photosDeleted) updateJob(job.id, { photosDeleted: true });
  console.log(`[uploads] Bilder von ${besitzer} gelöscht — die Rezepte stehen in Notion.`);
}

async function processOne(): Promise<boolean> {
  const job = nextQueuedJob();
  if (!job) return false;

  const startedAt = Date.now();
  updateJob(job.id, { status: "running", step: "Startet", error: null });
  console.log(
    `[worker] ${job.id} -> ${job.kind === "foto" ? `${job.photos.length} Foto(s)` : job.url}`,
  );

  try {
    const onProgress = (step: string) => updateJob(job.id, { step });

    if (job.kind === "foto" && job.photosDeleted) {
      throw new Error(
        "Die Fotos dieses Rezepts wurden nach dem erfolgreichen Durchlauf gelöscht. " +
          "Für einen neuen Anlauf müsstest du sie noch einmal hochladen. Das Rezept " +
          "selbst kannst du hier weiterhin bearbeiten und erneut nach Notion schreiben.",
      );
    }

    const result =
      job.kind === "foto"
        ? await runPhotoPipeline({
            paths: photoPaths(photoOwner(job), job.photos),
            reading: job.reading ?? undefined,
            // Beim zweiten Anlauf dieselbe Notion-Seite ersetzen, statt eine
            // zweite anzulegen: Ein Foto hat keine Quell-URL, ueber die der
            // Duplikat-Check sie wiederfinden koennte.
            existingPageId: job.notionPageId ?? undefined,
            onProgress,
          })
        : await runPipeline(job.url, onProgress);

    if ("split" in result) {
      await splitIntoChildren(job, result.readings, startedAt);
      return true;
    }

    updateJob(job.id, {
      status: "done",
      step: result.upsert.updated ? "Aktualisiert" : "Angelegt",
      title: result.recipe.titel,
      platform: result.platform,
      textSource: result.textSource,
      transcript: result.transcript,
      recipe: result.recipe,
      notionPageId: result.upsert.pageId ?? null,
      notionPageUrl: result.upsert.pageUrl ?? null,
      notionUpdated: result.upsert.updated,
      durationMs: Date.now() - startedAt,
    });

    console.log(
      `[worker] ${job.id} fertig in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
        `(${result.textSource})`,
    );

    await cleanupAfterSuccess({ ...job, status: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(job.id, {
      status: "failed",
      step: "Fehlgeschlagen",
      error: message,
      durationMs: Date.now() - startedAt,
    });
    console.error(`[worker] ${job.id} fehlgeschlagen: ${message}`);
  }
  return true;
}

/** Aus einem Stapel werden eigenstaendige Rezept-Jobs. */
async function splitIntoChildren(
  job: Job,
  readings: PhotoReading[],
  startedAt: number,
): Promise<void> {
  // Bei einem zweiten Anlauf sonst doppelte Kinder - und damit doppelte
  // Notion-Seiten.
  for (const alt of childrenOf(job.id)) {
    deleteJob(alt.id);
  }

  for (const reading of readings) {
    const { photos, reading: eigenes } = childPhotos(reading, job.photos);
    createChildJob({
      parentId: job.id,
      photos,
      reading: eigenes,
      title: reading.titel,
    });
  }

  updateJob(job.id, {
    status: "done",
    step: `${readings.length} Rezepte erkannt`,
    title: `${job.photos.length} Fotos → ${readings.length} Rezepte`,
    platform: "Foto",
    textSource: "Stapel",
    durationMs: Date.now() - startedAt,
  });

  console.log(
    `[worker] ${job.id}: ${job.photos.length} Bild(er) ergaben ${readings.length} Rezepte - ` +
      `als eigene Jobs eingereiht.`,
  );
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Solange Arbeit da ist, ohne Pause weitermachen.
    while (await processOne()) { /* naechster Job */ }
  } finally {
    running = false;
  }
}

export function startWorker(): void {
  const requeued = requeueStaleJobs();
  if (requeued > 0) {
    console.log(`[worker] ${requeued} unterbrochene(r) Job(s) wieder eingereiht.`);
  }
  void cleanDrafts();
  void sweepPhotos();
  timer = setInterval(() => void loop(), POLL_INTERVAL_MS);
  timer.unref?.();
  void loop();
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/**
 * Abgebrochene Uploads wegraeumen. Ein Entwurf entsteht, sobald das erste Byte
 * ankommt; bricht die Verbindung mitten im Hochladen ab, bleibt er samt
 * Bildern liegen und taucht nirgends mehr auf.
 */
async function cleanDrafts(): Promise<void> {
  for (const job of staleDrafts()) {
    await removePhotos(job.id).catch(() => {});
    deleteJob(job.id);
    console.log(`[worker] abgebrochenen Foto-Upload ${job.id} entfernt.`);
  }
}

/**
 * Die Altlasten: Bilder fehlgeschlagener Jobs bleiben fuer einen zweiten
 * Anlauf liegen - aber nicht fuer immer. Ohne diese Runde waechst der
 * Datenordner still vor sich hin, bis irgendwann die Platte voll ist.
 */
export async function sweepPhotos(): Promise<void> {
  const cfg = getConfig();
  const alt = await expiredPhotoDirs(cfg.photoRetentionDays);

  for (const id of alt) {
    await removePhotos(id).catch(() => {});
    // Der Job selbst bleibt im Verlauf stehen - nur ohne seine Bilder.
    updateJob(id, { photosDeleted: true });
    for (const kind of childrenOf(id)) updateJob(kind.id, { photosDeleted: true });
  }
  if (alt.length) {
    console.log(
      `[uploads] ${alt.length} Ordner älter als ${cfg.photoRetentionDays} Tage entfernt.`,
    );
  }

  const { bytes, ordner } = await uploadsSize();
  if (ordner) {
    console.log(`[uploads] ${(bytes / 1024 / 1024).toFixed(1)} MB in ${ordner} Ordner(n).`);
  }
}

/** Nach dem Einreihen sofort anstossen, statt aufs naechste Intervall zu warten. */
export function nudgeWorker(): void {
  void loop();
}
