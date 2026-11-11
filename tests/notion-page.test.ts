import { describe, it, expect } from "vitest";
import {
  recipeFromNotionPage,
  splitIngredient,
  type NotionBlock,
} from "../src/migrate/notionPage.ts";
import { buildRecipeBlocks } from "../src/notion/blocks.ts";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";

/** Notion liefert Text als rich_text mit plain_text - die App schreibt ihn als text.content. */
function alsNotionAntwort(blocks: Record<string, unknown>[]): NotionBlock[] {
  return blocks.map((b): NotionBlock => {
    const type = b.type as string;
    const inner = b[type] as { rich_text?: { text: { content: string } }[] };
    return {
      ...b,
      type,
      [type]: {
        ...inner,
        rich_text: (inner.rich_text ?? []).map((t) => ({ plain_text: t.text.content })),
      },
    };
  });
}

const titel = (t: string) => ({ type: "title", title: [{ plain_text: t }] });
const FIELDS = { titel: "Name", tags: "Tags", quelle: "Quelle", zeit: "Zeit" };

describe("recipeFromNotionPage", () => {
  it("liest eine Seite zurück, die die App selbst geschrieben hat", () => {
    // Rundreise: Was die App nach Notion schreibt, muss sich verlustarm
    // wieder lesen lassen - sonst taugt die Übernahme nach Mealie nichts.
    const original = RecipeSchema.parse({
      titel: "Pilzpasta",
      zeit_text: "25 Minuten",
      zutaten: [
        { gruppe: "Nudeln", eintraege: [{ menge: "200 g", zutat: "Pasta" }, { zutat: "Salz" }] },
        { gruppe: "Soße", eintraege: [{ menge: "100 ml", zutat: "Sahne" }] },
      ],
      schritte: ["Pasta kochen.", "Soße rühren."],
      pro_tipp: "Nudelwasser aufheben.",
    });
    const blocks = alsNotionAntwort(
      buildRecipeBlocks(original, {
        sourceUrl: "https://x.de/p",
        transcript: "Langes Transkript …",
        hasTimeProperty: true,
      }),
    );

    const r = recipeFromNotionPage(
      {
        properties: {
          Name: titel("Pilzpasta"),
          Tags: { type: "multi_select", multi_select: [{ name: "#Schnell" }] },
          Quelle: { type: "url", url: "https://x.de/p" },
          Zeit: { type: "number", number: 25 },
        },
        icon: { type: "emoji", emoji: "🍝" },
        blocks,
      },
      FIELDS,
    );

    if ("reason" in r) throw new Error(r.reason);
    expect(r.sourceUrl).toBe("https://x.de/p");
    expect(r.recipe.emoji).toBe("🍝");
    expect(r.recipe.tags).toEqual(["Schnell"]);
    expect(r.recipe.zeit_minuten).toBe(25);
    expect(r.recipe.zutaten).toEqual([
      {
        gruppe: "Nudeln",
        eintraege: [
          { menge: "200 g", zutat: "Pasta" },
          { menge: null, zutat: "Salz" },
        ],
      },
      { gruppe: "Soße", eintraege: [{ menge: "100 ml", zutat: "Sahne" }] },
    ]);
    expect(r.recipe.schritte).toEqual(["Pasta kochen.", "Soße rühren."]);
    expect(r.recipe.pro_tipp).toBe("Nudelwasser aufheben.");
  });

  it("versteht eine von Hand angelegte Seite", () => {
    const p = (type: string, text: string) => ({
      type,
      [type]: { rich_text: [{ plain_text: text }] },
    });
    const r = recipeFromNotionPage(
      {
        properties: { Name: titel("Omas Gulasch") },
        blocks: [
          p("paragraph", "Das beste Gulasch der Welt."),
          p("heading_3", "Zutaten:"),
          p("bulleted_list_item", "1 kg Rindfleisch"),
          p("bulleted_list_item", "3 Zwiebeln"),
          p("bulleted_list_item", "Paprikapulver"),
          p("heading_3", "So geht's"),
          p("paragraph", "Fleisch anbraten."),
          p("paragraph", "Zwei Stunden schmoren."),
        ],
      },
      FIELDS,
    );
    if ("reason" in r) throw new Error(r.reason);
    expect(r.recipe.zutaten[0]!.eintraege).toEqual([
      { menge: "1 kg", zutat: "Rindfleisch" },
      { menge: "3", zutat: "Zwiebeln" },
      { menge: null, zutat: "Paprikapulver" },
    ]);
    // Die Einleitung vor den Zutaten gehört nicht zur Anleitung.
    expect(r.recipe.schritte).toEqual(["Fleisch anbraten.", "Zwei Stunden schmoren."]);
    expect(r.sourceUrl).toBe("");
  });

  it("lehnt eine Seite ohne Rezept mit Grund ab", () => {
    const r = recipeFromNotionPage(
      { properties: { Name: titel("Einkaufsideen") }, blocks: [] },
      FIELDS,
    );
    expect(r).toEqual({ reason: "keine Zutaten gefunden" });
  });
});

describe("splitIngredient", () => {
  it.each([
    ["200 g Mehl", "200 g", "Mehl"],
    ["1,5 l Brühe", "1,5 l", "Brühe"],
    ["2 EL Öl", "2 EL", "Öl"],
    ["½ TL Salz", "½ TL", "Salz"],
    ["2-3 Zehen Knoblauch", "2-3 Zehen", "Knoblauch"],
    ["3 Zwiebeln", "3", "Zwiebeln"],
    ["ca. 100 g Butter", "ca. 100 g", "Butter"],
  ])("%s", (text, menge, zutat) => {
    expect(splitIngredient(text)).toEqual({ menge, zutat });
  });

  it("lässt Text ohne Zahl am Anfang zusammen", () => {
    expect(splitIngredient("Salz und Pfeffer")).toEqual({ menge: null, zutat: "Salz und Pfeffer" });
    // "g" mitten im Wort ist keine Einheit.
    expect(splitIngredient("2 gelbe Paprika")).toEqual({ menge: "2", zutat: "gelbe Paprika" });
  });
});
