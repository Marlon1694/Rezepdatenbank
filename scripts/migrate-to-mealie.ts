/**
 * Uebernimmt den Rezeptbestand nach Mealie.
 *
 *   npm run migrate:mealie                 zeigt nur, was passieren wuerde
 *   npm run migrate:mealie -- --ausfuehren  legt wirklich an
 *   ... --ausfuehren --aufwerten            und ergaenzt alte Rezepte (siehe unten)
 *   ... --ausfuehren --aufwerten --neu      wertet alle erneut auf, auch schon aufgewertete
 *
 * Zwei Quellen:
 *   1. Der Verlauf der App. Dort liegt jedes Rezept strukturiert vor - es geht
 *      verlustfrei hinueber, samt Zerlegung der Zutaten, sofern vorhanden.
 *   2. Notion-Seiten, die nicht ueber die App kamen (von Hand angelegt oder aus
 *      der Zeit davor). Die werden aus den Bloecken der Seite zurueckgelesen.
 *
 * Das Titelbild kommt aus Notion: Dort liegt es dauerhaft, waehrend die
 * Vorschaubild-Adressen von TikTok und Instagram laengst abgelaufen sind.
 *
 * Was in Mealie schon steht, wird uebersprungen. Ein zweiter Lauf ist also
 * unschaedlich.
 *
 * --aufwerten: Rezepte von vor den zerlegten Zutaten bekommen je eine
 * KI-Anfrage (ohne Video, nur der Rezepttext), die Anzahl, Einheit und
 * Lebensmittel ergaenzt und welche Zutat zu welchem Schritt gehoert. Mealie
 * erhaelt das vollstaendige Rezept, in Notion kommt unter jeden Schritt die
 * Zutatenzeile - sonst bleibt die Notion-Seite unberuehrt. Rezepte, die
 * schon in Mealie stehen, werden dabei aktualisiert.
 */
import { getConfig } from "../src/config.ts";
import { listJobs, updateJob, closeDb } from "../src/jobs/store.ts";
import { getNotion, getDataSourceSchema } from "../src/notion/client.ts";
import { findProperty, findTitleProperty } from "../src/notion/mapper.ts";
import { fetchThumbnail } from "../src/notion/cover.ts";
import { loadMapping } from "../src/jobs/mapping.ts";
import { mealieEnabled, mealieSelf } from "../src/mealie/client.ts";
import { upsertMealieRecipe, findExisting } from "../src/mealie/recipes.ts";
import { enrichRecipe, needsEnrichment } from "../src/llm/enrich.ts";
import { addStepLinesToPage } from "../src/notion/stepLines.ts";
import {
  recipeFromNotionPage,
  type NotionBlock,
  type NotionProperty,
} from "../src/migrate/notionPage.ts";
import { RecipeSchema, type Recipe } from "../src/llm/recipeSchema.ts";
import { pickPerLink, similarTitles } from "../src/migrate/dedupe.ts";
import type { GeneratedImage } from "../src/llm/image.ts";

const ausfuehren = process.argv.includes("--ausfuehren");
const aufwerten = process.argv.includes("--aufwerten");
// Alles noch einmal zerlegen - etwa nachdem die Regeln dafuer besser wurden.
const neu = aufwerten && process.argv.includes("--neu");

interface NotionPage {
  id: string;
  url?: string;
  icon?: { type: string; emoji?: string } | null;
  cover?: { type: "file" | "external"; file?: { url: string }; external?: { url: string } } | null;
  properties: Record<string, NotionProperty>;
}

async function allPages(dataSourceId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const res = await getNotion().dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...(res.results as unknown as NotionPage[]));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return pages;
}

async function allBlocks(pageId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const res = await getNotion().blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...(res.results as unknown as NotionBlock[]));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return blocks;
}

/** Das Titelbild der Notion-Seite - frisch abgerufen, solange die signierte Adresse gilt. */
async function coverOf(page: NotionPage | undefined): Promise<GeneratedImage | undefined> {
  const url = page?.cover?.type === "file" ? page.cover.file?.url : page?.cover?.external?.url;
  return url ? fetchThumbnail(url) : undefined;
}

interface Kandidat {
  titel: string;
  herkunft: "Verlauf" | "Notion";
  recipe: Recipe;
  sourceUrl: string;
  page?: NotionPage;
  jobId?: string;
  /** Steht schon in Mealie - nur beim Aufwerten ein Kandidat. */
  mealieSlug?: string;
  notionPageId?: string;
  aiNotice?: string;
  /** Bekommt eine KI-Anfrage fuer Zutaten und Schritt-Zuordnung. */
  aufwerten: boolean;
}

/** Gespeicherte Rezepte durchs Schema - bereinigt etwa doppelte Mengen von gestern. */
function bereinigt(recipe: Recipe): Recipe {
  const r = RecipeSchema.safeParse(recipe);
  return r.success ? r.data : recipe;
}

