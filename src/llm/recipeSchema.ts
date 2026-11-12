import { z } from "zod";

/**
 * Das Ausgabeschema entspricht exakt den sechs Feldern aus prompts/recipe.de.md.
 * Aenderst du hier etwas, passe auch den Prompt und src/notion/blocks.ts an.
 */

/**
 * "", null und fehlende Felder werden zu null - das Modell laesst Optionales gern
 * weg, und die Web-App schickt beim Korrigieren zurueck, was sie bekommen hat.
 *
 * `nullish` statt `optional` ist dabei wesentlich: Sonst gibt das Schema zwar null
 * aus, nimmt es aber nicht wieder an - und das erneute Speichern eines
 * korrigierten Rezepts scheitert an einem Feld, das nie befuellt war.
 */
const optionalText = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null));

export const ZutatSchema = z.object({
  /** "200 g", "1 EL", "1 cup (ca. 120 g)" - null, wenn im Video keine Menge genannt wird. */
  menge: optionalText,
  zutat: z.string().min(1),
  /**
   * Dieselbe Zutat zerlegt - fuer Mealie. Nur so fasst dessen Einkaufsliste
   * "200 g Mehl" und "100 g Mehl" zu einer Zeile zusammen, und nur so
   * funktioniert die Portionsumrechnung. Notion nutzt weiter menge/zutat.
   *
   * Alles optional: Bei "eine Prise Salz" oder "nach Geschmack" gibt es keine
   * Zahl. Und Rezepte, die vor dieser Erweiterung in der Datenbank gelandet
   * sind, haben die Felder gar nicht - deshalb ist auch `undefined` erlaubt
   * und nicht nur null. Der Typ soll das zeigen, statt es zu verschweigen.
   */
  anzahl: z.number().positive().nullish(),
  einheit: z.string().nullish(),
  lebensmittel: z.string().nullish(),
});

export const ZutatenGruppeSchema = z.object({
  /** "Zutaten" bei einfachen Rezepten, sonst z.B. "Fuer den Teig". */
  gruppe: z.string().min(1).default("Zutaten"),
  eintraege: z.array(ZutatSchema).min(1),
});

export const RecipeSchema = z.object({
  emoji: z.string().min(1).max(8).default("🍽️"),
  titel: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  zeit_text: z.string().default(""),
  zeit_minuten: z.number().int().positive().nullish().transform((v) => v ?? null),
  zutaten: z.array(ZutatenGruppeSchema).min(1),
  schritte: z.array(z.string().min(1)).min(1),
  /**
   * Parallel zu `schritte`: welche Zutaten jeder Schritt verwendet - beim
   * Namen, so wie er in `zutat` steht. Daraus stehen die Zutaten samt Menge
   * neben dem Schritt: in Notion als Zeile darunter, in Mealie als
   * Verknuepfung, die der Kochmodus anzeigt (siehe stepIngredients.ts). Ueber Namen statt Nummern, weil sich ein Modell beim
   * Abzaehlen leicht vertut und eine im Editor geloeschte Zutat sonst alle
   * folgenden Nummern verschoebe.
   *
   * Optional: aeltere Rezepte haben es nicht, und fehlt es, gibt es eben keine
   * Verknuepfung - am Rezept selbst aendert das nichts.
   */
  schritte_zutaten: z.array(z.array(z.string())).nullish(),
  pro_tipp: z.string().default(""),
  /** Optional, nur befuellt wenn die Notion-DB passende Spalten hat. */
  portionen: optionalText,
  kueche: optionalText,
  schwierigkeit: optionalText,
  /**
   * Grundzutaten ohne Mengen fuer eine multi_select-Spalte - damit laesst sich in
   * Notion nach "was kann ich mit Haehnchen kochen" filtern. Bewusst getrennt von
   * `zutaten`: dort stehen die Mengen, hier nur die Namen.
   */
  zutaten_namen: z.array(z.string().min(1)).default([]),
});

export type Recipe = z.infer<typeof RecipeSchema>;
export type Zutat = z.infer<typeof ZutatSchema>;
export type ZutatenGruppe = z.infer<typeof ZutatenGruppeSchema>;

