import { readFile } from "node:fs/promises";
import { getConfig } from "../config.ts";
import type { ExtraField } from "../notion/mapper.ts";

export interface PromptContext {
  input: string;
  sourceUrl: string;
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

  return body
    .replace("{{BEKANNTE_TAGS}}", knownTags)
    .replace("{{ZUSATZFELDER}}", extras)
    .replace("{{QUELLE}}", quelle)
    .replace("{{INPUT}}", ctx.input)
    .trim();
}
