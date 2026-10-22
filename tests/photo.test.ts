import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.APP_TOKEN ??= "t";
process.env.NOTION_TOKEN ??= "ntn_t";
process.env.NOTION_DATABASE_ID ??= "0".repeat(32);

const { normalizeChunk, stitchChunks, usableReadings, modeFor } =
  await import("../src/extract/photo.ts");
const { mimeForFile } = await import("../src/lib/images.ts");
const { buildModeSection } = await import("../src/llm/prompt.ts");
const { checkPhoto } = await import("../src/jobs/uploads.ts");
const { resetConfigCache } = await import("../src/config.ts");

describe("normalizeChunk", () => {
  const eines = (r: Record<string, unknown>) => ({ rezepte: [r] });

  it("übernimmt eine vollständige Antwort", () => {
    const [r] = normalizeChunk(
      eines({
        abschrift: "  Pfannkuchen\n200 g Mehl  ",
        art: "rezept",
        bild_indizes: [0, 1],
        zeigt_gericht: true,
        gericht_bild_index: 1,
        titel: " Pfannkuchen ",
        fehlt: [],
      }),
      0,
      2,
    );
    expect(r?.abschrift).toBe("Pfannkuchen\n200 g Mehl");
    expect(r?.art).toBe("rezept");
    expect(r?.zeigtGericht).toBe(true);
    expect(r?.gerichtBildIndex).toBe(1);
    expect(r?.titel).toBe("Pfannkuchen");
    expect(r?.bildIndizes).toEqual([0, 1]);
  });

  it("findet mehrere Rezepte auf einer Doppelseite", () => {
    // Genau der Fall aus der Praxis: ein Bild, zwei Rezepte darauf.
    const rezepte = normalizeChunk(
      {
        rezepte: [
          { abschrift: "Pfannkuchen …", art: "rezept", bild_indizes: [0], zeigt_gericht: false, fehlt: [] },
          { abschrift: "Apfelmus …", art: "rezept", bild_indizes: [0], zeigt_gericht: false, fehlt: [] },
        ],
      },
      0,
      1,
    );
    expect(rezepte).toHaveLength(2);
    expect(rezepte.map((r) => r.abschrift)).toEqual(["Pfannkuchen …", "Apfelmus …"]);
  });

  it("verwirft einen Bildindex, den es in diesem Block gar nicht gibt", () => {
    // Zeigt das Modell auf Bild 5, obwohl der Block nur 0 und 1 enthält, wäre
    // jede Zuordnung geraten. Dann lieber der ganze Block als Rückfallebene.
    const [r] = normalizeChunk(
      eines({ abschrift: "x", art: "rezept", bild_indizes: [5], zeigt_gericht: false, fehlt: [] }),
      0,
      2,
    );
    expect(r?.bildIndizes).toEqual([0, 1]);
  });

  it("gibt kein Titelbild aus einem fremden Rezept", () => {
    // Das Gerichtsbild muss zu DIESEM Rezept gehören - sonst bekäme das eine
    // Rezept das Foto des anderen auf die Notion-Seite.
    const [r] = normalizeChunk(
      eines({
        abschrift: "x",
        art: "rezept",
        bild_indizes: [0],
        zeigt_gericht: true,
        gericht_bild_index: 1,
        fehlt: [],
      }),
      0,
      2,
    );
    expect(r?.zeigtGericht).toBe(false);
    expect(r?.gerichtBildIndex).toBeUndefined();
  });

  it("rechnet mit dem Versatz späterer Blöcke", () => {
    const [r] = normalizeChunk(
      eines({ abschrift: "x", art: "rezept", bild_indizes: [4, 5], zeigt_gericht: false, fehlt: [] }),
      4,
      2,
    );
    expect(r?.bildIndizes).toEqual([4, 5]);
  });

  it("verträgt fehlende und falsch getypte Felder", () => {
    expect(normalizeChunk({}, 0, 1)).toEqual([]);
    expect(normalizeChunk({ rezepte: "kaputt" }, 0, 1)).toEqual([]);
    expect(normalizeChunk({ rezepte: [null, 7] }, 0, 1)).toEqual([]);

    const [r] = normalizeChunk(
      eines({ abschrift: 42, art: "kochbuchdeckel", fehlt: ["Schritte", "", 7, null] }),
      0,
      1,
    );
    expect(r?.abschrift).toBe("");
    expect(r?.art).toBe("sonstiges");
    expect(r?.fehlt).toEqual(["Schritte"]);
  });
});