/**
 * Schema fuer Geminis strukturierte Ausgabe - bewusst von Hand gepflegt statt aus Zod
 * generiert.
 *
 * Zwei Dinge sind hier Absicht:
 * 1. Kein "nullable" - das ist OpenAPI-Dialekt, nicht JSON Schema. Optionale Felder
 *    stehen stattdessen einfach nicht in "required" und duerfen fehlen.
 * 2. Keine Defaults - die setzt Zod nach dem Empfang.
 */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    emoji: { type: "string", description: "Ein einzelnes passendes Koch-Emoji" },
    titel: { type: "string", description: "Name des Gerichts, ohne Emoji" },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "3-5 Schlagworte ohne fuehrendes #",
    },
    zeit_text: {
      type: "string",
      description: 'Geschaetzte Gesamtdauer als Text, z.B. "ca. 30 Minuten"',
    },
    zeit_minuten: { type: "integer", description: "Dieselbe Dauer in Minuten" },
    zutaten: {
      type: "array",
      description: "Nach Verwendung gruppiert. Einfache Rezepte: eine Gruppe 'Zutaten'.",
      items: {
        type: "object",
        properties: {
          gruppe: { type: "string" },
          eintraege: {
            type: "array",
            items: {
              type: "object",
              properties: {
                menge: {
                  type: "string",
                  description: "Weglassen, wenn im Material keine Menge genannt wird",
                },
                zutat: { type: "string" },
                anzahl: {
                  type: "number",
                  description:
                    "Die Menge als Zahl: 200 bei '200 g', 0.5 bei '1/2 TL', 2 bei '2 Eier'. " +
                    "Bei nicht-metrischen Angaben die metrische Umrechnung. Weglassen, " +
                    "wenn keine Zahl genannt ist ('eine Prise', 'nach Geschmack').",
                },
                einheit: {
                  type: "string",
                  description:
                    "Die Einheit in deutscher Kurzform: g, kg, ml, l, EL, TL, Prise, " +
                    "Stück, Dose, Bund, Zehe, Packung. Weglassen bei bloßen Stückzahlen " +
                    "wie '2 Eier'.",
                },
                lebensmittel: {
                  type: "string",
                  description:
                    "Nur das Lebensmittel, im Singular, ohne Menge und ohne " +
                    "Zubereitungshinweis: 'Zwiebel' bei '2 Zwiebeln, fein gewürfelt'.",
                },
              },
              required: ["zutat"],
            },
          },
        },
        required: ["gruppe", "eintraege"],
      },
    },
    schritte: {
      type: "array",
      items: { type: "string" },
      description: "Ein Arbeitsschritt pro Eintrag, im Imperativ, ohne eigene Nummerierung",
    },
    schritte_zutaten: {
      type: "array",
      description:
        "Genau so viele Einträge wie schritte, in derselben Reihenfolge. Für jeden " +
        "Schritt die Zutaten, die darin verwendet werden - jeweils exakt so " +
        "geschrieben wie im Feld 'zutat'. Leere Liste für Schritte ohne Zutaten.",
      items: { type: "array", items: { type: "string" } },
    },
    pro_tipp: { type: "string", description: "Leer lassen, wenn im Material keiner vorkommt" },
    portionen: { type: "string" },
    kueche: { type: "string" },
    schwierigkeit: {
      type: "string",
      description: "Genau eines von: Leicht, Mittel, Schwer",
    },
    zutaten_namen: {
      type: "array",
      items: { type: "string" },
      description:
        "Die kennzeichnenden Zutaten als blosse Namen, ohne Mengen und ohne " +
        "Zubereitungshinweise, im Singular. Grundausstattung wie Salz, Pfeffer, " +
        "Wasser oder Oel weglassen. Hoechstens 12.",
    },
  },
  required: ["emoji", "titel", "tags", "zeit_text", "zutaten", "schritte"],
} as const;

/**
 * Ist das ueberhaupt ein brauchbares Rezept?
 *
 * Das Modell antwortet auch auf duenne Vorlagen pflichtschuldig im richtigen
 * Format - aus einer Pinterest-Ueberschrift wurde so eine Karte mit drei
 * Zutaten ohne Mengen und einem einzigen Schritt. Formal gueltig, zum Kochen
 * unbrauchbar, und in der Datenbank schlimmer als gar kein Eintrag: Sie sieht
 * aus wie ein Ergebnis.
 *
 * Gibt den Grund zurueck, oder einen leeren String wenn alles passt.
 */
export function recipeShortcoming(recipe: Recipe): string {
  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);
  const mitMenge = eintraege.filter((e) => e.menge && e.menge.trim()).length;

  if (recipe.schritte.length < 2) {
    return "die Anleitung besteht aus einem einzigen Schritt";
  }
  if (eintraege.length < 3) {
    return `es wurden nur ${eintraege.length} Zutaten gefunden`;
  }
  // Ganz ohne Mengen laesst sich nicht kochen. Bei sehr vielen Zutaten kann es
  // ein bewusst ungefaehr gehaltenes Rezept sein - dann lassen wir es durch.
  if (mitMenge === 0 && eintraege.length < 6) {
    return "keine einzige Zutat hat eine Mengenangabe";
  }
  return "";
}
