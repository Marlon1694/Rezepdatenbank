import { norm } from "./mapper.ts";

/**
 * Einkaufsvorschlag aus dem Wochenplan - reine Funktionen, ohne Netz.
 *
 * Aus allen geplanten Rezepten werden die Zutaten gesammelt, mit dem
 * Portionsfaktor des Wochenplans multipliziert und ueber die Woche
 * zusammengefasst: Zwei Rezepte mit je 1 Zwiebel ergeben eine Zeile
 * "2 Zwiebel", nicht zwei. Was vorraetig ist, ist vorab abgewaehlt.
 */

export interface MealieIngredient {
  referenceId?: string;
  quantity?: number | null;
  unit?: { id: string; name: string; abbreviation?: string; useAbbreviation?: boolean } | null;
  food?: {
    id: string;
    name: string;
    pluralName?: string | null;
    householdsWithIngredientFood?: string[];
  } | null;
  note?: string | null;
  display?: string | null;
  originalText?: string | null;
  title?: string | null;
}

export interface PlannedRecipe {
  entryId: number | string;
  date: string;
  entryType: string;
  recipeId: string;
  slug: string;
  name: string;
  /** Portionsfaktor aus dem Wochenplan, 1 = wie im Rezept. */
  scale: number;
  ingredients: MealieIngredient[];
}

export interface ShoppingLine {
  /** Stabil, solange sich das Rezept nicht aendert - die Freigabe schickt ihn zurueck. */
  key: string;
  label: string;
  /** Vorab abgewaehlt, weil vorraetig oder Grundausstattung. */
  onHand: boolean;
  /** Aus welchen Rezepten die Zeile stammt - fuer die Anzeige. */
  recipes: string[];
  /** Welche Zutaten welcher Rezepte dahinterstehen - fuer die Freigabe. */
  sources: { recipeId: string; entryId: number | string; referenceId: string }[];
}

/** 0.5 -> "0,5", 2 -> "2", 0.3333 -> "0,33". */
export function formatQuantity(q: number): string {
  const r = Math.round(q * 100) / 100;
  return String(r).replace(".", ",");
}

function unitLabel(unit: MealieIngredient["unit"]): string {
  if (!unit) return "";
  return unit.abbreviation || unit.name;
}

function ingredientText(i: MealieIngredient): string {
  return (i.note || i.display || i.originalText || "").trim();
}

/** Steht ein Grundvorrat-Wort als ganzes Wort darin? "Salz und Pfeffer" ja, "Salzbrezel" nein. */
export function isStaple(text: string, staples: string[]): boolean {
  const t = norm(text);
  return staples.some((s) => {
    const w = norm(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}])${w}($|[^\\p{L}])`, "u").test(t);
  });
}

export function buildShoppingLines(
  planned: PlannedRecipe[],
  opts: { householdSlug?: string; staples: string[] },
): ShoppingLine[] {
  interface Acc {
    line: ShoppingLine;
    quantity: number;
    food?: MealieIngredient["food"];
    unit?: MealieIngredient["unit"];
    text?: string;
  }
  const acc = new Map<string, Acc>();

  for (const p of planned) {
    for (const [i, ing] of p.ingredients.entries()) {
      const text = ingredientText(ing);
      // Reine Zwischenueberschriften ohne Inhalt gibt es in Mealie nicht als
      // eigene Zeile - aber leere Freitext-Zeilen schon. Die haben keinen Wert.
      if (!ing.food && !text) continue;

      const referenceId = ing.referenceId ?? `${p.recipeId}#${i}`;
      const key = ing.food
        ? `f:${ing.food.id}|u:${ing.unit?.id ?? ""}`
        : `n:${norm(text)}`;

      let a = acc.get(key);
      if (!a) {
        const onHand = ing.food
          ? Boolean(
              opts.householdSlug &&
                ing.food.householdsWithIngredientFood?.includes(opts.householdSlug),
            ) || isStaple(ing.food.name, opts.staples)
          : isStaple(text, opts.staples);
        a = {
          line: { key, label: "", onHand, recipes: [], sources: [] },
          quantity: 0,
          food: ing.food,
          unit: ing.unit,
          text,
        };
        acc.set(key, a);
      }
      a.quantity += (ing.quantity ?? 0) * (p.scale || 1);
      if (!a.line.recipes.includes(p.name)) a.line.recipes.push(p.name);
      a.line.sources.push({ recipeId: p.recipeId, entryId: p.entryId, referenceId });
    }
  }

  const lines = [...acc.values()].map((a) => {
    if (a.food) {
      const menge = a.quantity > 0 ? formatQuantity(a.quantity) : "";
      a.line.label = [menge, unitLabel(a.unit), a.food.name].filter(Boolean).join(" ");
    } else {
      // Freitext kann nicht addiert werden ("eine Prise", "200 g" als Text).
      // Kommt er mehrfach vor, steht das dabei.
      const n = a.line.sources.length;
      a.line.label = n > 1 ? `${a.text} (${n}×)` : (a.text ?? "");
    }
    return a.line;
  });

  // Erst was gekauft werden muss, dann der Vorrat; jeweils alphabetisch.
  return lines.sort(
    (x, y) => Number(x.onHand) - Number(y.onHand) || x.label.localeCompare(y.label, "de"),
  );
}

/**
 * Aus den freigegebenen Zeilen die Anfrage an Mealie bauen: pro geplantem
 * Eintrag das Rezept, der Portionsfaktor und genau die Zutaten, die bleiben
 * sollen. Mealie fasst dann selbst zusammen und merkt sich, aus welchem Rezept
 * eine Zeile stammt.
 */
export function approvalPayload(
  planned: PlannedRecipe[],
  lines: ShoppingLine[],
  approvedKeys: Set<string>,
) {
  const freigegeben = new Set<string>();
  for (const line of lines) {
    if (!approvedKeys.has(line.key)) continue;
    for (const s of line.sources) freigegeben.add(`${s.entryId}::${s.referenceId}`);
  }

  return planned
    .map((p) => ({
      recipeId: p.recipeId,
      recipeIncrementQuantity: p.scale || 1,
      recipeIngredients: p.ingredients.filter((ing, i) =>
        freigegeben.has(`${p.entryId}::${ing.referenceId ?? `${p.recipeId}#${i}`}`),
      ),
    }))
    .filter((r) => r.recipeIngredients.length > 0);
}
