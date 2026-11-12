import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Zwei Projekte: kostenlos zuerst, bezahlt, wenn das Kontingent erschoepft ist.
 * Das Double antwortet je nach Key - "frei" kann auf Limit stehen.
 */
const aufrufe: string[] = [];
let freiAmLimit = false;

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    apiKey: string;
    models: { generateContent: () => Promise<{ text: string }> };
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
      this.models = {
        generateContent: async () => {
          aufrufe.push(this.apiKey);
          if (this.apiKey === "frei" && freiAmLimit) {
            throw Object.assign(new Error("quota"), { status: 429 });
          }
          return { text: JSON.stringify({ von: this.apiKey }) };
        },
      };
    }
  },
}));

process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.LOG_LEVEL = "silent";
process.env.GEMINI_FALLBACK_MODEL = "";

const { resetConfigCache } = await import("../src/config.ts");
const { getGemini, getImageClient, resetGemini, generateJson } = await import(
  "../src/llm/gemini.ts"
);

function mitKeys(frei: string, bezahlt?: string) {
  process.env.GEMINI_API_KEY = frei;
  if (bezahlt === undefined) delete process.env.GEMINI_PAID_API_KEY;
  else process.env.GEMINI_PAID_API_KEY = bezahlt;
  resetConfigCache();
  resetGemini();
  aufrufe.length = 0;
  freiAmLimit = false;
}

const frage = () => generateJson({ prompt: "x", schema: {} }) as Promise<{ von: string }>;
const keyVon = (c: unknown) => (c as { apiKey: string }).apiKey;

describe("Kostenloses und bezahltes Projekt", () => {
  beforeEach(() => mitKeys("frei", "bezahlt"));

  it("nimmt zuerst den kostenlosen Key", async () => {
    expect((await frage()).von).toBe("frei");
    expect(aufrufe).toEqual(["frei"]);
  });

  it("wechselt bei erschöpftem Kontingent sofort auf den bezahlten", async () => {
    freiAmLimit = true;
    expect((await frage()).von).toBe("bezahlt");
    // Ein Versuch beim freien, keine Wartezeit, dann der bezahlte.
    expect(aufrufe).toEqual(["frei", "bezahlt"]);
  });

  it("lässt den kostenlosen danach eine Weile in Ruhe", async () => {
    freiAmLimit = true;
    await frage();
    aufrufe.length = 0;
    expect((await frage()).von).toBe("bezahlt");
    expect(aufrufe).toEqual(["bezahlt"]);
  });

  it("schickt Titelbilder immer über den bezahlten Key", () => {
    expect(keyVon(getImageClient())).toBe("bezahlt");
    expect(keyVon(getGemini())).toBe("frei");
  });
});

describe("Nur kostenloser Key", () => {
  beforeEach(() => mitKeys("frei"));

  it("nimmt ihn für alles, auch für Titelbilder", async () => {
    expect((await frage()).von).toBe("frei");
    expect(getImageClient()).toBe(getGemini());
  });

  it("meldet das erschöpfte Kontingent mit Hinweis auf den bezahlten Key", async () => {
    freiAmLimit = true;
    vi.useFakeTimers();
    const p = frage().catch((e: Error) => e.message);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await p).toMatch(/GEMINI_PAID_API_KEY/);
  });
});
