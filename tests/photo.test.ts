import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.APP_TOKEN ??= "t";
process.env.NOTION_TOKEN ??= "ntn_t";
process.env.NOTION_DATABASE_ID ??= "0".repeat(32);

const { normalizeReading, modeFor } = await import("../src/extract/photo.ts");
const { mimeForFile } = await import("../src/lib/images.ts");
const { buildModeSection } = await import("../src/llm/prompt.ts");
const { checkPhoto } = await import("../src/jobs/uploads.ts");
const { resetConfigCache } = await import("../src/config.ts");

describe("normalizeReading", () => {
  it("übernimmt eine vollständige Antwort", () => {
    const r = normalizeReading(
      {
        abschrift: "  Pfannkuchen\n200 g Mehl  ",
        art: "rezept",
        zeigt_gericht: true,
        gericht_bild_index: 1,
        titel: " Pfannkuchen ",
        fehlt: [],
      },
      2,
    );
    expect(r.abschrift).toBe("Pfannkuchen\n200 g Mehl");
    expect(r.art).toBe("rezept");
    expect(r.zeigtGericht).toBe(true);
    expect(r.gerichtBildIndex).toBe(1);
    expect(r.titel).toBe("Pfannkuchen");
    expect(r.fehlt).toEqual([]);
  });

  it("verwirft einen Bildindex, den es gar nicht gibt", () => {
    // Zeigt das Modell auf Bild 5, obwohl nur zwei hochgeladen wurden, wäre
    // jede Zuordnung geraten. Dann lieber kein Titelbild als das falsche.
    const r = normalizeReading(
      { abschrift: "x", art: "gericht", zeigt_gericht: true, gericht_bild_index: 5, fehlt: [] },
      2,
    );
    expect(r.zeigtGericht).toBe(false);
    expect(r.gerichtBildIndex).toBeUndefined();
  });

  it("setzt zeigtGericht nur mit brauchbarem Index", () => {
    const r = normalizeReading(
      { abschrift: "x", art: "gericht", zeigt_gericht: true, fehlt: [] },
      1,
    );
    expect(r.zeigtGericht).toBe(false);
  });

  it("fällt bei unbekannter Art auf sonstiges zurück", () => {
    const r = normalizeReading(
      { abschrift: "x", art: "kochbuchdeckel", zeigt_gericht: false, fehlt: [] },
      1,
    );
    expect(r.art).toBe("sonstiges");
  });

  it("verträgt fehlende und falsch getypte Felder", () => {
    const r = normalizeReading({}, 1);
    expect(r).toMatchObject({ abschrift: "", art: "sonstiges", zeigtGericht: false, fehlt: [] });

    const mitMuell = normalizeReading(
      { abschrift: 42, fehlt: ["Schritte", "", 7, null] },
      1,
    );
    expect(mitMuell.abschrift).toBe("");
    expect(mitMuell.fehlt).toEqual(["Schritte"]);
  });
});

describe("modeFor", () => {
  const basis = { abschrift: "x".repeat(300), zeigtGericht: false, fehlt: [] as string[] };

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
