import { readFile } from "node:fs/promises";
import { generateJson, type InlineImage } from "../llm/gemini.ts";
import { getConfig } from "../config.ts";
import { mimeForFile } from "../lib/images.ts";

/**
 * Liest abfotografierte Rezepte.
 *
 * Bewusst zwei getrennte Gemini-Aufrufe statt einem: Hier wird nur *gelesen*
 * und aufgeteilt. Das Strukturieren uebernimmt danach dieselbe Stufe wie bei
 * Videos, mit demselben Prompt aus prompts/recipe.de.md.
 *
 * Das kostet eine Anfrage mehr, bringt aber zwei Dinge, die den Unterschied
 * machen, wenn etwas schiefgeht: Die Abschrift landet zugeklappt in Notion,
 * und man sieht damit sofort, ob das Modell die Buchseite falsch gelesen oder
 * den gelesenen Text falsch verstanden hat. Bei schlechtem Licht, gewoelbten
 * Seiten und Handschrift ist das fast immer die erste Frage.
 *
 * Diese Stufe entscheidet ausserdem, WIE VIELE Rezepte vorliegen. Eine
 * aufgeschlagene Doppelseite traegt haeufig zwei, ein abfotografiertes
 * Kochbuch Dutzende - und niemand will das von Hand vorsortieren.
 */

/** Was auf den Bildern zu sehen ist. */
export type PhotoKind = "rezept" | "zutatenliste" | "gericht" | "sonstiges";

export interface PhotoReading {
  /** Der abgeschriebene Text, so wie er auf den Bildern steht. */
  abschrift: string;
  art: PhotoKind;
  /**
   * Zeigt eines der Bilder dieses Rezepts das fertige Gericht (nicht eine
   * bedruckte Seite)? Entscheidet ueber das Notion-Titelbild.
   */
  zeigtGericht: boolean;
  /** Index des Bildes, das das Gericht zeigt - fuer das Titelbild. */
  gerichtBildIndex?: number;
  titel?: string;
  /** Was zu einem kochbaren Rezept fehlt. Leer = vollstaendig. */
  fehlt: string[];
  /** Absolute Bildnummern, auf denen dieses Rezept steht. */
  bildIndizes: number[];
}

const SCHEMA = {
  type: "object",
  properties: {
    rezepte: {
      type: "array",
      items: {
        type: "object",
        properties: {
          titel: { type: "string" },
          abschrift: {
            type: "string",
            description:
              "Der Text GENAU DIESES Rezepts, Zeile fuer Zeile abgeschrieben. " +
              "Keine Zusammenfassung, keine Ergaenzung, keine Umformulierung.",
          },
          art: { type: "string", enum: ["rezept", "zutatenliste", "gericht", "sonstiges"] },
          bild_indizes: { type: "array", items: { type: "integer" } },
          zeigt_gericht: { type: "boolean" },
          gericht_bild_index: { type: "integer" },
          fehlt: { type: "array", items: { type: "string" } },
          beginnt_vorher: { type: "boolean" },
          geht_weiter: { type: "boolean" },
        },
        required: ["abschrift", "art", "bild_indizes", "zeigt_gericht", "fehlt"],
      },
    },
  },
  required: ["rezepte"],
} as const;