describe("stitchChunks", () => {
  const rezept = (over: Record<string, unknown> = {}) => ({
    abschrift: "Text",
    art: "rezept" as const,
    zeigtGericht: false,
    fehlt: [] as string[],
    bildIndizes: [0],
    beginntVorher: false,
    gehtWeiter: false,
    ...over,
  });

  it("lässt getrennte Rezepte getrennt", () => {
    const raus = stitchChunks([[rezept(), rezept({ abschrift: "Zweites" })]]);
    expect(raus).toHaveLength(2);
  });

  it("näht ein Rezept zusammen, das über die Blockgrenze läuft", () => {
    // Zutaten auf Bild 3, Zubereitung auf Bild 4 - bei Blockgröße 4 fällt das
    // genau auf die Naht. Ohne Zusammenfügen wären beide Hälften unvollständig.
    const raus = stitchChunks([
      [rezept({ abschrift: "Zutaten", bildIndizes: [3], gehtWeiter: true, fehlt: ["Zubereitung"] })],
      [
        rezept({
          abschrift: "Zubereitung",
          bildIndizes: [4],
          beginntVorher: true,
          zeigtGericht: true,
          gerichtBildIndex: 4,
        }),
      ],
    ]);

    expect(raus).toHaveLength(1);
    expect(raus[0]?.abschrift).toBe("Zutaten\nZubereitung");
    expect(raus[0]?.bildIndizes).toEqual([3, 4]);
    // Das Titelbild der zweiten Hälfte darf nicht verloren gehen.
    expect(raus[0]?.zeigtGericht).toBe(true);
    expect(raus[0]?.gerichtBildIndex).toBe(4);
  });

  it("näht nur, wenn beide Seiten es sagen", () => {
    // Ein einseitiges "beginnt vorher" reicht nicht - sonst würden zwei
    // unabhängige Rezepte an der Blockgrenze verschmolzen.
    const raus = stitchChunks([
      [rezept({ abschrift: "Erstes", gehtWeiter: false })],
      [rezept({ abschrift: "Zweites", beginntVorher: true })],
    ]);
    expect(raus).toHaveLength(2);
  });

  it("näht nur an das erste Rezept eines Blocks", () => {
    // Innerhalb eines Blocks hat das Modell bereits aufgeteilt. Ein späteres
    // Rezept darf deshalb nie Fortsetzung des vorigen Blocks sein.
    const raus = stitchChunks([
      [rezept({ abschrift: "Erstes", gehtWeiter: true })],
      [
        rezept({ abschrift: "Zweites" }),
        rezept({ abschrift: "Drittes", beginntVorher: true }),
      ],
    ]);
    expect(raus).toHaveLength(3);
  });

  it("entfernt die Hilfsfelder aus dem Ergebnis", () => {
    const [r] = stitchChunks([[rezept()]]);
    expect(r).not.toHaveProperty("beginntVorher");
    expect(r).not.toHaveProperty("gehtWeiter");
  });
});

