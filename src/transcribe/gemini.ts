import { readFile, stat } from "node:fs/promises";
import { getConfig } from "../config.ts";
import { getGemini } from "../llm/gemini.ts";
import type { TranscriptResult } from "./index.ts";

/** Gemini nimmt Audio direkt entgegen - spart die CPU-Last von Whisper. */
export async function transcribeGemini(audioPath: string): Promise<TranscriptResult> {
  const cfg = getConfig();
  const { size } = await stat(audioPath);

  // Inline-Daten sind bis ~20 MB zulaessig. 16 kHz Mono Opus liegt selbst bei einer
  // Stunde deutlich darunter, aber eine klare Meldung ist besser als ein API-Fehler.
  if (size > 18 * 1024 * 1024) {
    throw new Error(
      `Die Tonspur ist mit ${(size / 1024 / 1024).toFixed(1)} MB zu gross fuer den ` +
        `Gemini-Weg. Setze TRANSCRIBE_PROVIDER=local in der .env.`,
    );
  }

  const audio = await readFile(audioPath);
  const response = await getGemini().models.generateContent({
    model: cfg.geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "audio/ogg", data: audio.toString("base64") } },
          {
            text:
              "Transkribiere diese Tonspur eines Kochvideos wortgetreu. Gib nur den " +
              "Transkripttext zurueck, ohne Zeitstempel, ohne Kommentare, ohne Einleitung.",
          },
        ],
      },
    ],
  });

  return { text: (response.text ?? "").trim() };
}