function anweisung(bildAnzahl: number, erstesBild: number, weitereFolgen: boolean): string {
  const nummern =
    bildAnzahl === 1
      ? `Es ist genau ein Bild, seine Nummer ist ${erstesBild}.`
      : `Es sind ${bildAnzahl} Bilder, durchnummeriert von ${erstesBild} bis ${
          erstesBild + bildAnzahl - 1
        }.`;

  return `Du bekommst Fotos aus einem Kochbuch, einer Zeitschrift, von handschriftlichen
Rezeptkarten oder als Bildschirmfoto. ${nummern}

Deine Aufgabe hier ist **lesen und aufteilen** — noch nicht strukturieren.

Auf den Bildern können **mehrere Rezepte** stehen. Eine aufgeschlagene Doppelseite
trägt oft zwei, eine Zeitschriftenseite manchmal drei. Umgekehrt kann sich **ein**
Rezept über mehrere Bilder ziehen. Teile deshalb nach **Rezepten** auf, nicht nach
Bildern.

Antworte als JSON mit einer Liste \`rezepte\`. Für jedes Rezept:

- \`titel\`: Der Name des Gerichts, wenn er dasteht.
- \`abschrift\`: Der Text **genau dieses** Rezepts, Zeile für Zeile abgeschrieben.
  Mengenangaben, Überschriften und Reihenfolge exakt beibehalten. Nichts umschreiben,
  nichts zusammenfassen, nichts ergänzen. Text, der zu einem **anderen** Rezept
  gehört, darf hier nicht auftauchen. Ist eine Stelle unleserlich, schreib dort
  [unleserlich].
- \`art\`:
  - \`rezept\` — Zutaten **und** Zubereitung stehen da.
  - \`zutatenliste\` — nur Zutaten bzw. Mengen, keine Arbeitsschritte.
  - \`gericht\` — ein Foto des fertigen Essens, kein nennenswerter Text.
  - \`sonstiges\` — Buchdeckel, Inhaltsverzeichnis, Vorwort, unleserlich.
- \`bild_indizes\`: Auf welchen Bildnummern dieses Rezept steht.
- \`zeigt_gericht\`: true, wenn eines dieser Bilder **das zubereitete Essen** zeigt.
  Eine bedruckte Seite mit einem kleinen Foto darauf zählt **nicht** — gemeint ist
  ein Bild, das selbst das Gericht zeigt und als Titelbild taugen würde.
- \`gericht_bild_index\`: Die Nummer dieses Bildes.
- \`fehlt\`: Was zu einem kochbaren Rezept fehlt, kurze Stichworte auf Deutsch, z.B.
  ["Zubereitungsschritte", "Backtemperatur"]. Steht alles da, gib eine leere Liste
  zurück. Sei ehrlich: Eine abgeschnittene Seite, deren Anleitung mitten im Satz
  endet, ist unvollständig.
- \`beginnt_vorher\`: true, wenn dieses Rezept erkennbar **schon vor Bild ${erstesBild}**
  angefangen hat — die Seite also mitten im Rezept einsetzt.${
    weitereFolgen
      ? `
- \`geht_weiter\`: true, wenn dieses Rezept am Ende des letzten Bildes **nicht fertig**
  ist und auf dem nächsten Bild weitergeht.`
      : `
- \`geht_weiter\`: hier immer false, es folgen keine weiteren Bilder.`
  }

Wichtig:

- Ist nur **ein** Rezept zu sehen, enthält die Liste genau einen Eintrag.
- Seiten ohne Rezept (Vorwort, Register, Buchdeckel) kommen als \`sonstiges\` in die
  Liste — wirf sie nicht weg, aber erfinde für sie auch kein Rezept.
- Erfinde **niemals** ein Rezept, das nicht auf den Bildern steht.`;
}

export async function loadImages(paths: string[]): Promise<InlineImage[]> {
  return Promise.all(
    paths.map(async (path) => {
      const mimeType = mimeForFile(path);
      if (!mimeType) throw new Error(`Bildformat nicht unterstützt: ${path}`);
      return { mimeType, data: await readFile(path) };
    }),
  );
}

/** Ein Rezept, wie es aus einem einzelnen Block zurueckkommt. */
interface ChunkRecipe extends PhotoReading {
  beginntVorher: boolean;
  gehtWeiter: boolean;
}

export type ProgressFn = (step: string) => void;

/**
 * Liest alle Bilder und gibt die darauf gefundenen Rezepte zurueck.
 *
 * Die Bilder gehen blockweise an das Modell, nicht alle auf einmal. Ein ganzes
 * Kochbuch in einer Anfrage waere weder vom Kontext noch von der Sorgfalt her
 * sinnvoll - bei dreissig Seiten in einem Rutsch faengt jedes Modell an,
 * Rezepte zusammenzuziehen oder zu ueberspringen.
 */
