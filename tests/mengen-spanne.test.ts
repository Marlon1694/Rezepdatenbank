import { describe, it, expect } from "vitest";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";
import { mapIngredients, rangeLow } from "../src/mealie/mapper.ts";
import { mergeEnrichment } from "../src/llm/enrich.ts";

describe("rangeLow", () => {
  it("nimmt bei einer Spanne die untere Zahl", () => {
    expect(rangeLow("1–2 Zehen")).toBe(1);
    expect(rangeLow("2-3 EL")).toBe(2);
    expect(rangeLow("ca. 300–400 ml")).toBe(300);
    expect(rangeLow("1,5 - 2 kg")).toBe(1.5);
    expect(rangeLow("2 bis 3 Stück")).toBe(2);
  });

  it("lässt einfache Mengen in Ruhe", () => {
    expect(rangeLow("200 g")).toBeUndefined();
    expect(rangeLow("1/2 TL")).toBeUndefined();
    expect(rangeLow(null)).toBeUndefined();
  });
});

describe("Spannen in Mealie", () => {
  const ref = (name: string) => ({ id: `id-${name}`, name });
  const recipe = RecipeSchema.parse({
    titel: "Orzo",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          // So kam es aus der ersten Aufwertung: die Mitte der Spanne.
          { menge: "1–2 Zehen", zutat: "Knoblauch, gehackt", anzahl: 1.5, einheit: "Zehe", lebensmittel: "Knoblauch" },
          { menge: "200 g", zutat: "Brokkoli", anzahl: 200, einheit: "g", lebensmittel: "Brokkoli" },
        ],
      },
    ],
    schritte: ["Kochen."],
  });

  it("zeigt die untere Zahl und die ganze Angabe als Notiz - kein „1 ½ Zehen“", () => {
    const [knoblauch, brokkoli] = mapIngredients(recipe, {
      foods: new Map([["knoblauch", ref("Knoblauch")], ["brokkoli", ref("Brokkoli")]]),
      units: new Map([["zehe", ref("Zehe")], ["g", ref("g")]]),
    });
    expect(knoblauch).toMatchObject({ quantity: 1, note: "1–2 Zehen, gehackt" });
    expect(brokkoli).toMatchObject({ quantity: 200, note: "" });
  });
});

describe("erneutes Aufwerten (--neu)", () => {
  const vorher = RecipeSchema.parse({
    titel: "Orzo",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "250 g", zutat: "Hähnchenbruststücke", anzahl: 250, einheit: "g", lebensmittel: "Hähnchenbruststück" },
          { menge: null, zutat: "Salz", lebensmittel: "Salz" },
        ],
      },
    ],
    schritte: ["Anbraten.", "Würzen."],
    schritte_zutaten: [["Hähnchenbruststücke"], []],
  });
  const antwort = {
    zutaten: [{ nr: 1, anzahl: 250, einheit: "g", lebensmittel: "Hähnchenbrust" }],
    schritte: [{ schritt: 1, zutaten: [1] }, { schritt: 2, zutaten: [2] }],
  };

  it("ersetzt die alte Zerlegung", () => {
    const r = mergeEnrichment(vorher, antwort, { ersetzen: true });
    expect(r.zutaten[0]!.eintraege[0]!.lebensmittel).toBe("Hähnchenbrust");
    expect(r.schritte_zutaten).toEqual([["Hähnchenbruststücke"], ["Salz"]]);
  });

  it("behält eine Zutat, zu der die Antwort nichts sagt", () => {
    const r = mergeEnrichment(vorher, antwort, { ersetzen: true });
    expect(r.zutaten[0]!.eintraege[1]!.lebensmittel).toBe("Salz");
  });

  it("ohne --neu bleibt das Vorhandene", () => {
    const r = mergeEnrichment(vorher, antwort);
    expect(r.zutaten[0]!.eintraege[0]!.lebensmittel).toBe("Hähnchenbruststück");
  });
});
