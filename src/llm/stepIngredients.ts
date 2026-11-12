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

  const schonDran = new Set<number>();
  return liste.map((namen, schritt) => {
    const treffer = new Set<number>();
    for (const n of namen) {
      const kandidaten = nachName.get(norm(n)) ?? [];
      if (kandidaten.length === 1) {
        treffer.add(kandidaten[0]!);
        continue;
      }
      // Passt der Name zu mehreren Zutaten - "2 TL Italienische Kräuter" für
      // die Hackbällchen und genauso für die Sauce -, nimmt der Schritt die
      // erste, die noch kein früherer Schritt verwendet hat. Gleiche Zutaten
      // in zwei Gruppen kommen fast immer in verschiedenen Schritten dran.
      // Sind alle schon verwendet, keine: lieber keine Zeile als die falsche.
      const frei = kandidaten.find((i) => !schonDran.has(i) && !treffer.has(i));
      if (frei !== undefined) treffer.add(frei);
    }
    // "Den Teig nachkneten" ist kein Schritt mit Mehl, Hefe und Wasser - die
    // stecken seit Schritt 2 im Teig. Was frueher schon dran war, erscheint
    // nur wieder, wenn der Schritt es beim Namen nennt ("mit Salz abschmecken").
    const text = recipe.schritte[schritt] ?? "";
    const ergebnis = [...treffer]
      .filter((i) => !schonDran.has(i) || nenntZutat(text, eintraege[i]!))
      .sort((a, b) => a - b);
    for (const i of ergebnis) schonDran.add(i);
    return ergebnis;
  });
}

/**
 * Nennt der Schritt die Zutat? Als ganzes Wort, mit den ueblichen
 * Pluralendungen ("Ei" -> "Eier", "Zwiebel" -> "Zwiebeln"). Sonst steckte
 * "Ei" in "eine" und "Teig", "Wasser" in "Eiswasser".
 */
export function nenntZutat(
  text: string,
  z: { zutat: string; lebensmittel?: string | null },
): boolean {
  const namen = [z.lebensmittel ?? "", z.zutat.split(/[,(]/)[0] ?? ""]
    .map((n) => n.trim())
    .filter((n) => n.length >= 2);
  return namen.some((n) =>
    new RegExp(
      `(?<!\\p{L})${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e|n|en|er|ern|s|es|ns)?(?!\\p{L})`,
      "iu",
    ).test(text),
  );
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
