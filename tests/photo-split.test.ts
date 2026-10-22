import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Die Aufteilung von Ende zu Ende - mit gefaelschten Modell- und
 * Notion-Antworten, aber echtem Worker, echter Datenbank und echter Ablage.
 *
 * Genau hier lag der Fehler aus der Praxis: Eine abfotografierte Doppelseite
 * trug zwei Rezepte, angelegt wurde nur eines.
 */

const dataDir = mkdtempSync(join(tmpdir(), "rezepte-split-"));

process.env.APP_TOKEN = "t";
process.env.NOTION_TOKEN = "ntn_t";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "testkey";
process.env.LOG_LEVEL = "silent";

/* ── Das Modell ──────────────────────────────────────────────────────────── */

/** Antworten, die generateJson der Reihe nach liefert. */
let antworten: unknown[] = [];
const gesehen: Array<{ bilder: number }> = [];

vi.mock("../src/llm/gemini.ts", () => ({
  generateJson: vi.fn(async (opts: { images?: unknown[] }) => {
    gesehen.push({ bilder: opts.images?.length ?? 0 });
    if (!antworten.length) throw new Error("Keine Testantwort mehr hinterlegt.");
    return antworten.shift();
  }),
  resetGemini: () => {},
  getGemini: () => {
    throw new Error("nicht benutzt");
  },
}));

/* ── Notion ──────────────────────────────────────────────────────────────── */

const angelegteSeiten: Array<{ titel: string }> = [];

vi.mock("../src/notion/upsert.ts", () => ({
  upsertRecipe: vi.fn(async (input: { recipe: { titel: string } }) => {
    angelegteSeiten.push({ titel: input.recipe.titel });
    return {
      pageId: `page-${angelegteSeiten.length}`,
      pageUrl: `https://notion.so/page-${angelegteSeiten.length}`,
      updated: false,
      skippedFields: [],
    };
  }),
}));

vi.mock("../src/notion/client.ts", () => ({
  getDataSourceSchema: async () => ({
    dataSourceId: "ds",
    databaseTitle: "Rezeptbuch",
    properties: [{ name: "Name", type: "title", options: [] }],
  }),
  getNotion: () => {
    throw new Error("nicht benutzt");
  },
}));

const store = await import("../src/jobs/store.ts");
const { runPhotoPipeline } = await import("../src/jobs/pipeline.ts");
const { childPhotos } = await import("../src/jobs/worker.ts");
const { jobDir } = await import("../src/jobs/uploads.ts");

/** Ein Rezept, wie das Strukturier-Modell es zurueckgibt. */
function rezeptAntwort(titel: string) {
  return {
    emoji: "🍲",
    titel,
    tags: ["Schnell"],
    zeit_text: "30 Minuten",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "200 g", zutat: "Mehl" },
          { menge: "2", zutat: "Eier" },
          { menge: "250 ml", zutat: "Milch" },
        ],
      },
    ],
    schritte: ["Alles verrühren.", "In der Pfanne ausbacken."],
  };
}

function legeFotoAn(jobId: string, namen: string[]): void {
  const dir = jobDir(jobId);
  mkdirSync(dir, { recursive: true });
  for (const name of namen) writeFileSync(join(dir, name), "nicht wirklich ein Bild");
}

beforeEach(() => {
  antworten = [];
  gesehen.length = 0;
  angelegteSeiten.length = 0;
});

afterEach(() => {
  store.closeDb();
});

describe("Eine Seite mit zwei Rezepten", () => {
  it("liefert eine Aufteilung statt nur des ersten Rezepts", async () => {
    antworten = [
      {
        rezepte: [
          {
            titel: "Pfannkuchen",
            abschrift: "Pfannkuchen: 200 g Mehl, 2 Eier, 250 ml Milch. Verrühren, ausbacken.",
            art: "rezept",
            bild_indizes: [0],
            zeigt_gericht: false,
            fehlt: [],
          },
          {
            titel: "Apfelmus",
            abschrift: "Apfelmus: 1 kg Äpfel, 50 g Zucker. Schälen, kochen, pürieren.",
            art: "rezept",
            bild_indizes: [0],
            zeigt_gericht: false,
            fehlt: [],
          },
        ],
      },
    ];

    const job = store.createPhotoJob();
    legeFotoAn(job.id, ["1.jpg"]);

    const ergebnis = await runPhotoPipeline({ paths: [join(jobDir(job.id), "1.jpg")] });

    expect("split" in ergebnis).toBe(true);
    if ("split" in ergebnis) {
      expect(ergebnis.readings).toHaveLength(2);
      expect(ergebnis.readings.map((r) => r.titel)).toEqual(["Pfannkuchen", "Apfelmus"]);
    }
    // Noch keine Notion-Seite: Die entstehen erst aus den Kind-Jobs.
    expect(angelegteSeiten).toHaveLength(0);
  });

  it("macht aus der Aufteilung zwei eigenständige Rezepte in Notion", async () => {
    const eltern = store.createPhotoJob();
    legeFotoAn(eltern.id, ["1.jpg"]);
    store.queuePhotoJob(eltern.id, ["1.jpg"]);

    const readings = [
      {
        titel: "Pfannkuchen",
        abschrift: "Pfannkuchen: 200 g Mehl, 2 Eier, 250 ml Milch. Verrühren, ausbacken.",
        art: "rezept" as const,
        zeigtGericht: false,
        fehlt: [],
        bildIndizes: [0],
      },
      {
        titel: "Apfelmus",
        abschrift: "Apfelmus: 1 kg Äpfel, 50 g Zucker. Schälen, kochen, pürieren.",
        art: "rezept" as const,
        zeigtGericht: false,
        fehlt: [],
        bildIndizes: [0],
      },
    ];

    for (const reading of readings) {
      const { photos, reading: eigenes } = childPhotos(reading, ["1.jpg"]);
      store.createChildJob({
        parentId: eltern.id,
        photos,
        reading: eigenes,
        title: reading.titel,
      });
    }

    const kinder = store.childrenOf(eltern.id);
    expect(kinder).toHaveLength(2);

    // Jedes Kind strukturiert nur noch - die Bilder gehen nicht erneut ans
    // Modell, die Abschrift liegt ja schon vor.
    antworten = [rezeptAntwort("Pfannkuchen"), rezeptAntwort("Apfelmus")];
    gesehen.length = 0;

    for (const kind of kinder) {
      const ergebnis = await runPhotoPipeline({
        paths: [join(jobDir(eltern.id), "1.jpg")],
        reading: kind.reading ?? undefined,
      });
      expect("split" in ergebnis).toBe(false);
    }

    expect(angelegteSeiten.map((s) => s.titel)).toEqual(["Pfannkuchen", "Apfelmus"]);
    // Kein einziger Aufruf mit Bildern: Das wäre verschenktes Kontingent.
    expect(gesehen.every((g) => g.bilder === 0)).toBe(true);
  });
});

