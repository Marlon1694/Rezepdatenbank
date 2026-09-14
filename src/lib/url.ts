/**
 * Teilen-Menues haengen gern Tracking-Parameter an. Die stoeren die Duplikat-Erkennung:
 * derselbe TikTok, zweimal geteilt, kaeme sonst als zwei verschiedene Rezepte in Notion an.
 */

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
];

export function cleanUrl(raw: string): string {
  const url = new URL(raw.trim());
  for (const key of [...url.searchParams.keys()]) {
    if (JUNK_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
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
