import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Welche Fassung der Web-App der Server ausliefert.
 *
 * iOS holt eine Web-App vom Home-Bildschirm beim Oeffnen oft nur aus dem
 * Speicher zurueck, statt sie neu zu laden - mit dem alten Programmcode. Nach
 * einem Update fehlten dann neue Funktionen, bis die App von Hand beendet wurde.
 * Die App vergleicht deshalb beim Zurueckkehren ihre Fassung mit dieser hier
 * und laedt sich bei einem Unterschied einmal neu.
 */
export function webVersion(dir: string): string {
  const hash = createHash("sha256");
  // Sortiert, damit dieselben Dateien immer dieselbe Kennung ergeben.
  for (const name of readdirSync(dir).sort()) {
    if (!/\.(html|js|css|webmanifest|svg)$/.test(name)) continue;
    hash.update(name).update("\0").update(readFileSync(join(dir, name))).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * Die index.html mit Fassungskennung: als Meta-Angabe fuer den Vergleich und
 * als Anhang an Skripten und Stylesheet, damit kein Zwischenspeicher eine alte
 * Datei unter demselben Namen liefert.
 */
export function versionedIndex(html: string, version: string): string {
  return html
    .replace(/(<meta charset="utf-8">)/i, `$1\n<meta name="web-version" content="${version}">`)
    .replace(/(<script src=")([\w-]+\.js)(")/g, `$1$2?v=${version}$3`)
    .replace(/(<link rel="stylesheet" href=")([\w-]+\.css)(")/g, `$1$2?v=${version}$3`);
}
