/**
 * Zeigt das Schema deiner Notion-Rezept-Datenbank an und schlaegt eine passende
 * config/notion-mapping.json vor.
 *
 *   npm run inspect:notion
 *
 * Das ist gleichzeitig der schnellste Test, ob Token, Datenbank-ID und die
 * Freigabe der Integration stimmen.
 */
import { getDataSourceSchema } from "../src/notion/client.ts";
import {
  findProperty,
  findTitleProperty,
  type CanonicalField,
  type Mapping,
} from "../src/notion/mapper.ts";
import { writeFileSync, existsSync } from "node:fs";

const FIELDS: CanonicalField[] = [
  "titel",
  "tags",
  "zeit",
  "quelle",
  "portionen",
  "kueche",
  "datum",
];

const BESCHREIBUNG: Record<CanonicalField, string> = {
  titel: "Name des Gerichts (mit Emoji)",
  tags: "3-5 Schlagworte",
  zeit: "Zubereitungszeit",
  quelle: "Link zum Video/Rezept  << wichtig fuer die Duplikat-Erkennung",
  portionen: "optional",
  kueche: "optional",
  datum: "optional, wird automatisch auf heute gesetzt",
};

async function main(): Promise<void> {
  const schema = await getDataSourceSchema(true);

  console.log(`\n  Datenbank : ${schema.databaseTitle}`);
  console.log(`  Datenquelle: ${schema.dataSourceId}\n`);

  console.log("  Spalten in deiner Datenbank");
  console.log("  " + "-".repeat(70));
  for (const p of schema.properties) {
    const opts = p.options.length
      ? `  [${p.options.slice(0, 6).join(", ")}${p.options.length > 6 ? ", ..." : ""}]`
      : "";
    console.log(`  ${p.name.padEnd(28)} ${p.type.padEnd(18)}${opts}`);
  }

  console.log("\n  Automatische Zuordnung");
  console.log("  " + "-".repeat(70));

  const mapping: Mapping = {};
  let missingQuelle = false;

  for (const field of FIELDS) {
    const prop = field === "titel"
      ? findTitleProperty(schema.properties)
      : findProperty(schema.properties, field);

    if (prop) {
      mapping[field] = prop.name;
      console.log(`  ${field.padEnd(12)} -> ${prop.name}  (${prop.type})`);
    } else {
      console.log(`  ${field.padEnd(12)} -> nicht gefunden   ${BESCHREIBUNG[field]}`);
      if (field === "quelle") missingQuelle = true;
    }
  }

  const tagsProp = findProperty(schema.properties, "tags");
  if (tagsProp?.options.length) {
    const withHash = tagsProp.options.filter((o) => o.startsWith("#")).length;
    console.log(
      `\n  Vorhandene Tags: ${tagsProp.options.length}` +
        (withHash ? `, davon ${withHash} mit '#' - die Schreibweise wird uebernommen.` : ""),
    );
  }

  if (missingQuelle) {
    console.log(
      "\n  Hinweis: Ohne eine URL- oder Text-Spalte fuer die Quelle kann derselbe Link\n" +
        "  nicht wiedererkannt werden - jeder Lauf legt dann eine neue Seite an.\n" +
        "  Eine Spalte 'Quelle' vom Typ URL in Notion anzulegen behebt das.",
    );
  }

  const target = "config/notion-mapping.json";
  if (existsSync(target)) {
    console.log(`\n  ${target} existiert bereits - nicht ueberschrieben.`);
    console.log(`  Vorschlag auf Basis der Erkennung oben:\n`);
    console.log(JSON.stringify(mapping, null, 2));
  } else {
    writeFileSync(target, `${JSON.stringify(mapping, null, 2)}\n`);
    console.log(`\n  ${target} geschrieben. Spaltennamen dort bei Bedarf korrigieren.`);
    console.log(`  Ein Feld auf null setzen schaltet es ab.`);
  }
  console.log();
}

main().catch((err: unknown) => {
  console.error(`\n  Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}\n`);
  console.error("  Checkliste siehe docs/notion.md\n");
  process.exit(1);
});
