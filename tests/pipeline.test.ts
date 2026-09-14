import { describe, it, expect } from "vitest";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";
import { buildProperties } from "../src/notion/mapper.ts";
import { buildRecipeBlocks } from "../src/notion/blocks.ts";
import type { DataSourceSchema } from "../src/notion/client.ts";

/**
 * Der Weg vom Modell-JSON bis zum fertigen Notion-Payload - ohne Netzwerk.
 * Damit ist die gesamte Kette ueberprueft, die deinem Prompt-Schema entspricht.
 */

// So antwortet Gemini: optionale Felder fehlen einfach, statt null zu sein.
const MODEL_RESPONSE = {
  emoji: "🍜",
  titel: "Schnelle Erdnuss-Nudeln",
  tags: ["schnell", "#Vegetarisch", "Asiatisch"],
  zeit_text: "ca. 20 Minuten",
  zeit_minuten: 20,
  zutaten: [
    {
      gruppe: "Hauptzutaten",
      eintraege: [
        { menge: "250 g", zutat: "Mie-Nudeln" },
        { zutat: "1 Frühlingszwiebel" },
      ],
    },
    {
      gruppe: "Für die Soße",
      eintraege: [
        { menge: "3 EL", zutat: "Erdnussbutter" },
        { menge: "1 cup (ca. 240 ml)", zutat: "Kokosmilch" },
      ],
    },
  ],
  schritte: ["Nudeln nach Packung kochen.", "Soße verrühren.", "Alles vermengen."],
  pro_tipp: "Ein Spritzer Limette hebt die Süße auf.",
};

const schema: DataSourceSchema = {
  dataSourceId: "ds-1",
  databaseTitle: "Rezepte",
  properties: [
    { name: "Name", type: "title", options: [] },
    { name: "Tags", type: "multi_select", options: ["Schnell", "Asiatisch"] },
    { name: "Zubereitungszeit", type: "rich_text", options: [] },
    { name: "Quelle", type: "url", options: [] },
  ],
};

describe("Modell-Antwort → Notion", () => {
  it("nimmt eine Antwort mit fehlenden Optionalfeldern an", () => {
    const parsed = RecipeSchema.safeParse(MODEL_RESPONSE);
    expect(parsed.success).toBe(true);

    const recipe = parsed.data!;
    // Fehlende "menge" wird zu null, nicht zu undefined - blocks.ts verlässt sich darauf.
    expect(recipe.zutaten[0]!.eintraege[1]!.menge).toBeNull();
    expect(recipe.portionen).toBeNull();
    expect(recipe.pro_tipp).toBe("Ein Spritzer Limette hebt die Süße auf.");
  });

  it("lehnt eine Antwort ohne Schritte ab, statt eine leere Seite anzulegen", () => {
    const { schritte, ...ohneSchritte } = MODEL_RESPONSE;
    expect(RecipeSchema.safeParse(ohneSchritte).success).toBe(false);
  });

  it("baut Properties nach deinem Schema", () => {
    const recipe = RecipeSchema.parse(MODEL_RESPONSE);
    const { properties } = buildProperties(recipe, schema, {
      sourceUrl: "https://www.tiktok.com/@koch/video/123",
      tagsWithHash: false,
    });

    expect(properties.Name).toEqual({
      title: [{ type: "text", text: { content: "🍜 Schnelle Erdnuss-Nudeln" } }],
    });
    // "schnell" trifft auf "Schnell", "#Vegetarisch" wird zu "Vegetarisch" (neu).
    expect(properties.Tags).toEqual({
      multi_select: [{ name: "Schnell" }, { name: "Vegetarisch" }, { name: "Asiatisch" }],
    });
    expect(properties.Quelle).toEqual({ url: "https://www.tiktok.com/@koch/video/123" });
  });

  it("ergibt eine Notion-Seite mit allen sechs Bestandteilen deines Prompts", () => {
    const recipe = RecipeSchema.parse(MODEL_RESPONSE);
    const blocks = buildRecipeBlocks(recipe, {
      sourceUrl: "https://www.tiktok.com/@koch/video/123",
      sourceTitle: "Peanut Noodles in 20 min",
      transcript: "Today we make peanut noodles.",
      transcriptSource: "Auto-Untertitel",
    });
    const types = blocks.map((b) => b.type);

    expect(types.filter((t) => t === "to_do")).toHaveLength(4);          // 4 Zutaten
    expect(types.filter((t) => t === "numbered_list_item")).toHaveLength(3); // 3 Schritte
    expect(types.filter((t) => t === "heading_3")).toHaveLength(2);      // 2 Gruppen
    expect(types).toContain("callout");                                   // Quelle + Pro-Tipp
    expect(types).toContain("toggle");                                    // Transkript

    // Die Umrechnung aus dem Prompt bleibt im Zutatentext erhalten.
    const texte = blocks
      .filter((b) => b.type === "to_do")
      .map((b) => (b as { to_do: { rich_text: Array<{ text: { content: string } }> } })
        .to_do.rich_text[0]?.text.content);
    expect(texte).toContain("1 cup (ca. 240 ml) Kokosmilch");
    expect(texte).toContain("1 Frühlingszwiebel");
  });
});
