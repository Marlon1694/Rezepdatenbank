import { readFile } from "node:fs/promises";
import { getConfig } from "../config.ts";
import type { Mapping } from "../notion/mapper.ts";

/**
 * Laedt config/notion-mapping.json. Fehlt die Datei, wird die automatische
 * Spaltenerkennung benutzt - das ist der Normalfall vor dem ersten
 * `npm run inspect:notion`.
 */
export async function loadMapping(): Promise<Mapping> {
  try {
    const raw = await readFile(getConfig().mappingFile, "utf8");
    return JSON.parse(raw) as Mapping;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[mapping] ${getConfig().mappingFile} ist fehlerhaft: ${String(err)}`);
    }
    return {};
  }
}
