/**
 * Wandelt WebVTT/SRT-Untertitel in Fliesstext.
 *
 * YouTubes Auto-Captions sind hier die eigentliche Herausforderung: sie rollen Zeile
 * fuer Zeile hoch, wodurch jede Zeile im naechsten Cue wiederholt wird. Roh eingelesen
 * bekommt man den Text zwei- bis dreifach - und ein Modell, das aus dieser Wiederholung
 * dann falsche Mengen liest.
 */

const TIMESTAMP = /^\d{1,2}:\d{2}(:\d{2})?[.,]\d{3}\s*-->/;

/** Entfernt Cue-Tags wie <00:00:12.345><c> und HTML-Reste. */
function stripTags(line: string): string {
  return line
    .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{3}>/g, "")
    .replace(/<\/?c[^>]*>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

export function parseVtt(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (line.startsWith("NOTE") || line.startsWith("STYLE")) continue;
    if (line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (TIMESTAMP.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // SRT-Cue-Nummer

    const text = stripTags(line);
    if (!text) continue;

    // Das Rolling-Window der Auto-Captions: identische Zeile erneut, oder die neue
    // Zeile ist in der vorigen bereits vollstaendig enthalten.
    const prev = out[out.length - 1];
    if (prev === text) continue;
    if (prev && prev.endsWith(text)) continue;
    if (prev && text.startsWith(prev)) {
      out[out.length - 1] = text;
      continue;
    }
    out.push(text);
  }

  return collapse(out.join(" "));
}

/** Zieht doppelte Leerzeichen zusammen und repariert Leerzeichen vor Satzzeichen. */
function collapse(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/**
 * Grobe Schaetzung, ob ein Text ueberhaupt ein Rezept enthaelt. Verhindert, dass wir
 * uns eine lange Kanal-Werbung als "genug Text" verkaufen und die Transkription
 * ueberspringen.
 */
export function looksLikeRecipe(text: string): boolean {
  if (text.length < 120) return false;

  const units =
    /\b(\d+([.,]\d+)?)\s*(g|kg|ml|l|el|tl|prise|prisen|stück|stk|dose|dosen|pkg|packung|cup|cups|tbsp|tsp|oz|lb|pound|ounce)\b/gi;
  const unitHits = (text.match(units) ?? []).length;

  const verbs =
    /\b(anbraten|braten|backen|kochen|rühren|verrühren|schneiden|würfeln|hacken|mischen|vermengen|schwenken|köcheln|marinieren|abschmecken|servieren|erhitzen|bake|fry|stir|chop|simmer|whisk|season)\b/gi;
  const verbHits = (text.match(verbs) ?? []).length;

  return unitHits >= 2 || (unitHits >= 1 && verbHits >= 2) || verbHits >= 4;
}