async function main(): Promise<void> {
  if (!mealieEnabled()) {
    throw new Error("Mealie ist nicht eingerichtet: MEALIE_URL und MEALIE_API_TOKEN in der .env setzen.");
  }
  const cfg = getConfig();
  const self = await mealieSelf();
  console.log(`\n  Mealie: ${cfg.mealieUrl} (Konto ${self.username ?? self.email})`);

  const kandidaten: Kandidat[] = [];
  const uebersprungen: string[] = [];

  // ── 1. Verlauf der App ───────────────────────────────────────────────────
  const { nehmen: jobs, aeltere } = pickPerLink(
    listJobs(100_000).filter((j) => j.status === "done" && j.recipe),
  );
  const ohneStrich = (id: string) => id.replace(/-/g, "");
  // Notion-Seite -> Kandidat aus dem Verlauf, um ihm spaeter das Titelbild
  // der Seite zu geben.
  const ausVerlauf = new Map<string, Kandidat | null>();
  for (const job of aeltere) {
    // Ihre Notion-Seite soll auch nicht als eigenes Rezept wieder auftauchen.
    if (job.notionPageId) ausVerlauf.set(ohneStrich(job.notionPageId), null);
    uebersprungen.push(`${job.recipe!.titel} — ältere Fassung desselben Links`);
  }
  for (const job of jobs) {
    const recipe = bereinigt(job.recipe!);
    const alt = aufwerten && (neu || needsEnrichment(recipe));
    if (job.mealieSlug && !alt) {
      if (job.notionPageId) ausVerlauf.set(ohneStrich(job.notionPageId), null);
      uebersprungen.push(`${job.recipe!.titel} — schon in Mealie`);
      continue;
    }
    const k: Kandidat = {
      titel: recipe.titel,
      herkunft: "Verlauf",
      recipe,
      sourceUrl: job.url,
      jobId: job.id,
      mealieSlug: job.mealieSlug ?? undefined,
      notionPageId: job.notionPageId ?? undefined,
      aiNotice: job.aiNotice ?? undefined,
      aufwerten: alt,
    };
    kandidaten.push(k);
    if (job.notionPageId) ausVerlauf.set(ohneStrich(job.notionPageId), k);
  }

  // ── 2. Notion ────────────────────────────────────────────────────────────
  let pages: NotionPage[] = [];
  if (cfg.notionEnabled) {
    const [schema, mapping] = await Promise.all([getDataSourceSchema(), loadMapping()]);
    const name = (f: Parameters<typeof findProperty>[1]) =>
      findProperty(schema.properties, f, mapping)?.name;
    const fields = {
      titel: findTitleProperty(schema.properties)?.name,
      tags: name("tags"),
      zeit: name("zeit"),
      quelle: name("quelle"),
      portionen: name("portionen"),
      kueche: name("kueche"),
      schwierigkeit: name("schwierigkeit"),
    };

    pages = await allPages(schema.dataSourceId);
    console.log(`  Notion: ${pages.length} Seite(n) in „${schema.databaseTitle}"`);

    for (const page of pages) {
      // Kam die Seite ueber die App, liegt das Rezept im Verlauf schon besser
      // vor - von der Seite wird dann nur das Titelbild gebraucht.
      const id = ohneStrich(page.id);
      if (ausVerlauf.has(id)) {
        const k = ausVerlauf.get(id);
        if (k) k.page = page;
        continue;
      }

      const parsed = recipeFromNotionPage(
        { properties: page.properties, icon: page.icon, blocks: await allBlocks(page.id) },
        fields,
      );
      if ("reason" in parsed) {
        const t = page.properties[fields.titel ?? ""];
        const titel = t && t.type === "title" ? ((t.title as { plain_text: string }[])[0]?.plain_text ?? page.id) : page.id;
        uebersprungen.push(`${titel} — ${parsed.reason}`);
        continue;
      }
      kandidaten.push({
        titel: parsed.recipe.titel,
        herkunft: "Notion",
        recipe: parsed.recipe,
        sourceUrl: parsed.sourceUrl,
        page,
        notionPageId: page.id,
        aufwerten:
          aufwerten && (neu || (!parsed.mitZutatenzeilen && needsEnrichment(parsed.recipe))),
      });
    }
  }

  // ── Bericht und Ausfuehrung ──────────────────────────────────────────────
  console.log(`\n  ${kandidaten.length} Rezept(e) zu übernehmen:`);
  for (const k of kandidaten) {
    const z = k.recipe.zutaten.reduce((n, g) => n + g.eintraege.length, 0);
    const extra = [k.mealieSlug ? "schon in Mealie" : "", k.aufwerten ? "wird aufgewertet" : ""]
      .filter(Boolean)
      .join(", ");
    console.log(
      `    • ${k.titel}  (${k.herkunft}, ${z} Zutaten, ${k.recipe.schritte.length} Schritte` +
        `${extra ? `; ${extra}` : ""})`,
    );
  }
  const aehnlich = similarTitles(kandidaten.map((k) => k.titel));
  if (aehnlich.length) {
    console.log(`\n  Achtung, ähnliche Titel (verschiedene Links) - würden einzeln angelegt:`);
    for (const g of aehnlich) console.log(`    ! ${g.join("  |  ")}`);
    console.log(`    Doppelte vorher in der App im Verlauf löschen, dann den Probelauf wiederholen.`);
  }
  if (uebersprungen.length) {
    console.log(`\n  ${uebersprungen.length} übersprungen:`);
    for (const u of uebersprungen) console.log(`    – ${u}`);
  }

  if (!ausfuehren) {
    const n = kandidaten.filter((k) => k.aufwerten).length;
    if (n) console.log(`\n  ${n} Rezept(e) würden aufgewertet - je eine KI-Anfrage.`);
    console.log(`\n  Probelauf - nichts angelegt. Wirklich übernehmen mit:`);
    console.log(
      `    npm run migrate:mealie -- --ausfuehren${aufwerten ? " --aufwerten" : ""}${neu ? " --neu" : ""}\n`,
    );
    return;
  }

  console.log("");
  let ok = 0;
  const fehler: string[] = [];
  const notionHinweise: string[] = [];
  // Ist das Tageskontingent weg, scheitert jede weitere Anfrage genauso -
  // nach je einer Minute Wartezeit. Dann ohne Aufwerten weiter.
  let kontingentWeg = false;
  for (const [i, k] of kandidaten.entries()) {
    const nr = `[${i + 1}/${kandidaten.length}]`;
    try {
      let recipe = k.recipe;
      let aufgewertet = false;
      if (k.aufwerten && !kontingentWeg) {
        try {
          recipe = await enrichRecipe(recipe, { ersetzen: neu });
          aufgewertet = true;
        } catch (err) {
          // Ohne Aufwertung geht es trotzdem nach Mealie - nur ohne den Komfort.
          const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
          console.log(`  ${nr} Aufwerten fehlgeschlagen (${msg}), übernehme ohne: ${k.titel}`);
          if (/Kontingent ist aufgebraucht|Limit erreicht/.test(msg ?? "")) {
            kontingentWeg = true;
            console.log(`  Gemini-Kontingent für heute aufgebraucht - ab hier ohne Aufwerten.`);
          }
        }
      }

      // Steht es schon in Mealie, bleibt es unangetastet - dort hast du es
      // inzwischen womoeglich bearbeitet. Nur die Verknuepfung wird gemerkt.
      // Ausnahme: Es wurde gerade aufgewertet, dann ist genau das gewollt.
      const da =
        k.mealieSlug !== undefined
          ? { slug: k.mealieSlug }
          : await findExisting({ recipe, sourceUrl: k.sourceUrl, dedupeByName: !k.sourceUrl });

      if (da && !aufgewertet) {
        if (k.jobId && !k.mealieSlug) {
          updateJob(k.jobId, {
            mealieSlug: da.slug,
            mealieUrl: `${cfg.mealieUrl}/g/${self.groupSlug}/r/${da.slug}`,
          });
        }
        console.log(`  ${nr} schon in Mealie, übersprungen: ${k.titel}`);
        continue;
      }

      const r = await upsertMealieRecipe({
        recipe,
        sourceUrl: k.sourceUrl,
        existingSlug: da?.slug,
        // Ein vorhandenes Rezept behaelt sein Bild.
        coverImage: da ? undefined : await coverOf(k.page),
        aiNotice: k.aiNotice,
        dedupeByName: !k.sourceUrl,
      });
      if (k.jobId) {
        updateJob(k.jobId, {
          mealieSlug: r.slug,
          mealieUrl: r.url,
          ...(aufgewertet ? { recipe } : {}),
        });
      }
      ok++;

      let notionTeil = "";
      if (aufgewertet && cfg.notionEnabled && k.notionPageId) {
        try {
          const n = await addStepLinesToPage(k.notionPageId, recipe);
          if (n.ok) notionTeil = `, Notion: ${n.geaendert} Schritt(e) ergänzt`;
          else notionHinweise.push(`${k.titel}: ${n.reason} - Notion-Seite unverändert`);
        } catch (err) {
          const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
          notionHinweise.push(`${k.titel}: ${msg}`);
        }
      }
      console.log(
        `  ${nr} ${r.updated ? "aktualisiert" : "angelegt"}${aufgewertet ? " und aufgewertet" : ""}` +
          `: ${k.titel}${notionTeil}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fehler.push(`${k.titel}: ${msg}`);
      console.log(`  ${nr} FEHLER: ${k.titel} — ${msg}`);
    }
  }

  if (notionHinweise.length) {
    console.log(`\n  In Notion nicht ergänzt (${notionHinweise.length}):`);
    for (const h of notionHinweise) console.log(`    – ${h}`);
  }
  console.log(`\n  Fertig: ${ok} übernommen, ${fehler.length} fehlgeschlagen.`);
  if (kontingentWeg) {
    console.log(
      `  Nicht alle Rezepte sind aufgewertet. Morgen denselben Befehl noch einmal - ` +
        `er wertet nur die fehlenden auf.`,
    );
  }
  if (fehler.length) {
    console.log(`  Ein zweiter Lauf versucht nur die fehlgeschlagenen erneut.\n`);
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\n  Abgebrochen: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
