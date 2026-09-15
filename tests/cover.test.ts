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

describe("explainImageError", () => {
  it("erkennt ein Kontingent von null als 'nicht enthalten'", async () => {
    const { explainImageError } = await import("../src/llm/image.ts");
    // Genau diese Antwort kam aus der Praxis: kein aufgebrauchtes Kontingent,
    // sondern von vornherein keines.
    const raw =
      '{"error":{"code":429,"message":"You exceeded your current quota. ' +
      "* Quota exceeded for metric: generate_content_free_tier_requests, " +
      'limit: 0, model: gemini-3.1-flash-image","status":"RESOURCE_EXHAUSTED"}}';
    const text = explainImageError(new Error(raw), "gemini-3.1-flash-image");
    expect(text).toContain("kein Kontingent");
    expect(text).toContain("COVER_IMAGE=false");
    expect(text).not.toContain("RESOURCE_EXHAUSTED");
  });

  it("unterscheidet das vom wirklich aufgebrauchten Kontingent", async () => {
    const { explainImageError } = await import("../src/llm/image.ts");
    const text = explainImageError(
      new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'),
      "m",
    );
    expect(text).toContain("erschöpft");
  });

  it("kürzt unbekannte Fehler, statt sie ungebremst auszuschütten", async () => {
    const { explainImageError } = await import("../src/llm/image.ts");
    const text = explainImageError(new Error("x".repeat(900)), "m");
    expect(text.length).toBeLessThan(320);
  });
});
