import { describe, it, expect, vi, beforeEach } from "vitest";

const keys: string[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    apiKey: string;
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
      keys.push(opts.apiKey);
    }
  },
}));

process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.LOG_LEVEL = "silent";

const { resetConfigCache } = await import("../src/config.ts");
const { getGemini, getImageClient, resetGemini } = await import("../src/llm/gemini.ts");

function mitKeys(haupt: string, bild?: string) {
  process.env.GEMINI_API_KEY = haupt;
  if (bild === undefined) delete process.env.IMAGE_API_KEY;
  else process.env.IMAGE_API_KEY = bild;
  resetConfigCache();
  resetGemini();
  keys.length = 0;
}

describe("Eigener Key für Titelbilder", () => {
  beforeEach(() => mitKeys("frei"));

  it("nimmt für Bilder den IMAGE_API_KEY und für Rezepte weiter den Haupt-Key", () => {
    mitKeys("frei", "bezahlt");
    expect((getImageClient() as unknown as { apiKey: string }).apiKey).toBe("bezahlt");
    expect((getGemini() as unknown as { apiKey: string }).apiKey).toBe("frei");
  });

  it("nimmt ohne eigenen Bild-Key den Haupt-Key für beides", () => {
    expect((getImageClient() as unknown as { apiKey: string }).apiKey).toBe("frei");
    expect(getImageClient()).toBe(getGemini());
  });
});