export async function readPhotos(
  paths: string[],
  onProgress: ProgressFn = () => {},
): Promise<PhotoReading[]> {
  if (!paths.length) throw new Error("Es wurden keine Fotos übergeben.");

  const cfg = getConfig();
  const groesse = Math.max(1, cfg.visionChunkSize);
  const bloecke: number[][] = [];
  for (let i = 0; i < paths.length; i += groesse) {
    bloecke.push(paths.slice(i, i + groesse).map((_, k) => i + k));
  }

  const ergebnisse: ChunkRecipe[][] = [];

  for (const [nr, indizes] of bloecke.entries()) {
    if (bloecke.length > 1) {
      onProgress(`Fotos werden gelesen (${nr + 1}/${bloecke.length})`);
    }

    const ersterIndex = indizes[0] ?? 0;
    const bilder = await loadImages(indizes.map((i) => paths[i] as string));
    const weitereFolgen = nr < bloecke.length - 1;

    const raw = (await generateJson({
      prompt: anweisung(indizes.length, ersterIndex, weitereFolgen),
      schema: SCHEMA,
      images: bilder,
      model: cfg.visionModel || undefined,
    })) as Record<string, unknown>;

    ergebnisse.push(normalizeChunk(raw, ersterIndex, indizes.length));
  }

  return stitchChunks(ergebnisse);
}

/**
 * Bringt die Antwort eines Blocks in Form.
 *
 * Getrennt und exportiert, damit sich die Sonderfaelle ohne API-Zugriff
 * pruefen lassen - und davon gibt es hier viele.
 */
export function normalizeChunk(
  raw: Record<string, unknown>,
  ersterIndex: number,
  bildAnzahl: number,
): ChunkRecipe[] {
  const liste = Array.isArray(raw.rezepte) ? raw.rezepte : [];
  const gueltig = (i: unknown): i is number =>
    typeof i === "number" &&
    Number.isInteger(i) &&
    i >= ersterIndex &&
    i < ersterIndex + bildAnzahl;

  const rezepte: ChunkRecipe[] = [];

  for (const eintrag of liste) {
    if (!eintrag || typeof eintrag !== "object") continue;
    const r = eintrag as Record<string, unknown>;

    const abschrift = typeof r.abschrift === "string" ? r.abschrift.trim() : "";

    const art: PhotoKind = (["rezept", "zutatenliste", "gericht", "sonstiges"] as const).includes(
      r.art as PhotoKind,
    )
      ? (r.art as PhotoKind)
      : "sonstiges";

    // Zeigt das Modell auf Bilder, die es in diesem Block nicht gibt, waere die
    // Zuordnung geraten. Dann lieber der ganze Block als Rueckfallebene.
    const bildIndizes = (Array.isArray(r.bild_indizes) ? r.bild_indizes : []).filter(gueltig);
    const indizes = bildIndizes.length
      ? [...new Set(bildIndizes)].sort((a, b) => a - b)
      : Array.from({ length: bildAnzahl }, (_, k) => ersterIndex + k);

    const gerichtIndex = gueltig(r.gericht_bild_index) ? r.gericht_bild_index : undefined;
    // Nur gelten lassen, wenn das Bild auch zu diesem Rezept gehoert - sonst
    // bekaeme ein Rezept das Titelbild eines anderen.
    const zeigtGericht = r.zeigt_gericht === true && gerichtIndex !== undefined
      && indizes.includes(gerichtIndex);

    const titel = typeof r.titel === "string" && r.titel.trim() ? r.titel.trim() : undefined;

    rezepte.push({
      abschrift,
      art,
      zeigtGericht,
      ...(zeigtGericht ? { gerichtBildIndex: gerichtIndex } : {}),
      ...(titel ? { titel } : {}),
      fehlt: Array.isArray(r.fehlt)
        ? r.fehlt.filter((f): f is string => typeof f === "string" && f.trim() !== "")
        : [],
      bildIndizes: indizes,
      beginntVorher: r.beginnt_vorher === true,
      gehtWeiter: r.geht_weiter === true,
    });
  }

  return rezepte;
}

