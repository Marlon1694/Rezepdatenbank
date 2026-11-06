import { describe, it, expect } from "vitest";

process.env.APP_TOKEN ??= "t";
process.env.NOTION_TOKEN ??= "ntn_t";
process.env.NOTION_DATABASE_ID ??= "0".repeat(32);

const { explainError } = await import("../src/extract/ytdlp.ts");

describe("explainError", () => {
  it("erkennt TikToks Login-Sperre für heikle Videos", () => {
    // Wortgleich aus der Praxis. Vorher fiel die Meldung durch alle Muster und
    // stand roh auf Englisch in der Web-App - mit einem Hinweis auf
    // --cookies-from-browser, der auf dem Server nichts nützt.
    const stderr =
      "ERROR: [TikTok] 7694174386995186976: This post may not be comfortable for " +
      "some audiences. Log in for access. Use --cookies-from-browser or --cookies " +
      "for the authentication.";
    const text = explainError(stderr);
    expect(text).toContain("TikTok");
    expect(text).toContain("config/cookies.txt");
    expect(text).not.toContain("--cookies-from-browser");
  });

  it("bleibt beim allgemeinen Login-Fall", () => {
    expect(explainError("ERROR: [Instagram] abc: login required")).toContain(
      "verlangt einen Login",
    );
  });
});