describe("usableReadings", () => {
  const basis = { zeigtGericht: false, fehlt: [] as string[], bildIndizes: [0] };

  it("übergeht Vorwort, Register und Buchdeckel", () => {
    // Beim Abfotografieren eines ganzen Kochbuchs sind die unvermeidlich mit
    // dabei. Sie dürfen weder ein Rezept ergeben noch den Lauf abbrechen.
    const raus = usableReadings([
      { ...basis, art: "sonstiges", abschrift: "Inhaltsverzeichnis" },
      { ...basis, art: "rezept", abschrift: "Pfannkuchen …" },
      { ...basis, art: "sonstiges", abschrift: "" },
    ]);
    expect(raus).toHaveLength(1);
    expect(raus[0]?.art).toBe("rezept");
  });

  it("behält langen Text auch ohne klare Einordnung", () => {
    const lang = { ...basis, art: "sonstiges" as const, abschrift: "x".repeat(200) };
    expect(usableReadings([lang])).toHaveLength(1);
  });
});

describe("modeFor", () => {
  const basis = {
    abschrift: "x".repeat(300),
    zeigtGericht: false,
    fehlt: [] as string[],
    bildIndizes: [0],
  };

  it("tippt ab, wenn das Rezept vollständig ist", () => {
    expect(modeFor({ ...basis, art: "rezept" })).toBe("abtippen");
  });

  it("ergänzt, wenn die Vorlage Lücken hat", () => {
    expect(modeFor({ ...basis, art: "rezept", fehlt: ["Backtemperatur"] })).toBe("ergaenzen");
    expect(modeFor({ ...basis, art: "zutatenliste", fehlt: ["Zubereitung"] })).toBe("ergaenzen");
  });

  it("erfindet nur beim Bild des fertigen Gerichts", () => {
    expect(modeFor({ ...basis, art: "gericht", abschrift: "" })).toBe("erfinden");
  });

  it("erfindet auch, wenn fast kein Text gelesen wurde", () => {
    // Eine Zutatenliste, von der nur ein Wort lesbar war, lässt sich nicht
    // "ergänzen" - da gäbe es kein Gerüst, an dem die Ergänzung hängt.
    expect(modeFor({ ...basis, art: "zutatenliste", abschrift: "Mehl", fehlt: ["alles"] })).toBe(
      "erfinden",
    );
  });
});

describe("buildModeSection", () => {
  it("bleibt bei Videos leer", () => {
    expect(buildModeSection(undefined)).toBe("");
    expect(buildModeSection("abtippen")).toBe("");
  });

  it("hebt die Regel im Ergänzungsmodus gezielt auf und benennt die Lücken", () => {
    const text = buildModeSection("ergaenzen", ["Backtemperatur", "Ruhezeit"]);
    expect(text).toContain("Backtemperatur, Ruhezeit");
    expect(text).toContain("eingeschränkt");
    expect(text).toContain("(ergänzt)");
    // Das Entscheidende: Vorhandenes darf nicht angefasst werden.
    expect(text).toContain("unverändert");
  });

  it("verlangt im Erfindungsmodus eine sichtbare Kennzeichnung", () => {
    const text = buildModeSection("erfinden");
    expect(text).toContain("ausgesetzt");
    expect(text).toContain("(geschätzt)");
  });
});

describe("mimeForFile", () => {
  it("kennt die Formate, die ein iPhone liefert", () => {
    expect(mimeForFile("a.jpg")).toBe("image/jpeg");
    expect(mimeForFile("a.HEIC")).toBe("image/heic");
    expect(mimeForFile("a.png")).toBe("image/png");
  });

  it("lehnt alles andere ab", () => {
    expect(mimeForFile("rezept.pdf")).toBeUndefined();
    expect(mimeForFile("rezept.txt")).toBeUndefined();
    // Ohne Endung gibt es nichts zu erkennen.
    expect(mimeForFile("foto")).toBeUndefined();
    // Der Name darf keinen Typ vortäuschen, den die Endung nicht hergibt.
    expect(mimeForFile("bild.jpg.exe")).toBeUndefined();
  });
});

