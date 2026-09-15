import { GoogleGenAI } from "@google/genai";
import { getConfig } from "../config.ts";

let client: GoogleGenAI | undefined;

export function getGemini(): GoogleGenAI {
  const cfg = getConfig();
  if (!cfg.geminiApiKey) {
    throw new Error(
      "GEMINI_API_KEY fehlt. Kostenlos unter aistudio.google.com -> 'Get API key'. " +
        "Siehe .env.example.",
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
  return client;
}

export function resetGemini(): void {
  client = undefined;
}

export interface GenerateJsonOptions {
  prompt: string;
  schema: unknown;
  /** Free-Tier laeuft schnell in 429, und 503 bei Modellandrang ist haeufig. */
  maxAttempts?: number;
}

const RETRYABLE = [429, 500, 502, 503, 504];

/**
 * Wartezeiten in Sekunden. Bewusst laenger als ueblich: ein ueberlastetes Modell
 * (503) ist meist nach einer knappen Minute wieder da, und der Job laeuft ohnehin
 * im Hintergrund - niemand sitzt davor und wartet.
 */
const BACKOFF_SECONDS = [3, 8, 20, 40];

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.code === "number") return e.code;
    const msg = typeof e.message === "string" ? e.message : "";
    // Das SDK verpackt den Fehler als JSON im Text: {"error":{"code":503,...}}
    const json = /"code"\s*:\s*(\d{3})/.exec(msg);
    if (json?.[1]) return Number(json[1]);
    const plain = /\b(400|403|404|429|500|502|503|504)\b/.exec(msg);
    if (plain?.[1]) return Number(plain[1]);
  }
  return undefined;
}

/** Uebersetzt die API-Fehler in etwas, das in der Web-App weiterhilft. */
function explain(status: number | undefined, model: string, raw: string): string {
  switch (status) {
    case 429:
      return (
        "Das kostenlose Gemini-Kontingent ist aufgebraucht (1.500 Anfragen/Tag). " +
        "Morgen geht es weiter, oder du hinterlegst einen bezahlten Key."
      );
    case 503:
      return (
        `Das Modell „${model}“ ist gerade überlastet. Das ist vorübergehend — ` +
        `tippe in ein paar Minuten auf „Erneut versuchen“. Passiert es öfter, ` +
        `trage in der .env ein stabiles Modell unter GEMINI_MODEL ein: die ` +
        `„-latest“-Namen zeigen auf experimentelle Modelle mit engeren Limits.`
      );
    case 404:
      return (
        `Gemini kennt kein Modell namens „${model}“. Prüfe GEMINI_MODEL in der .env. ` +
        `Die verfügbaren Namen listet:  npm run models`
      );
    case 400:
    case 403:
      return "Der Gemini-API-Key wurde abgelehnt. Stimmt GEMINI_API_KEY in der .env?";
    default:
      return `Gemini-Anfrage fehlgeschlagen: ${raw}`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ein einzelner Anlauf gegen ein bestimmtes Modell. */
async function callOnce(model: string, prompt: string, schema: unknown): Promise<unknown> {
  const response = await getGemini().models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      temperature: 0.2,
    },
  });

  const raw = (response.text ?? "").trim();
  if (!raw) throw new Error("Gemini hat eine leere Antwort geliefert.");

  // Trotz responseMimeType kommt gelegentlich ein ```json-Block zurueck.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

export async function generateJson({
  prompt,
  schema,
  maxAttempts = BACKOFF_SECONDS.length + 1,
}: GenerateJsonOptions): Promise<unknown> {
  const cfg = getConfig();

  // Erst das eingestellte Modell mit Wiederholungen, danach - falls konfiguriert -
  // ein einzelner Anlauf mit dem Ausweichmodell. Ist eines ueberlastet, ist das
  // andere es meist nicht.
  const models = [cfg.geminiModel, cfg.geminiFallbackModel].filter(
    (m, i, all): m is string => Boolean(m) && all.indexOf(m) === i,
  );

  let lastError: unknown;
  let lastModel = cfg.geminiModel;

  for (const [modelIndex, model] of models.entries()) {
    const attempts = modelIndex === 0 ? maxAttempts : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await callOnce(model, prompt, schema);
      } catch (err) {
        lastError = err;
        lastModel = model;
        const status = statusOf(err);

        // Bei einem Fehler, der sich nicht von allein loest (falscher Key, falsches
        // Modell), waere jede Wiederholung nur verlorene Zeit.
        if (status !== undefined && !RETRYABLE.includes(status)) break;
        if (attempt === attempts) break;

        const waitMs = (BACKOFF_SECONDS[attempt - 1] ?? 40) * 1000;
        console.warn(
          `[gemini] ${model}: Versuch ${attempt}/${attempts} fehlgeschlagen` +
            `${status ? ` (HTTP ${status})` : ""}, neuer Versuch in ${waitMs / 1000}s`,
        );
        await sleep(waitMs);
      }
    }

    if (models[modelIndex + 1]) {
      console.warn(`[gemini] wechsle auf Ausweichmodell ${models[modelIndex + 1]}`);
    }
  }

  const raw = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(explain(statusOf(lastError), lastModel, raw));
}

/** Nur fuer Tests: die reinen Hilfsfunktionen ohne Netzwerk. */
export const __test = { statusOf, explain };
