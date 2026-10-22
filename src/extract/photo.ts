import { readFile } from "node:fs/promises";
import { generateJson, type InlineImage } from "../llm/gemini.ts";
import { getConfig } from "../config.ts";
import { mimeForFile } from "../lib/images.ts";

/**
 * Liest abfotografierte Rezepte.
 *
 * Bewusst zwei getrennte Gemini-Aufrufe statt einem: Hier wird nur *gelesen*,
 * was auf den Bildern steht. Das Strukturieren uebernimmt danach dieselbe
 * Stufe wie bei Videos, mit demselben Prompt aus prompts/recipe.de.md.
 *
 * Das kostet eine Anfrage mehr, bringt aber zwei Dinge, die den Unterschied
 * machen, wenn etwas schiefgeht: Die Abschrift landet zugeklappt in Notion,
 * und man sieht damit sofort, ob das Modell die Buchseite falsch gelesen oder
 * den gelesenen Text falsch verstanden hat. Bei schlechtem Licht, gewoelbten
 * Seiten und Handschrift ist das fast immer die erste Frage.
 */

/** Was auf den Bildern zu sehen ist. */
export type PhotoKind = "rezept" | "zutatenliste" | "gericht" | "sonstiges";

export interface PhotoReading {
  /** Der abgeschriebene Text, so wie er auf den Bildern steht. */
  abschrift: string;
  art: PhotoKind;
  /**
   * Zeigt mindestens eines der Bilder das fertige Gericht (nicht eine
   * bedruckte Seite)? Entscheidet ueber das Notion-Titelbild.
   */
  zeigtGericht: boolean;
  /** Index des Bildes, das das Gericht zeigt - fuer das Titelbild. */
  gerichtBildIndex?: number;
  titel?: string;
  /** Was zu einem kochbaren Rezept fehlt. Leer = vollstaendig. */
  fehlt: string[];
}

const SCHEMA = {
  type: "object",
  properties: {
    abschrift: {
      type: "string",
      description:
        "Der gesamte lesbare Text der Bilder, Zeile fuer Zeile abgeschrieben. " +
        "Keine Zusammenfassung, keine Ergaenzung, keine Umformulierung.",
    },
    art: {
      type: "string",
      enum: ["rezept", "zutatenliste", "gericht", "sonstiges"],
    },
    zeigt_gericht: { type: "boolean" },
    gericht_bild_index: { type: "integer" },
    titel: { type: "string" },
    fehlt: { type: "array", items: { type: "string" } },
  },
  required: ["abschrift", "art", "zeigt_gericht", "fehlt"],
} as const;

const ANWEISUNG = `Du bekommst ein oder mehrere Fotos. Sie stammen aus einem Kochbuch, einer
Zeitschrift, einer handschriftlichen Rezeptkarte oder sind ein Bildschirmfoto.

Deine einzige Aufgabe hier ist **lesen und einordnen** — noch nicht strukturieren.

Antworte als JSON:

- \`abschrift\`: Der gesamte lesbare Text, Zeile fuer Zeile abgeschrieben. Behalte
  Mengenangaben, Ueberschriften und die Reihenfolge exakt bei. Schreibe nichts um,
  fasse nichts zusammen, ergaenze nichts. Gehoeren mehrere Bilder zusammen (etwa
  eine Doppelseite oder ein zweiseitiges Rezept), haenge sie in der gegebenen
  Reihenfolge aneinander. Ist ein Bild unleserlich, schreib an der Stelle [unleserlich].
  Zeigt gar kein Bild Text, gib einen leeren String zurueck.
- \`art\`: Was liegt vor?
  - \`rezept\` — vollstaendiges Rezept: Zutaten **und** Zubereitung stehen da.
  - \`zutatenliste\` — nur Zutaten bzw. Mengen, keine Arbeitsschritte.
  - \`gericht\` — ein Foto des fertigen Essens, kein nennenswerter Text.
  - \`sonstiges\` — alles andere (Buchdeckel, Inhaltsverzeichnis, unleserlich).
- \`zeigt_gericht\`: true, wenn mindestens ein Bild **das zubereitete Essen** zeigt.
  Eine bedruckte Seite mit einem kleinen Foto darauf zaehlt **nicht** — gemeint ist
  ein Bild, das selbst das Gericht zeigt und als Titelbild taugen wuerde.
- \`gericht_bild_index\`: Nummer dieses Bildes, beginnend bei 0.
- \`titel\`: Der Name des Gerichts, wenn er dasteht.
- \`fehlt\`: Was zu einem kochbaren Rezept fehlt, in kurzen Stichworten auf Deutsch
  — z.B. ["Zubereitungsschritte", "Mengen fuer den Teig", "Backtemperatur"].
  Steht alles da, gib eine leere Liste zurueck. Sei hier ehrlich: Eine
  abgeschnittene Seite, bei der die Anleitung mitten im Satz endet, ist
  unvollstaendig.`;

export async function loadImages(paths: string[]): Promise<InlineImage[]> {
  return Promise.all(
    paths.map(async (path) => {
      const mimeType = mimeForFile(path);
      if (!mimeType) throw new Error(`Bildformat nicht unterstützt: ${path}`);
      return { mimeType, data: await readFile(path) };
    }),
  );
}

export async function readPhotos(paths: string[]): Promise<PhotoReading> {
  if (!paths.length) throw new Error("Es wurden keine Fotos übergeben.");

  const cfg = getConfig();
  const images = await loadImages(paths);

  const raw = (await generateJson({
    prompt: ANWEISUNG,
    schema: SCHEMA,
    images,
    model: cfg.visionModel || undefined,
  })) as Record<string, unknown>;

  return normalizeReading(raw, images.length);
}

/**
 * Bringt die Modellantwort in Form. Getrennt und exportiert, damit die
 * Sonderfaelle ohne API-Zugriff pruefbar sind.
 */
export function normalizeReading(raw: Record<string, unknown>, imageCount: number): PhotoReading {
  const abschrift = typeof raw.abschrift === "string" ? raw.abschrift.trim() : "";

  const art: PhotoKind = (["rezept", "zutatenliste", "gericht", "sonstiges"] as const).includes(
    raw.art as PhotoKind,
  )
    ? (raw.art as PhotoKind)
    : "sonstiges";

  const fehlt = Array.isArray(raw.fehlt)
    ? raw.fehlt.filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];

  const index = typeof raw.gericht_bild_index === "number" ? raw.gericht_bild_index : undefined;
  // Ein Index ausserhalb der gelieferten Bilder waere eine stille Fehlzuordnung:
  // Dann lieber kein Titelbild als das falsche.
  const gueltigerIndex =
    index !== undefined && Number.isInteger(index) && index >= 0 && index < imageCount
      ? index
      : undefined;

  const zeigtGericht = raw.zeigt_gericht === true && gueltigerIndex !== undefined;

  const titel = typeof raw.titel === "string" && raw.titel.trim() ? raw.titel.trim() : undefined;

  return {
    abschrift,
    art,
    zeigtGericht,
    ...(zeigtGericht ? { gerichtBildIndex: gueltigerIndex } : {}),
    ...(titel ? { titel } : {}),
    fehlt,
  };
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
