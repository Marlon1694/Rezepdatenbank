/**
 * Teilen-Menues haengen gern Tracking-Parameter an. Die stoeren die Duplikat-Erkennung:
 * derselbe TikTok, zweimal geteilt, kaeme sonst als zwei verschiedene Rezepte in Notion an.
 */

/**
 * Bei den bekannten Plattformen steckt die Identitaet vollstaendig im Pfad (oder
 * bei YouTube in "v"). Alles andere ist Beiwerk.
 *
 * Eine Erlaubnisliste statt einer Sperrliste: Die Dienste erfinden laufend neue
 * Parameter - Instagram etwa "stkn" beim Teilen aus der App - und jeder
 * uebersehene macht aus demselben Rezept ein zweites.
 */
const KEEP_PARAMS: Array<{ host: RegExp; keep: string[] }> = [
  { host: /(^|\.)youtube\.com$/i, keep: ["v"] },
  { host: /(^|\.)instagram\.com$/i, keep: [] },
  { host: /(^|\.)tiktok\.com$/i, keep: [] },
  { host: /(^|\.)pinterest\.[a-z]{2,}(\.[a-z]{2,})?$/i, keep: [] },
  { host: /(^|\.)facebook\.com$/i, keep: ["v"] },
];

/** Fuer alle uebrigen Seiten: nur bekannte Verfolgungs-Parameter entfernen. */
const JUNK_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^igshid$/i,
  /^igsh$/i,
  /^si$/i,
  /^feature$/i,
  /^_r$/i,
  /^_t$/i,
  /^is_from_webapp$/i,
  /^sender_device$/i,
  /^web_id$/i,
  /^share_app_id$/i,
  /^stkn$/i,
  /^img_index$/i,
];

/**
 * Bringt verschiedene Schreibweisen derselben Seite auf eine Form.
 *
 * Ohne das waeren youtu.be/ABC und youtube.com/watch?v=ABC zwei verschiedene
 * Rezepte - und genau so teilt man mal aus der App, mal aus dem Browser.
 * Kurzlinks wie vm.tiktok.com loest spaeter yt-dlp auf, die lassen sich hier
 * nicht ohne Netzwerk aufloesen.
 */
function canonicalizeHost(url: URL): void {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").split("/")[0];
    if (id) {
      url.protocol = "https:";
      url.hostname = "www.youtube.com";
      url.pathname = "/watch";
      url.search = `?v=${id}`;
    }
    return;
  }

  if (host === "youtube.com" || host === "m.youtube.com") {
    url.hostname = "www.youtube.com";
    // /shorts/ABC und /watch?v=ABC zeigen auf dasselbe Video.
    const shorts = /^\/shorts\/([^/]+)/.exec(url.pathname);
    if (shorts?.[1]) {
      url.pathname = "/watch";
      url.search = `?v=${shorts[1]}`;
    }
    return;
  }

  if (host.endsWith("tiktok.com") && host !== "tiktok.com") {
    // m.tiktok.com -> www, aber vm./vt. bleiben: das sind Kurzlinks, deren Ziel
    // erst yt-dlp kennt.
    if (host.startsWith("m.")) url.hostname = "www.tiktok.com";
    return;
  }

  if (host === "instagram.com") url.hostname = "www.instagram.com";
}

export function cleanUrl(raw: string): string {
  const url = new URL(raw.trim());
  canonicalizeHost(url);

  const rule = KEEP_PARAMS.find((r) => r.host.test(url.hostname));
  for (const key of [...url.searchParams.keys()]) {
    const entfernen = rule
      ? !rule.keep.includes(key.toLowerCase())
      : JUNK_PARAMS.some((re) => re.test(key));
    if (entfernen) url.searchParams.delete(key);
  }

  // Ein abschliessender Schraegstrich macht keinen Unterschied, waere fuer den
  // Vergleich aber eine andere Zeichenkette.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
