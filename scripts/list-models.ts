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

async function modelsFor(key: string, name: string): Promise<ModelEntry[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`,
  );
  if (!res.ok) {
    throw new Error(`Abfrage fehlgeschlagen (HTTP ${res.status}). Stimmt ${name}?`);
  }
  return ((await res.json()) as { models?: ModelEntry[] }).models ?? [];
}

async function main(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.geminiApiKey) {
    throw new Error("GEMINI_API_KEY fehlt in der .env.");
  }

  const data = { models: await modelsFor(cfg.geminiApiKey, "GEMINI_API_KEY") };
  const usable = data.models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    // Einbettungs- und Video-/Musikmodelle taugen fuer keinen unserer Schritte.
    .filter((n) => !/(embedding|aqa|veo|tts|lyria)/i.test(n))
    .sort();

  // Bildmodelle getrennt ausweisen: sie kommen fuer ein Titelbild in Frage,
  // nicht fuer die Rezept-Extraktion.
  const textModels = usable.filter((n) => !/(imagen|image|banana)/i.test(n));
  // Imagen arbeitet ueber "predict", nicht "generateContent" - ein Filter nur
  // auf generateContent liesse ausgerechnet das guenstigste Bildmodell weg.
  // Bilder laufen ueber den bezahlten Key - es zaehlt, was der darf.
  const bildListe = cfg.geminiPaidApiKey
    ? await modelsFor(cfg.geminiPaidApiKey, "GEMINI_PAID_API_KEY")
    : data.models;
  const imageModels = bildListe
    .filter((m) =>
      m.supportedGenerationMethods?.some((g) => g === "predict" || g === "generateContent"),
    )
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /(imagen|image|banana)/i.test(n))
    .sort();

  // "-latest" zeigt laut Google auf experimentelle Modelle mit engeren Limits -
  // fuer den Dauerbetrieb ist eine feste Version die ruhigere Wahl.
  const stable = textModels.filter((n) => !n.includes("latest") && !/preview|exp/i.test(n));
  const rest = textModels.filter((n) => !stable.includes(n));

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

  if (imageModels.length) {
    console.log(
      `\n  Bildmodelle (für IMAGE_MODEL)${cfg.geminiPaidApiKey ? " - über GEMINI_PAID_API_KEY" : ""}`,
    );
    console.log("  " + "-".repeat(60));
    for (const n of imageModels) console.log(`  ${n}`);
  } else {
    console.log(`\n  Bildmodelle: keine verfügbar`);
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
