/**
 * Welche Bildformate angenommen werden.
 *
 * Bewusst eine eigene kleine Datei: Sowohl der Upload als auch das Notion-
 * Titelbild brauchen diese Zuordnung. Laege sie bei der Vision-Stufe, zoege
 * jede Dateinamenspruefung das Gemini-SDK mit herein - fuer eine Tabelle mit
 * sieben Eintraegen.
 */

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
};

/** Alle unterstuetzten Endungen - fuer die Pruefung beim Hochladen. */
export const SUPPORTED_EXTENSIONS = Object.keys(MIME);

/**
 * Der Typ anhand der Endung. Entscheidend ist die LETZTE Endung: "bild.jpg.exe"
 * ist eine exe und muss durchfallen, auch wenn ".jpg" darin vorkommt.
 */
export function mimeForFile(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MIME[name.slice(dot).toLowerCase()];
}
