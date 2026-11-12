import { randomUUID } from "node:crypto";
import type { Recipe, Zutat } from "../llm/recipeSchema.ts";
import { stepIngredientIndices } from "../llm/stepIngredients.ts";

/**
 * Rezept -> Mealie. Reine Funktionen, ohne Netz, in tests/mealie.test.ts
 * abgedeckt. Was nachgeschlagen werden muss (Tags, Lebensmittel, Einheiten),
 * kommt als fertige Zuordnung herein.
 */

/** Ein Eintrag, wie Mealie ihn fuer Tags, Kategorien, Lebensmittel und Einheiten liefert. */
export interface MealieRef {
  id: string;
  name: string;
  slug?: string;
  groupId?: string;
  [key: string]: unknown;
}

export interface Lookups {
  tags: MealieRef[];
  category?: MealieRef;
  /** Schluessel: normalisierter Name, siehe norm(). */
  foods: Map<string, MealieRef>;
  units: Map<string, MealieRef>;
}

export interface MapOptions {
  sourceUrl: string;
  /** Hinweise oben auf der Seite, etwa "von der KI ergaenzt". */
  aiNotice?: string;
}

/** Vergleichsschluessel: klein, ohne Rand- und Mehrfachleerzeichen. */
export function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * "4", "4 Personen", "für 4" -> 4. Mealie kennt dafuer recipeServings als Zahl;
 * passt nichts, bleibt die Angabe als Text in recipeYield erhalten.
 */
export function parseServings(portionen: string | null | undefined): number | undefined {
  if (!portionen) return undefined;
  const m = /(\d+(?:[.,]\d+)?)/.exec(portionen);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Was am Zutatentext ueber das Lebensmittel hinausgeht - "fein gewürfelt" bei
 * "Zwiebel, fein gewürfelt". Mealie zeigt Menge, Einheit, Lebensmittel und
 * Notiz hintereinander; stuende dort der ganze Text, hiesse es
 * "2 Zwiebel Zwiebeln, fein gewürfelt".
 */
export function ingredientNote(zutat: string, lebensmittel: string): string {
  const komma = zutat.indexOf(",");
  if (komma !== -1) return zutat.slice(komma + 1).trim();
  const klammer = /\(([^)]*)\)\s*$/.exec(zutat);
  if (klammer?.[1] && !norm(lebensmittel).includes(norm(klammer[1]))) return klammer[1].trim();
  return "";
}

function originalText(z: Zutat): string {
  return [z.menge, z.zutat].filter(Boolean).join(" ").trim();
}

/** Eine Zutatengruppe ohne eigene Ueberschrift - wie in den Notion-Bloecken. */
function isGenericGroup(name: string, groupCount: number): boolean {
  return groupCount === 1 && /^(zutaten|hauptzutaten|alle zutaten)$/i.test(name.trim());
}

export function mapIngredients(
  recipe: Recipe,
  lookups: Pick<Lookups, "foods" | "units">,
  newId: () => string = randomUUID,
) {
  const result: Record<string, unknown>[] = [];

  for (const gruppe of recipe.zutaten) {
    gruppe.eintraege.forEach((z, i) => {
      // Mealie kennt keine Gruppen, nur eine Ueberschrift am ersten Eintrag.
      const title =
        i === 0 && !isGenericGroup(gruppe.gruppe, recipe.zutaten.length) ? gruppe.gruppe : null;

      const food = z.lebensmittel ? lookups.foods.get(norm(z.lebensmittel)) : undefined;
      const unit = z.einheit ? lookups.units.get(norm(z.einheit)) : undefined;

      if (food) {
        result.push({
          referenceId: newId(),
          title,
          quantity: z.anzahl ?? 0,
          unit: unit ?? null,
          food,
          note: ingredientNote(z.zutat, food.name),
          originalText: originalText(z),
        });
        return;
      }

      // Ohne zugeordnetes Lebensmittel bleibt es Freitext. Das ist kein Fehler:
      // Mealie zeigt und kauft es genauso, es fasst nur nichts zusammen.
      result.push({
        referenceId: newId(),
        title,
        quantity: 0,
        unit: null,
        food: null,
        note: originalText(z),
        originalText: originalText(z),
      });
    });
  }
  return result;
}

/**
 * Verknuepft jeden Schritt mit den Zutaten, die er verwendet. Mealies
 * Kochmodus zeigt diese dann neben dem Schritt an - mit Menge und
 * mitgerechnet, wenn du die Portionen aenderst. Welche das sind, entscheidet
 * dieselbe Funktion, die auch die Zeile unter dem Schritt in Notion fuellt.
 */
export function linkSteps(
  recipe: Recipe,
  ingredients: Record<string, unknown>[],
): { referenceId: string }[][] {
  return stepIngredientIndices(recipe).map((indizes) =>
    indizes
      .map((i) => ingredients[i]?.referenceId as string | undefined)
      .filter((r): r is string => Boolean(r))
      .map((referenceId) => ({ referenceId })),
  );
}

/** Der PATCH-Inhalt. Nur die Felder, die wir besitzen - der Rest bleibt in Mealie, wie er ist. */
export function mapRecipe(recipe: Recipe, lookups: Lookups, opts: MapOptions) {
  const servings = parseServings(recipe.portionen);

  const notes: { title: string; text: string }[] = [];
  if (opts.aiNotice?.trim()) notes.push({ title: "🤖 Hinweis", text: opts.aiNotice.trim() });
  if (recipe.pro_tipp.trim()) notes.push({ title: "💡 Pro-Tipp", text: recipe.pro_tipp.trim() });

  const ingredients = mapIngredients(recipe, lookups);
  const links = linkSteps(recipe, ingredients);

  const extras: Record<string, string> = {};
  if (recipe.schwierigkeit) extras.schwierigkeit = recipe.schwierigkeit;
  if (recipe.emoji) extras.emoji = recipe.emoji;

  return {
    name: recipe.titel,
    orgURL: opts.sourceUrl || null,
    totalTime: recipe.zeit_text || null,
    ...(servings !== undefined
      ? { recipeServings: servings, recipeYield: null }
      : { recipeYield: recipe.portionen ?? null }),
    tags: lookups.tags,
    recipeCategory: lookups.category ? [lookups.category] : [],
    recipeIngredient: ingredients,
    recipeInstructions: recipe.schritte.map((text, i) => ({
      title: "",
      summary: "",
      text,
      ingredientReferences: links[i] ?? [],
    })),
    notes,
    extras,
  };
}
