import { getNotion } from "./client.ts";
import { STEP_INGREDIENTS_MARK } from "./blocks.ts";
import { stepIngredientLabels } from "../llm/stepIngredients.ts";
import { walkRecipeBlocks, type NotionBlock } from "../migrate/notionPage.ts";
import type { Recipe } from "../llm/recipeSchema.ts";

/**
 * Schreibt unter jeden Schritt einer bestehenden Notion-Seite die Zeile
 * "↳ 200 g Mehl · 2 Eier" - und fasst sonst nichts an.
 *
 * Bewusst kein Neuschreiben der Seite: Kommentare, eigene Notizen, ein von
 * Hand getauschtes Titelbild oder eine in Notion korrigierte Menge bleiben,
 * wie sie sind. Geaendert wird nur der Text der Schritt-Bloecke, und auch
 * dort nur die Zutatenzeile.
 */

type RichTextItem = {
  type: string;
  plain_text?: string;
  href?: string | null;
  text?: { content: string; link?: { url: string } | null };
  [key: string]: unknown;
};

const MARKE = `\n${STEP_INGREDIENTS_MARK}`;

/**
 * Der Text eines Schritts ohne seine bisherige Zutatenzeile - in der Form,
 * die Notion beim Schreiben annimmt (plain_text und href sind nur lesbar).
 */
export function withoutStepLine(items: RichTextItem[]): RichTextItem[] {
  const out: RichTextItem[] = [];
  for (const item of items) {
    const { plain_text: plain, href: _href, ...rest } = item;
    const inhalt = rest.type === "text" ? (rest.text?.content ?? "") : (plain ?? "");
    const pos = inhalt.indexOf(MARKE);
    if (pos === -1) {
      out.push(rest);
      continue;
    }
    // Ab hier beginnt die alte Zutatenzeile; alles danach gehoert zu ihr.
    if (pos > 0 && rest.type === "text") {
      out.push({ ...rest, text: { ...rest.text!, content: inhalt.slice(0, pos) } });
    }
    break;
  }
  return out;
}

export function withStepLine(items: RichTextItem[], label: string): RichTextItem[] {
  const basis = withoutStepLine(items);
  if (!label) return basis;
  return [
    ...basis,
    {
      type: "text",
      text: { content: `${MARKE}${label}`.slice(0, 2000) },
      annotations: { color: "gray", italic: true },
    },
  ];
}

async function topLevelBlocks(pageId: string): Promise<NotionBlock[]> {
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

export type StepLinesResult =
  | { ok: true; geaendert: number }
  | { ok: false; reason: string };

export async function addStepLinesToPage(pageId: string, recipe: Recipe): Promise<StepLinesResult> {
  const { schritte } = walkRecipeBlocks(await topLevelBlocks(pageId));

  // Stimmt die Zahl der Schritte nicht, ist die Seite in Notion veraendert
  // worden. Jede Zeile saesse dann womoeglich unter dem falschen Schritt -
  // lieber gar keine.
  if (schritte.length !== recipe.schritte.length) {
    return {
      ok: false,
      reason: `Notion hat ${schritte.length} Schritte, das Rezept ${recipe.schritte.length}`,
    };
  }

  const labels = stepIngredientLabels(recipe);
  let geaendert = 0;
  for (const [i, { block }] of schritte.entries()) {
    const typ = block.type;
    const inhalt = block[typ] as { rich_text?: RichTextItem[] } | undefined;
    const vorher = inhalt?.rich_text ?? [];
    const label = labels[i] ?? "";
    const hatteZeile = vorher.some((t) => (t.plain_text ?? t.text?.content ?? "").includes(MARKE));
    // Kein Schritt ohne Grund anfassen: Jede Aenderung erscheint in Notions
    // Seitenverlauf.
    if (!label && !hatteZeile) continue;
    const nachher = withStepLine(vorher, label);
    await getNotion().blocks.update({
      block_id: block.id as string,
      [typ]: { rich_text: nachher },
    } as never);
    geaendert++;
  }
  return { ok: true, geaendert };
}
