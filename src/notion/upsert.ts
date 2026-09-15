import { getNotion, getDataSourceSchema } from "./client.ts";
import { buildProperties, findProperty, type Mapping } from "./mapper.ts";
import { buildRecipeBlocks, chunkBlocks } from "./blocks.ts";
import type { Recipe } from "../llm/recipeSchema.ts";
import { getConfig } from "../config.ts";
import { generateCoverImage } from "../llm/image.ts";
import { uploadCover } from "./cover.ts";

export interface UpsertInput {
  recipe: Recipe;
  sourceUrl: string;
  sourceTitle?: string;
  transcript?: string;
  transcriptSource?: string;
  mapping?: Mapping;
  /** true = nichts schreiben, nur das fertige Payload zurueckgeben. */
  dryRun?: boolean;
}

export interface UpsertResult {
  pageId?: string;
  pageUrl?: string;
  /** true, wenn eine bestehende Seite zur selben Quell-URL ersetzt wurde. */
  updated: boolean;
  skippedFields: string[];
  payload?: unknown;
}

/** Sucht eine bereits vorhandene Seite zur selben Quell-URL. */
async function findExistingPage(
  sourceUrl: string,
  mapping: Mapping,
): Promise<string | undefined> {
  const schema = await getDataSourceSchema();
  const quelleProp = findProperty(schema.properties, "quelle", mapping);
  if (!quelleProp) return undefined;

  const filter =
    quelleProp.type === "url"
      ? { property: quelleProp.name, url: { equals: sourceUrl } }
      : quelleProp.type === "rich_text"
        ? { property: quelleProp.name, rich_text: { equals: sourceUrl } }
        : undefined;
  if (!filter) return undefined;

  try {
    const res = await getNotion().dataSources.query({
      data_source_id: schema.dataSourceId,
      filter: filter as never,
      page_size: 1,
    });
    return res.results[0]?.id;
  } catch (err) {
    // Ein fehlgeschlagener Duplikat-Check darf das Anlegen nicht verhindern.
    console.warn(`[notion] Duplikat-Suche fehlgeschlagen, lege neu an: ${String(err)}`);
    return undefined;
  }
}

/** Entfernt alle Kindbloecke einer Seite, damit der Inhalt sauber neu geschrieben wird. */
async function clearPageContent(pageId: string): Promise<void> {
  const notion = getNotion();
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    ids.push(...res.results.map((b) => b.id));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  for (const id of ids) {
    await notion.blocks.delete({ block_id: id });
  }
}

export async function upsertRecipe(input: UpsertInput): Promise<UpsertResult> {
  const cfg = getConfig();
  const schema = await getDataSourceSchema();
  const mapping = input.mapping ?? {};

  // Erst nachsehen, ob es die Seite schon gibt: davon haengt ab, ob der Status
  // gesetzt wird. Sonst wuerfe ein erneuter Import ein auf "Perfektioniert"
  // stehendes Rezept wieder auf "Ausprobieren" zurueck.
  const existingId = input.dryRun
    ? undefined
    : await findExistingPage(input.sourceUrl, mapping);

  const { properties, skipped } = buildProperties(input.recipe, schema, {
    sourceUrl: input.sourceUrl,
    tagsWithHash: cfg.tagsWithHash,
    mapping,
    newRecipeStatus: existingId ? undefined : cfg.newRecipeStatus,
  });

  const blocks = buildRecipeBlocks(input.recipe, {
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    transcript: input.transcript,
    transcriptSource: input.transcriptSource,
    hasTimeProperty: Boolean(findProperty(schema.properties, "zeit", mapping)),
  });

  // Titelbild: laeuft parallel zum Rest und darf scheitern, ohne das Rezept
  // mitzureissen.
  let coverId: string | undefined;
  if (!input.dryRun) {
    const image = await generateCoverImage(input.recipe);
    if (image) coverId = await uploadCover(image);
  }
  const cover = coverId
    ? ({ type: "file_upload", file_upload: { id: coverId } } as const)
    : undefined;

  const batches = chunkBlocks(blocks);
  const [firstBatch = [], ...restBatches] = batches;

  if (input.dryRun) {
    return {
      updated: false,
      skippedFields: skipped,
      payload: {
        parent: { type: "data_source_id", data_source_id: schema.dataSourceId },
        icon: { type: "emoji", emoji: input.recipe.emoji },
        properties,
        children: blocks,
      },
    };
  }

  const notion = getNotion();

  let pageId: string;
  let pageUrl: string | undefined;

  if (existingId) {
    await notion.pages.update({
      page_id: existingId,
      icon: { type: "emoji", emoji: input.recipe.emoji },
      // Nur ueberschreiben, wenn ein neues Bild entstanden ist - sonst bliebe
      // ein selbst gesetztes Titelbild auf der Strecke.
      ...(cover ? { cover } : {}),
      properties: properties as never,
    });
    await clearPageContent(existingId);
    pageId = existingId;
    if (firstBatch.length) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: firstBatch as never,
      });
    }
  } else {
    const created = await notion.pages.create({
      parent: { type: "data_source_id", data_source_id: schema.dataSourceId },
      icon: { type: "emoji", emoji: input.recipe.emoji },
      ...(cover ? { cover } : {}),
      properties: properties as never,
      children: firstBatch as never,
    });
    pageId = created.id;
    pageUrl = "url" in created ? created.url : undefined;
  }

  for (const batch of restBatches) {
    await notion.blocks.children.append({ block_id: pageId, children: batch as never });
  }

  if (!pageUrl) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    pageUrl = "url" in page ? page.url : undefined;
  }

  return { pageId, pageUrl, updated: Boolean(existingId), skippedFields: skipped };
}
