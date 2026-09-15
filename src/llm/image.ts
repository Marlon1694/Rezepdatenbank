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

/** Warum ist kein Titelbild moeglich? Leerer String = alles bereit. */
export function coverImageBlocker(): string {
  const cfg = getConfig();
  if (!cfg.coverSource.includes("ai")) return `COVER_SOURCE steht auf "${cfg.coverSource}"`;
  if (!cfg.imageModel) return "IMAGE_MODEL ist nicht gesetzt";
  if (!cfg.geminiApiKey) return "GEMINI_API_KEY fehlt";
  return "";
}

export async function generateCoverImage(recipe: Recipe): Promise<GeneratedImage | undefined> {
  const cfg = getConfig();

  const blocker = coverImageBlocker();
  if (blocker) {
    // Frueher wurde hier wortlos ausgestiegen - wer die .env unvollstaendig
    // ausgefuellt hatte, bekam nirgends einen Hinweis darauf.
    console.log(`[titelbild] nicht erzeugt: ${blocker}`);
    return undefined;
  }

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
    console.warn(`[titelbild] übersprungen: ${explainImageError(err, cfg.imageModel)}`);
    return undefined;
  }
}

/**
 * Macht aus der JSON-Wand der API einen Satz, der weiterhilft.
 *
 * Der wichtige Fall ist "limit: 0": Das heisst nicht "Kontingent aufgebraucht",
 * sondern dass die kostenlose Stufe fuer Bildmodelle ueberhaupt keines vorsieht.
 * Warten hilft da nicht, nur Abrechnung aktivieren oder abschalten.
 */
export function explainImageError(err: unknown, model: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/limit:\s*0\b/.test(raw)) {
    return (
      `Die kostenlose Gemini-Stufe sieht für "${model}" kein Kontingent vor ` +
      `(limit: 0) — Bildgenerierung ist dort nicht enthalten. Entweder in der ` +
      `Google-Cloud-Konsole die Abrechnung aktivieren oder COVER_IMAGE=false setzen.`
    );
  }
  if (/RESOURCE_EXHAUSTED|"code":\s*429/.test(raw)) {
    return `Kontingent für "${model}" erschöpft. Später erneut versuchen.`;
  }
  if (/"code":\s*404|not found/i.test(raw)) {
    return `Modell "${model}" ist unbekannt. "npm run models" zeigt die verfügbaren.`;
  }
  if (/PERMISSION_DENIED|"code":\s*403/.test(raw)) {
    return `Der API-Key darf "${model}" nicht verwenden.`;
  }
  // Unbekanntes nicht verschlucken, aber auch nicht ungebremst ausschuetten.
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}
