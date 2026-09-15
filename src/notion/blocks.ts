import type { Recipe } from "../llm/recipeSchema.ts";
import { truncate } from "./mapper.ts";

/**
 * Rendert die Rezept-Karte als Notion-Bloecke. Reine Funktionen, in
 * tests/blocks.test.ts abgedeckt.
 *
 * Bewusst echte to_do-Bloecke fuer die Zutaten: "[ ]" im Prompt meint Kaestchen zum
 * Abhaken, und das kann Notion nativ - als Text waeren es nur zwei Zeichen.
 */

type Block = Record<string, unknown>;

const NOTION_TEXT_LIMIT = 2000;
/** Notion nimmt pro Aufruf hoechstens 100 Kindbloecke an. */
export const MAX_BLOCKS_PER_REQUEST = 100;

function text(content: string) {
  return [{ type: "text" as const, text: { content: truncate(content, NOTION_TEXT_LIMIT) } }];
}

function link(content: string, url: string) {
  return [{ type: "text" as const, text: { content: truncate(content), link: { url } } }];
}

function heading(content: string): Block {
  return { object: "block", type: "heading_2", heading_2: { rich_text: text(content) } };
}

function subheading(content: string): Block {
  return { object: "block", type: "heading_3", heading_3: { rich_text: text(content) } };
}

/** Zerlegt langen Text in Absaetze unterhalb des 2000-Zeichen-Limits. */
export function chunkText(value: string, size = NOTION_TEXT_LIMIT): string[] {
  if (value.length <= size) return value ? [value] : [];
  const chunks: string[] = [];
  let rest = value;
  while (rest.length > size) {
    // Moeglichst an einem Satz- oder Wortende trennen statt mitten im Wort.
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > size * 0.5 ? cut + 1 : size;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

export interface BlockOptions {
  sourceUrl: string;
  sourceTitle?: string;
  /** Original-Transkript; landet zugeklappt am Seitenende zum Nachpruefen. */
  transcript?: string;
  /** Wie der Text gewonnen wurde - hilft beim Einschaetzen der Qualitaet. */
  transcriptSource?: string;
  /**
   * Gibt es eine eigene Spalte fuer die Zubereitungszeit? Dann zeigt Notion sie
   * ohnehin im Seitenkopf an und dieselbe Angabe im Text waere nur Dopplung.
   */
  hasTimeProperty?: boolean;
}

export function buildRecipeBlocks(recipe: Recipe, opts: BlockOptions): Block[] {
  const blocks: Block[] = [];

  // ── Quelle ─────────────────────────────────────────────────────────────────
  blocks.push({
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "🔗" },
      color: "gray_background",
      rich_text: link(opts.sourceTitle?.trim() || opts.sourceUrl, opts.sourceUrl),
    },
  });

  if (recipe.zeit_text.trim() && !opts.hasTimeProperty) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: text(`⏱️ ${recipe.zeit_text}`) },
    });
  }

  // ── Zutaten ────────────────────────────────────────────────────────────────
  blocks.push(heading("Zutaten"));

  const singleGroup = recipe.zutaten.length === 1;
  for (const gruppe of recipe.zutaten) {
    // Bei nur einer generischen Gruppe waere die Zwischenueberschrift Rauschen.
    const generic = /^(zutaten|hauptzutaten|alle zutaten)$/i.test(gruppe.gruppe.trim());
    if (!(singleGroup && generic)) blocks.push(subheading(gruppe.gruppe));

    for (const eintrag of gruppe.eintraege) {
      const label = eintrag.menge?.trim()
        ? `${eintrag.menge.trim()} ${eintrag.zutat.trim()}`
        : eintrag.zutat.trim();
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: { rich_text: text(label), checked: false },
      });
    }
  }

  // ── Zubereitung ────────────────────────────────────────────────────────────
  blocks.push(heading("Zubereitung"));
  for (const schritt of recipe.schritte) {
    blocks.push({
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: { rich_text: text(schritt) },
    });
  }

  // ── Pro-Tipp ───────────────────────────────────────────────────────────────
  if (recipe.pro_tipp.trim()) {
    blocks.push({
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "💡" },
        color: "yellow_background",
        rich_text: text(recipe.pro_tipp.trim()),
      },
    });
  }

  // ── Transkript ─────────────────────────────────────────────────────────────
  if (opts.transcript?.trim()) {
    const label = opts.transcriptSource
      ? `Original-Transkript (${opts.transcriptSource})`
      : "Original-Transkript";
    blocks.push({
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: text(label),
        children: chunkText(opts.transcript.trim()).map((chunk) => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: text(chunk) },
        })),
      },
    });
  }

  return blocks;
}

/** Teilt Bloecke in Paeckchen, die Notion pro Aufruf annimmt. */
export function chunkBlocks(blocks: Block[], size = MAX_BLOCKS_PER_REQUEST): Block[][] {
  const out: Block[][] = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}
