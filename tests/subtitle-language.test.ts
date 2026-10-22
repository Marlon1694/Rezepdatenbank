import { describe, it, expect } from "vitest";
import { pickSubtitleLanguage } from "../src/extract/ytdlp.ts";

/**
 * Entstanden aus einem echten Fehlschlag: Bei einem deutschen YouTube-Video
 * wurden pauschal sechs Sprachvarianten angefragt. YouTube antwortete auf die
 * englische mit "HTTP Error 429: Too Many Requests", yt-dlp beendete sich mit
 * Fehlercode - und das Video lief durch die Transkription, statt die
 * vorhandenen Untertitel zu nutzen.
 *
 * Es darf immer nur genau EINE Spur angefragt werden.
 */

describe("pickSubtitleLanguage", () => {
  it("nimmt echte Untertitel vor automatischen", () => {
    const wahl = pickSubtitleLanguage({
      language: "de",
      subtitleLangs: ["de"],
      autoCaptionLangs: ["de", "en", "fr"],
    });
    expect(wahl).toEqual({ lang: "de", auto: false });
  });

  it("nimmt bei Auto-Untertiteln die Sprache des Videos, keine Übersetzung", () => {
    // YouTube bietet Hunderte Übersetzungsziele an. Nur die Originalspur ist
    // nicht selbst schon maschinell übersetzt.
    const wahl = pickSubtitleLanguage({
      language: "de",
      subtitleLangs: [],
      autoCaptionLangs: ["en", "es", "fr", "de", "zu"],
    });
    expect(wahl).toEqual({ lang: "de", auto: true });
  });

  it("erkennt die -orig-Spur als Original", () => {
    const wahl = pickSubtitleLanguage({
      language: "de",
      subtitleLangs: [],
      autoCaptionLangs: ["en", "de-orig", "de"],
    });
    expect(wahl?.lang).toBe("de-orig");
  });

  it("fällt auf die Wunschsprachen zurück, wenn das Video keine nennt", () => {
    const wahl = pickSubtitleLanguage({
      subtitleLangs: [],
      autoCaptionLangs: ["fr", "en", "es"],
    });
    expect(wahl).toEqual({ lang: "en", auto: true });
  });

  it("akzeptiert Regionalvarianten", () => {
    const wahl = pickSubtitleLanguage({
      language: "de",
      subtitleLangs: ["de-DE"],
      autoCaptionLangs: [],
    });
    expect(wahl).toEqual({ lang: "de-DE", auto: false });
  });

  it("hält sich an die Reihenfolge der Wunschsprachen", () => {
    const wahl = pickSubtitleLanguage({
      subtitleLangs: ["en", "de"],
      autoCaptionLangs: [],
    });
    expect(wahl?.lang).toBe("de");
  });

  it("gibt undefined zurück, wenn es gar keine gibt", () => {
    // Dann wird gar nicht erst angefragt - eine Anfrage weniger, die 429 auslösen kann.
    expect(
      pickSubtitleLanguage({ language: "de", subtitleLangs: [], autoCaptionLangs: [] }),
    ).toBeUndefined();
  });

  it("liefert immer genau eine Spur, nie mehrere", () => {
    const wahl = pickSubtitleLanguage({
      language: "de",
      subtitleLangs: ["de", "en"],
      autoCaptionLangs: ["de", "en", "fr", "es", "it"],
    });
    expect(typeof wahl?.lang).toBe("string");
    expect(wahl?.lang).not.toContain(",");
  });
});
