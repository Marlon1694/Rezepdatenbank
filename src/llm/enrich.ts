import { generateJson } from "./gemini.ts";
import type { Recipe } from "./recipeSchema.ts";

/**
 * Wertet ein Rezept auf, das vor den zerlegten Zutaten gespeichert wurde.
 *
 * Ergaenzt werden genau zwei Dinge:
 *   - je Zutat Anzahl, Einheit und Lebensmittel (fuer Mealie: Portionen
 *     umrechnen, Einkaufsliste zusammenfassen)
 *   - je Schritt die Zutaten, die er verwendet (Notion: Zeile unter dem
 *     Schritt, Mealie: Kochmodus)
 *
 * Alles andere bleibt Wort fuer Wort, wie es ist: Das Modell sieht das Rezept
 * zwar, liefert aber nur Nummern und die drei Felder zurueck. Umschreiben
 * kann es so nichts.
 */

/** Fehlt dem Rezept, was seit der Erweiterung dazugehoert? */
export function needsEnrichment(recipe: Recipe): boolean {
  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);
  const zerlegt = eintraege.some((z) => z.lebensmittel);
  const verknuepft = (recipe.schritte_zutaten ?? []).some((s) => s.length > 0);
  return !zerlegt || !verknuepft;
}

export const ENRICH_SCHEMA = {
  type: "object",
  properties: {
    zutaten: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nr: { type: "integer", description: "Nummer der Zutat aus der Liste" },
          anzahl: {
            type: "number",
            description:
              "Die Menge als Zahl: 200 bei '200 g', 0.5 bei '1/2 TL', 2 bei '2 Eier'. Bei " +
              "nicht-metrischen Angaben die metrische Umrechnung. Bei einer Spanne " +
              "('1-2 Zehen') die untere Zahl. Weglassen, wenn keine Zahl genannt ist.",
          },
          einheit: {
            type: "string",
            description:
              "Deutsche Kurzform: g, kg, ml, l, EL, TL, Prise, Stück, Dose, Bund, Zehe, " +
              "Packung. Weglassen bei bloßen Stückzahlen wie '2 Eier'.",
          },
          lebensmittel: {
            type: "string",
            description:
              "Nur das Lebensmittel, so wie es auf einem Einkaufszettel steht: im " +
              "Singular, ohne Menge, ohne Zubereitung, Form oder Zuschnitt. 'Zwiebel' " +
              "bei '2 Zwiebeln, fein gewürfelt', 'Hähnchenbrust' bei " +
              "'Hähnchenbruststücke', 'Brokkoli' bei 'Brokkoliröschen', 'Orzo' bei " +
              "'Orzo (Risoni-Nudeln)'. Was abgemessen wird, bleibt das abgemessene " +
                    "Produkt: 'Zitronensaft' bei '2 EL Zitronensaft', aber 'Zitrone' bei " +
                    "'Saft einer Zitrone'. Keine Beispiele oder Alternativen: 'Petersilie' " +
              "bei 'Kräuter, z. B. Petersilie oder Basilikum'.",
          },
        },
        required: ["nr"],
      },
    },
    schritte: {
      type: "array",
      items: {
        type: "object",
        properties: {
          schritt: { type: "integer", description: "Nummer des Schritts" },
          zutaten: {
            type: "array",
            items: { type: "integer" },
            description: "Nummern der Zutaten, die in diesem Schritt verwendet werden",
          },
        },
        required: ["schritt", "zutaten"],
      },
    },
    portionen: {
      type: "string",
      description:
        "Nur wenn oben 'Portionen: unbekannt' steht: aus den Mengen geschätzt, z.B. '4'. " +
        "Bei Brot oder Gebäck die Menge mit Einheit: '1 Brot', '12 Stück'.",
    },
  },
  required: ["zutaten", "schritte"],
} as const;

export function enrichPrompt(recipe: Recipe): string {
  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);
  return [
    "Hier ist ein Rezept. Ändere nichts daran – ergänze nur Daten dazu.",
    "",
    `Rezept: ${recipe.titel}`,
    `Portionen: ${recipe.portionen ?? "unbekannt"}`,
    "",
    "Zutaten:",
    ...eintraege.map((z, i) => `${i + 1}. ${[z.menge, z.zutat].filter(Boolean).join(" ")}`),
    "",
    "Schritte:",
    ...recipe.schritte.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Aufgabe:",
    "1. Zerlege jede Zutat in Anzahl, Einheit und Lebensmittel.",
    "2. Nenne für jeden Schritt die Nummern der Zutaten, die in diesem Schritt " +
      "hinzukommen oder zum ersten Mal verarbeitet werden. Auch indirekt Genanntes " +
      "zählt: „die Gewürze“ meint die Gewürze aus der Liste. Was schon in einem " +
      "früheren Schritt verarbeitet wurde und jetzt nur als „Teig“, „Masse“ oder " +
      "„Sauce“ weiterläuft, zählt nicht. Eine Zutat erscheint später nur noch einmal, " +
      "wenn der Schritt sie ausdrücklich nennt („mit Salz abschmecken“, „die " +
      "restliche Butter“). Schritte ohne neue Zutaten bekommen eine leere Liste.",
    ...(recipe.portionen
      ? []
      : ["3. Schätze aus den Mengen, für wie viele Personen das Rezept reicht (Feld `portionen`)."]),
  ].join("\n");
}

