import { describe, it, expect } from "vitest";
import { __test } from "../src/llm/gemini.ts";

const { statusOf, explain } = __test;

/**
 * Die Fehlererkennung ist der Teil, der im Ernstfall darueber entscheidet, ob in
 * der Web-App ein brauchbarer Hinweis steht oder eine Wand aus JSON.
 */

describe("statusOf", () => {
  it("liest den Code aus dem JSON, das das SDK in die Meldung packt", () => {
    // Genau die Form, die bei einer Ueberlastung ankommt.
    const err = new Error(
      '{"error":{"code":503,"message":"This model is currently experiencing high ' +
        'demand. Spikes in demand are usually temporary. Please try again later.",' +
        '"status":"UNAVAILABLE"}}',
    );
    expect(statusOf(err)).toBe(503);
  });

  it("nimmt ein status-Feld, wenn das SDK eines mitliefert", () => {
    expect(statusOf({ status: 429, message: "quota" })).toBe(429);
  });

  it("erkennt eine nackte Statuszahl in der Meldung", () => {
    expect(statusOf(new Error("got 404 Not Found"))).toBe(404);
  });

  it("gibt undefined zurück, wenn nichts erkennbar ist", () => {
    expect(statusOf(new Error("Netzwerk weg"))).toBeUndefined();
    expect(statusOf("irgendwas")).toBeUndefined();
  });

  it("verwechselt eine Jahreszahl nicht mit einem Statuscode", () => {
    expect(statusOf(new Error("Rezept von 2026 gefunden"))).toBeUndefined();
  });
});

describe("explain", () => {
  it("sagt bei Überlastung, was zu tun ist, statt JSON zu zeigen", () => {
    const text = explain(503, "gemini-flash-latest", "roher JSON-Müll");
    expect(text).toContain("überlastet");
    expect(text).toContain("Erneut versuchen");
    expect(text).not.toContain("JSON-Müll");
  });

  it("nennt beim Tageslimit den Grund", () => {
    expect(explain(429, "m", "")).toContain("Kontingent");
  });

  it("verweist bei unbekanntem Modell auf die Modell-Liste", () => {
    const text = explain(404, "gemini-gibtsnicht", "");
    expect(text).toContain("gemini-gibtsnicht");
    expect(text).toContain("npm run models");
  });

  it("zeigt bei abgelehntem Key auf die .env", () => {
    expect(explain(403, "m", "")).toContain("GEMINI_API_KEY");
  });

  it("reicht unbekannte Fehler im Wortlaut durch, statt sie zu verschlucken", () => {
    expect(explain(undefined, "m", "Verbindung abgebrochen")).toContain(
      "Verbindung abgebrochen",
    );
  });
});
