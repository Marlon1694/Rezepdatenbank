import { getNotion } from "./client.ts";
import type { GeneratedImage } from "../llm/image.ts";

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
    const extension = image.mimeType.includes("jpeg") ? "jpg" : "png";

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
