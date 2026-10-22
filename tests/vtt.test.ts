import { describe, it, expect } from "vitest";
import { parseVtt, looksLikeRecipe, recipeSignals } from "../src/extract/vtt.ts";

describe("parseVtt", () => {
  it("entfernt Zeitstempel, Header und Cue-Nummern", () => {
    const vtt = `WEBVTT
Kind: captions
Language: de

1
00:00:01.000 --> 00:00:04.000
Heute machen wir Pasta.

2
00:00:04.000 --> 00:00:07.500
Dazu brauchen wir 200 g Mehl.`;
    expect(parseVtt(vtt)).toBe("Heute machen wir Pasta. Dazu brauchen wir 200 g Mehl.");
  });

  it("entwirrt das Rolling-Window der YouTube-Auto-Captions", () => {
    // Auto-Captions rollen hoch: jede Zeile erscheint im naechsten Cue erneut.
    // Roh eingelesen stuende hier alles doppelt bis dreifach.
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
wir brauchen

00:00:02.000 --> 00:00:04.000
wir brauchen 200 Gramm

00:00:04.000 --> 00:00:06.000
wir brauchen 200 Gramm Mehl`;
    expect(parseVtt(vtt)).toBe("wir brauchen 200 Gramm Mehl");
  });

  it("entfernt Inline-Cue-Tags und HTML-Entities", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<00:00:01.500><c>Salz</c> &amp; Pfeffer`;
    expect(parseVtt(vtt)).toBe("Salz & Pfeffer");
  });

  it("kommt mit SRT-Zeitstempeln (Komma) zurecht", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Zwiebeln würfeln.`;
    expect(parseVtt(srt)).toBe("Zwiebeln würfeln.");
  });

  it("repariert Leerzeichen vor Satzzeichen", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Fertig

00:00:02.000 --> 00:00:03.000
.`;
    expect(parseVtt(vtt)).toBe("Fertig.");
  });

  it("liefert leeren String, wenn nichts ausser Metadaten da ist", () => {
    expect(parseVtt("WEBVTT\n\nKind: captions\nLanguage: en\n")).toBe("");
  });
});

describe("looksLikeRecipe", () => {
  it("erkennt Mengenangaben", () => {
    expect(
      looksLikeRecipe(
        "Für dieses Gericht brauchst du 200 g Mehl, 250 ml Milch und eine Prise Salz. " +
          "Alles gut verrühren und dann in der Pfanne anbraten bis es goldbraun ist.",
      ),
    ).toBe(true);
  });

  it("erkennt Zubereitungsverben auch ohne viele Mengen", () => {
    expect(
      looksLikeRecipe(
        "Zuerst die Zwiebeln schneiden, dann anbraten, danach alles vermengen und " +
          "zum Schluss kräftig abschmecken bevor du servieren kannst.",
      ),
    ).toBe(true);
  });

  it("lehnt reine Kanal-Werbung ab", () => {
    // Genau der Fall, den der Schwellwert verhindern soll: viel Text, kein Rezept.
    expect(
      looksLikeRecipe(
        "Abonniert meinen Kanal und aktiviert die Glocke! Folgt mir auf Instagram und " +
          "TikTok. Mein Kochbuch bekommt ihr über den Link in der Beschreibung. " +
          "Vielen Dank an alle Unterstützer auf Patreon für eure Treue.",
      ),
    ).toBe(false);
  });

  it("lehnt zu kurzen Text ab", () => {
    expect(looksLikeRecipe("200 g Mehl")).toBe(false);
  });

  it("lehnt eine reine Zutatenliste ohne Zubereitung ab", () => {
    // Der Fall aus der Praxis: Die YouTube-Beschreibung enthielt nur die
    // Mengenangaben, kein einziger Arbeitsschritt stand darin. Vorher genuegten
    // zwei Mengenangaben - dadurch wurde die Beschreibung akzeptiert und das
    // Transkript, das das Rezept enthielt, nie erstellt.
    const nurMengen = [
      "Zutaten für den Teig:",
      "500 g Mehl",
      "350 ml Wasser",
      "5 g Trockenhefe",
      "10 g Salz",
      "2 EL Olivenöl",
      "Zutaten für den Belag:",
      "400 g Tomaten",
      "250 g Mozzarella",
      "1 Bund Basilikum",
      "Viel Spaß beim Nachmachen und lasst mir gern ein Abo da!",
    ].join("\n");

    expect(nurMengen.length).toBeGreaterThan(120);
    expect(recipeSignals(nurMengen).mengen).toBeGreaterThanOrEqual(2);
    expect(looksLikeRecipe(nurMengen)).toBe(false);
  });

  it("nimmt dasselbe Rezept an, sobald die Zubereitung dabeisteht", () => {
    const mitSchritten = [
      "500 g Mehl, 350 ml Wasser, 5 g Trockenhefe und 10 g Salz verkneten.",
      "Den Teig zwei Stunden gehen lassen, dann von Hand ausrollen.",
      "Mit 400 g Tomaten belegen, 250 g Mozzarella darauf verteilen",
      "und bei 250 Grad im vorgeheizten Ofen backen.",
    ].join(" ");

    expect(looksLikeRecipe(mitSchritten)).toBe(true);
  });

  it("lehnt eine Zutatenliste mit einem beilaeufigen Verb ab", () => {
    // "zum Abschmecken" ist ein Zutatenhinweis, kein Arbeitsschritt - ein
    // einzelnes Verb darf die Entscheidung deshalb nicht kippen.
    const text =
      "Einkaufsliste für vier Portionen: 800 g Rinderhack, 300 ml Brühe, " +
      "2 Dosen Tomaten, 1 Bund Petersilie, 200 g Nudeln, Salz und Pfeffer " +
      "zum Abschmecken. Alle Zutaten findet ihr verlinkt in der Beschreibung.";

    expect(recipeSignals(text).schritte).toBe(1);
    expect(looksLikeRecipe(text)).toBe(false);
  });
});

describe("recipeSignals", () => {
  it("zaehlt Mengen und Zubereitungsschritte getrennt", () => {
    const { mengen, schritte } = recipeSignals(
      "200 g Mehl und 100 ml Milch verrühren, dann anbraten und servieren.",
    );
    expect(mengen).toBe(2);
    expect(schritte).toBe(3);
  });

  it("erkennt die Schritte eines Hefeteigs", () => {
    // Kneten, gehen lassen und ausrollen fehlten in der Verbliste - ein
    // vollstaendiges Teigrezept fiel dadurch faelschlich durch.
    const { schritte } = recipeSignals(
      "Den Teig kneten, eine Stunde gehen lassen und anschließend ausrollen.",
    );
    expect(schritte).toBe(3);
  });
});
