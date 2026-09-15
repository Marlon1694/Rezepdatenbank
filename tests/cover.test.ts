import { describe, it, expect, beforeAll } from "vitest";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";

process.env.APP_TOKEN ??= "t";
process.env.NOTION_TOKEN ??= "ntn_t";
process.env.NOTION_DATABASE_ID ??= "0".repeat(32);

const { buildImagePrompt, generateCoverImage } = await import("../src/llm/image.ts");

const recipe = RecipeSchema.parse({
  emoji: "🍜",
  titel: "Erdnuss-Nudeln",
  tags: ["Schnell"],
  zeit_text: "20 Minuten",
  zutaten: [
    {
      gruppe: "Zutaten",
      eintraege: [
        { menge: "250 g", zutat: "Mie-Nudeln" },
        { menge: "3 EL", zutat: "Erdnussbutter" },
      ],
    },
  ],
  schritte: ["Kochen."],
  zutaten_namen: ["Mie-Nudeln", "Erdnussbutter", "Limette"],
});

describe("buildImagePrompt", () => {
  it("setzt Gericht und Zutaten in die Vorlage ein", async () => {
    const prompt = await buildImagePrompt(recipe);
    expect(prompt).toContain("Erdnuss-Nudeln");
    expect(prompt).toContain("Mie-Nudeln, Erdnussbutter, Limette");
  });

  it("lässt die Erklärung für Menschen weg", async () => {
    // Alles oberhalb der ersten --- richtet sich an den Leser, nicht an das Modell.
    const prompt = await buildImagePrompt(recipe);
    expect(prompt).not.toContain("Wird bei jedem Rezept frisch gelesen");
    expect(prompt).not.toContain("{{");
  });

  it("weist Text und Wasserzeichen ab", async () => {
    const prompt = await buildImagePrompt(recipe);
    expect(prompt.toLowerCase()).toContain("kein text");
  });

  it("greift auf die Mengen-Zutaten zurück, wenn keine Namen da sind", async () => {
    const ohneNamen = RecipeSchema.parse({ ...recipe, zutaten_namen: [] });
    const prompt = await buildImagePrompt(ohneNamen);
    expect(prompt).toContain("Mie-Nudeln");
    // Ohne Mengenangabe - die gehört nicht in einen Bildprompt.
    expect(prompt).not.toContain("250 g");
  });
});

describe("generateCoverImage", () => {
  it("tut nichts, solange kein Bildmodell eingestellt ist", async () => {
    // Der entscheidende Punkt: ohne Konfiguration keine API-Anfrage, kein Fehler.
    expect(await generateCoverImage(recipe)).toBeUndefined();
  });
});
