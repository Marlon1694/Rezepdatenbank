import { describe, it, expect } from "vitest";
import { detectPlatform, looksLikeVideoUrl } from "../src/extract/index.ts";
import { cleanUrl } from "../src/lib/url.ts";

describe("detectPlatform", () => {
  it("erkennt die üblichen Verdächtigen", () => {
    expect(detectPlatform("https://www.youtube.com/watch?v=abc")).toBe("YouTube");
    expect(detectPlatform("https://youtu.be/abc")).toBe("YouTube");
    expect(detectPlatform("https://www.instagram.com/reel/abc/")).toBe("Instagram");
    expect(detectPlatform("https://vm.tiktok.com/abc/")).toBe("TikTok");
  });

  it("gibt bei anderen Seiten den Hostnamen zurück", () => {
    expect(detectPlatform("https://www.chefkoch.de/rezepte/1")).toBe("chefkoch.de");
  });

  it("verschluckt sich nicht an Unsinn", () => {
    expect(detectPlatform("keine url")).toBe("unbekannt");
  });

  it("lässt sich nicht von einer ähnlich klingenden Domain täuschen", () => {
    // youtube.com.phish.example darf nicht als YouTube durchgehen.
    expect(detectPlatform("https://youtube.com.phish.example/x")).toBe(
      "youtube.com.phish.example",
    );
  });
});

describe("looksLikeVideoUrl", () => {
  it("trennt Video-Plattformen von Blogs", () => {
    expect(looksLikeVideoUrl("https://www.tiktok.com/@a/video/1")).toBe(true);
    expect(looksLikeVideoUrl("https://www.chefkoch.de/rezepte/1")).toBe(false);
  });
});

describe("cleanUrl", () => {
  it("entfernt Tracking-Parameter aus Teilen-Links", () => {
    // Genau so kommt ein Link aus dem iOS-Teilen-Menü.
    expect(cleanUrl("https://www.tiktok.com/@koch/video/123?is_from_webapp=1&sender_device=pc")).toBe(
      "https://www.tiktok.com/@koch/video/123",
    );
    // youtu.be wird zusätzlich auf die lange Form vereinheitlicht (s.u.).
    expect(cleanUrl("https://youtu.be/abc?si=xyz123")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
    expect(cleanUrl("https://www.instagram.com/reel/abc/?igshid=xyz")).toBe(
      "https://www.instagram.com/reel/abc",
    );
  });

  it("behält inhaltlich wichtige Parameter", () => {
    // Ohne ?v= zeigt ein YouTube-Link auf gar nichts mehr.
    expect(cleanUrl("https://www.youtube.com/watch?v=abc&utm_source=x")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });

  it("führt verschiedene Schreibweisen desselben Videos zusammen", () => {
    // Aus der App geteilt vs. aus dem Browser kopiert - dasselbe Video.
    // Ohne Vereinheitlichung entstünden zwei Notion-Seiten.
    const kurz = cleanUrl("https://youtu.be/8R39Hs5aQw4?si=xyz");
    const lang = cleanUrl("https://www.youtube.com/watch?v=8R39Hs5aQw4");
    const mobil = cleanUrl("https://m.youtube.com/watch?v=8R39Hs5aQw4");
    expect(kurz).toBe(lang);
    expect(mobil).toBe(lang);
    expect(lang).toBe("https://www.youtube.com/watch?v=8R39Hs5aQw4");
  });

  it("behandelt YouTube-Shorts wie das normale Video", () => {
    expect(cleanUrl("https://www.youtube.com/shorts/8R39Hs5aQw4")).toBe(
      "https://www.youtube.com/watch?v=8R39Hs5aQw4",
    );
  });

  it("ignoriert einen abschließenden Schrägstrich", () => {
    expect(cleanUrl("https://www.tiktok.com/@koch/video/123/")).toBe(
      cleanUrl("https://www.tiktok.com/@koch/video/123"),
    );
  });

  it("lässt TikTok-Kurzlinks unangetastet", () => {
    // vm.tiktok.com/XYZ lässt sich ohne Netzwerk nicht auflösen - das übernimmt
    // später yt-dlp, dessen Ergebnis für Notion verwendet wird.
    expect(cleanUrl("https://vm.tiktok.com/ZGdQUTHGQ/")).toBe(
      "https://vm.tiktok.com/ZGdQUTHGQ",
    );
  });

  it("lässt saubere URLs unangetastet", () => {
    expect(cleanUrl("https://www.chefkoch.de/rezepte/1/Pasta.html")).toBe(
      "https://www.chefkoch.de/rezepte/1/Pasta.html",
    );
  });

  it("schneidet Leerzeichen ab", () => {
    expect(cleanUrl("  https://www.youtube.com/watch?v=abc  ")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });
});
