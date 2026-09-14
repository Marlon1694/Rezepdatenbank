import { nextQueuedJob, updateJob, requeueStaleJobs } from "./store.ts";
import { runPipeline } from "./pipeline.ts";

/**
 * In-Process-Worker mit Nebenlaeufigkeit 1.
 *
 * Bei ein paar Rezepten am Tag braucht es dafuer weder Redis noch BullMQ - ein
 * zweiter Dienst waere hier reiner Betriebsaufwand ohne Gegenwert.
 */

let running = false;
let timer: NodeJS.Timeout | undefined;

const POLL_INTERVAL_MS = 2000;

async function processOne(): Promise<boolean> {
  const job = nextQueuedJob();
  if (!job) return false;

  const startedAt = Date.now();
  updateJob(job.id, { status: "running", step: "Startet", error: null });
  console.log(`[worker] ${job.id} -> ${job.url}`);

  try {
    const result = await runPipeline(job.url, (step) => updateJob(job.id, { step }));

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
  timer = setInterval(() => void loop(), POLL_INTERVAL_MS);
  timer.unref?.();
  void loop();
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Nach dem Einreihen sofort anstossen, statt aufs naechste Intervall zu warten. */
export function nudgeWorker(): void {
  void loop();
}
