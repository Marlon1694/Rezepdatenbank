import type { Job } from "../jobs/store.ts";

/**
 * Ein Link, ein Rezept. Wurde derselbe Link mehrmals erfasst - ein zweiter
 * Anlauf, eine Korrektur -, stehen im Verlauf mehrere Fassungen. Uebernommen
 * wird nur eine: die schon in Mealie steht, sonst die neueste. Sonst
 * ueberschriebe eine aeltere, schlechtere Fassung die gute.
 */
export function pickPerLink(jobs: Job[]): { nehmen: Job[]; aeltere: Job[] } {
  const gewaehlt = new Map<string, Job>();
  for (const job of jobs) {
    if (!job.url) continue;
    const bisher = gewaehlt.get(job.url);
    // jobs kommen neueste zuerst - die erste ist die neueste.
    if (!bisher || (!bisher.mealieSlug && job.mealieSlug)) gewaehlt.set(job.url, job);
  }
  const nehmen: Job[] = [];
  const aeltere: Job[] = [];
  for (const job of jobs) {
    if (!job.url || gewaehlt.get(job.url) === job) nehmen.push(job);
    else aeltere.push(job);
  }
  return { nehmen, aeltere };
}

/** Titel, die mehrfach vorkommen - "Risoni Hähnchenblech" und "Risoni-Hähnchenblech" auch. */
export function similarTitles(titel: string[]): string[][] {
  const schluessel = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const gruppen = new Map<string, string[]>();
  for (const t of titel) gruppen.set(schluessel(t), [...(gruppen.get(schluessel(t)) ?? []), t]);
  return [...gruppen.values()].filter((g) => g.length > 1);
}
