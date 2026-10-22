import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * Die Gratis-Kaskade: Untertitel und Beschreibung kosten nichts, Transkribieren
 * kostet Zeit und - beim Gemini-Weg - Kontingent. Transkribiert werden darf
 * deshalb nur, wenn vom Gratis-Text nichts Brauchbares uebrig bleibt.
 *
 * Genau hier entstand der Fehler, den looksLikeRecipe seit PR #2 verhindert: Die
 * YouTube-Beschreibung enthielt nur Mengenangaben, keinen einzigen Arbeits-
 * schritt. Sie bestand trotzdem die Pruefung, die Transkription lief nie an, und
 * in Notion landete ein Rezept ohne Anleitung. Die Pruefung selbst ist in
 * vtt.test.ts abgedeckt - hier geht es darum, dass ihr Urteil auch Folgen hat.
 *
 * Ohne Netzwerk: yt-dlp, die Transkription und das Seitenlesen sind ersetzt.
 */

process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.FREE_TEXT_MIN_CHARS = "200";

const probe = vi.fn();
const fetchSubtitles = vi.fn();
const downloadAudio = vi.fn();
const transcribe = vi.fn();
const fetchPage = vi.fn();

vi.mock("../src/extract/ytdlp.ts", async (original) => {
  // pickSubtitleLanguage bleibt echt: welche Spur gewaehlt wird, ist in
  // subtitle-language.test.ts geprueft und soll hier mitlaufen.
  const echt = await original<typeof import("../src/extract/ytdlp.ts")>();
  return { ...echt, probe, fetchSubtitles, downloadAudio };
});
vi.mock("../src/transcribe/index.ts", () => ({ transcribe }));
vi.mock("../src/extract/web.ts", () => ({ fetchPage }));

const { extract } = await import("../src/extract/index.ts");
const { resetConfigCache } = await import("../src/config.ts");

const VIDEO = "https://www.youtube.com/watch?v=abc123";

/** Ein Text mit Mengen UND Arbeitsschritten - so sieht ein echtes Rezept aus. */
const MIT_SCHRITTEN = [
  "Für den Teig 500 g Mehl, 350 ml Wasser, 5 g Trockenhefe und 10 g Salz verkneten.",
  "Den Teig zwei Stunden gehen lassen, dann von Hand ausrollen.",
  "Mit 400 g Tomaten belegen, 250 g Mozzarella darauf verteilen, mit Basilikum",
  "bestreuen und bei 250 Grad im vorgeheizten Ofen backen, bis der Rand bräunt.",
  "Vor dem Servieren kurz ruhen lassen und mit Olivenöl beträufeln.",
].join(" ");

/** Dieselben Mengen, aber kein Arbeitsschritt - eine Einkaufsliste. */
const NUR_MENGEN = [
  "Zutaten für den Teig: 500 g Mehl, 350 ml Wasser, 5 g Trockenhefe, 10 g Salz,",
  "2 EL Olivenöl. Zutaten für den Belag: 400 g Tomaten, 250 g Mozzarella,",
  "1 Bund Basilikum, 2 Zehen Knoblauch, 1 Prise Zucker, 3 EL Tomatenmark.",
  "Alle Zutaten findet ihr verlinkt in der Beschreibung. Vielen Dank an alle",
  "Unterstützer auf Patreon, und lasst mir gern ein Abo da! Folgt mir auch auf",
  "Instagram und TikTok, dort gibt es jede Woche ein neues Rezept zu sehen.",
].join(" ");

const INFO = {
  title: "Pizza wie beim Italiener",
  uploader: "Kanal",
  durationSeconds: 420,
  thumbnail: "https://i.ytimg.com/vi/abc123/maxres.jpg",
  webpageUrl: VIDEO,
  language: "de",
  subtitleLangs: [] as string[],
  autoCaptionLangs: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FREE_TEXT_MIN_CHARS = "200";
  process.env.TRANSCRIBE_PROVIDER = "local";
  resetConfigCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  downloadAudio.mockResolvedValue("/tmp/audio.opus");
  transcribe.mockResolvedValue({ text: MIT_SCHRITTEN });
});

afterAll(() => {
  vi.restoreAllMocks();
  delete process.env.FREE_TEXT_MIN_CHARS;
  delete process.env.TRANSCRIBE_PROVIDER;
  resetConfigCache();
});

