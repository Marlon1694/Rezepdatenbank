import { getConfig } from "../config.ts";
import { transcribeLocal } from "./localWhisper.ts";
import { transcribeGemini } from "./gemini.ts";

export interface TranscriptResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

/**
 * Provider-Interface, damit der Wechsel zwischen lokalem Whisper und Gemini eine
 * Zeile in der .env bleibt und keine Codeaenderung wird.
 */
export async function transcribe(audioPath: string): Promise<TranscriptResult> {
  const provider = getConfig().transcribeProvider;
  const result =
    provider === "gemini" ? await transcribeGemini(audioPath) : await transcribeLocal(audioPath);

  if (!result.text.trim()) {
    throw new Error(
      "Die Transkription hat keinen Text ergeben. Enthält das Video überhaupt " +
        "gesprochene Anleitung? Manche TikToks zeigen das Rezept nur als eingeblendeten Text.",
    );
  }
  return result;
}