/** Je vollstaendiger, desto hoeher - entscheidet beim Zusammenfuegen. */
const RANG: Record<PhotoKind, number> = { rezept: 3, zutatenliste: 2, gericht: 1, sonstiges: 0 };

/**
 * Fuegt die Bloecke zusammen und naeht dabei Rezepte zusammen, die ueber eine
 * Blockgrenze laufen.
 *
 * Ohne das waere ein Rezept, dessen Zutaten auf Bild 4 und dessen Zubereitung
 * auf Bild 5 steht, bei einer Blockgroesse von 4 in zwei Haelften zerfallen -
 * und beide Haelften waeren fuer sich unvollstaendig.
 */
export function stitchChunks(bloecke: ChunkRecipe[][]): PhotoReading[] {
  const alle: ChunkRecipe[] = [];

  for (const block of bloecke) {
    for (const [i, rezept] of block.entries()) {
      const vorheriges = alle[alle.length - 1];
      // Nur das ERSTE Rezept eines Blocks kann die Fortsetzung des letzten
      // sein. Innerhalb eines Blocks hat das Modell bereits aufgeteilt.
      const istFortsetzung =
        i === 0 && vorheriges !== undefined && vorheriges.gehtWeiter && rezept.beginntVorher;

      if (istFortsetzung && vorheriges) {
        vorheriges.abschrift = [vorheriges.abschrift, rezept.abschrift]
          .filter(Boolean)
          .join("\n");
        vorheriges.bildIndizes = [
          ...new Set([...vorheriges.bildIndizes, ...rezept.bildIndizes]),
        ].sort((a, b) => a - b);
        vorheriges.fehlt = [...new Set([...vorheriges.fehlt, ...rezept.fehlt])];
        vorheriges.art = RANG[rezept.art] > RANG[vorheriges.art] ? rezept.art : vorheriges.art;
        vorheriges.titel ??= rezept.titel;
        if (!vorheriges.zeigtGericht && rezept.zeigtGericht) {
          vorheriges.zeigtGericht = true;
          vorheriges.gerichtBildIndex = rezept.gerichtBildIndex;
        }
        vorheriges.gehtWeiter = rezept.gehtWeiter;
        continue;
      }

      alle.push({ ...rezept });
    }
  }

  return alle.map(({ beginntVorher: _b, gehtWeiter: _g, ...rest }) => rest);
}

/**
 * Welche der gelesenen Rezepte taugen ueberhaupt etwas?
 *
 * Bei einem abfotografierten Kochbuch sind Vorwort, Register und Buchdeckel
 * unvermeidlich mit dabei. Die sollen weder ein Rezept ergeben noch den
 * ganzen Lauf scheitern lassen - sie werden einfach uebergangen.
 */
export function usableReadings(readings: PhotoReading[]): PhotoReading[] {
  return readings.filter((r) => !(r.art === "sonstiges" && r.abschrift.length < 120));
}

/**
 * Soll die KI das Rezept ergaenzen - und wenn ja, wie weit?
 *
 *   abtippen  = alles da, nichts erfinden (wie bei Videos)
 *   ergaenzen = Grundgeruest da, Luecken werden gefuellt und gekennzeichnet
 *   erfinden  = nur ein Bild vom Gericht, das Rezept entsteht komplett neu
 */
export type RecipeMode = "abtippen" | "ergaenzen" | "erfinden";

export function modeFor(reading: PhotoReading): RecipeMode {
  if (reading.art === "rezept" && reading.fehlt.length === 0) return "abtippen";
  // Ohne nennenswerten Text gibt es nichts zu ergaenzen - nur noch zu erfinden.
  if (reading.art === "gericht" || reading.abschrift.length < 40) return "erfinden";
  return "ergaenzen";
}
