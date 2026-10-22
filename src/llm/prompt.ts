import { readFile } from "node:fs/promises";
import { getConfig } from "../config.ts";
import type { ExtraField } from "../notion/mapper.ts";
import type { RecipeMode } from "../extract/photo.ts";

export interface PromptContext {
  input: string;
  sourceUrl: string;
  /**
   * Nur bei Fotos gesetzt. Entscheidet, ob die Regel "Nichts erfinden" gilt
   * oder gezielt ausgehebelt wird. Fehlt sie, bleibt alles wie bisher.
   */
  mode?: RecipeMode;
  /** Was laut Vision-Stufe fehlt - wird im Ergaenzungsmodus benannt. */
  fehlt?: string[];
  sourceTitle?: string;
  uploader?: string;
  platform?: string;
  /** Tag-Optionen, die es in der Notion-DB schon gibt. */
  knownTags?: string[];
  /** Vorhandene Zutaten-Optionen - damit keine Synonyme entstehen. */
  knownIngredients?: string[];
  /** Zusatzfelder, fuer die es in der DB auch wirklich eine Spalte gibt. */
  extraFields?: ExtraField[];
}

const EXTRA_TEXT: Record<ExtraField, string> = {
  portionen: "- `portionen`: Für wie viele Personen bzw. welche Menge das Rezept gedacht ist.",
  kueche: "- `kueche`: Länderküche oder Region (z.B. Italienisch, Thai, Fränkisch).",
  schwierigkeit:
    "- `schwierigkeit`: Genau eines von **Leicht**, **Mittel**, **Schwer**. " +
    "Richte dich nach Technik und Timing, nicht nach der Kochdauer: ein Schmorgericht, " +
    "das drei Stunden vor sich hin köchelt, ist *Leicht*.",
  zutatenliste:
    "- `zutaten_namen`: Die kennzeichnenden Zutaten als bloße Namen — ohne Mengen, ohne " +
    "Zubereitungshinweise, im Singular (`Hähnchenbrust`, nicht `2 gewürfelte Hähnchenbrüste`). " +
    "Grundausstattung wie Salz, Pfeffer, Wasser oder Öl weglassen: sie steckt in jedem Rezept " +
    "und taugt deshalb nicht zum Filtern. Höchstens 12.",
};

/**
 * Setzt den Prompt aus prompts/recipe.de.md zusammen.
 *
 * Die Datei wird bei JEDEM Aufruf frisch gelesen - so wirkt eine Aenderung sofort
 * beim naechsten Rezept, ohne Neustart.
 */
