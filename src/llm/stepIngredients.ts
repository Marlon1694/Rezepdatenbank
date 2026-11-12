import type { Recipe } from "./recipeSchema.ts";

/**
 * Welche Zutaten jeder Zubereitungsschritt verwendet - als Positionen in der
 * flachen Zutatenliste (alle Gruppen hintereinander).
 *
 * Gemeinsame Grundlage fuer beide Ziele: Notion schreibt die Zutaten samt
 * Menge unter den Schritt, Mealie verknuepft sie, damit der Kochmodus sie
 * daneben zeigt. So sehen beide dasselbe.
 *
 * Gemini nennt die Zutaten beim Namen. Gefunden wird eine Zutat ueber den
 * vollen Text, den Teil vor dem Komma ("Zwiebel" zu "Zwiebel, fein
 * gewürfelt") oder das Lebensmittel.
 *
 * Passt die Liste nicht zu den Schritten - weil im Editor einer geloescht
 * wurde -, gibt es keine Zuordnung: Jede danach waere um eins verrutscht,
 * und dann lieber keine als falsche.
 */
export function stepIngredientIndices(recipe: Recipe): number[][] {
  const leer = recipe.schritte.map(() => []);
  const liste = recipe.schritte_zutaten;
  if (!liste || liste.length !== recipe.schritte.length) return leer;

  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);
  const nachName = new Map<string, number[]>();
  eintraege.forEach((z, i) => {
    // Auch "500 g Karotten": Gemini nennt die Zutat im Schritt manchmal samt Menge.
    const namen = [
      z.zutat,
      z.zutat.split(",")[0] ?? "",
      z.lebensmittel ?? "",
      z.menge ? `${z.menge} ${z.zutat}` : "",
    ]
      .map(norm)
      .filter(Boolean);
    for (const n of new Set(namen)) nachName.set(n, [...(nachName.get(n) ?? []), i]);
  });

  return liste.map((namen) => {
    const treffer = new Set<number>();
    for (const n of namen) {
      const kandidaten = nachName.get(norm(n)) ?? [];
      // Ein Name, der zu mehreren Zutaten passt ("Wasser"), ist keine
      // Aussage ueber eine bestimmte - lieber keine Zeile als die falsche.
      // Eindeutig wird er mit Menge: "450 g Wasser".
      if (kandidaten.length === 1) treffer.add(kandidaten[0]!);
    }
    return [...treffer].sort((a, b) => a - b);
  });
}

/** Wie die Zutaten unter einem Schritt erscheinen: "200 g Mehl · 2 Eier". */
export function stepIngredientLabels(recipe: Recipe): string[] {
  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);
  return stepIngredientIndices(recipe).map((indizes) =>
    indizes
      .map((i) => eintraege[i])
      .filter((z) => z !== undefined)
      .map((z) => [z.menge, z.zutat].filter(Boolean).join(" "))
      .join(" · "),
  );
}
