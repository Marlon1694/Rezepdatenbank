import { extract, detectPlatform, type ProgressFn } from "../extract/index.ts";
import { extractRecipe } from "../llm/index.ts";
import { getDataSourceSchema } from "../notion/client.ts";
import { availableExtraFields, knownTags } from "../notion/mapper.ts";
import { upsertRecipe, type UpsertResult } from "../notion/upsert.ts";
import { loadMapping } from "./mapping.ts";
import type { Recipe } from "../llm/recipeSchema.ts";

export interface PipelineResult {
  recipe: Recipe;
  upsert: UpsertResult;
  title?: string;
  platform: string;
  textSource: string;
  transcript: string;
}

/**
 * Der komplette Weg von der URL zur Notion-Seite. Bewusst getrennt vom Worker, damit
 * ihn auch scripts/run-once.ts direkt aufrufen kann.
 */
export async function runPipeline(
  url: string,
  onProgress: ProgressFn = () => {},
  dryRun = false,
): Promise<PipelineResult> {
  const platform = detectPlatform(url);

  const extracted = await extract(url, onProgress);

  onProgress("Rezept wird erstellt");
  // Schema vorher laden: es bestimmt, welche Zusatzfelder der Prompt anfordert und
  // welche Tags dem Modell als bereits vorhanden angeboten werden.
  const [schema, mapping] = await Promise.all([getDataSourceSchema(), loadMapping()]);

  const recipe = await extractRecipe({
    input: extracted.text,
    sourceUrl: url,
    sourceTitle: extracted.title,
    uploader: extracted.uploader,
    platform,
    knownTags: knownTags(schema, mapping),
    extraFields: availableExtraFields(schema, mapping),
  });

  // Hat die Seite eine Gesamtzeit mitgeliefert, ist die verlaesslicher als eine Schaetzung.
  if (extracted.hintMinutes && !recipe.zeit_minuten) {
    recipe.zeit_minuten = extracted.hintMinutes;
  }

  onProgress(dryRun ? "Vorschau wird gebaut" : "Wird nach Notion geschrieben");
  const upsert = await upsertRecipe({
    recipe,
    sourceUrl: url,
    sourceTitle: extracted.title,
    transcript: extracted.text,
    transcriptSource: extracted.source,
    mapping,
    dryRun,
  });

  return {
    recipe,
    upsert,
    title: extracted.title,
    platform,
    textSource: extracted.source,
    transcript: extracted.text,
  };
}
