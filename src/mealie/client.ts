import { getConfig } from "../config.ts";

/**
 * Schlanker Zugriff auf die Mealie-API (geprueft gegen Mealie 3.29).
 *
 * Bewusst ohne SDK: Mealie hat keines fuer Node, und die paar Aufrufe, die
 * wir brauchen, sind mit fetch uebersichtlicher als jede generierte Huelle.
 */

export class MealieError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;

export function mealieEnabled(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.mealieUrl && cfg.mealieApiToken);
}

/** Uebersetzt das, was schiefgehen kann, in etwas, das in der Web-App weiterhilft. */
export function explainMealieError(status: number | undefined, detail: string): string {
  const url = getConfig().mealieUrl;
  switch (status) {
    case 401:
      return (
        "Mealie hat das API-Token abgelehnt. Ist MEALIE_API_TOKEN vollständig kopiert, " +
        "oder wurde das Token in Mealie gelöscht? Neues anlegen unter /user/profile/api-tokens."
      );
    case 403:
      return (
        "Das Mealie-Konto hinter dem Token darf das nicht. Rezepte anlegen und Tags " +
        "verwalten braucht ein Konto mit den passenden Rechten in Mealie."
      );
    case undefined:
      return (
        `Mealie ist unter ${url} nicht erreichbar (${detail}). Läuft der Container? ` +
        "Die Adresse darf nicht localhost sein — aus dem App-Container heraus zeigt " +
        "das auf die App selbst. Nimm die IP des Servers, z.B. http://192.168.2.227:9925."
      );
    default:
      return `Mealie antwortete mit HTTP ${status}: ${detail}`;
  }
}

/** Nimmt aus Mealies Fehlerantwort den lesbaren Teil, falls es einen gibt. */
function detailOf(body: string): string {
  try {
    const json = JSON.parse(body) as { detail?: unknown };
    if (typeof json.detail === "string") return json.detail;
    if (json.detail && typeof json.detail === "object") {
      const d = json.detail as { message?: unknown };
      if (typeof d.message === "string") return d.message;
      return JSON.stringify(json.detail).slice(0, 300);
    }
  } catch {
    /* kein JSON */
  }
  return body.slice(0, 300) || "(keine Antwort)";
}

export interface MealieRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
}

export async function mealie<T = unknown>(path: string, req: MealieRequest = {}): Promise<T> {
  const cfg = getConfig();
  if (!mealieEnabled()) throw new MealieError("Mealie ist nicht eingerichtet.");

  const url = new URL(`${cfg.mealieUrl}/api${path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.mealieApiToken}`,
    Accept: "application/json",
  };
  let body: string | FormData | undefined;
  if (req.form) {
    body = req.form; // Content-Type samt Boundary setzt fetch selbst
  } else if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? "GET",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const grund =
      err instanceof Error && err.name === "AbortError"
        ? `keine Antwort nach ${TIMEOUT_MS / 1000} s`
        : err instanceof Error
          ? ((err.cause as { code?: string } | undefined)?.code ?? err.message)
          : String(err);
    throw new MealieError(explainMealieError(undefined, grund));
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new MealieError(explainMealieError(res.status, detailOf(text)), res.status);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // POST /recipes antwortet mit dem Slug als JSON-String; ein nackter Text
    // waere unerwartet, aber kein Grund, das Ergebnis wegzuwerfen.
    return text as T;
  }
}

/** Seiten einer Mealie-Liste - perPage=-1 liefert alles in einem Rutsch. */
export interface Page<T> {
  items: T[];
  total?: number;
}

/** Ein Wert fuer Mealies queryFilter: in Anfuehrungszeichen, ohne darin enthaltene. */
export function filterValue(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

export interface MealieSelf {
  id: string;
  username?: string;
  email?: string;
  groupSlug: string;
  household?: string;
}

let selfCache: MealieSelf | undefined;

/** Wer steckt hinter dem Token? Liefert auch den Gruppen-Slug fuer Links. */
export async function mealieSelf(): Promise<MealieSelf> {
  selfCache ??= await mealie<MealieSelf>("/users/self");
  return selfCache;
}

/** Nur fuer Tests. */
export function resetMealieCache(): void {
  selfCache = undefined;
}

/** Die Adresse, unter der ein Rezept in Mealie im Browser aufgeht. */
export function recipeLink(groupSlug: string, slug: string): string {
  return `${getConfig().mealieUrl}/g/${groupSlug}/r/${slug}`;
}
