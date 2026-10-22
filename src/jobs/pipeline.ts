import { extract, detectPlatform, type ProgressFn } from "../extract/index.ts";
import { readPhotos, modeFor, type RecipeMode } from "../extract/photo.ts";
import { extractRecipe } from "../llm/index.ts";
import { getDataSourceSchema } from "../notion/client.ts";
import { availableExtraFields, knownTags, knownOptions } from "../notion/mapper.ts";
import { upsertRecipe, type UpsertResult } from "../notion/upsert.ts";
import { loadMapping } from "./mapping.ts";
import { cleanUrl } from "../lib/url.ts";
import { recipeShortcoming, type Recipe } from "../llm/recipeSchema.ts";

export interface PipelineResult {
  recipe: Recipe;
  upsert: UpsertResult;
  title?: string;
  platform: string;
  textSource: string;
  transcript: string;
}

export interface PhotoPipelineInput {
  /** Vollstaendige Pfade der hochgeladenen Bilder, in Reihenfolge. */
  paths: string[];
  /** Bereits bestehende Notion-Seite dieses Jobs (zweiter Anlauf). */
  existingPageId?: string;
  onProgress?: ProgressFn;
  dryRun?: boolean;
}

/** Was in Notion oben auf der Seite steht, wenn die KI nachgeholfen hat. */
function noticeFor(mode: RecipeMode, fehlt: string[]): string | undefined {
  if (mode === "abtippen") return undefined;
  if (mode === "erfinden") {
    return (
      "Dieses Rezept wurde von der KI anhand eines Fotos des Gerichts entwickelt. " +
      "Es stammt aus keiner Vorlage — Zutaten und Mengen sind geschätzt."
    );
  }
  const luecken = fehlt.length ? ` Ergänzt wurde: ${fehlt.join(", ")}.` : "";
  return (
    "Die Vorlage war unvollständig. Die mit „(ergänzt)“ markierten Stellen stammen " +
    `von der KI, alles Übrige steht so im Original.${luecken}`
  );
}

/**
 * Derselbe Weg wie bei einem Link, nur dass der Text nicht aus Untertiteln
 * kommt, sondern von einem Foto gelesen wird.
 *
 * Ab der Strukturierung ist es exakt dieselbe Strecke: gleicher Prompt,
 * gleiches Schema, gleiche Notion-Zuordnung.
 */
