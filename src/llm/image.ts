import { readFile } from "node:fs/promises";
import { getConfig } from "../config.ts";
import { getGemini } from "./gemini.ts";
import type { Recipe } from "./recipeSchema.ts";

/**
 * Erzeugt ein Titelbild zum Rezept.
 *
 * Scheitert das - Kontingent erschoepft, Modell nicht verfuegbar, Inhaltsfilter -
 * wird `undefined` zurueckgegeben. Ein fehlendes Bild darf niemals verhindern,
 * dass das Rezept in Notion landet.
 */

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

/** Baut den Bild-Prompt aus prompts/cover.de.md. */
export async function buildImagePrompt(recipe: Recipe): Promise<string> {
  const template = await readFile(getConfig().coverPromptFile, "utf8");
  const separator = template.indexOf("\n---\n");
  const body = separator === -1 ? template : template.slice(separator + 5);

  // Die kennzeichnenden Zutaten reichen; eine vollstaendige Liste mit Mengen
  // verwaessert den Bildprompt nur.
  const zutaten = recipe.zutaten_namen.length
    ? recipe.zutaten_namen.slice(0, 8).join(", ")
    : recipe.zutaten
        .flatMap((g) => g.eintraege.map((e) => e.zutat))
        .slice(0, 8)
        .join(", ");

  return body
    .replace("{{GERICHT}}", recipe.titel)
    .replace("{{ZUTATEN}}", zutaten || "—")
    .trim();
}

/** Imagen liefert Bilder ueber einen eigenen Endpunkt. */
async function viaImagen(model: string, prompt: string): Promise<GeneratedImage | undefined> {
  const res = await getGemini().models.generateImages({
    model,
    prompt,
    config: { numberOfImages: 1, aspectRatio: "16:9" },
  });

  const first = res.generatedImages?.[0];
  if (first?.raiFilteredReason) {
    console.warn(`[titelbild] vom Inhaltsfilter abgelehnt: ${first.raiFilteredReason}`);
    return undefined;
  }
  const bytes = first?.image?.imageBytes;
  if (!bytes) return undefined;

  return { data: Buffer.from(bytes, "base64"), mimeType: first.image?.mimeType ?? "image/png" };
}

/**
 * Die Gemini-eigenen Bildmodelle antworten ueber generateContent.
 *
 * Bei den Modalitaeten sind sie unterschiedlich streng: manche wollen nur IMAGE,
 * andere bestehen auf TEXT daneben. Statt das je Modell zu pflegen, werden beide
 * Formen probiert - der Unterschied kostet einen Fehlversuch, eine falsche
 * Voreinstellung dagegen jedes Titelbild.
 */
async function viaGemini(model: string, prompt: string): Promise<GeneratedImage | undefined> {
  const variants: string[][] = [["IMAGE"], ["TEXT", "IMAGE"]];
  let lastError: unknown;

  for (const responseModalities of variants) {
    try {
      const res = await getGemini().models.generateContent({
        model,
        contents: prompt,
        config: { responseModalities },
      });

      // Antwortet das Modell mit Text und Bild, interessiert nur das Bild.
      for (const part of res.candidates?.[0]?.content?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data) {
          return {
            data: Buffer.from(inline.data, "base64"),
            mimeType: inline.mimeType ?? "image/png",
          };
        }
      }
      // Antwort kam an, enthielt aber kein Bild - eine andere Modalitaet hilft da nicht.
      return undefined;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

export async function generateCoverImage(recipe: Recipe): Promise<GeneratedImage | undefined> {
  const cfg = getConfig();
  if (!cfg.coverImage || !cfg.imageModel) return undefined;

  try {
    const prompt = await buildImagePrompt(recipe);
    // Imagen und die Gemini-eigenen Bildmodelle sprechen unterschiedliche
    // Endpunkte an; der Name verraet, welcher gemeint ist.
    const image = /^imagen/i.test(cfg.imageModel)
      ? await viaImagen(cfg.imageModel, prompt)
      : await viaGemini(cfg.imageModel, prompt);

    if (!image) {
      console.warn(`[titelbild] ${cfg.imageModel} lieferte kein Bild.`);
      return undefined;
    }
    console.log(`[titelbild] erzeugt (${Math.round(image.data.length / 1024)} kB)`);
    return image;
  } catch (err) {
    // Bewusst nur eine Warnung: das Rezept soll trotzdem nach Notion.
    console.warn(
      `[titelbild] uebersprungen: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
