import { GoogleGenAI } from "@google/genai";
import { getConfig } from "../config.ts";

export type KeyArt = "frei" | "bezahlt";

const clients = new Map<KeyArt, GoogleGenAI>();

/**
 * "frei" = GEMINI_API_KEY (kostenloses Kontingent), "bezahlt" =
 * GEMINI_PAID_API_KEY (Projekt mit Abrechnung). Ohne bezahlten Key ist es
 * immer der freie.
 */
export function getGemini(art: KeyArt = "frei"): GoogleGenAI {
  const cfg = getConfig();
  const key = art === "bezahlt" && cfg.geminiPaidApiKey ? cfg.geminiPaidApiKey : cfg.geminiApiKey;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY fehlt. Kostenlos unter aistudio.google.com -> 'Get API key'. " +
        "Siehe .env.example.",
    );
  }
  const art2: KeyArt = key === cfg.geminiApiKey ? "frei" : "bezahlt";
  let c = clients.get(art2);
  if (!c) {
    c = new GoogleGenAI({ apiKey: key });
    clients.set(art2, c);
  }
  return c;
}

/** Titelbilder: das kostenlose Kontingent hat fuer Bildmodelle nichts. */
export function getImageClient(): GoogleGenAI {
  return getGemini("bezahlt");
}

/**
 * Bis wann der freie Key nach einem "Limit erreicht" ruht. Danach wird er
 * wieder probiert: Ein Minutenlimit ist laengst vorbei, und ist es das
 * Tageslimit, kostet die Probe nur einen sofort abgelehnten Aufruf.
 */
let freiRuhtBis = 0;
const FREI_PAUSE_MS = 15 * 60 * 1000;

export function resetGemini(): void {
  clients.clear();
  freiRuhtBis = 0;
}

/** Ein Bild, so wie Gemini es entgegennimmt. */
export interface InlineImage {
  mimeType: string;
  data: Buffer;
}

