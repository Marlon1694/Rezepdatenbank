import { describe, it, expect } from "vitest";
import { buildRecipeBlocks, chunkBlocks, chunkText } from "../src/notion/blocks.ts";
import type { Recipe } from "../src/llm/recipeSchema.ts";

const base: Recipe = {
  emoji: "🍝",
  titel: "Pilzpasta",
  tags: ["Schnell"],
  zeit_text: "ca. 25 Minuten",
  zeit_minuten: 25,
  zutaten: [
    {
      gruppe: "Hauptzutaten",
      eintraege: [
        { menge: "200 g", zutat: "Pasta" },
        { menge: null, zutat: "Salz" },
      ],
    },
    { gruppe: "Für die Soße", eintraege: [{ menge: "100 ml", zutat: "Sahne" }] },
  ],
  schritte: ["Pasta kochen.", "Soße rühren."],
  pro_tipp: "Nudelwasser aufheben.",
  portionen: null,
  kueche: null,
};

const opts = { sourceUrl: "https://youtu.be/abc", sourceTitle: "Beste Pasta" };

function typesOf(blocks: Array<Record<string, unknown>>): string[] {
  return blocks.map((b) => b.type as string);
}

describe("buildRecipeBlocks", () => {
  it("macht aus jeder Zutat einen echten to_do-Block zum Abhaken", () => {
    const blocks = buildRecipeBlocks(base, opts);
    const todos = blocks.filter((b) => b.type === "to_do");
    expect(todos).toHaveLength(3);

    const first = todos[0] as { to_do: { rich_text: Array<{ text: { content: string } }>; checked: boolean } };
    expect(first.to_do.rich_text[0]?.text.content).toBe("200 g Pasta");
    expect(first.to_do.checked).toBe(false);
  });

  it("lässt die Menge weg, wenn keine genannt wurde", () => {
    const blocks = buildRecipeBlocks(base, opts);
    const todos = blocks.filter((b) => b.type === "to_do");
    const salz = todos[1] as { to_do: { rich_text: Array<{ text: { content: string } }> } };
    expect(salz.to_do.rich_text[0]?.text.content).toBe("Salz");
  });

  it("setzt für jede Zutatengruppe eine Zwischenüberschrift", () => {
    const types = typesOf(buildRecipeBlocks(base, opts));
    expect(types.filter((t) => t === "heading_3")).toHaveLength(2);
  });

  it("unterdrückt die Zwischenüberschrift bei einer einzigen generischen Gruppe", () => {
    // "Zutaten" über einer Liste unter der Überschrift "Zutaten" wäre reines Rauschen.
    const simple: Recipe = {
      ...base,
      zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "1", zutat: "Ei" }] }],
    };
    expect(typesOf(buildRecipeBlocks(simple, opts))).not.toContain("heading_3");
  });

  it("nummeriert die Schritte über Notion-Blöcke statt im Text", () => {
    const blocks = buildRecipeBlocks(base, opts);
    const steps = blocks.filter((b) => b.type === "numbered_list_item");
    expect(steps).toHaveLength(2);
    const first = steps[0] as { numbered_list_item: { rich_text: Array<{ text: { content: string } }> } };
    expect(first.numbered_list_item.rich_text[0]?.text.content).toBe("Pasta kochen.");
  });

  it("legt Quelle und Pro-Tipp als Callouts an", () => {
    const callouts = buildRecipeBlocks(base, opts).filter((b) => b.type === "callout");
    expect(callouts).toHaveLength(2);
    const emojis = callouts.map(
      (c) => (c as { callout: { icon: { emoji: string } } }).callout.icon.emoji,
    );
    expect(emojis).toEqual(["🔗", "💡"]);
  });

  it("lässt den Pro-Tipp weg, wenn keiner gefunden wurde", () => {
    const blocks = buildRecipeBlocks({ ...base, pro_tipp: "  " }, opts);
    expect(blocks.filter((b) => b.type === "callout")).toHaveLength(1);
  });

  it("verlinkt die Quelle mit dem Videotitel", () => {
    const callout = buildRecipeBlocks(base, opts)[0] as {
      callout: { rich_text: Array<{ text: { content: string; link: { url: string } } }> };
    };
    expect(callout.callout.rich_text[0]?.text.content).toBe("Beste Pasta");
    expect(callout.callout.rich_text[0]?.text.link.url).toBe("https://youtu.be/abc");
  });

  it("packt das Transkript zugeklappt ans Ende", () => {
    const blocks = buildRecipeBlocks(base, {
      ...opts,
      transcript: "Heute machen wir Pasta.",
      transcriptSource: "Auto-Untertitel",
    });
    const toggle = blocks.find((b) => b.type === "toggle") as
      | { toggle: { rich_text: Array<{ text: { content: string } }>; children: unknown[] } }
      | undefined;
    expect(toggle).toBeDefined();
    expect(toggle?.toggle.rich_text[0]?.text.content).toBe("Original-Transkript (Auto-Untertitel)");
    expect(toggle?.toggle.children).toHaveLength(1);
  });

  it("kommt ohne Transkript aus", () => {
    expect(typesOf(buildRecipeBlocks(base, opts))).not.toContain("toggle");
  });
});

describe("chunkText", () => {
  it("lässt Text unter dem Limit in einem Stück", () => {
    expect(chunkText("kurz")).toEqual(["kurz"]);
  });

  it("teilt langen Text an Satzgrenzen statt mitten im Wort", () => {
    const text = `${"Satz eins. ".repeat(300)}Ende.`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    // Zusammengesetzt darf nichts fehlen.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("Ende.");
  });

  it("liefert bei leerem Text nichts", () => {
    expect(chunkText("")).toEqual([]);
  });
});

describe("chunkBlocks", () => {
  it("teilt in Pakete von höchstens 100 Blöcken", () => {
    // Notion nimmt pro Aufruf nicht mehr an - ein langes Rezept muss sonst scheitern.
    const many = Array.from({ length: 250 }, () => ({ type: "paragraph" }));
    const batches = chunkBlocks(many);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("lässt kurze Rezepte in einem Paket", () => {
    expect(chunkBlocks([{ type: "paragraph" }])).toHaveLength(1);
  });
});
