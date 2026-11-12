import { describe, it, expect } from "vitest";
import { RecipeSchema, zutatOhneMenge } from "../src/llm/recipeSchema.ts";
import { stepIngredientLabels } from "../src/llm/stepIngredients.ts";

describe("zutatOhneMenge", () => {
  it("streicht die doppelte Menge vorn im Zutatentext", () => {
    expect(zutatOhneMenge("500 g", "500 g Karotten")).toBe("Karotten");
    expect(zutatOhneMenge("1", "1 Bio-Orange (Saft + etwas Schale)")).toBe(
      "Bio-Orange (Saft + etwas Schale)",
    );
    expect(zutatOhneMenge("ca. 300–400 ml", "ca. 300–400 ml Wasser")).toBe("Wasser");
    expect(zutatOhneMenge("3 EL", "3  el Honig")).toBe("Honig");
  });

  it("lässt alles andere stehen", () => {
    expect(zutatOhneMenge("500 g", "Karotten")).toBe("Karotten");
    expect(zutatOhneMenge(null, "500 g Karotten")).toBe("500 g Karotten");
    expect(zutatOhneMenge("2", "2-3 Zwiebeln")).toBe("2-3 Zwiebeln");
    expect(zutatOhneMenge("1 cup (ca. 120 g)", "1 cup (ca. 120 g) Mehl")).toBe("Mehl");
    // Nur die Menge im Text - dann lieber doppelt als leer.
    expect(zutatOhneMenge("2 Eier", "2 Eier")).toBe("2 Eier");
  });
});

describe("Rezept mit doppelten Mengen", () => {
  const recipe = RecipeSchema.parse({
    titel: "Glasierte Karotten",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "500 g", zutat: "500 g Karotten", lebensmittel: "Karotte" },
          { menge: "30 g", zutat: "30 g Butter" },
          { zutat: "Salz" },
        ],
      },
    ],
    schritte: ["Karotten schälen.", "Mit Butter und Salz glasieren."],
    schritte_zutaten: [["500 g Karotten"], ["30 g Butter", "Salz"]],
  });

  it("wird beim Einlesen bereinigt", () => {
    expect(recipe.zutaten[0]!.eintraege.map((e) => e.zutat)).toEqual(["Karotten", "Butter", "Salz"]);
  });

  it("findet die Zutaten der Schritte trotzdem und nennt die Menge nur einmal", () => {
    expect(stepIngredientLabels(recipe)).toEqual(["500 g Karotten", "30 g Butter · Salz"]);
  });
});
