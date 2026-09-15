/**
 * Listet die Gemini-Modelle auf, die dein API-Key tatsaechlich nutzen darf.
 *
 *   npm run models
 *
 * Nuetzlich, wenn ein Modell dauerhaft ueberlastet ist (HTTP 503) oder gar nicht
 * mehr existiert (404): Namen von hier nach GEMINI_MODEL in die .env uebernehmen.
 */
import { getConfig } from "../src/config.ts";

interface ModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

async function main(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.geminiApiKey) {
    throw new Error("GEMINI_API_KEY fehlt in der .env.");
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${cfg.geminiApiKey}&pageSize=200`,
  );
  if (!res.ok) {
    throw new Error(`Abfrage fehlgeschlagen (HTTP ${res.status}). Stimmt der API-Key?`);
  }

  const data = (await res.json()) as { models?: ModelEntry[] };
  const usable = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    // Bild-, Video- und Sprachmodelle taugen nicht zum Strukturieren von Rezepten.
    .filter((n) => !/(embedding|aqa|imagen|veo|tts|image|audio)/i.test(n))
    .sort();

  // "-latest" zeigt laut Google auf experimentelle Modelle mit engeren Limits -
  // fuer den Dauerbetrieb ist eine feste Version die ruhigere Wahl.
  const stable = usable.filter((n) => !n.includes("latest") && !/preview|exp/i.test(n));
  const rest = usable.filter((n) => !stable.includes(n));

  console.log(`\n  Aktuell eingestellt: ${cfg.geminiModel}`);
  if (cfg.geminiFallbackModel) console.log(`  Ausweichmodell     : ${cfg.geminiFallbackModel}`);
  console.log(`  Für Audio          : ${cfg.geminiTranscribeModel}`);

  console.log(`\n  Stabile Modelle (empfohlen für GEMINI_MODEL)`);
  console.log("  " + "-".repeat(60));
  for (const n of stable) console.log(`  ${n}`);

  if (rest.length) {
    console.log(`\n  Experimentell / Vorschau / „-latest“`);
    console.log("  " + "-".repeat(60));
    console.log("  (engere Limits, Verfügbarkeit nicht zugesichert)");
    for (const n of rest) console.log(`  ${n}`);
  }

  console.log(
    `\n  Ein Modell übernehmen: in der .env GEMINI_MODEL setzen, optional` +
      `\n  zusätzlich GEMINI_FALLBACK_MODEL für den Fall der Überlastung.` +
      `\n  Danach:  docker compose up -d\n`,
  );
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