export async function runPhotoPipeline(input: PhotoPipelineInput): Promise<PipelineResult> {
  const onProgress = input.onProgress ?? (() => {});

  onProgress(input.paths.length > 1 ? "Fotos werden gelesen" : "Foto wird gelesen");
  const reading = await readPhotos(input.paths);

  const mode = modeFor(reading);
  console.log(
    `[foto] ${input.paths.length} Bild(er), erkannt als "${reading.art}", Modus "${mode}"` +
      (reading.fehlt.length ? `, fehlt: ${reading.fehlt.join(", ")}` : ""),
  );

  // Ein Buchdeckel oder ein Inhaltsverzeichnis ergibt kein Rezept. Das jetzt zu
  // sagen ist ehrlicher, als die KI eines erfinden zu lassen.
  if (reading.art === "sonstiges" && reading.abschrift.length < 120) {
    throw new Error(
      "Auf den Fotos ist kein Rezept zu erkennen — und auch kein Gericht, aus dem " +
        "sich eines ableiten ließe. Ist die Seite vollständig im Bild und gut " +
        "ausgeleuchtet? Bei gewölbten Buchseiten hilft es, die Seite flach zu drücken.",
    );
  }

  onProgress("Rezept wird erstellt");
  const [schema, mapping] = await Promise.all([getDataSourceSchema(), loadMapping()]);

  const recipe = await extractRecipe({
    input: reading.abschrift || "(Die Bilder enthalten keinen lesbaren Text.)",
    sourceUrl: "",
    sourceTitle: reading.titel,
    platform: "Foto",
    mode,
    fehlt: reading.fehlt,
    knownTags: knownTags(schema, mapping),
    knownIngredients: knownOptions(schema, "zutatenliste", mapping),
    extraFields: availableExtraFields(schema, mapping),
  });

  // Im Erfindungsmodus ist das Rezept definitionsgemaess vollstaendig - die
  // Pruefung gilt dem, was aus einer echten Vorlage kommt.
  const mangel = mode === "erfinden" ? "" : recipeShortcoming(recipe);
  if (mangel) {
    throw new Error(
      `Aus den Fotos ließ sich kein vollständiges Rezept gewinnen — ${mangel}. ` +
        `(Gelesen: ${reading.abschrift.length} Zeichen)`,
    );
  }

  const label =
    input.paths.length > 1
      ? `Eigenes Foto (${input.paths.length} Bilder)`
      : "Eigenes Foto";

  onProgress(input.dryRun ? "Vorschau wird gebaut" : "Wird nach Notion geschrieben");
  const upsert = await upsertRecipe({
    recipe,
    sourceUrl: "",
    sourceLabel: label,
    sourceTitle: reading.titel,
    existingPageId: input.existingPageId,
    coverFile:
      reading.gerichtBildIndex !== undefined
        ? input.paths[reading.gerichtBildIndex]
        : undefined,
    aiNotice: noticeFor(mode, reading.fehlt),
    transcript: reading.abschrift,
    transcriptSource: `Foto (${reading.art})`,
    mapping,
    dryRun: input.dryRun,
  });

  return {
    recipe,
    upsert,
    title: reading.titel ?? recipe.titel,
    platform: "Foto",
    textSource: `Foto (${reading.art})`,
    transcript: reading.abschrift,
  };
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

  // Fuer Notion die aufgeloeste Adresse verwenden. Ein Kurzlink aus der
  // TikTok-App und die volle Adresse desselben Videos landen damit auf
  // derselben Seite, statt zwei Rezepte anzulegen.
  const notionUrl = extracted.canonicalUrl
    ? cleanUrl(extracted.canonicalUrl)
    : url;
  if (notionUrl !== url) {
    console.log(`[quelle] ${url} -> ${notionUrl}`);
  }

  onProgress("Rezept wird erstellt");
  // Schema vorher laden: es bestimmt, welche Zusatzfelder der Prompt anfordert und
  // welche Tags dem Modell als bereits vorhanden angeboten werden.
  const [schema, mapping] = await Promise.all([getDataSourceSchema(), loadMapping()]);

  const recipe = await extractRecipe({
    input: extracted.text,
    sourceUrl: notionUrl,
    sourceTitle: extracted.title,
    uploader: extracted.uploader,
    platform,
    knownTags: knownTags(schema, mapping),
    knownIngredients: knownOptions(schema, "zutatenliste", mapping),
    extraFields: availableExtraFields(schema, mapping),
  });

  // Lieber nichts schreiben als eine Karte, die nach Rezept aussieht und keines ist.
  const mangel = recipeShortcoming(recipe);
  if (mangel) {
    throw new Error(
      `Die Quelle enthält kein vollständiges Rezept — ${mangel}. ` +
        `Steht das Rezept dort wirklich im Text, oder verweist die Seite nur darauf? ` +
        `(Ausgangstext: ${extracted.source}, ${extracted.text.length} Zeichen)`,
    );
  }

  // Hat die Seite eine Gesamtzeit mitgeliefert, ist die verlaesslicher als eine Schaetzung.
  if (extracted.hintMinutes && !recipe.zeit_minuten) {
    recipe.zeit_minuten = extracted.hintMinutes;
  }

  onProgress(dryRun ? "Vorschau wird gebaut" : "Wird nach Notion geschrieben");
  const upsert = await upsertRecipe({
    recipe,
    sourceUrl: notionUrl,
    thumbnailUrl: extracted.thumbnailUrl,
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
