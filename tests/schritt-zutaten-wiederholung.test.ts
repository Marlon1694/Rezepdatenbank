import { describe, it, expect } from "vitest";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";
import { stepIngredientLabels, nenntZutat } from "../src/llm/stepIngredients.ts";

const pizza = (schritteZutaten: string[][]) =>
  RecipeSchema.parse({
    titel: "Biga Pizza",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "1 kg", zutat: "Manitoba Mehl", lebensmittel: "Mehl" },
          { menge: "6 g", zutat: "frische Hefe", lebensmittel: "Hefe" },
          { menge: "25 g", zutat: "Salz", lebensmittel: "Salz" },
          { menge: null, zutat: "Olivenöl", lebensmittel: "Olivenöl" },
          { menge: "2", zutat: "Eier", lebensmittel: "Ei" },
        ],
      },
    ],
    schritte: [
      "Mehl, Hefe und Eier verkneten.",
      "Salz zugeben und weiterkneten.",
      "Den Teig auf eine geölte Arbeitsfläche geben und ruhen lassen.",
      "Den Teig noch einmal mit etwas Salz bestreuen.",
    ],
    schritte_zutaten: schritteZutaten,
  });

describe("Zutaten, die schon im Teig stecken", () => {
  it("erscheinen in einem späteren Schritt nicht noch einmal", () => {
    const r = pizza([
      ["Manitoba Mehl", "frische Hefe", "Eier"],
      ["Salz"],
      // So kam es von der KI: "den Teig" als alle Teigzutaten gelesen.
      ["Manitoba Mehl", "frische Hefe", "Salz", "Eier", "Olivenöl"],
      [],
    ]);
    expect(stepIngredientLabels(r)[2]).toBe("Olivenöl");
  });

  it("erscheinen wieder, wenn der Schritt sie beim Namen nennt", () => {
    const r = pizza([["Manitoba Mehl", "frische Hefe", "Eier"], ["Salz"], ["Olivenöl"], ["Salz"]]);
    expect(stepIngredientLabels(r)[3]).toBe("25 g Salz");
  });
});

describe("nenntZutat", () => {
  it("erkennt den Namen nur am Wortanfang", () => {
    expect(nenntZutat("Eier verquirlen", { zutat: "Eier", lebensmittel: "Ei" })).toBe(true);
    expect(nenntZutat("Den Teig ruhen lassen", { zutat: "Eier", lebensmittel: "Ei" })).toBe(false);
    expect(nenntZutat("auf eine Fläche", { zutat: "Eier", lebensmittel: "Ei" })).toBe(false);
    expect(nenntZutat("Zwiebeln anbraten", { zutat: "Zwiebel", lebensmittel: "Zwiebel" })).toBe(true);
    expect(nenntZutat("Eiswasser zugeben", { zutat: "Wasser", lebensmittel: "Wasser" })).toBe(false);
    expect(nenntZutat("restliches Mehl einarbeiten", { zutat: "Manitoba Mehl (14 %)", lebensmittel: "Mehl" })).toBe(true);
  });
});
