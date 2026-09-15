/**
 * Ein Rezept direkt von der Kommandozeile erfassen - ohne Server, ohne Web-App.
 *
 *   npm run recipe -- <url>              schreibt nach Notion
 *   npm run recipe -- <url> --dry-run    zeigt nur, was geschrieben wuerde
 *
 * Der Trockenlauf ist der schnellste Weg, Prompt-Aenderungen zu pruefen.
 */
import { runPipeline } from "../src/jobs/pipeline.ts";

function usage(): never {
  console.error(`
  Aufruf: npm run recipe -- <url> [--dry-run]

    --dry-run   Nichts nach Notion schreiben, nur das Ergebnis anzeigen.
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) usage();

  const started = Date.now();
  const result = await runPipeline(
    url,
    (step) => console.log(`  · ${step} …`),
    dryRun,
  );

  const r = result.recipe;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n  ${r.emoji} ${r.titel}`);
  console.log(`  ${"─".repeat(60)}`);
  console.log(`  Tags     : ${r.tags.join(", ")}`);
  console.log(`  Zeit     : ${r.zeit_text}${r.zeit_minuten ? ` (${r.zeit_minuten} Min.)` : ""}`);
  if (r.portionen) console.log(`  Portionen: ${r.portionen}`);
  if (r.kueche) console.log(`  Küche    : ${r.kueche}`);
  console.log(`  Quelle   : ${result.textSource}`);

  console.log(`\n  Zutaten`);
  for (const gruppe of r.zutaten) {
    console.log(`    ${gruppe.gruppe}`);
    for (const e of gruppe.eintraege) {
      console.log(`      ☐ ${[e.menge, e.zutat].filter(Boolean).join(" ")}`);
    }
  }

  console.log(`\n  Zubereitung`);
  r.schritte.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));

  if (r.pro_tipp) console.log(`\n  💡 ${r.pro_tipp}`);

  if (result.upsert.skippedFields.length) {
    console.log(
      `\n  Hinweis: Fuer diese Felder gibt es keine passende Spalte in deiner ` +
        `Datenbank: ${result.upsert.skippedFields.join(", ")}.` +
        `\n  'npm run inspect:notion' zeigt dein Schema.`,
    );
  }

  if (dryRun) {
    console.log(`\n  Trockenlauf - nichts geschrieben. (${seconds}s)\n`);
  } else {
    console.log(
      `\n  ${result.upsert.updated ? "Aktualisiert" : "Angelegt"}: ` +
        `${result.upsert.pageUrl ?? result.upsert.pageId} (${seconds}s)\n`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(`\n  Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
