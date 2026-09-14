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
  /** Free-Tier laeuft schnell in 429 - deshalb mehrere Anlaeufe. */
  maxAttempts?: number;
}

const RETRYABLE = [429, 500, 502, 503, 504];

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.code === "number") return e.code;
    const msg = typeof e.message === "string" ? e.message : "";
    const m = /\b(429|500|502|503|504)\b/.exec(msg);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateJson({
  prompt,
  schema,
  maxAttempts = 4,
}: GenerateJsonOptions): Promise<unknown> {
  const cfg = getConfig();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await getGemini().models.generateContent({
        model: cfg.geminiModel,
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
    } catch (err) {
      lastError = err;
      const status = statusOf(err);
      if (attempt === maxAttempts || (status !== undefined && !RETRYABLE.includes(status))) break;

      const waitMs = 2 ** attempt * 1000;
      console.warn(
        `[gemini] Versuch ${attempt}/${maxAttempts} fehlgeschlagen` +
          `${status ? ` (HTTP ${status})` : ""}, neuer Versuch in ${waitMs / 1000}s`,
      );
      await sleep(waitMs);
    }
  }

  const status = statusOf(lastError);
  if (status === 429) {
    throw new Error(
      "Das kostenlose Gemini-Kontingent ist aufgebraucht (1.500 Anfragen/Tag). " +
        "Morgen geht es weiter, oder du hinterlegst einen bezahlten Key.",
    );
  }
  throw new Error(
    `Gemini-Anfrage fehlgeschlagen: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
