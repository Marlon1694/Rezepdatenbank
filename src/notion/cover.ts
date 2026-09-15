import { getNotion } from "./client.ts";
import type { GeneratedImage } from "../llm/image.ts";

/** Ein Titelbild sollte nicht groesser sein als noetig. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Laedt das Vorschaubild herunter.
 *
 * Bewusst selbst geholt statt Notion die Adresse zu geben: CDN-Adressen von
 * TikTok und Instagram sind signiert und laufen ab. Als hochgeladene Datei
 * gehoert das Bild dauerhaft zur Seite.
 */
export async function fetchThumbnail(url: string): Promise<GeneratedImage | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      console.warn(`[titelbild] Vorschaubild nicht abrufbar (HTTP ${res.status}).`);
      return undefined;
    }

    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mimeType.startsWith("image/")) {
      console.warn(`[titelbild] Vorschaubild ist kein Bild, sondern "${mimeType}".`);
      return undefined;
    }

    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) return undefined;
    if (data.length > MAX_BYTES) {
      console.warn(
        `[titelbild] Vorschaubild ist mit ${Math.round(data.length / 1024 / 1024)} MB zu groß.`,
      );
      return undefined;
    }

    console.log(`[titelbild] Vorschaubild geladen (${Math.round(data.length / 1024)} kB)`);
    return { data, mimeType };
  } catch (err) {
    console.warn(
      `[titelbild] Vorschaubild übersprungen: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Laedt ein Bild zu Notion hoch und gibt die file_upload-ID zurueck.
 *
 * Bewusst hochgeladen statt als externe URL verlinkt: Notion speichert die Datei
 * dann selbst. Ein Link auf unseren Server waere von aussen nicht erreichbar, und
 * CDN-Adressen von TikTok und Co. laufen nach einiger Zeit ab.
 *
 * Gibt bei jedem Fehler undefined zurueck - ein fehlendes Titelbild darf das
 * Anlegen des Rezepts nicht verhindern.
 */
export async function uploadCover(image: GeneratedImage): Promise<string | undefined> {
  try {
    const notion = getNotion();
    const extension = image.mimeType.includes("jpeg")
      ? "jpg"
      : image.mimeType.includes("webp")
        ? "webp"
        : "png";

    const upload = await notion.fileUploads.create({
      mode: "single_part",
      filename: `titelbild.${extension}`,
      content_type: image.mimeType,
    });

    await notion.fileUploads.send({
      file_upload_id: upload.id,
      file: {
        data: new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
        filename: `titelbild.${extension}`,
      },
    });

    return upload.id;
  } catch (err) {
    console.warn(
      `[titelbild] Upload nach Notion fehlgeschlagen: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
