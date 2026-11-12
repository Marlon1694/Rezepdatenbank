import { generateJson } from "./gemini.ts";
import { RecipeSchema, GEMINI_RESPONSE_SCHEMA, type Recipe } from "./recipeSchema.ts";

/**
 * "Mit KI überarbeiten": ein fertiges Rezept nach einer kurzen Anweisung
 * aendern - "schärfer", "ohne Sahne", "für 2 statt 4 Personen".
 *
 * Das Ergebnis ist ein Vorschlag. Gespeichert wird erst, wenn du ihn im Editor
 * pruefst und auf Speichern tippst - ueber denselben Weg wie jede Korrektur.
 */

/** Felder, die das Antwortschema nicht verlangt. Fehlen sie, gilt das Original. */
const OPTIONAL = [
  "zeit_minuten",
  "pro_tipp",
  "portionen",
  "kueche",
  "schwierigkeit",
  "zutaten_namen",
  "schritte_zutaten",
] as const;

export function revisePrompt(recipe: Recipe, anweisung: string): string {
  return [
    "Hier ist ein Rezept als JSON und eine Änderung, die ich mir wünsche.",
    "Gib das vollständige, geänderte Rezept im selben Format zurück.",
    "",
    "## Regeln",
    "- Ändere nur, was die Anweisung betrifft. Alles andere bleibt Wort für Wort, wie es ist.",
    "- Andere Portionenzahl: alle Mengen umrechnen – im Text (`menge`) und in `anzahl` –,",
    "  `portionen` anpassen, Zeiten nur ändern, wenn es nötig ist. Krumme Werte sinnvoll",
    "  runden (1 Ei statt 0,75 Eier, 250 g statt 247 g).",
    "- Zutat weglassen oder ersetzen: auch in den Schritten, in `schritte_zutaten` und in",
    "  `zutaten_namen`. Kein Schritt darf eine Zutat nennen, die es nicht mehr gibt.",
    "- Neue Zutaten mit Menge, `anzahl`, `einheit` und `lebensmittel` wie die übrigen.",
    "- `schritte_zutaten` hat genau so viele Einträge wie `schritte`; die Namen exakt wie",
    "  im Feld `zutat`.",
    "- Den Titel nur ändern, wenn es dadurch ein anderes Gericht wird",
    "  (etwa „Vegetarische Lasagne“ statt „Lasagne“).",
    "- Ist die Anweisung keine Änderung am Rezept, gib das Rezept unverändert zurück.",
    "",
    "## Anweisung",
    anweisung.trim(),
    "",
    "## Rezept",
    JSON.stringify(recipe, null, 2),
  ].join("\n");
}

/**
 * Antwort pruefen und mit dem Original zusammenfuehren: Was das Modell bei
 * den optionalen Feldern weglaesst, ist keine Loeschung, sondern Vergessen.
 */
export function mergeRevision(original: Recipe, raw: unknown): Recipe {
  const obj = { ...((raw ?? {}) as Record<string, unknown>) };
  for (const key of OPTIONAL) {
    if (obj[key] === undefined) obj[key] = original[key] ?? undefined;
  }
  const parsed = RecipeSchema.safeParse(obj);
  if (!parsed.success) {
    const was = parsed.error.issues.map((i) => i.path.join(".") || "(Rezept)").join(", ");
    throw new Error(
      `Der Vorschlag der KI war unvollständig (${was}). Bitte noch einmal versuchen, ` +
        `gern mit etwas genauerer Anweisung.`,
    );
  }
  return parsed.data;
}

export async function reviseRecipe(recipe: Recipe, anweisung: string): Promise<Recipe> {
  const raw = await generateJson({
    prompt: revisePrompt(recipe, anweisung),
    schema: GEMINI_RESPONSE_SCHEMA,
  });
  return mergeRevision(recipe, raw);
}
