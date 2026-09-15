/**
 * Zieht schema.org/Recipe aus dem HTML einer Seite.
 *
 * Praktisch jeder Food-Blog bettet sein Rezept als JSON-LD ein, damit Google die
 * Rich-Snippets anzeigen kann. Das sind fertig strukturierte Daten - deutlich
 * verlaesslicher als ein Modell auf den Fliesstext loszulassen.
 */

export interface JsonLdRecipe {
  name?: string;
  description?: string;
  ingredients: string[];
  instructions: string[];
  totalTime?: string;
  yield?: string;
  cuisine?: string;
  keywords: string[];
  author?: string;
  /** Erstes Bild aus dem Datensatz - taugt als Notion-Titelbild. */
  image?: string;
}

/** Alle <script type="application/ld+json">-Bloecke, tolerant gegen kaputtes JSON. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    const body = match[1];
    if (!body) continue;
    try {
      // Manche CMS schreiben CDATA-Wrapper oder abschliessende Kommas.
      const cleaned = body
        .replace(/^\s*\/\/\s*<!\[CDATA\[/, "")
        .replace(/\/\/\s*\]\]>\s*$/, "")
        .trim();
      out.push(JSON.parse(cleaned));
    } catch {
      // Ein kaputter Block darf die anderen nicht mitreissen.
    }
  }
  return out;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/** Laeuft durch verschachtelte Strukturen inklusive @graph und Arrays. */
function* walk(node: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item, depth + 1);
    return;
  }

  const obj = node as Record<string, unknown>;
  yield obj;

  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    if (key in obj) yield* walk(obj[key], depth + 1);
  }
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item): string[] => {
      if (typeof item === "string") return [item.trim()];
      if (!item || typeof item !== "object") return [];

      const o = item as Record<string, unknown>;

      // HowToSection zuerst: ihre Schritte sind der Inhalt, "name" nur die
      // Abschnittsueberschrift. Andersherum verliert man das ganze Rezept und
      // behaelt nur "Vorbereitung", "Zubereitung", ...
      if (Array.isArray(o.itemListElement)) {
        const steps = asStringArray(o.itemListElement);
        if (steps.length) {
          const section = typeof o.name === "string" ? o.name.trim() : "";
          return section ? steps.map((s) => `${section}: ${s}`) : steps;
        }
      }

      // HowToStep
      if (typeof o.text === "string" && o.text.trim()) return [o.text.trim()];
      if (typeof o.name === "string" && o.name.trim()) return [o.name.trim()];
      return [];
    })
    .filter(Boolean);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string" && v.trim());
    return typeof first === "string" ? first.trim() : undefined;
  }
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
}

/**
 * schema.org erlaubt fuer "image" so ziemlich alles: eine Zeichenkette, ein
 * Array, ein ImageObject mit url oder contentUrl - oder eine Mischung davon.
 */
function firstImage(value: unknown): string | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  for (const item of candidates) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      for (const key of ["url", "contentUrl"]) {
        const v = o[key];
        if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
      }
    }
  }
  return undefined;
}

export function findRecipe(html: string): JsonLdRecipe | undefined {
  for (const block of extractJsonLdBlocks(html)) {
    for (const node of walk(block)) {
      if (!typesOf(node).some((t) => t.toLowerCase() === "recipe")) continue;

      const ingredients = asStringArray(node.recipeIngredient ?? node.ingredients);
      const instructions = asStringArray(node.recipeInstructions);
      if (!ingredients.length && !instructions.length) continue;

      return {
        name: asString(node.name),
        description: asString(node.description),
        ingredients,
        instructions,
        totalTime: asString(node.totalTime) ?? asString(node.cookTime),
        yield: asString(node.recipeYield),
        cuisine: asString(node.recipeCuisine),
        keywords: asStringArray(node.keywords).flatMap((k) =>
          k.includes(",") ? k.split(",").map((s) => s.trim()).filter(Boolean) : [k],
        ),
        author: asString(node.author),
        image: firstImage(node.image),
      };
    }
  }
  return undefined;
}

/** Formt das Ergebnis zu dem Text, der als Input in den Prompt geht. */
export function recipeToText(recipe: JsonLdRecipe): string {
  const parts: string[] = [];
  if (recipe.name) parts.push(`Titel: ${recipe.name}`);
  if (recipe.description) parts.push(`Beschreibung: ${recipe.description}`);
  if (recipe.yield) parts.push(`Ergibt: ${recipe.yield}`);
  if (recipe.totalTime) parts.push(`Gesamtzeit (ISO-8601): ${recipe.totalTime}`);
  if (recipe.cuisine) parts.push(`Küche: ${recipe.cuisine}`);
  if (recipe.keywords.length) parts.push(`Stichworte: ${recipe.keywords.join(", ")}`);
  if (recipe.ingredients.length) {
    parts.push(`\nZutaten:\n${recipe.ingredients.map((i) => `- ${i}`).join("\n")}`);
  }
  if (recipe.instructions.length) {
    parts.push(
      `\nZubereitung:\n${recipe.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

/** ISO-8601-Dauer (PT1H30M) in Minuten. */
export function isoDurationToMinutes(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const total = days * 1440 + hours * 60 + mins;
  return total > 0 ? total : null;
}
