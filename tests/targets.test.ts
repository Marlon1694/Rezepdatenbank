import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Notion und Mealie sind unabhängig: Fällt eines aus, landet das Rezept
 * trotzdem im anderen. Nur wenn beide scheitern, scheitert der Job.
 */

process.env.APP_TOKEN = "t";
process.env.NOTION_TOKEN = "ntn_t";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.MEALIE_URL = "http://mealie.test:9925";
process.env.MEALIE_API_TOKEN = "m";
process.env.LOG_LEVEL = "silent";

const notion = vi.fn();
const mealie = vi.fn();
const cover = vi.fn();

vi.mock("../src/notion/upsert.ts", () => ({
  upsertRecipe: (...a: unknown[]) => notion(...a),
  resolveCover: (...a: unknown[]) => cover(...a),
}));
vi.mock("../src/mealie/recipes.ts", () => ({
  upsertMealieRecipe: (...a: unknown[]) => mealie(...a),
}));

const { publishRecipe, activeTargets } = await import("../src/targets.ts");
const { resetConfigCache } = await import("../src/config.ts");
const { RecipeSchema } = await import("../src/llm/recipeSchema.ts");

const recipe = RecipeSchema.parse({
  titel: "Test",
  zutaten: [{ gruppe: "Zutaten", eintraege: [{ zutat: "Mehl" }] }],
  schritte: ["Rühren."],
});

const NOTION_OK = { pageId: "p1", pageUrl: "https://notion.so/p1", updated: false, skippedFields: [] };
const MEALIE_OK = { slug: "test", url: "http://mealie.test:9925/g/home/r/test", updated: false };

beforeEach(() => {
  notion.mockReset();
  mealie.mockReset();
  cover.mockReset().mockResolvedValue({ data: Buffer.from("x"), mimeType: "image/jpeg" });
  resetConfigCache();
});

describe("publishRecipe", () => {
  it("schreibt in beide Ziele", async () => {
    notion.mockResolvedValue(NOTION_OK);
    mealie.mockResolvedValue(MEALIE_OK);
    const r = await publishRecipe({ recipe, sourceUrl: "https://x.de" });
    expect(r.notion).toEqual(NOTION_OK);
    expect(r.mealie).toEqual(MEALIE_OK);
    expect(r.errors).toEqual({});
  });

  it("holt das Titelbild einmal und gibt es beiden", async () => {
    notion.mockResolvedValue(NOTION_OK);
    mealie.mockResolvedValue(MEALIE_OK);
    await publishRecipe({ recipe, sourceUrl: "https://x.de", thumbnailUrl: "https://cdn/x.jpg" });
    expect(cover).toHaveBeenCalledTimes(1);
    const bild = await cover.mock.results[0]!.value;
    expect(notion.mock.calls[0]![0].coverImage).toBe(bild);
    expect(mealie.mock.calls[0]![0].coverImage).toBe(bild);
  });

  it("behält Mealie, wenn Notion scheitert", async () => {
    notion.mockRejectedValue(new Error("Notion-Token abgelaufen"));
    mealie.mockResolvedValue(MEALIE_OK);
    const r = await publishRecipe({ recipe, sourceUrl: "https://x.de" });
    expect(r.mealie).toEqual(MEALIE_OK);
    expect(r.errors).toEqual({ notion: "Notion-Token abgelaufen" });
  });

  it("behält Notion, wenn Mealie scheitert", async () => {
    notion.mockResolvedValue(NOTION_OK);
    mealie.mockRejectedValue(new Error("Mealie nicht erreichbar"));
    const r = await publishRecipe({ recipe, sourceUrl: "https://x.de" });
    expect(r.notion).toEqual(NOTION_OK);
    expect(r.errors).toEqual({ mealie: "Mealie nicht erreichbar" });
  });

  it("scheitert erst, wenn beide scheitern - mit beiden Gründen", async () => {
    notion.mockRejectedValue(new Error("A"));
    mealie.mockRejectedValue(new Error("B"));
    await expect(publishRecipe({ recipe, sourceUrl: "" })).rejects.toThrow(/Notion: A\nMealie: B/);
  });

  it("schreibt beim Nachtrag nur ins fehlende Ziel", async () => {
    mealie.mockResolvedValue(MEALIE_OK);
    const r = await publishRecipe({ recipe, sourceUrl: "", only: ["mealie"] });
    expect(notion).not.toHaveBeenCalled();
    expect(r.mealie).toEqual(MEALIE_OK);
  });

  it("lässt Mealie im Probelauf aus", async () => {
    notion.mockResolvedValue(NOTION_OK);
    await publishRecipe({ recipe, sourceUrl: "", dryRun: true });
    expect(mealie).not.toHaveBeenCalled();
  });
});

describe("activeTargets", () => {
  it("richtet sich nach der .env", () => {
    expect(activeTargets()).toEqual(["notion", "mealie"]);

    process.env.NOTION_ENABLED = "false";
    resetConfigCache();
    try {
      expect(activeTargets()).toEqual(["mealie"]);
    } finally {
      delete process.env.NOTION_ENABLED;
      resetConfigCache();
    }
  });
});