describe("checkPhoto", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rezept-test-"));
    process.env.DATA_DIR = dir;
    process.env.MAX_PHOTO_BYTES = "1000";
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.MAX_PHOTO_BYTES;
    delete process.env.DATA_DIR;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("nimmt ein normales Foto an", () => {
    const r = checkPhoto("IMG_4711.HEIC", 500);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.extension).toBe(".heic");
  });

  it("lehnt ein fremdes Format ab", () => {
    const r = checkPhoto("rezept.pdf", 500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kein unterstütztes Bildformat");
  });

  it("lehnt leere und zu große Dateien ab", () => {
    expect(checkPhoto("a.jpg", 0).ok).toBe(false);
    const gross = checkPhoto("a.jpg", 5000);
    expect(gross.ok).toBe(false);
    if (!gross.ok) expect(gross.error).toContain("zu groß");
  });
});

const { childPhotos } = await import("../src/jobs/worker.ts");

describe("childPhotos", () => {
  const alle = ["1.jpg", "2.jpg", "3.jpg", "4.jpg"];
  const basis = {
    abschrift: "x",
    art: "rezept" as const,
    zeigtGericht: false,
    fehlt: [] as string[],
  };

  it("gibt dem Kind nur seine eigenen Bilder", () => {
    const { photos, reading } = childPhotos({ ...basis, bildIndizes: [2, 3] }, alle);
    expect(photos).toEqual(["3.jpg", "4.jpg"]);
    // Das Kind kennt nur noch seine zwei Bilder - die Nummern müssen
    // entsprechend umgerechnet sein, sonst zeigen sie ins Leere.
    expect(reading.bildIndizes).toEqual([0, 1]);
  });

  it("rechnet das Titelbild mit um", () => {
    const { reading } = childPhotos(
      { ...basis, bildIndizes: [2, 3], zeigtGericht: true, gerichtBildIndex: 3 },
      alle,
    );
    expect(reading.gerichtBildIndex).toBe(1);
    expect(reading.zeigtGericht).toBe(true);
  });

  it("verwirft ein Titelbild, das nicht zu diesem Rezept gehört", () => {
    // Bild 0 gehört einem anderen Rezept. Lieber kein Titelbild als das
    // Foto eines fremden Gerichts auf der Seite.
    const { reading } = childPhotos(
      { ...basis, bildIndizes: [2, 3], zeigtGericht: true, gerichtBildIndex: 0 },
      alle,
    );
    expect(reading.gerichtBildIndex).toBeUndefined();
    expect(reading.zeigtGericht).toBe(false);
  });

  it("fällt auf alle Bilder zurück, wenn die Zuordnung unbrauchbar ist", () => {
    const { photos } = childPhotos({ ...basis, bildIndizes: [9, 10] }, alle);
    expect(photos).toEqual(alle);
  });
});

const { photosStillNeeded } = await import("../src/jobs/worker.ts");

describe("photosStillNeeded", () => {
  const job = (id: string, status: string) => ({ id, status }) as never;

  it("gibt die Bilder frei, wenn alle Rezepte durch sind", () => {
    expect(
      photosStillNeeded("b", [job("a", "done"), job("b", "done"), job("c", "done")]),
    ).toBe(false);
  });

  it("hält sie fest, solange ein Geschwisterrezept noch läuft", () => {
    // Bei einem abfotografierten Kochbuch hängen alle Rezepte an denselben
    // Bildern. Wer zuerst fertig ist, darf sie den anderen nicht wegnehmen.
    expect(photosStillNeeded("b", [job("a", "queued"), job("b", "done")])).toBe(true);
    expect(photosStillNeeded("b", [job("a", "running"), job("b", "done")])).toBe(true);
  });

  it("hält sie fest, wenn ein Geschwisterrezept fehlgeschlagen ist", () => {
    // Sonst ließe sich der fehlgeschlagene Teil nie wieder versuchen.
    expect(photosStillNeeded("b", [job("a", "failed"), job("b", "done")])).toBe(true);
  });

  it("gibt ein einzelnes Rezept ohne Geschwister frei", () => {
    expect(photosStillNeeded("a", [job("a", "done")])).toBe(false);
  });
});
