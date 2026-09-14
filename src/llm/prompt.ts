import { readFile } from "node:fs/promises";
import { getConfig } from "../config.ts";

export interface PromptContext {
  input: string;
  sourceUrl: string;
  sourceTitle?: string;
  uploader?: string;
  platform?: string;
  /** Tag-Optionen, die es in der Notion-DB schon gibt. */
  knownTags?: string[];
  /** Zusatzfelder, fuer die es in der DB auch wirklich eine Spalte gibt. */
  extraFields?: Array<"portionen" | "kueche">;
}

const EXTRA_TEXT: Record<"portionen" | "kueche", string> = {
  portionen: "- `portionen`: Für wie viele Personen bzw. welche Menge das Rezept gedacht ist.",
  kueche: "- `kueche`: Länderküche oder Region (z.B. Italienisch, Thai, Fränkisch).",
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

  const extras = ctx.extraFields?.length
    ? [
        "## Zusatzfelder",
        "",
        "Diese Datenbank hat zusätzlich folgende Spalten. Befülle sie, wenn das Material",
        "die Information hergibt, sonst lass sie weg:",
        "",
        ...ctx.extraFields.map((f) => EXTRA_TEXT[f]),
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
