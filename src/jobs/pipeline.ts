import { basename } from "node:path";
import { extract, detectPlatform, type ProgressFn } from "../extract/index.ts";
import {
  readPhotos,
  modeFor,
  usableReadings,
  type PhotoReading,
  type RecipeMode,
} from "../extract/photo.ts";
import { extractRecipe } from "../llm/index.ts";
import { publishRecipe, promptTargetContext, type PublishResult } from "../targets.ts";
import { transcribe } from "../transcribe/index.ts";
import { recipeSignals } from "../extract/vtt.ts";
import { cleanUrl } from "../lib/url.ts";
import { recipeShortcoming, type Recipe } from "../llm/recipeSchema.ts";

export interface PipelineResult {
  recipe: Recipe;
  /** Ergebnis je Ziel (Notion, Mealie) samt Fehlern der Ziele, die nicht geklappt haben. */
  publish: PublishResult;
  /** Siehe Job.coverRef. */
  coverRef?: string;
  /** Siehe Job.aiNotice. */
  aiNotice?: string;
  title?: string;
  platform: string;
  textSource: string;
  transcript: string;
}

export interface PhotoPipelineInput {
  /** Vollstaendige Pfade der Bilder dieses Jobs, in Reihenfolge. */
  paths: string[];
  /**
   * Bereits gelesen. Bei einem Rezept aus einem Stapel hat der Elternteil die
   * Bilder schon gelesen und aufgeteilt - dann faellt die Vision-Stufe weg.
   */
  reading?: PhotoReading;
  /** Bereits bestehende Notion-Seite dieses Jobs (zweiter Anlauf). */
  existingPageId?: string;
  /** Bereits bestehendes Mealie-Rezept dieses Jobs. */
  existingMealieSlug?: string;
  onProgress?: ProgressFn;
  dryRun?: boolean;
}

/**
 * Auf den Bildern lagen mehrere Rezepte. Daraus macht der Worker eigene Jobs -
 * so bekommt jedes Rezept seine eigene Notion-Seite, seinen eigenen Eintrag im
 * Verlauf und seine eigene Korrekturansicht.
 */
export interface PhotoSplit {
  split: true;
  readings: PhotoReading[];
}

