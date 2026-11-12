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
  /** Bereits zusammengefuehrt: was in Mealie steht, plus die Kueche aus der App. */
  categories: MealieRef[];
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

export interface Ausbeute {
  /** Fuer wie viele Personen - Mealies recipeServings. */
  servings?: number;
  /** "1 Brot", "12 Stück" - Mealies recipeYieldQuantity und recipeYield. */
  menge?: number;
  einheit?: string;
  /** Keine Zahl erkannt: der Text, wie er ist. */
  text?: string;
  /** Die KI hat die Zahl aus den Mengen geschaetzt. */
  geschaetzt: boolean;
}

const PERSONEN = /^(personen?|portionen?|pers\.?|leute|esser|servings?|people)$/i;

/**
 * "4" und "4 Personen" sind Portionen, "1 Brot" und "12 Stück" eine Menge.
 * Atelier rechnet beides um - aber "12 Stück" als 12 Personen hiesse,
 * fuer zwei Leute ein Sechstel des Blechs.
 */
export function parseYield(portionen: string | null | undefined): Ausbeute {
  const roh = (portionen ?? "").trim();
  const geschaetzt = /gesch[äa]tzt/i.test(roh);
  const ohne = roh
    .replace(/\(?\s*gesch[äa]tzt\s*\)?/gi, "")
    .replace(/\b(ca\.?|etwa|für|fuer|rund)\s*/gi, "")
    .trim();
  if (!ohne) return { geschaetzt };
  const m = /(\d+(?:[.,]\d+)?)/.exec(ohne);
  const n = m?.[1] ? Number(m[1].replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return { text: roh, geschaetzt };
  const rest = ohne.replace(m![0], "").replace(/[-–]\s*\d+(?:[.,]\d+)?/, "").trim();
  if (!rest || PERSONEN.test(rest)) return { servings: n, geschaetzt };
  return { menge: n, einheit: rest, geschaetzt };
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

/**
 * "1–2 Zehen", "ca. 300-400 ml" -> 1 bzw. 300. Mealie speichert nur eine
 * Zahl. Die Mitte ergaebe "1 ½ Zehen" - das schreibt niemand. Gespeichert
 * wird deshalb die untere Zahl, und die ganze Angabe steht als Notiz dabei.
 */
export function rangeLow(menge: string | null | undefined): number | undefined {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:[-–—]|bis)\s*\d+(?:[.,]\d+)?/.exec(menge ?? "");
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
        const spanne = rangeLow(z.menge);
        const notiz = ingredientNote(z.zutat, food.name);
        result.push({
          referenceId: newId(),
          title,
          quantity: spanne ?? z.anzahl ?? 0,
          unit: unit ?? null,
          food,
          note: spanne ? [z.menge!.trim(), notiz].filter(Boolean).join(", ") : notiz,
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
  const ausbeute = parseYield(recipe.portionen);

  const notes: { title: string; text: string }[] = [];
  if (opts.aiNotice?.trim()) notes.push({ title: "🤖 Hinweis", text: opts.aiNotice.trim() });
  if (recipe.pro_tipp.trim()) notes.push({ title: "💡 Pro-Tipp", text: recipe.pro_tipp.trim() });
  if (ausbeute.geschaetzt && (ausbeute.servings || ausbeute.menge)) {
    notes.push({
      title: "🍽️ Portionen geschätzt",
      text: "Das Original nennt keine Portionenzahl – sie ist aus den Mengen geschätzt.",
    });
  }

  const ingredients = mapIngredients(recipe, lookups);
  const links = linkSteps(recipe, ingredients);

  const extras: Record<string, string> = {};
  if (recipe.schwierigkeit) extras.schwierigkeit = recipe.schwierigkeit;
  if (recipe.emoji) extras.emoji = recipe.emoji;

  return {
    name: recipe.titel,
    orgURL: opts.sourceUrl || null,
    totalTime: recipe.zeit_text || null,
    // Immer alle drei Felder: Wechselt ein Rezept von "12 Stück" zu "4", darf
    // die alte Menge nicht stehen bleiben.
    ...(ausbeute.servings
      ? { recipeServings: ausbeute.servings, recipeYieldQuantity: 0, recipeYield: null }
      : ausbeute.menge
        ? { recipeServings: 0, recipeYieldQuantity: ausbeute.menge, recipeYield: ausbeute.einheit }
        : { recipeServings: 0, recipeYieldQuantity: 0, recipeYield: ausbeute.text ?? null }),
    tags: lookups.tags,
    recipeCategory: lookups.categories,
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
