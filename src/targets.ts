import { getConfig } from "./config.ts";
import { upsertRecipe, resolveCover, type UpsertInput, type UpsertResult } from "./notion/upsert.ts";
import { getDataSourceSchema } from "./notion/client.ts";
import {
  availableExtraFields,
  knownTags as notionKnownTags,
  knownOptions,
  type ExtraField,
} from "./notion/mapper.ts";
import { loadMapping } from "./jobs/mapping.ts";
import { mealieEnabled, mealie, type Page } from "./mealie/client.ts";
import { upsertMealieRecipe, type MealieUpsertResult } from "./mealie/recipes.ts";
import type { MealieRef } from "./mealie/mapper.ts";

/**
 * Wohin ein Rezept geschrieben wird: Notion, Mealie oder beide.
 *
 * Die beiden Ziele sind unabhaengig. Faellt eines aus, landet das Rezept
 * trotzdem im anderen, und der Fehler wird festgehalten statt den ganzen Job
 * zu verwerfen. Ein zweiter Anlauf schreibt dann nur noch dorthin, wo es
 * gefehlt hat - sonst entstuende im funktionierenden Ziel nichts Doppeltes,
 * aber jede Korrektur dort ginge verloren.
 */

export type Target = "notion" | "mealie";

export function activeTargets(): Target[] {
  const t: Target[] = [];
  if (getConfig().notionEnabled) t.push("notion");
  if (mealieEnabled()) t.push("mealie");
  return t;
}

export interface PublishInput extends UpsertInput {
  existingMealieSlug?: string;
  aiNotice?: string;
  /** Nur diese Ziele beschreiben - fuer den zweiten Anlauf nach einem Teilfehler. */
  only?: Target[];
}

export interface PublishResult {
  notion?: UpsertResult;
  mealie?: MealieUpsertResult;
  /** Ziel -> Fehlermeldung, fuer jedes Ziel, das nicht geklappt hat. */
  errors: Partial<Record<Target, string>>;
  /** War es irgendwo schon vorhanden? Dann "Aktualisiert" statt "Angelegt". */
  updated: boolean;
}

const NAME: Record<Target, string> = { notion: "Notion", mealie: "Mealie" };

export async function publishRecipe(input: PublishInput): Promise<PublishResult> {
  const ziele = activeTargets().filter((t) => !input.only || input.only.includes(t));
  // Ein Probelauf zeigt nur, was nach Notion ginge - Mealie hat keinen.
  const echt = input.dryRun ? ziele.filter((t) => t === "notion") : ziele;

  if (!echt.length) {
    throw new Error(
      input.only
        ? `Keines der Ziele (${input.only.map((t) => NAME[t]).join(", ")}) ist eingerichtet.`
        : "Weder Notion noch Mealie ist eingerichtet - siehe .env.example.",
    );
  }

  // Einmal holen, an beide geben: Ein TikTok-Vorschaubild zweimal abzurufen
  // kostet Zeit, und signierte CDN-Adressen laufen dazwischen womoeglich ab.
  const coverImage =
    input.dryRun || input.coverImage !== undefined
      ? input.coverImage
      : ((await resolveCover(input)) ?? null);

  const result: PublishResult = { errors: {}, updated: false };

  if (echt.includes("notion")) {
    try {
      result.notion = await upsertRecipe({ ...input, coverImage });
    } catch (err) {
      result.errors.notion = err instanceof Error ? err.message : String(err);
      console.error(`[notion] fehlgeschlagen: ${result.errors.notion}`);
    }
  }

  if (echt.includes("mealie")) {
    try {
      result.mealie = await upsertMealieRecipe({
        recipe: input.recipe,
        sourceUrl: input.sourceUrl,
        existingSlug: input.existingMealieSlug,
        coverImage: coverImage ?? undefined,
        aiNotice: input.aiNotice,
      });
    } catch (err) {
      result.errors.mealie = err instanceof Error ? err.message : String(err);
      console.error(`[mealie] fehlgeschlagen: ${result.errors.mealie}`);
    }
  }

  const geklappt = Number(Boolean(result.notion)) + Number(Boolean(result.mealie));
  if (!geklappt) {
    // Nirgends angekommen: Das ist ein echter Fehlschlag, und die Meldungen
    // aller Ziele gehoeren in die eine Fehlermeldung des Jobs.
    throw new Error(
      echt.map((t) => `${NAME[t]}: ${result.errors[t] ?? "unbekannter Fehler"}`).join("\n"),
    );
  }

  result.updated = Boolean(result.notion?.updated || result.mealie?.updated);
  return result;
}

/* ── Was der Prompt ueber die Ziele wissen muss ───────────────────────────── */

export interface PromptTargetContext {
  knownTags: string[];
  knownIngredients: string[];
  extraFields: ExtraField[];
}

/** Ohne Notion fragt der Prompt alle Zusatzfelder ab - Mealie hat fuer jedes einen Platz. */
const ALL_EXTRAS: ExtraField[] = ["portionen", "kueche", "schwierigkeit", "zutatenliste"];

/**
 * Welche Tags schon vergeben sind und welche Zusatzfelder abgefragt werden.
 *
 * Solange Notion aktiv ist, bestimmt seine Datenbank das - wie bisher. Ist es
 * abgeschaltet, kommen die Tags aus Mealie, damit dort nicht "Schnell" und
 * "schnell" nebeneinander entstehen.
 */
export async function promptTargetContext(): Promise<PromptTargetContext> {
  if (getConfig().notionEnabled) {
    const [schema, mapping] = await Promise.all([getDataSourceSchema(), loadMapping()]);
    return {
      knownTags: notionKnownTags(schema, mapping),
      knownIngredients: knownOptions(schema, "zutatenliste", mapping),
      extraFields: availableExtraFields(schema, mapping),
    };
  }

  let knownTags: string[] = [];
  try {
    const tags = await mealie<Page<MealieRef>>("/organizers/tags", { query: { perPage: -1 } });
    knownTags = tags.items.map((t) => t.name);
  } catch (err) {
    // Nur ein Komfort fuer den Prompt - daran soll kein Rezept scheitern.
    console.warn(`[mealie] Tags nicht abrufbar: ${String(err)}`);
  }
  return { knownTags, knownIngredients: [], extraFields: ALL_EXTRAS };
}
