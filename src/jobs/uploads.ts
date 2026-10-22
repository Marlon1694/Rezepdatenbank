import { mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { getConfig } from "../config.ts";
import { SUPPORTED_EXTENSIONS, mimeForFile } from "../lib/images.ts";

/**
 * Ablage der hochgeladenen Fotos: data/uploads/<besitzer-id>/1.jpg, 2.jpg, ...
 *
 * Die Bilder bleiben nur so lange liegen, wie sie gebraucht werden. Steht das
 * Rezept in Notion, sind sie weg - das Titelbild liegt dann ohnehin dort.
 * Bleiben duerfen sie, solange noch etwas davon abhaengt:
 *
 *   - ein fehlgeschlagener Job, der sich erneut versuchen laesst
 *   - Geschwisterrezepte aus demselben Stapel, die noch nicht durch sind
 *
 * Was trotzdem uebrig bleibt, raeumt sweepPhotos() nach der Aufbewahrungsfrist
 * weg. Ohne das waechst der Datenordner still vor sich hin, bis die Platte
 * voll ist.
 */

export function uploadsRoot(): string {
  return resolve(getConfig().dataDir, "uploads");
}

export function jobDir(jobId: string): string {
  // basename() schneidet alles ab, was wie ein Pfad aussieht. Die ID kommt
  // zwar aus randomUUID(), aber der Pfad wird aus Benutzereingaben
  // zusammengesetzt - diese Stelle soll das nicht voraussetzen muessen.
  return join(uploadsRoot(), basename(jobId));
}

export function photoPaths(ownerId: string, names: string[]): string[] {
  const dir = jobDir(ownerId);
  return names.map((name) => join(dir, basename(name)));
}

/**
 * Wem gehoeren die Bilder eines Jobs?
 *
 * Bei einem Rezept aus einem Stapel liegen sie beim Elternteil - sonst muesste
 * ein abfotografiertes Kochbuch fuer jedes einzelne Rezept erneut auf die
 * Platte geschrieben werden.
 */
export function photoOwner(job: { id: string; parentId: string | null }): string {
  return job.parentId ?? job.id;
}

/** Prueft eine hochgeladene Datei, bevor sie auf der Platte landet. */
export function checkPhoto(
  filename: string,
  size: number,
): { ok: true; extension: string } | { ok: false; error: string } {
  const cfg = getConfig();

  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot).toLowerCase();

  if (!mimeForFile(filename)) {
    return {
      ok: false,
      error:
        `„${filename}“ ist kein unterstütztes Bildformat. ` +
        `Möglich sind: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    };
  }
  if (size <= 0) {
    return { ok: false, error: `„${filename}“ ist leer.` };
  }
  if (size > cfg.maxPhotoBytes) {
    return {
      ok: false,
      error:
        `„${filename}“ ist mit ${Math.round(size / 1024 / 1024)} MB zu groß ` +
        `(erlaubt sind ${Math.round(cfg.maxPhotoBytes / 1024 / 1024)} MB).`,
    };
  }
  return { ok: true, extension };
}

/**
 * Legt ein Foto ab und gibt den Dateinamen zurueck.
 *
 * Der Name wird selbst vergeben - der vom Client mitgelieferte wird nur fuer
 * die Endung herangezogen. So kann kein Name von aussen bestimmen, wohin
 * geschrieben wird.
 */
export async function savePhoto(
  jobId: string,
  index: number,
  extension: string,
  data: Buffer,
): Promise<string> {
  const dir = jobDir(jobId);
  await mkdir(dir, { recursive: true });
  const name = `${index}${extension}`;
  await writeFile(join(dir, name), data);
  return name;
}

/** Entfernt den Ordner eines Jobs samt Bildern. */
export async function removePhotos(jobId: string): Promise<void> {
  await rm(jobDir(jobId), { recursive: true, force: true });
}

/** Wie viel Platz die Fotos belegen - fuer /api/health und die Protokollzeile. */
export async function uploadsSize(): Promise<{ bytes: number; ordner: number }> {
  let bytes = 0;
  let ordner = 0;
  try {
    for (const name of await readdir(uploadsRoot())) {
      ordner++;
      const dir = join(uploadsRoot(), name);
      for (const datei of await readdir(dir).catch(() => [])) {
        bytes += (await stat(join(dir, datei)).catch(() => ({ size: 0 }))).size;
      }
    }
  } catch {
    /* Noch kein Upload-Ordner - dann belegt auch nichts Platz. */
  }
  return { bytes, ordner };
}

/**
 * Ordner, die aelter sind als die Aufbewahrungsfrist.
 *
 * Gemeint sind die Reste: fehlgeschlagene Jobs, deren Bilder fuer einen
 * zweiten Anlauf liegen blieben, und abgebrochene Uploads. Nach erfolgreichem
 * Lauf sind die Bilder ohnehin schon weg.
 */
export async function expiredPhotoDirs(days: number): Promise<string[]> {
  if (days <= 0) return [];
  const grenze = Date.now() - days * 24 * 60 * 60 * 1000;
  const alt: string[] = [];

  for (const name of await readdir(uploadsRoot()).catch(() => [])) {
    const info = await stat(join(uploadsRoot(), name)).catch(() => undefined);
    if (info && info.mtimeMs < grenze) alt.push(name);
  }
  return alt;
}
