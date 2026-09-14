import { describe, it, expect } from "vitest";
import { parseVtt, looksLikeRecipe } from "../src/extract/vtt.ts";

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
});