describe("Ein ganzes Kochbuch", () => {
  it("liest blockweise und näht Rezepte über die Blockgrenze zusammen", async () => {
    process.env.VISION_CHUNK_SIZE = "2";
    const { resetConfigCache } = await import("../src/config.ts");
    resetConfigCache();

    try {
      antworten = [
        // Block 1: Bilder 0-1
        {
          rezepte: [
            {
              titel: "Vorwort",
              abschrift: "Liebe Leserin",
              art: "sonstiges",
              bild_indizes: [0],
              zeigt_gericht: false,
              fehlt: [],
            },
            {
              titel: "Gulasch",
              abschrift: "Gulasch — Zutaten: 1 kg Rindfleisch, 500 g Zwiebeln.",
              art: "zutatenliste",
              bild_indizes: [1],
              zeigt_gericht: false,
              fehlt: ["Zubereitung"],
              geht_weiter: true,
            },
          ],
        },
        // Block 2: Bilder 2-3
        {
          rezepte: [
            {
              abschrift: "Zubereitung: Anbraten, schmoren, 2 Stunden köcheln lassen.",
              art: "rezept",
              bild_indizes: [2],
              zeigt_gericht: true,
              gericht_bild_index: 2,
              fehlt: [],
              beginnt_vorher: true,
            },
            {
              titel: "Spätzle",
              abschrift: "Spätzle: 400 g Mehl, 4 Eier. Teig schlagen, schaben, kochen.",
              art: "rezept",
              bild_indizes: [3],
              zeigt_gericht: false,
              fehlt: [],
            },
          ],
        },
      ];

      const job = store.createPhotoJob();
      const namen = ["1.jpg", "2.jpg", "3.jpg", "4.jpg"];
      legeFotoAn(job.id, namen);

      const ergebnis = await runPhotoPipeline({
        paths: namen.map((n) => join(jobDir(job.id), n)),
      });

      expect("split" in ergebnis).toBe(true);
      if (!("split" in ergebnis)) return;

      // Das Vorwort fliegt raus, Gulasch wird aus zwei Blöcken zusammengesetzt.
      expect(ergebnis.readings).toHaveLength(2);

      const gulasch = ergebnis.readings[0];
      expect(gulasch?.titel).toBe("Gulasch");
      expect(gulasch?.abschrift).toContain("Rindfleisch");
      expect(gulasch?.abschrift).toContain("schmoren");
      expect(gulasch?.bildIndizes).toEqual([1, 2]);
      // Die Lücke war mit der zweiten Hälfte gefüllt - das Rezept ist komplett.
      expect(gulasch?.art).toBe("rezept");
      expect(gulasch?.gerichtBildIndex).toBe(2);

      expect(ergebnis.readings[1]?.titel).toBe("Spätzle");

      // Zwei Blöcke à zwei Bilder, nicht vier Bilder in einer Anfrage.
      expect(gesehen).toEqual([{ bilder: 2 }, { bilder: 2 }]);
    } finally {
      delete process.env.VISION_CHUNK_SIZE;
      const { resetConfigCache } = await import("../src/config.ts");
      resetConfigCache();
    }
  });

  it("bricht ab, wenn gar kein Rezept dabei ist", async () => {
    antworten = [
      {
        rezepte: [
          {
            abschrift: "Register",
            art: "sonstiges",
            bild_indizes: [0],
            zeigt_gericht: false,
            fehlt: [],
          },
        ],
      },
    ];

    const job = store.createPhotoJob();
    legeFotoAn(job.id, ["1.jpg"]);

    await expect(
      runPhotoPipeline({ paths: [join(jobDir(job.id), "1.jpg")] }),
    ).rejects.toThrow(/kein Rezept zu erkennen/);
  });
});

afterEach(() => {
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});
