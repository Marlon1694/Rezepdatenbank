import type { Recipe } from "../llm/recipeSchema.ts";
import { publishRecipe, activeTargets, type PublishResult, type Target } from "../targets.ts";
import { updateJob, type Job } from "./store.ts";
import { photoOwner, photoPaths } from "./uploads.ts";

/**
 * Schreibt ein bereits fertiges Rezept erneut - ohne Video, ohne Transkript,
 * ohne neue KI-Anfrage.
 *
 * Gebraucht fuer zwei Faelle:
 *   - Korrektur aus der Web-App: Das geaenderte Rezept geht in alle Ziele.
 *   - Nachtrag: Ein Ziel war beim ersten Mal nicht erreichbar (Mealie
 *     neugestartet, Notion-Token abgelaufen). Dann wird nur dieses beschrieben.
 */

/** Welche Ziele haben dieses Rezept noch nicht? */
export function missingTargets(job: Job): Target[] {
  return activeTargets().filter((t) =>
    t === "notion" ? !job.notionPageId : !job.mealieSlug,
  );
}

function coverInput(job: Job): { thumbnailUrl?: string; coverFile?: string } {
  if (!job.coverRef) return {};
  if (/^https?:\/\//i.test(job.coverRef)) return { thumbnailUrl: job.coverRef };
  if (job.kind === "foto" && !job.photosDeleted) {
    const [pfad] = photoPaths(photoOwner(job), [job.coverRef]);
    return pfad ? { coverFile: pfad } : {};
  }
  return {};
}

export async function republish(
  job: Job,
  recipe: Recipe,
  only?: Target[],
): Promise<PublishResult> {
  const ziele = only ?? activeTargets();
  // Wo es die Seite schon gibt, bleibt ihr Titelbild, wie es ist - das hast du
  // dort vielleicht selbst ausgetauscht. Nur ein Ziel, das das Rezept noch gar
  // nicht hat, bekommt das Bild von der urspruenglichen Quelle.
  const fehlt = missingTargets(job).some((t) => ziele.includes(t));

  const publish = await publishRecipe({
    recipe,
    only,
    sourceUrl: job.url,
    existingPageId: job.notionPageId ?? undefined,
    existingMealieSlug: job.mealieSlug ?? undefined,
    sourceLabel:
      job.kind === "foto"
        ? job.photos.length > 1
          ? `Eigenes Foto (${job.photos.length} Bilder)`
          : "Eigenes Foto"
        : undefined,
    sourceTitle: job.title ?? undefined,
    transcript: job.transcript ?? undefined,
    transcriptSource: job.textSource ?? undefined,
    ...(fehlt ? coverInput(job) : { coverImage: null }),
  });

  // Fehler nur fuer die beschriebenen Ziele ersetzen; die anderen behalten
  // ihren Stand aus dem letzten Lauf.
  const errors = { ...job.targetErrors };
  for (const t of ziele) delete errors[t];
  Object.assign(errors, publish.errors);

  updateJob(job.id, {
    recipe,
    status: "done",
    error: null,
    title: recipe.titel,
    step: Object.keys(errors).length
      ? "Teilweise gespeichert"
      : publish.updated
        ? "Aktualisiert"
        : "Angelegt",
    ...(publish.notion
      ? {
          notionPageId: publish.notion.pageId ?? null,
          notionPageUrl: publish.notion.pageUrl ?? null,
          notionUpdated: publish.notion.updated,
        }
      : {}),
    ...(publish.mealie ? { mealieSlug: publish.mealie.slug, mealieUrl: publish.mealie.url } : {}),
    targetErrors: errors,
  });

  return publish;
}