describe("extract: Untertitel reichen", () => {
  it("nimmt echte Untertitel und lädt keine Tonspur", () => {
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: "" });
    fetchSubtitles.mockResolvedValue({ text: MIT_SCHRITTEN, lang: "de", auto: false });

    return extract(VIDEO).then((ergebnis) => {
      expect(ergebnis.source).toBe("Untertitel");
      expect(ergebnis.transcribed).toBe(false);
      expect(downloadAudio).not.toHaveBeenCalled();
      expect(transcribe).not.toHaveBeenCalled();
      // Die Metadaten des Videos wandern mit - sie werden Titelbild und Quelle.
      expect(ergebnis.canonicalUrl).toBe(VIDEO);
      expect(ergebnis.thumbnailUrl).toBe(INFO.thumbnail);
      expect(ergebnis.durationSeconds).toBe(420);
    });
  });

  it("kennzeichnet Auto-Untertitel getrennt von echten", async () => {
    probe.mockResolvedValue({ ...INFO, autoCaptionLangs: ["de"], description: "" });
    fetchSubtitles.mockResolvedValue({ text: MIT_SCHRITTEN, lang: "de", auto: true });

    expect((await extract(VIDEO)).source).toBe("Auto-Untertitel");
  });

  it("hängt eine längere Beschreibung an die Untertitel an", async () => {
    // Bei vielen Kanaelen stehen die exakten Mengen nur in der Beschreibung,
    // waehrend sie im Video genannt, aber nicht buchstabiert werden.
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: NUR_MENGEN });
    fetchSubtitles.mockResolvedValue({ text: MIT_SCHRITTEN, lang: "de", auto: false });

    const ergebnis = await extract(VIDEO);
    expect(ergebnis.source).toBe("Untertitel");
    expect(ergebnis.text).toContain("--- Videobeschreibung ---");
    expect(ergebnis.text).toContain("3 EL Tomatenmark");
  });

  it("hängt eine kurze Beschreibung nicht an", async () => {
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: "Mein Rezept 🍕" });
    fetchSubtitles.mockResolvedValue({ text: MIT_SCHRITTEN, lang: "de", auto: false });

    expect((await extract(VIDEO)).text).not.toContain("--- Videobeschreibung ---");
  });
});

describe("extract: Beschreibung statt Untertitel", () => {
  it("nimmt die Beschreibung, wenn das Video keine Untertitel hat", async () => {
    // Der TikTok- und Reels-Fall: das ganze Rezept steht in der Caption.
    probe.mockResolvedValue({ ...INFO, description: MIT_SCHRITTEN });

    const ergebnis = await extract(VIDEO);
    expect(ergebnis.source).toBe("Videobeschreibung");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("fragt gar keine Untertitel an, wenn das Video keine anbietet", async () => {
    // Jede unnoetige Anfrage an YouTubes Untertitel-Endpunkt ist eine, die 429
    // ausloesen kann - deshalb wird erst in den Metadaten nachgesehen.
    probe.mockResolvedValue({ ...INFO, description: MIT_SCHRITTEN });

    await extract(VIDEO);
    expect(fetchSubtitles).not.toHaveBeenCalled();
  });
});

describe("extract: wann transkribiert wird", () => {
  it("transkribiert, wenn die Beschreibung nur eine Zutatenliste ist", async () => {
    // Der Fall aus der Praxis. Die Liste ist lang genug und voller Mengen -
    // ohne die Pruefung auf Arbeitsschritte wuerde sie hier durchgewinkt.
    probe.mockResolvedValue({ ...INFO, description: NUR_MENGEN });

    const ergebnis = await extract(VIDEO);
    expect(ergebnis.source).toBe("Transkription (lokal)");
    expect(ergebnis.transcribed).toBe(true);
    expect(transcribe).toHaveBeenCalledOnce();
    // Die Zutatenliste ist nicht verloren: sie haengt am Transkript.
    expect(ergebnis.text).toContain("--- Videobeschreibung ---");
    expect(ergebnis.text).toContain("500 g Mehl");
  });

  it("transkribiert auch dann, wenn die Untertitel nur Zutaten nennen", async () => {
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: "" });
    fetchSubtitles.mockResolvedValue({ text: NUR_MENGEN, lang: "de", auto: false });

    expect((await extract(VIDEO)).transcribed).toBe(true);
  });

  it("transkribiert bei zu kurzem Gratis-Text, auch wenn er ein Rezept wäre", async () => {
    process.env.FREE_TEXT_MIN_CHARS = "5000";
    resetConfigCache();
    probe.mockResolvedValue({ ...INFO, description: MIT_SCHRITTEN });

    expect((await extract(VIDEO)).transcribed).toBe(true);
  });

  it("nennt den Gemini-Weg in der Quelle, wenn er eingestellt ist", async () => {
    process.env.TRANSCRIBE_PROVIDER = "gemini";
    resetConfigCache();
    probe.mockResolvedValue({ ...INFO, description: NUR_MENGEN });

    expect((await extract(VIDEO)).source).toBe("Transkription (Gemini)");
  });

  it("läuft weiter, wenn der Untertitel-Abruf wirft", async () => {
    // Ein 429 beim Untertitel-Endpunkt darf den ganzen Job nicht beenden -
    // die Tonspur ist noch da.
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: "" });
    fetchSubtitles.mockRejectedValue(new Error("HTTP Error 429: Too Many Requests"));

    const ergebnis = await extract(VIDEO);
    expect(ergebnis.transcribed).toBe(true);
    expect(downloadAudio).toHaveBeenCalledOnce();
  });

  it("läuft weiter, wenn die Untertiteldatei leer blieb", async () => {
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: "" });
    fetchSubtitles.mockResolvedValue(undefined);

    expect((await extract(VIDEO)).transcribed).toBe(true);
  });
});

describe("extract: Fortschrittsmeldungen", () => {
  it("meldet die Schritte in der Reihenfolge, in der sie laufen", async () => {
    probe.mockResolvedValue({ ...INFO, subtitleLangs: ["de"], description: "" });
    fetchSubtitles.mockResolvedValue({ text: NUR_MENGEN, lang: "de", auto: false });

    const schritte: string[] = [];
    await extract(VIDEO, (s) => schritte.push(s));

    expect(schritte).toEqual([
      "Video-Infos werden geladen",
      "Untertitel werden geladen",
      "Tonspur wird heruntergeladen",
      "Wird transkribiert",
    ]);
  });
});
