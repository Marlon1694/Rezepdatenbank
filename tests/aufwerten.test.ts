import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";

const updates: { block_id: string; [k: string]: unknown }[] = [];
let seitenBloecke: unknown[] = [];

vi.mock("../src/notion/client.ts", () => ({
  getNotion: () => ({
    blocks: {
      children: {
        list: vi.fn(async () => ({ results: seitenBloecke, has_more: false, next_cursor: null })),
      },
      update: vi.fn(async (args: { block_id: string }) => {
        updates.push(args);
        return {};
      }),
    },
  }),
}));

const { needsEnrichment, mergeEnrichment, enrichPrompt } = await import("../src/llm/enrich.ts");
const { withoutStepLine, withStepLine, addStepLinesToPage } = await import("../src/notion/stepLines.ts");

/** Ein Rezept, wie es vor den zerlegten Zutaten gespeichert wurde. */
const altesRezept = () =>
  RecipeSchema.parse({
    titel: "Pfannkuchen",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "200 g", zutat: "Mehl" },
          { menge: "2", zutat: "Eier" },
          { menge: "1 Prise", zutat: "Salz" },
        ],
      },
    ],
    schritte: ["Mehl, Eier und Salz verrühren.", "Ruhen lassen.", "Ausbacken."],
  });

describe("needsEnrichment", () => {
  it("erkennt alte Rezepte", () => {
    expect(needsEnrichment(altesRezept())).toBe(true);
  });

  it("lässt aufgewertete Rezepte in Ruhe - ein zweiter Lauf fragt die KI nicht noch einmal", () => {
    const r = mergeEnrichment(altesRezept(), {
      zutaten: [{ nr: 1, anzahl: 200, einheit: "g", lebensmittel: "Mehl" }],
      schritte: [{ schritt: 1, zutaten: [1] }],
    });
    expect(needsEnrichment(r)).toBe(false);
  });
});

describe("mergeEnrichment", () => {
  it("ergänzt die Felder und lässt die Texte unverändert", () => {
    const vorher = altesRezept();
    const r = mergeEnrichment(vorher, {
      zutaten: [
        { nr: 1, anzahl: 200, einheit: "g", lebensmittel: "Mehl" },
        { nr: 2, anzahl: 2, lebensmittel: "Ei" },
        { nr: 3, einheit: "Prise", lebensmittel: "Salz" },
      ],
      schritte: [
        { schritt: 1, zutaten: [1, 2, 3] },
        { schritt: 2, zutaten: [] },
      ],
    });

    const e = r.zutaten[0]!.eintraege;
    expect(e.map((z) => [z.menge, z.zutat])).toEqual(
      vorher.zutaten[0]!.eintraege.map((z) => [z.menge, z.zutat]),
    );
    expect(r.schritte).toEqual(vorher.schritte);
    expect(r.titel).toBe(vorher.titel);
    expect(e[1]).toMatchObject({ anzahl: 2, einheit: null, lebensmittel: "Ei" });
    expect(e[2]).toMatchObject({ anzahl: null, einheit: "Prise" });
    // Schritt 3 fehlte in der Antwort - er bekommt eine leere Liste, kein Raten.
    expect(r.schritte_zutaten).toEqual([["Mehl", "Eier", "Salz"], [], []]);
  });

  it("verwirft unsinnige Nummern und Mengen", () => {
    const r = mergeEnrichment(altesRezept(), {
      zutaten: [
        { nr: 0, lebensmittel: "falsch" },
        { nr: 9, lebensmittel: "falsch" },
        { nr: 1.5, lebensmittel: "falsch" },
        { nr: 1, anzahl: -3, lebensmittel: "  " },
      ],
      schritte: [
        { schritt: 7, zutaten: [1] },
        { schritt: 1, zutaten: [42, "1", 2] },
      ],
    });
    const e = r.zutaten[0]!.eintraege;
    expect(e.every((z) => !z.lebensmittel && !z.anzahl)).toBe(true);
    expect(r.schritte_zutaten).toEqual([["Eier"], [], []]);
  });

  it("überschreibt nichts, was schon da ist", () => {
    const vorher = RecipeSchema.parse({
      titel: "X",
      zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "1 kg", zutat: "Kartoffeln", anzahl: 1, einheit: "kg", lebensmittel: "Kartoffel" }] }],
      schritte: ["Kochen."],
    });
    const r = mergeEnrichment(vorher, {
      zutaten: [{ nr: 1, anzahl: 1000, einheit: "g", lebensmittel: "Erdapfel" }],
      schritte: [],
    });
    expect(r.zutaten[0]!.eintraege[0]).toMatchObject({ anzahl: 1, einheit: "kg", lebensmittel: "Kartoffel" });
  });

  it("behält die alte Zuordnung, wenn die Antwort keine liefert", () => {
    const r = mergeEnrichment({ ...altesRezept(), schritte_zutaten: [["Mehl"], [], []] }, {});
    expect(r.schritte_zutaten).toEqual([["Mehl"], [], []]);
  });
});

describe("enrichPrompt", () => {
  it("nummeriert Zutaten und Schritte, damit die Antwort nur Nummern braucht", () => {
    const p = enrichPrompt(altesRezept());
    expect(p).toContain("1. 200 g Mehl");
    expect(p).toContain("3. 1 Prise Salz");
    expect(p).toContain("2. Ruhen lassen.");
  });
});

