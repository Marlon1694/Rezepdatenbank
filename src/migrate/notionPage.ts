import { RecipeSchema, type Recipe } from "../llm/recipeSchema.ts";

/**
 * Liest ein Rezept aus einer Notion-Seite zurueck - fuer die einmalige
 * Uebernahme nach Mealie.
 *
 * Die Seiten, die die App selbst angelegt hat, folgen einem festen Aufbau.
 * Von Hand angelegte weichen davon ab: andere Ueberschriften, Aufzaehlungen
 * statt Kaestchen, Mengen mitten im Text. Der Parser nimmt deshalb, was nach
 * Rezept aussieht, und lehnt nur ab, was wirklich keines ist.
 */

type RichText = { plain_text?: string }[];
export type NotionBlock = { type: string; [key: string]: unknown };
export type NotionProperty = { type: string; [key: string]: unknown };

function plain(rt: unknown): string {
  return Array.isArray(rt) ? (rt as RichText).map((t) => t.plain_text ?? "").join("").trim() : "";
}

function blockText(block: NotionBlock): string {
  const inner = block[block.type] as { rich_text?: unknown } | undefined;
  return plain(inner?.rich_text);
}

function propertyText(prop: NotionProperty | undefined): string | null {
  if (!prop) return null;
  const v = prop[prop.type];
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plain(v) || null;
    case "select":
    case "status":
      return (v as { name?: string } | null)?.name ?? null;
    case "number":
      return typeof v === "number" ? String(v) : null;
    case "url":
      return typeof v === "string" && v ? v : null;
    default:
      return null;
  }
}

function propertyList(prop: NotionProperty | undefined): string[] {
  if (!prop) return [];
  if (prop.type === "multi_select") {
    return ((prop.multi_select as { name: string }[]) ?? []).map((o) => o.name);
  }
  const text = propertyText(prop);
  return text ? text.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
}

const EINHEIT =
  "g|kg|mg|ml|l|cl|dl|EL|TL|Msp\\.?|Prisen?|Pck\\.?|Pkg\\.?|Packung(?:en)?|Dosen?|Bund|Zehen?|" +
  "Stück|Stk\\.?|Becher|Tassen?|Scheiben?|Zweige?|Blätter|Blatt|cups?|tbsp|tsp|oz|lb";

/**
 * "200 g Mehl" -> Menge "200 g", Zutat "Mehl". Nur mit Zahl am Anfang - und
 * eine Einheit nur aus einer festen Liste, sonst wuerde aus "2 Zwiebeln" die
 * Menge "2 Zwiebeln" ohne Zutat.
 */
export function splitIngredient(text: string): { menge: string | null; zutat: string } {
  const m = new RegExp(
    `^((?:ca\\.\\s*)?[\\d½¼¾⅓⅔.,/]+(?:\\s*[-–]\\s*[\\d.,/]+)?(?:\\s*(?:${EINHEIT})\\b)?)\\s+(.+)$`,
    "i",
  ).exec(text.trim());
  if (m?.[1] && m[2]) return { menge: m[1].trim(), zutat: m[2].trim() };
  return { menge: null, zutat: text.trim() };
}

type Abschnitt = "zutaten" | "schritte" | "sonst";

function abschnittFuer(ueberschrift: string): Abschnitt {
  const t = ueberschrift.toLowerCase();
  if (/zutat|einkauf|ingredient/.test(t)) return "zutaten";
  if (/zubereitung|anleitung|schritt|so geht|method|instruction/.test(t)) return "schritte";
  return "sonst";
}

const LISTE = new Set(["to_do", "bulleted_list_item", "numbered_list_item"]);
const UEBERSCHRIFT = new Set(["heading_1", "heading_2"]);

export interface NotionPageInput {
  properties: Record<string, NotionProperty>;
  icon?: { type: string; emoji?: string } | null;
  blocks: NotionBlock[];
}

export interface ParsedNotionRecipe {
  recipe: Recipe;
  sourceUrl: string;
}

/**
 * Gibt das Rezept zurueck oder den Grund, warum die Seite keines ist.
 *
 * `fields` sagt, welche Notion-Spalte welches Feld ist - dieselbe Zuordnung,
 * mit der die App schreibt.
 */
export function recipeFromNotionPage(
  page: NotionPageInput,
  fields: Partial<Record<"titel" | "tags" | "zeit" | "quelle" | "portionen" | "kueche" | "schwierigkeit", string>>,
): ParsedNotionRecipe | { reason: string } {
  const prop = (k: keyof typeof fields) => (fields[k] ? page.properties[fields[k]!] : undefined);

  const titel = propertyText(prop("titel"));
  if (!titel) return { reason: "kein Titel" };

  const gruppen: { gruppe: string; eintraege: { menge: string | null; zutat: string }[] }[] = [];
  const schritte: string[] = [];
  let pro_tipp = "";
  let abschnitt: Abschnitt = "sonst";

  for (const block of page.blocks) {
    const text = blockText(block);

    if (UEBERSCHRIFT.has(block.type)) {
      abschnitt = abschnittFuer(text);
      continue;
    }
    // Eine Unterueberschrift ist im Zutatenteil eine Gruppe ("Für den Teig").
    // Ausserhalb kann sie selbst einen Abschnitt beginnen - bei von Hand
    // angelegten Seiten steht "Zutaten" oft nur als kleine Ueberschrift da.
    if (block.type === "heading_3") {
      const neu = abschnittFuer(text);
      if (neu !== "sonst") abschnitt = neu;
      else if (abschnitt === "zutaten") gruppen.push({ gruppe: text, eintraege: [] });
      continue;
    }

    if (block.type === "callout") {
      const icon = (block.callout as { icon?: { emoji?: string } }).icon?.emoji;
      if (icon === "💡") pro_tipp = text;
      continue;
    }
    if (!text) continue;

    if (abschnitt === "zutaten" && (LISTE.has(block.type) || block.type === "paragraph")) {
      if (!gruppen.length) gruppen.push({ gruppe: "Zutaten", eintraege: [] });
      gruppen[gruppen.length - 1]!.eintraege.push(splitIngredient(text));
    } else if (abschnitt === "schritte" && (LISTE.has(block.type) || block.type === "paragraph")) {
      schritte.push(text);
    }
  }

  const zutaten = gruppen.filter((g) => g.eintraege.length);
  if (!zutaten.length) return { reason: "keine Zutaten gefunden" };
  if (!schritte.length) return { reason: "keine Zubereitung gefunden" };

  const zeit = propertyText(prop("zeit"));
  const zeitMinuten = zeit && /^\d+$/.test(zeit) ? Number(zeit) : undefined;

  const parsed = RecipeSchema.safeParse({
    emoji: page.icon?.type === "emoji" && page.icon.emoji ? page.icon.emoji : undefined,
    titel,
    tags: propertyList(prop("tags")).map((t) => t.replace(/^#/, "")),
    zeit_text: zeitMinuten ? `${zeitMinuten} Minuten` : (zeit ?? ""),
    zeit_minuten: zeitMinuten,
    zutaten,
    schritte,
    pro_tipp,
    portionen: propertyText(prop("portionen")),
    kueche: propertyText(prop("kueche")),
    schwierigkeit: propertyText(prop("schwierigkeit")),
  });
  if (!parsed.success) return { reason: `Rezept unvollständig (${parsed.error.issues[0]?.message})` };

  return { recipe: parsed.data, sourceUrl: propertyText(prop("quelle")) ?? "" };
}
