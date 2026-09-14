import { spawn } from "node:child_process";
import { getConfig } from "../config.ts";
import type { TranscriptResult } from "./index.ts";

/** Ruft scripts/transcribe.py auf und liest dessen JSON von stdout. */
export function transcribeLocal(audioPath: string): Promise<TranscriptResult> {
  const cfg = getConfig();

  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [
        "scripts/transcribe.py",
        audioPath,
        "--model",
        cfg.whisperModel,
        "--compute-type",
        cfg.whisperComputeType,
        "--model-dir",
        `${cfg.dataDir}/models`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    child.on("error", (err) =>
      reject(
        new Error(
          `python3 nicht startbar (${err.message}). Im Container ist alles enthalten; ` +
            `lokal: pip install faster-whisper`,
        ),
      ),
    );

    child.on("close", () => {
      // Das Skript schreibt auch Fehler als JSON - erst parsen, dann urteilen.
      const line = stdout.trim().split("\n").pop() ?? "";
      let parsed: { text?: string; error?: string; language?: string; durationSeconds?: number };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        reject(new Error(`Transkription fehlgeschlagen: ${stderr.trim() || "keine Ausgabe"}`));
        return;
      }
      if (parsed.error) {
        reject(new Error(`Transkription fehlgeschlagen: ${parsed.error}`));
        return;
      }
      resolve({
        text: parsed.text ?? "",
        language: parsed.language,
        durationSeconds: parsed.durationSeconds,
      });
    });
  });
}
