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
 * Grobe Schaetzung, ob ein Text ueberhaupt ein Rezept enthaelt.
 *
 * Entscheidend sind ZWEI Dinge, nicht eines: Mengen und Zubereitung. Frueher
 * genuegten zwei Mengenangaben - damit bestand eine blosse Zutatenliste aus
 * einer Videobeschreibung den Test, obwohl darin kein einziger Arbeitsschritt
 * stand. Das Ergebnis war ein Rezept ohne Anleitung, und die Transkription,
 * die den Fehler behoben haette, lief nie an.
 *
 * Mengen allein sind eine Einkaufsliste.
 */
export function looksLikeRecipe(text: string): boolean {
  const { mengen, schritte } = recipeSignals(text);

  if (text.length < 120) return false;

  // Ohne erkennbare Zubereitung ist es kein Rezept - egal wie viele Mengen
  // darin stehen. Ein einzelnes Verb kann auch in einer Zutatenliste stehen
  // ("Salz zum Abschmecken"), deshalb zwei.
  if (schritte < 2) return false;

  // Zusammen mit Mengenangaben genuegen diese zwei Hinweise; ohne Mengen
  // braucht es mehr, weil dann nur dieses eine Signal uebrig bleibt.
  return mengen >= 2 || schritte >= 4;
}

/** Die Zaehlwerte hinter der Entscheidung - auch fuer das Protokoll nuetzlich. */
export function recipeSignals(text: string): { mengen: number; schritte: number } {
  const units =
    /\b(\d+([.,]\d+)?)\s*(g|kg|ml|l|el|tl|msp|prise|prisen|stück|stk|dose|dosen|pkg|packung|bund|zehen?|cup|cups|tbsp|tsp|oz|lb|pound|ounce)\b/gi;

  // Bewusst breit: Ein Pizzateig wird geknetet, gehen gelassen und ausgerollt -
  // ohne diese Woerter faellt ein vollstaendiges Rezept faelschlich durch.
  const verbs =
    /\b(anbraten|braten|backen|kochen|garen|duensten|dünsten|anschwitzen|köcheln|koecheln|schmoren|grillen|frittieren|rühren|ruehren|verrühren|verruehren|kneten|falten|formen|ausrollen|schneiden|würfeln|wuerfeln|hacken|reiben|raspeln|mischen|vermengen|unterheben|schwenken|wenden|marinieren|abschmecken|würzen|wuerzen|salzen|pfeffern|servieren|anrichten|erhitzen|aufgießen|aufgiessen|ablöschen|abloeschen|abgießen|abgiessen|pürieren|puerieren|bestreuen|beträufeln|betraeufeln|belegen|füllen|fuellen|bestreichen|ruhen lassen|gehen lassen|abkühlen|abkuehlen|auftauen|vorheizen|bake|fry|stir|chop|simmer|whisk|season|knead|fold|roll|mix|bl?end|serve|preheat)\b/gi;

  return {
    mengen: (text.match(units) ?? []).length,
    schritte: (text.match(verbs) ?? []).length,
  };
}
