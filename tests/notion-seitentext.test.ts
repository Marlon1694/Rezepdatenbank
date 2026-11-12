import { describe, it, expect } from "vitest";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";
import {
  pageText,
  notionMeta,
  withNotionMeta,
  titelOhneEmoji,
  recipeFromNotionPage,
  type NotionBlock,
} from "../src/migrate/notionPage.ts";

const rt = (content: string, color = "default") => [
  { type: "text", text: { content }, plain_text: content, annotations: { color } },
];
const block = (type: string, content: string, color?: string): NotionBlock => ({
  type,
  [type]: { rich_text: rt(content, color) },
});

/** So sieht eine Vorlagenseite aus, nachdem der KI-Block in Text umgewandelt wurde. */
const seite: NotionBlock[] = [
  block("heading_1", "Zutaten & Zubereitung"),
  block("paragraph", "Nutze den KI-Block, um Rezepte nach deinem Geschmack zu entwickeln.", "gray"),
  block("paragraph", "**Zutaten für 4 Personen:**"),
  block("bulleted_list_item", "500 g Spaghetti"),
  block("bulleted_list_item", "150 g Guanciale"),
  block("paragraph", "**Zubereitung:**"),
  block("numbered_list_item", "Guanciale knusprig braten."),
  block("numbered_list_item", "Pasta kochen und mit Ei und Pecorino vermengen."),
  block("paragraph", "↓ Alternativ kannst du unten einen Link zu einem Rezept einbetten.", "gray"),
  block("heading_1", "Verbesserungen für das nächste Mal"),
  block("bulleted_list_item", "Weniger Salz ins Nudelwasser"),
  block("paragraph", "Wenn du dieses Rezept mit anderen teilen möchtest …", "gray"),
];

describe("Vorlagenseite ohne eigene Überschriften", () => {
  it("findet der Parser nicht - deshalb der Weg über die KI", () => {
    const r = recipeFromNotionPage(
      { properties: { Name: { type: "title", title: rt("🍝 Carbonara") } }, blocks: seite },
      { titel: "Name" },
    );
    expect("reason" in r).toBe(true);
  });

  it("liefert der KI den Rezepttext ohne Vorlagenhinweise und ohne deine Notizen", () => {
    const text = pageText(seite);
    expect(text).toContain("- 500 g Spaghetti");
    expect(text).toContain("1. Guanciale knusprig braten.");
    expect(text).toContain("**Zubereitung:**");
    expect(text).not.toMatch(/KI-Block|Alternativ|teilen möchtest/);
    expect(text).not.toContain("Weniger Salz");
  });
});

describe("Spalten der Seite gehen vor", () => {
  const properties = {
    Name: { type: "title", title: rt("🍝 Original Spaghetti alla Carbonara") },
    Kategorien: { type: "multi_select", multi_select: [{ name: "Pasta" }, { name: "Schnell" }] },
    Kochzeit: { type: "rich_text", rich_text: rt("25") },
    Schwierigkeitsgrad: { type: "select", select: { name: "Leicht" } },
  };
  const meta = notionMeta(
    { properties, icon: { type: "emoji", emoji: "🥄" } },
    { titel: "Name", tags: "Kategorien", zeit: "Kochzeit", schwierigkeit: "Schwierigkeitsgrad" },
  );
  const vonDerKi = RecipeSchema.parse({
    titel: "Spaghetti Carbonara",
    tags: ["Italienisch", "Pasta"],
    zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "500 g", zutat: "Spaghetti" }] }],
    schritte: ["Kochen."],
    schwierigkeit: "Mittel",
  });

  it("übernimmt Titel ohne Emoji, Tags, Zeit und Schwierigkeit aus Notion", () => {
    const r = withNotionMeta(vonDerKi, meta);
    expect(r.titel).toBe("Original Spaghetti alla Carbonara");
    expect(r.emoji).toBe("🍝");
    expect(r.tags).toEqual(["Pasta", "Schnell", "Italienisch"]);
    expect(r.zeit_minuten).toBe(25);
    expect(r.schwierigkeit).toBe("Leicht");
    // Der Inhalt bleibt, wie die KI ihn gelesen hat.
    expect(r.zutaten).toEqual(vonDerKi.zutaten);
  });

  it("entfernt Emojis aus dem Titel, auch am Ende", () => {
    expect(titelOhneEmoji("No Knead Baguette 🥖")).toBe("No Knead Baguette");
    expect(titelOhneEmoji("🥧 Shepherd's Pie")).toBe("Shepherd's Pie");
  });
});