export type PhotoOutcome = PipelineResult | PhotoSplit;

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
export async function runPhotoPipeline(input: PhotoPipelineInput): Promise<PhotoOutcome> {
  const onProgress = input.onProgress ?? (() => {});

  let reading = input.reading;

  if (!reading) {
    onProgress(input.paths.length > 1 ? "Fotos werden gelesen" : "Foto wird gelesen");
    const gelesen = await readPhotos(input.paths, onProgress);
    const brauchbar = usableReadings(gelesen);

    console.log(
      `[foto] ${input.paths.length} Bild(er) gelesen: ${gelesen.length} Abschnitt(e), ` +
        `davon ${brauchbar.length} brauchbar.`,
    );

    // Ein Buchdeckel oder ein Inhaltsverzeichnis ergibt kein Rezept. Das jetzt
    // zu sagen ist ehrlicher, als die KI eines erfinden zu lassen.
    if (!brauchbar.length) {
      throw new Error(
        "Auf den Fotos ist kein Rezept zu erkennen — und auch kein Gericht, aus dem " +
          "sich eines ableiten ließe. Ist die Seite vollständig im Bild und gut " +
          "ausgeleuchtet? Bei gewölbten Buchseiten hilft es, die Seite flach zu drücken.",
      );
    }

    // Mehrere Rezepte: Der Worker macht daraus eigene Jobs. Hier ist Schluss.
    if (brauchbar.length > 1) return { split: true, readings: brauchbar };

    reading = brauchbar[0] as PhotoReading;
  }

  const mode = modeFor(reading);
  console.log(
    `[foto] "${reading.titel ?? "ohne Titel"}": erkannt als "${reading.art}", ` +
      `Modus "${mode}"` +
      (reading.fehlt.length ? `, fehlt: ${reading.fehlt.join(", ")}` : ""),
  );

  onProgress("Rezept wird erstellt");
  const ziele = await promptTargetContext();

  const recipe = await extractRecipe({
    input: reading.abschrift || "(Die Bilder enthalten keinen lesbaren Text.)",
    sourceUrl: "",
    sourceTitle: reading.titel,
    platform: "Foto",
    mode,
    fehlt: reading.fehlt,
    knownTags: ziele.knownTags,
    knownIngredients: ziele.knownIngredients,
    extraFields: ziele.extraFields,
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
    input.paths.length > 1 ? `Eigenes Foto (${input.paths.length} Bilder)` : "Eigenes Foto";
  const hinweis = noticeFor(mode, reading.fehlt);

  onProgress(input.dryRun ? "Vorschau wird gebaut" : "Wird gespeichert");
  const publish = await publishRecipe({
    recipe,
    sourceUrl: "",
    sourceLabel: label,
    sourceTitle: reading.titel,
    existingPageId: input.existingPageId,
    existingMealieSlug: input.existingMealieSlug,
    coverFile:
      reading.gerichtBildIndex !== undefined ? input.paths[reading.gerichtBildIndex] : undefined,
    aiNotice: hinweis,
    transcript: reading.abschrift,
    transcriptSource: `Foto (${reading.art})`,
    dryRun: input.dryRun,
  });

  const coverPath =
    reading.gerichtBildIndex !== undefined ? input.paths[reading.gerichtBildIndex] : undefined;

  return {
    recipe,
    publish,
    coverRef: coverPath ? basename(coverPath) : undefined,
    aiNotice: hinweis,
    title: reading.titel ?? recipe.titel,
    platform: "Foto",
    textSource: `Foto (${reading.art})`,
    transcript: reading.abschrift,
  };
}

export interface DictationInput {
  /** Bereits vorliegender Text - vom Tastatur-Diktat, aus Siri oder einem frueheren Lauf. */
  text?: string;
  /** Sonst eine Audiodatei, die erst abgeschrieben wird. */
  audioPath?: string;
  existingPageId?: string;
  existingMealieSlug?: string;
  onProgress?: ProgressFn;
  /** Sobald die Audiodatei abgeschrieben ist - damit der Text einen Fehlschlag danach uebersteht. */
  onTranscribed?: (text: string) => void;
}

/**
 * Wie viel hat die KI selbst beigetragen? Das steht oben auf der Seite.
 *
 * Grob geschaetzt am Diktat: Kommen darin Mengen oder Arbeitsschritte vor,
 * war es ein Rezept, das ergaenzt wurde; sonst ein Wunsch, aus dem die KI ein
 * Rezept entwickelt hat. Beides ist in Ordnung - nur soll spaeter erkennbar
 * sein, was davon von dir stammt.
 */
export function dictationNotice(text: string): string {
  const { mengen, schritte } = recipeSignals(text);
  return mengen + schritte >= 3
    ? "Nach deinem Diktat erstellt. Mit „(ergänzt)“ markierte Stellen hat die KI hinzugefügt."
    : "Von der KI nach deinem Wunsch entwickelt — es gibt keine Vorlage, Mengen und Zeiten sind Vorschläge.";
}

/**
 * Aus Gesprochenem ein Rezept. Ab dem Strukturieren derselbe Weg wie bei
 * Links und Fotos: gleicher Prompt, gleiches Schema, gleiche Ziele.
 */
export async function runDictationPipeline(input: DictationInput): Promise<PipelineResult> {
  const onProgress = input.onProgress ?? (() => {});

  let text = input.text?.trim() ?? "";
  if (!text && input.audioPath) {
    onProgress("Wird abgeschrieben");
    text = (await transcribe(input.audioPath)).text.trim();
    if (text) input.onTranscribed?.(text);
  }
  if (text.length < 3) {
    throw new Error("Im Diktat war nichts zu verstehen. Bitte noch einmal sprechen.");
  }

  onProgress("Rezept wird erstellt");
  const ziele = await promptTargetContext();
  const recipe = await extractRecipe({
    input: text,
    sourceUrl: "",
    platform: "Diktat",
    mode: "diktat",
    knownTags: ziele.knownTags,
    knownIngredients: ziele.knownIngredients,
    extraFields: ziele.extraFields,
  });

  // Auch ein frei entwickeltes Rezept muss kochbar sein - ein einziger Schritt
  // oder zwei Zutaten ohne Mengen waeren keines.
  const mangel = recipeShortcoming(recipe);
  if (mangel) {
    throw new Error(
      `Aus dem Diktat ließ sich kein vollständiges Rezept machen — ${mangel}. ` +
        `Sag ruhig etwas mehr dazu, etwa welche Zutaten oder wie viele Personen.`,
    );
  }

  onProgress("Wird gespeichert");
  const publish = await publishRecipe({
    recipe,
    sourceUrl: "",
    sourceLabel: "Eigenes Diktat",
    sourceIcon: "🎙️",
    existingPageId: input.existingPageId,
    existingMealieSlug: input.existingMealieSlug,
    aiNotice: dictationNotice(text),
    transcript: text,
    transcriptSource: "Diktat",
  });

  return {
    recipe,
    publish,
    aiNotice: dictationNotice(text),
    title: recipe.titel,
    platform: "Diktat",
    textSource: "Diktat",
    transcript: text,
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
  opts: { existingMealieSlug?: string } = {},
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
  const ziele = await promptTargetContext();

  const recipe = await extractRecipe({
    input: extracted.text,
    sourceUrl: notionUrl,
    sourceTitle: extracted.title,
    uploader: extracted.uploader,
    platform,
    knownTags: ziele.knownTags,
    knownIngredients: ziele.knownIngredients,
    extraFields: ziele.extraFields,
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

  onProgress(dryRun ? "Vorschau wird gebaut" : "Wird gespeichert");
  const publish = await publishRecipe({
    recipe,
    sourceUrl: notionUrl,
    thumbnailUrl: extracted.thumbnailUrl,
    sourceTitle: extracted.title,
    transcript: extracted.text,
    transcriptSource: extracted.source,
    existingMealieSlug: opts.existingMealieSlug,
    dryRun,
  });

  return {
    recipe,
    publish,
    coverRef: extracted.thumbnailUrl,
    title: extracted.title,
    platform,
    textSource: extracted.source,
    transcript: extracted.text,
  };
}