export interface GenerateJsonOptions {
  prompt: string;
  schema: unknown;
  /** Bilder, die dem Prompt vorangestellt werden. Leer = reine Textanfrage. */
  images?: InlineImage[];
  /** Free-Tier laeuft schnell in 429, und 503 bei Modellandrang ist haeufig. */
  maxAttempts?: number;
  /** Ueberschreibt das Hauptmodell - fuer Bilder ggf. ein eigenes. */
  model?: string;
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
function explain(
  status: number | undefined,
  model: string,
  raw: string,
  art: KeyArt = "frei",
): string {
  switch (status) {
    case 429:
      return art === "bezahlt"
        ? "Gemini lehnt auch über den bezahlten Key ab (Limit erreicht). Prüfe in der " +
            "Google-Cloud-Abrechnung von GEMINI_PAID_API_KEY Budget und Kontingente."
        : "Das kostenlose Gemini-Kontingent ist aufgebraucht. Morgen geht es weiter, " +
            "oder du hinterlegst GEMINI_PAID_API_KEY aus einem Projekt mit Abrechnung.";
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
async function callOnce(
  client: GoogleGenAI,
  model: string,
  prompt: string,
  schema: unknown,
  images: InlineImage[] = [],
): Promise<unknown> {
  // Bilder vor den Text: Das Modell soll erst sehen, worum es geht, und dann
  // lesen, was es damit tun soll.
  const parts = [
    ...images.map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.data.toString("base64") },
    })),
    { text: prompt },
  ];

  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
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
  images = [],
  model: override,
  maxAttempts = BACKOFF_SECONDS.length + 1,
}: GenerateJsonOptions): Promise<unknown> {
  const cfg = getConfig();

  // Erst das eingestellte Modell mit Wiederholungen, danach - falls konfiguriert -
  // ein einzelner Anlauf mit dem Ausweichmodell. Ist eines ueberlastet, ist das
  // andere es meist nicht.
  const haupt = override || cfg.geminiModel;
  const models = [haupt, cfg.geminiFallbackModel].filter(
    (m, i, all): m is string => Boolean(m) && all.indexOf(m) === i,
  );

  // Erst der kostenlose Key, dann - falls hinterlegt - der bezahlte. Ruht der
  // kostenlose gerade, direkt der bezahlte.
  const bezahltDa = Boolean(cfg.geminiPaidApiKey);
  const keys: KeyArt[] = !bezahltDa
    ? ["frei"]
    : Date.now() < freiRuhtBis
      ? ["bezahlt"]
      : ["frei", "bezahlt"];

  // Getrennt festhalten: Scheitert das Ausweichmodell, weil es zurueckgezogen
  // wurde, darf dessen 404 nicht die eigentliche Ursache verdecken. Genau das
  // passierte, als Google seine 2.5er-Reihe abschaltete - gemeldet wurde
  // "Modell gibt es nicht", gemeint war die Ueberlastung des Hauptmodells.
  let primaryError: unknown;
  let fallbackError: unknown;
  let letzteArt: KeyArt = keys[0]!;

  for (const art of keys) {
    letzteArt = art;
    primaryError = undefined;
    fallbackError = undefined;
    // Beim freien Key mit bezahltem dahinter: "Limit erreicht" heisst sofort
    // wechseln. Abwarten lohnt nicht, es kostet nur Zeit.
    const wechselMoeglich = art === "frei" && keys.includes("bezahlt");
    let wechseln = false;

    modelle: for (const [modelIndex, model] of models.entries()) {
      const istHaupt = modelIndex === 0;
      const attempts = istHaupt ? maxAttempts : 1;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await callOnce(getGemini(art), model, prompt, schema, images);
        } catch (err) {
          if (istHaupt) primaryError = err;
          else fallbackError = err;

          const status = statusOf(err);

          if (status === 429 && wechselMoeglich) {
            freiRuhtBis = Date.now() + FREI_PAUSE_MS;
            wechseln = true;
            break modelle;
          }

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

      const naechstes = models[modelIndex + 1];
      if (naechstes) console.warn(`[gemini] wechsle auf Ausweichmodell ${naechstes}`);
    }

    if (!wechseln) break;
    console.warn(
      "[gemini] kostenloses Kontingent erschöpft - weiter über den bezahlten Key " +
        `(kostenloser ruht ${FREI_PAUSE_MS / 60000} Minuten).`,
    );
  }

  throw new Error(
    describeFailure(haupt, primaryError, cfg.geminiFallbackModel, fallbackError, letzteArt),
  );
}

/**
 * Setzt die Meldung so zusammen, dass das Hauptmodell im Vordergrund steht.
 *
 * Ein zurueckgezogenes Ausweichmodell ist eine eigene Information - aber nicht
 * die, nach der man beim Suchen des Fehlers greifen sollte.
 */
export function describeFailure(
  model: string,
  primaryError: unknown,
  fallbackModel: string,
  fallbackError: unknown,
  art: KeyArt = "frei",
): string {
  const rawPrimary = primaryError instanceof Error ? primaryError.message : String(primaryError);
  const haupt = explain(statusOf(primaryError), model, rawPrimary, art);

  if (fallbackError === undefined) return haupt;

  const statusFallback = statusOf(fallbackError);
  const zusatz =
    statusFallback === 404
      ? `Das Ausweichmodell "${fallbackModel}" gibt es nicht mehr — setze ` +
        `GEMINI_FALLBACK_MODEL in der .env neu ("npm run models" zeigt die ` +
        `verfügbaren) oder lass es leer.`
      : `Das Ausweichmodell "${fallbackModel}" half ebenfalls nicht.`;

  return `${haupt} ${zusatz}`;
}

/** Nur fuer Tests: die reinen Hilfsfunktionen ohne Netzwerk. */
export const __test = { statusOf, explain, describeFailure };