type Antwort = {
  portionen?: unknown;
  zutaten?: { nr?: unknown; anzahl?: unknown; einheit?: unknown; lebensmittel?: unknown }[];
  schritte?: { schritt?: unknown; zutaten?: unknown }[];
};

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Fuehrt die Antwort mit dem Rezept zusammen. Rein und getrennt testbar:
 * Was nicht passt - falsche Nummern, negative Mengen -, wird verworfen statt
 * geraten.
 */
export function mergeEnrichment(
  recipe: Recipe,
  raw: unknown,
  opts: { ersetzen?: boolean } = {},
): Recipe {
  const antwort = (raw ?? {}) as Antwort;
  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);

  const proZutat = new Map<number, { anzahl?: number; einheit?: string; lebensmittel?: string }>();
  for (const z of antwort.zutaten ?? []) {
    const nr = typeof z.nr === "number" ? z.nr : NaN;
    if (!Number.isInteger(nr) || nr < 1 || nr > eintraege.length) continue;
    proZutat.set(nr - 1, {
      anzahl: typeof z.anzahl === "number" && z.anzahl > 0 ? z.anzahl : undefined,
      einheit: text(z.einheit),
      lebensmittel: text(z.lebensmittel),
    });
  }

  let i = 0;
  const zutaten = recipe.zutaten.map((g) => ({
    ...g,
    eintraege: g.eintraege.map((z) => {
      const neu = proZutat.get(i++);
      // Was schon da ist, gilt - ergaenzt wird nur, was fehlt. Ausser beim
      // erneuten Aufwerten: Dann ersetzt die neue Zerlegung die alte.
      if (opts.ersetzen && neu) {
        return {
          ...z,
          anzahl: neu.anzahl ?? null,
          einheit: neu.einheit ?? null,
          lebensmittel: neu.lebensmittel ?? null,
        };
      }
      return {
        ...z,
        anzahl: z.anzahl ?? neu?.anzahl ?? null,
        einheit: z.einheit ?? neu?.einheit ?? null,
        lebensmittel: z.lebensmittel ?? neu?.lebensmittel ?? null,
      };
    }),
  }));

  // Ueber die Nummer statt ueber den Namen: So kommt genau der Text aus
  // `zutat` hinein, und die Zuordnung findet die Zutat sicher wieder.
  const proSchritt = recipe.schritte.map(() => new Set<string>());
  // Steht derselbe Name mehrfach in der Liste - "Wasser" fuer Vorteig und
  // Hauptteig -, fuehrte der Name allein zu beiden. Dann mit Menge: "450 g Wasser".
  const anzahlNamen = new Map<string, number>();
  for (const z of eintraege) {
    const k = z.zutat.trim().toLowerCase();
    anzahlNamen.set(k, (anzahlNamen.get(k) ?? 0) + 1);
  }
  const eindeutig = (z: (typeof eintraege)[number]) =>
    (anzahlNamen.get(z.zutat.trim().toLowerCase()) ?? 0) > 1 && z.menge
      ? `${z.menge} ${z.zutat}`
      : z.zutat;
  let irgendwas = false;
  for (const s of antwort.schritte ?? []) {
    const nr = typeof s.schritt === "number" ? s.schritt : NaN;
    if (!Number.isInteger(nr) || nr < 1 || nr > recipe.schritte.length) continue;
    for (const zNr of Array.isArray(s.zutaten) ? s.zutaten : []) {
      const z = typeof zNr === "number" && Number.isInteger(zNr) ? eintraege[zNr - 1] : undefined;
      if (z) {
        proSchritt[nr - 1]!.add(eindeutig(z));
        irgendwas = true;
      }
    }
  }

  // Portionen nur ergaenzen, nie ersetzen - und als Schaetzung kennzeichnen.
  const geschaetzt = text(antwort.portionen);
  const portionen =
    recipe.portionen ??
    (geschaetzt ? (/gesch[äa]tzt/i.test(geschaetzt) ? geschaetzt : `${geschaetzt} (geschätzt)`) : null);

  return {
    ...recipe,
    zutaten,
    portionen,
    schritte_zutaten: irgendwas ? proSchritt.map((s) => [...s]) : recipe.schritte_zutaten,
  };
}

export async function enrichRecipe(
  recipe: Recipe,
  opts: { ersetzen?: boolean } = {},
): Promise<Recipe> {
  const raw = await generateJson({ prompt: enrichPrompt(recipe), schema: ENRICH_SCHEMA });
  return mergeEnrichment(recipe, raw, opts);
}
