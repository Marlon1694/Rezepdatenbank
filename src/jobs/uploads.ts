import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { getConfig } from "../config.ts";
import { SUPPORTED_EXTENSIONS, mimeForFile } from "../lib/images.ts";

/**
 * Ablage der hochgeladenen Fotos: data/uploads/<job-id>/1.jpg, 2.jpg, ...
 *
 * Die Bilder bleiben liegen, nicht aus Sammelleidenschaft, sondern damit
 * "Erneut versuchen" funktioniert, ohne dass du noch einmal fotografieren
 * musst - und damit in der Web-App nachvollziehbar bleibt, was das Modell
 * eigentlich vor sich hatte.
 */

export function uploadsRoot(): string {
  return resolve(getConfig().dataDir, "uploads");
}

export function jobDir(jobId: string): string {
  // basename() schneidet alles ab, was wie ein Pfad aussieht. Die ID kommt
  // zwar aus randomUUID(), aber der Pfad wird aus Benutzereingaben
  // zusammengesetzt - diese Stelle soll das nicht voraussetzen muessen.
  return join(uploadsRoot(), basename(jobId));
}

export function photoPaths(jobId: string, names: string[]): string[] {
  const dir = jobDir(jobId);
  return names.map((name) => join(dir, basename(name)));
}

/** Prueft eine hochgeladene Datei, bevor sie auf der Platte landet. */
export function checkPhoto(
  filename: string,
  size: number,
): { ok: true; extension: string } | { ok: false; error: string } {
  const cfg = getConfig();

  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot).toLowerCase();

  if (!mimeForFile(filename)) {
    return {
      ok: false,
      error:
        `„${filename}“ ist kein unterstütztes Bildformat. ` +
        `Möglich sind: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    };
  }
  if (size <= 0) {
    return { ok: false, error: `„${filename}“ ist leer.` };
  }
  if (size > cfg.maxPhotoBytes) {
    return {
      ok: false,
      error:
        `„${filename}“ ist mit ${Math.round(size / 1024 / 1024)} MB zu groß ` +
        `(erlaubt sind ${Math.round(cfg.maxPhotoBytes / 1024 / 1024)} MB).`,
    };
  }
  return { ok: true, extension };
}

/**
 * Legt ein Foto ab und gibt den Dateinamen zurueck.
 *
 * Der Name wird selbst vergeben - der vom Client mitgelieferte wird nur fuer
 * die Endung herangezogen. So kann kein Name von aussen bestimmen, wohin
 * geschrieben wird.
 */
export async function savePhoto(
  jobId: string,
  index: number,
  extension: string,
  data: Buffer,
): Promise<string> {
  const dir = jobDir(jobId);
  await mkdir(dir, { recursive: true });
  const name = `${index}${extension}`;
  await writeFile(join(dir, name), data);
  return name;
}

/** Entfernt den Ordner eines Jobs samt Bildern. */
export async function removePhotos(jobId: string): Promise<void> {
  await rm(jobDir(jobId), { recursive: true, force: true });
}