describe("Zutatenzeile im Notion-Schritt", () => {
  const ausNotion = (content: string, extra: Record<string, unknown> = {}) => ({
    type: "text",
    text: { content, link: null },
    plain_text: content,
    href: null,
    annotations: { bold: false, italic: false, color: "default" },
    ...extra,
  });

  it("entfernt eine vorhandene Zeile und die nur lesbaren Felder", () => {
    const out = withoutStepLine([
      ausNotion("Mehl verrühren."),
      ausNotion("\n↳ 200 g Mehl", { annotations: { italic: true, color: "gray" } }),
    ]);
    expect(out).toEqual([
      { type: "text", text: { content: "Mehl verrühren.", link: null }, annotations: { bold: false, italic: false, color: "default" } },
    ]);
  });

  it("schneidet auch eine Zeile ab, die in Notion mit dem Schritt verschmolzen ist", () => {
    const out = withoutStepLine([ausNotion("Mehl verrühren.\n↳ 200 g Mehl")]);
    expect(out.map((t) => t.text?.content)).toEqual(["Mehl verrühren."]);
  });

  it("hängt die neue Zeile grau und kursiv an und behält Formatierung davor", () => {
    const out = withStepLine([ausNotion("Mehl", { annotations: { bold: true } }), ausNotion(" verrühren.")], "200 g Mehl");
    expect(out).toHaveLength(3);
    expect(out[0]!.annotations).toEqual({ bold: true });
    expect(out[2]).toEqual({
      type: "text",
      text: { content: "\n↳ 200 g Mehl" },
      annotations: { color: "gray", italic: true },
    });
  });
});

describe("addStepLinesToPage", () => {
  const schritt = (id: string, content: string) => ({
    id,
    type: "numbered_list_item",
    numbered_list_item: { rich_text: [{ type: "text", text: { content }, plain_text: content }] },
  });
  const ueberschrift = (t: string) => ({
    id: `h-${t}`,
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: t }, plain_text: t }] },
  });

  const aufgewertet = () =>
    mergeEnrichment(altesRezept(), {
      zutaten: [{ nr: 1, anzahl: 200, einheit: "g", lebensmittel: "Mehl" }],
      schritte: [{ schritt: 1, zutaten: [1, 2] }, { schritt: 3, zutaten: [] }],
    });

  beforeEach(() => {
    updates.length = 0;
  });

  it("ergänzt nur die Schritte mit Zutaten und fasst den Rest der Seite nicht an", async () => {
    seitenBloecke = [
      ueberschrift("Zutaten"),
      { id: "z1", type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: "200 g Mehl" }, plain_text: "200 g Mehl" }] } },
      ueberschrift("Zubereitung"),
      schritt("s1", "Mehl, Eier und Salz verrühren."),
      schritt("s2", "Ruhen lassen."),
      schritt("s3", "Ausbacken."),
      { id: "notiz", type: "paragraph", paragraph: { rich_text: [] } },
    ];
    const r = await addStepLinesToPage("seite", aufgewertet());
    expect(r).toEqual({ ok: true, geaendert: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.block_id).toBe("s1");
    const rt = (updates[0]!.numbered_list_item as { rich_text: { text: { content: string } }[] }).rich_text;
    expect(rt.map((t) => t.text.content)).toEqual(["Mehl, Eier und Salz verrühren.", "\n↳ 200 g Mehl · 2 Eier"]);
  });

  it("lässt die Seite unverändert, wenn die Schritte nicht zusammenpassen", async () => {
    seitenBloecke = [ueberschrift("Zubereitung"), schritt("s1", "Alles in einem Schritt.")];
    const r = await addStepLinesToPage("seite", aufgewertet());
    expect(r).toEqual({ ok: false, reason: "Notion hat 1 Schritte, das Rezept 3" });
    expect(updates).toHaveLength(0);
  });
});

describe("Zweiter Lauf über Notion-Seiten", () => {
  it("erkennt eine schon ergänzte Seite an ihren Zutatenzeilen", async () => {
    const { recipeFromNotionPage } = await import("../src/migrate/notionPage.ts");
    const rt = (content: string) => [{ type: "text", text: { content }, plain_text: content }];
    const seite = (schrittText: string) => ({
      properties: { Name: { type: "title", title: rt("Pfannkuchen") } },
      blocks: [
        { type: "heading_2", heading_2: { rich_text: rt("Zutaten") } },
        { type: "to_do", to_do: { rich_text: rt("200 g Mehl") } },
        { type: "heading_2", heading_2: { rich_text: rt("Zubereitung") } },
        { type: "numbered_list_item", numbered_list_item: { rich_text: rt(schrittText) } },
      ],
    });
    const vorher = recipeFromNotionPage(seite("Verrühren."), { titel: "Name" });
    const nachher = recipeFromNotionPage(seite("Verrühren.\n↳ 200 g Mehl"), { titel: "Name" });
    expect("recipe" in vorher && vorher.mitZutatenzeilen).toBe(false);
    expect("recipe" in nachher && nachher.mitZutatenzeilen).toBe(true);
    // Der Schritt selbst bleibt ohne die Zeile.
    expect("recipe" in nachher && nachher.recipe.schritte).toEqual(["Verrühren."]);
  });
});
