import { describe, it, expect } from "vitest";
import { isPinterestUrl, findPinTarget } from "../src/extract/pinterest.ts";
import { recipeShortcoming, RecipeSchema } from "../src/llm/recipeSchema.ts";

describe("isPinterestUrl", () => {
  it("erkennt die Pinterest-Adressen", () => {
    expect(isPinterestUrl("https://de.pinterest.com/pin/123/")).toBe(true);
    expect(isPinterestUrl("https://pin.it/2m7cVBxGF")).toBe(true);
    expect(isPinterestUrl("https://www.pinterest.co.uk/pin/1/")).toBe(true);
  });

  it("lässt sich nicht von ähnlichen Domains täuschen", () => {
    expect(isPinterestUrl("https://pinterest.com.phish.example/x")).toBe(false);
    expect(isPinterestUrl("https://www.chefkoch.de/rezepte/1")).toBe(false);
  });
});

describe("findPinTarget", () => {
  it("findet die Ziel-Adresse im eingebetteten JSON", () => {
    const html = `<script>{"id":"1","link":"https://blog.de/orzo-pfanne","title":"x"}</script>`;
    expect(findPinTarget(html)).toBe("https://blog.de/orzo-pfanne");
  });

  it("entschlüsselt maskierte Schrägstriche", () => {
    // So steht es im JSON der Seite.
    const html = `<script>{"link":"https:\\/\\/blog.de\\/orzo"}</script>`;
    expect(findPinTarget(html)).toBe("https://blog.de/orzo");
  });

  it("überspringt Verweise auf Pinterest selbst", () => {
    // Der erste Treffer zeigt oft zurück auf Pinterest - der nützt nichts.
    const html =
      `<script>{"link":"https://www.pinterest.com/pin/999/"},` +
      `{"link":"https://i.pinimg.com/bild.jpg"},` +
      `{"link":"https://blog.de/echtes-rezept"}</script>`;
    expect(findPinTarget(html)).toBe("https://blog.de/echtes-rezept");
  });

  it("nimmt og:see_also, wenn vorhanden", () => {
    const html = `<meta property="og:see_also" content="https://blog.de/rezept">`;
    expect(findPinTarget(html)).toBe("https://blog.de/rezept");
  });

  it("gibt undefined zurück, wenn kein Ziel erkennbar ist", () => {
    expect(findPinTarget(`<html><body>nichts</body></html>`)).toBeUndefined();
  });
});

describe("recipeShortcoming", () => {
  const vollstaendig = RecipeSchema.parse({
    emoji: "🍝",
    titel: "Orzo-Pfanne",
    tags: ["Schnell"],
    zeit_text: "30 Minuten",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "200 g", zutat: "Risoni" },
          { menge: "300 g", zutat: "Hähnchen" },
          { menge: "1", zutat: "Brokkoli" },
        ],
      },
    ],
    schritte: ["Anbraten.", "Köcheln.", "Servieren."],
  });

  it("lässt ein vollständiges Rezept durch", () => {
    expect(recipeShortcoming(vollstaendig)).toBe("");
  });

  it("erkennt die Pinterest-Attrappe", () => {
    // Genau das kam bei einem Pin heraus: Zutaten ohne Mengen, ein Schritt.
    const attrappe = RecipeSchema.parse({
      ...vollstaendig,
      zutaten: [
        {
          gruppe: "Zutaten",
          eintraege: [
            { zutat: "Hähnchenfilet" },
            { zutat: "Brokkoli" },
            { zutat: "Risoni-Nudeln" },
          ],
        },
      ],
      schritte: ["Hähnchen, Brokkoli und Risoni zusammen cremig zubereiten."],
    });
    expect(recipeShortcoming(attrappe)).toContain("einzigen Schritt");
  });

  it("beanstandet fehlende Mengen", () => {
    const ohneMengen = RecipeSchema.parse({
      ...vollstaendig,
      zutaten: [
        {
          gruppe: "Zutaten",
          eintraege: [{ zutat: "Risoni" }, { zutat: "Hähnchen" }, { zutat: "Brokkoli" }],
        },
      ],
    });
    expect(ohneMengen && recipeShortcoming(ohneMengen)).toContain("Mengenangabe");
  });

  it("lässt ein bewusst ungefähres Rezept mit vielen Zutaten durch", () => {
    // Manche Rezepte kommen ohne Grammangaben aus - bei genug Zutaten in Ordnung.
    const rustikal = RecipeSchema.parse({
      ...vollstaendig,
      zutaten: [
        {
          gruppe: "Zutaten",
          eintraege: ["Risoni", "Hähnchen", "Brokkoli", "Sahne", "Zwiebel", "Knoblauch"].map(
            (zutat) => ({ zutat }),
          ),
        },
      ],
    });
    expect(recipeShortcoming(rustikal)).toBe("");
  });

  it("beanstandet zu wenige Zutaten", () => {
    const duenn = RecipeSchema.parse({
      ...vollstaendig,
      zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "200 g", zutat: "Risoni" }] }],
    });
    expect(recipeShortcoming(duenn)).toContain("nur 1 Zutaten");
  });
});
