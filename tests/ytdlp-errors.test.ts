import { describe, it, expect } from "vitest";
import { explainError } from "../src/extract/ytdlp.ts";

/**
 * Was yt-dlp auf stderr schreibt, ist ein Python-Trace. Was in der Web-App steht,
 * entscheidet diese Funktion - und damit, wo man beim Suchen anfaengt. Eine
 * Meldung, die auf Cookies zeigt, obwohl das Video schlicht weg ist, kostet mehr
 * Zeit als gar keine.
 */

describe("explainError", () => {
  it("zeigt bei verlangtem Login auf die Cookie-Anleitung", () => {
    const text = explainError("ERROR: [Instagram] 123: Requested content is not available");
    expect(text).toContain("Login");
    expect(text).toContain("config/cookies.txt");
  });

  it("behandelt ein erreichtes Rate-Limit ebenfalls als Login-Problem", () => {
    // Instagram antwortet auf nicht angemeldete Abrufe mit einer Drosselung,
    // nicht mit einer Login-Aufforderung.
    expect(explainError("ERROR: rate-limit reached or login required")).toContain(
      "docs/cookies.md",
    );
  });

  it("erkennt den Bot-Verdacht von YouTube", () => {
    const text = explainError("ERROR: Sign in to confirm you're not a bot");
    expect(text).toContain("Bot");
    expect(text).toContain("docs/cookies.md");
  });

  it("hält 'both' nicht für einen Bot-Verdacht", () => {
    // Der Fehler, den diese Datei aufgedeckt hat: die Pruefung lief ueber
    // s.includes("bot"), und in "both" steckt diese Zeichenfolge. Ein Video,
    // das einfach weg war, schickte einen damit auf die Cookie-Fährte.
    const text = explainError("ERROR: both audio and video streams unavailable");
    expect(text).not.toContain("Bot");
  });

  it("nennt ein nicht öffentliches Video als solches", () => {
    expect(explainError("ERROR: Private video. Sign in if you've been granted access")).toBe(
      "Das Video ist nicht (mehr) öffentlich abrufbar.",
    );
    expect(explainError("ERROR: Video unavailable")).toContain("nicht (mehr) öffentlich");
  });

  it("verweist bei TikTok auf die Browser-Fingerabdrücke", () => {
    const text = explainError("ERROR: [TikTok] Unexpected response from webpage request");
    expect(text).toContain("--list-impersonate-targets");
  });

  it("sagt bei unbekannter Seite, dass sie als Webseite gelesen wird", () => {
    expect(explainError("ERROR: Unsupported URL: https://kochblog.example/rezept")).toContain(
      "als Webseite gelesen",
    );
  });

  it("meldet 404 knapp", () => {
    expect(explainError("ERROR: unable to download: HTTP Error 404: Not Found")).toBe(
      "Die URL existiert nicht (404).",
    );
  });

  it("reicht einen unbekannten Fehler im Wortlaut durch, ohne das ERROR-Präfix", () => {
    const text = explainError(
      "[youtube] Extracting URL\nERROR: Postprocessing: ffmpeg nicht gefunden\n",
    );
    expect(text).toBe("Postprocessing: ffmpeg nicht gefunden");
  });

  it("liefert auch bei leerem stderr einen Satz, keinen leeren String", () => {
    expect(explainError("")).toBe("yt-dlp konnte die Seite nicht verarbeiten.");
    expect(explainError("\n\n")).toBe("yt-dlp konnte die Seite nicht verarbeiten.");
  });

  it("ist unabhängig von der Groß- und Kleinschreibung", () => {
    expect(explainError("ERROR: VIDEO UNAVAILABLE")).toContain("nicht (mehr) öffentlich");
  });
});