export async function buildPrompt(ctx: PromptContext): Promise<string> {
  const template = await readFile(getConfig().promptFile, "utf8");

  // Alles oberhalb der ersten --- ist Erklaerung fuer Menschen, nicht fuer das Modell.
  const separator = template.indexOf("\n---\n");
  const body = separator === -1 ? template : template.slice(separator + 5);

  const knownTags = ctx.knownTags?.length
    ? ctx.knownTags.join(", ")
    : "(noch keine vorhanden - vergib passende neue)";

  const extraLines = ctx.extraFields?.map((f) => EXTRA_TEXT[f]) ?? [];

  // Bereits vergebene Zutatennamen anbieten, damit nicht "Sahne" und "Schlagsahne"
  // als zwei Optionen nebeneinander entstehen.
  if (ctx.extraFields?.includes("zutatenliste") && ctx.knownIngredients?.length) {
    extraLines.push(
      `  Bevorzuge diese bereits vorhandenen Bezeichnungen, wo sie passen: ` +
        `${ctx.knownIngredients.join(", ")}`,
    );
  }

  const extras = extraLines.length
    ? [
        "## Zusatzfelder",
        "",
        "Diese Datenbank hat zusätzlich folgende Spalten. Befülle sie, wenn das Material",
        "die Information hergibt, sonst lass sie weg:",
        "",
        ...extraLines,
      ].join("\n")
    : "";

  const quelle = [
    ctx.platform ? `Plattform: ${ctx.platform}` : "",
    ctx.sourceTitle ? `Titel: ${ctx.sourceTitle}` : "",
    ctx.uploader ? `Kanal/Autor: ${ctx.uploader}` : "",
    `URL: ${ctx.sourceUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const modus = buildModeSection(ctx.mode, ctx.fehlt);

  const gefuellt = body
    .replace("{{BEKANNTE_TAGS}}", knownTags)
    .replace("{{ZUSATZFELDER}}", extras)
    .replace("{{QUELLE}}", quelle)
    .replace("{{INPUT}}", ctx.input);

  // Die Prompt-Datei liegt als Volume auf dem Server und darf bearbeitet
  // werden. Fehlt der neue Platzhalter in einer aelteren oder angepassten
  // Fassung, haengen wir den Abschnitt an, statt ihn stillschweigend fallen
  // zu lassen - sonst waere im Ergaenzungsmodus wieder "Nichts erfinden" in
  // Kraft und das Rezept bliebe unvollstaendig.
  if (gefuellt.includes("{{MODUS}}")) {
    return gefuellt.replace("{{MODUS}}", modus).trim();
  }
  return modus ? `${gefuellt.trim()}\n\n${modus}` : gefuellt.trim();
}

/**
 * Der Abschnitt, der die Grundregel "Nichts erfinden" fuer Fotos anpasst.
 *
 * Bei Videos bleibt er leer - dort ist Erfinden nie erwuenscht.
 */
export function buildModeSection(mode: RecipeMode | undefined, fehlt: string[] = []): string {
  if (!mode || mode === "abtippen") return "";

  const luecken = fehlt.length ? fehlt.join(", ") : "Teile des Rezepts";

  if (mode === "erfinden") {
    return [
      "## Sonderfall: Das Material zeigt kein Rezept",
      "",
      "Auf den Bildern ist das fertige Gericht zu sehen, aber kein brauchbares Rezept.",
      "Die Regel „Nichts erfinden“ ist hier **ausgesetzt**: Entwickle ein vollständiges,",
      "kochbares Rezept für genau dieses Gericht.",
      "",
      "- Richte dich nach dem, was auf dem Bild erkennbar ist — Zutaten, Beilagen,",
      "  Garmethode, Portionsgröße. Erfinde kein anderes Gericht.",
      "- Bleib bei einer naheliegenden, klassischen Zubereitung. Keine ausgefallenen",
      "  Techniken, keine schwer erhältlichen Zutaten.",
      "- Setze **hinter jede Mengenangabe** `(geschätzt)`.",
      "- Schreibe in `pro_tipp` als ersten Satz: „Dieses Rezept wurde anhand eines Fotos",
      "  erstellt — die Mengen sind geschätzt.“",
    ].join("\n");
  }

  return [
    "## Sonderfall: Das Material ist unvollständig",
    "",
    `Das Rezept auf den Bildern ist lückenhaft. Es fehlt: ${luecken}.`,
    "",
    "Die Regel „Nichts erfinden“ gilt hier **eingeschränkt**:",
    "",
    "- Alles, was im Material steht, wird **unverändert** übernommen. Ändere keine",
    "  Menge, keine Zutat und keinen Schritt, der dasteht.",
    "- **Nur die Lücken** füllst du so, dass das Rezept kochbar wird — knapp und",
    "  naheliegend, passend zu dem, was dasteht.",
    "- Jede Ergänzung wird gekennzeichnet: Mengen bekommen `(ergänzt)` angehängt,",
    "  ergänzte Arbeitsschritte beginnen mit `(ergänzt)`.",
    "- Was im Material steht, bleibt **ohne** Kennzeichnung. So ist auf einen Blick",
    "  erkennbar, was aus dem Buch stammt und was nicht.",
  ].join("\n");
}
