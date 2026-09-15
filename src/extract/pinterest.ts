/**
 * Pinterest-Pins enthalten kein Rezept.
 *
 * Ein Pin ist ein Bild, ein Satz Beschreibung und ein Link auf die Seite, wo das
 * Rezept tatsaechlich steht. Wer den Pin liest, bekommt eine Ueberschrift und
 * sonst nichts - und ein Modell macht daraus pflichtschuldig ein "Rezept" mit
 * einem einzigen Schritt.
 *
 * Deshalb: Ziel-Adresse aus dem Pin holen und stattdessen diese verarbeiten.
 */

/**
 * Pinterest laeuft unter vielen Endungen (.com, .de, .co.uk). Die Punkte duerfen
 * dabei nicht ins Zeichenklassen-Wiederholungsmuster rutschen, sonst gilt auch
 * "pinterest.com.fremde-domain.example" als Pinterest.
 */
const PINTEREST_HOSTS =
  /(^|\.)(pinterest\.[a-z]{2,}(\.[a-z]{2,})?|pin\.it|pinimg\.com)$/i;

export function isPinterestUrl(url: string): boolean {
  try {
    return PINTEREST_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Gehoert die Adresse zu Pinterest selbst (und ist damit kein Rezept-Ziel)? */
function isOwnDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return PINTEREST_HOSTS.test(host) || /(^|\.)pinimg\.com$/i.test(host);
  } catch {
    return true;
  }
}

/**
 * Sucht im Pin-HTML die verlinkte Quelle.
 *
 * Pinterest legt die Pin-Daten als JSON in die Seite; darin steht die
 * Ziel-Adresse unter "link". Zusaetzlich wird og:see_also geprueft, das manche
 * Varianten der Seite setzen. Schraegstriche koennen im JSON maskiert sein.
 */
export function findPinTarget(html: string): string | undefined {
  const candidates: string[] = [];

  const seeAlso = /<meta[^>]+property=["']og:see_also["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (seeAlso?.[1]) candidates.push(seeAlso[1]);

  const re = /"(?:link|domain_link|seo_url|clickthrough_url)"\s*:\s*"((?:https?:)\\?\/\\?\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (raw) candidates.push(raw.replace(/\\\//g, "/").replace(/\\u002F/gi, "/"));
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (isOwnDomain(candidate)) continue;
      return candidate;
    } catch {
      // Unbrauchbare Kandidaten ueberspringen.
    }
  }
  return undefined;
}
