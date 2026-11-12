import { getConfig } from "../config.ts";
import { generateJson } from "../llm/gemini.ts";
import { mealie, mealieSelf, recipeLink, type Page } from "./client.ts";
import { norm, type MealieRef } from "./mapper.ts";
import {
  buildShoppingLines,
  approvalPayload,
  type PlannedRecipe,
  type MealieIngredient,
  type ShoppingLine,
} from "./shopping.ts";
import {
  addDays,
  freeSlots,
  recency,
  pickAlternative,
  validateProposal,
  plannerPrompt,
  PLANNER_SCHEMA,
  type RecipeOption,
  type ProposalDay,
} from "./planner.ts";

/**
 * Wochenplan, Einkauf und "Was kann ich kochen?" - alles ueber Mealie.
 *
 * Mealie bleibt dabei die eine Stelle, an der Plan und Einkaufsliste leben.
 * Die App liest dort, schlaegt vor und schreibt erst nach deiner Freigabe.
 */

export type EntryType = "breakfast" | "lunch" | "dinner" | "side" | "snack" | "drink" | "dessert";
export const ENTRY_TYPES: EntryType[] = [
  "breakfast",
  "lunch",
  "dinner",
  "side",
  "snack",
  "drink",
  "dessert",
];
const MAHLZEIT: Record<EntryType, string> = {
  breakfast: "Frühstück",
  lunch: "Mittagessen",
  dinner: "Abendessen",
  side: "Beilage",
  snack: "Snack",
  drink: "Getränk",
  dessert: "Nachtisch",
};

interface PlanEntry {
  id: number;
  date: string;
  entryType: EntryType;
  title?: string;
  recipeId?: string | null;
  recipeScale?: number;
  recipe?: { id: string; slug: string; name: string } | null;
}

/** Heute als YYYY-MM-DD in der Zeitzone des Servers (TZ in der .env bzw. im Container). */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function planEntries(start: string, end: string): Promise<PlanEntry[]> {
  const page = await mealie<Page<PlanEntry>>("/households/mealplans", {
    query: { start_date: start, end_date: end, perPage: -1 },
  });
  return page.items;
}

interface FullRecipe {
  id: string;
  slug: string;
  name: string;
  recipeIngredient?: MealieIngredient[];
}

/* ── Einkauf ──────────────────────────────────────────────────────────────── */

export interface ShoppingPreview {
  start: string;
  end: string;
  recipes: { date: string; entryType: string; name: string; scale: number; url: string }[];
  lines: ShoppingLine[];
  list: string;
}

async function planned(start: string, days: number): Promise<PlannedRecipe[]> {
  const end = addDays(start, days - 1);
  const entries = (await planEntries(start, end)).filter((e) => e.recipe?.slug);

  // Dasselbe Rezept zweimal in der Woche wird nur einmal geladen.
  const cache = new Map<string, Promise<FullRecipe>>();
  const load = (slug: string) => {
    if (!cache.has(slug)) cache.set(slug, mealie<FullRecipe>(`/recipes/${encodeURIComponent(slug)}`));
    return cache.get(slug)!;
  };

  return Promise.all(
    entries.map(async (e) => {
      const r = await load(e.recipe!.slug);
      return {
        entryId: e.id,
        date: e.date,
        entryType: e.entryType,
        recipeId: r.id,
        slug: r.slug,
        name: r.name,
        scale: e.recipeScale ?? 1,
        ingredients: r.recipeIngredient ?? [],
      };
    }),
  );
}

export async function shoppingPreview(start: string, days: number): Promise<ShoppingPreview> {
  const cfg = getConfig();
  const [plan, self] = await Promise.all([planned(start, days), mealieSelf()]);
  plan.sort((a, b) => a.date.localeCompare(b.date));
  return {
    start,
    end: addDays(start, days - 1),
    recipes: plan.map((p) => ({
      date: p.date,
      entryType: MAHLZEIT[p.entryType as EntryType] ?? p.entryType,
      name: p.name,
      scale: p.scale,
      url: recipeLink(self.groupSlug, p.slug),
    })),
    lines: buildShoppingLines(plan, { householdSlug: self.householdSlug, staples: cfg.staples }),
    list: cfg.mealieShoppingList,
  };
}

async function ensureShoppingList(name: string): Promise<{ id: string; name: string }> {
  const lists = await mealie<Page<{ id: string; name: string }>>("/households/shopping/lists", {
    query: { perPage: -1 },
  });
  const da = lists.items.find((l) => norm(l.name ?? "") === norm(name));
  if (da) return da;
  return mealie<{ id: string; name: string }>("/households/shopping/lists", {
    method: "POST",
    json: { name },
  });
}

/**
 * Schreibt die freigegebenen Zutaten in die Mealie-Einkaufsliste.
 *
 * Der Vorschlag wird dafuer frisch berechnet, statt der Web-App zu glauben,
 * was sie zurueckschickt: Hat sich zwischen Anzeigen und Freigeben der Plan
 * geaendert, zaehlt der aktuelle Stand. Von der Web-App kommen nur die
 * Schluessel der Zeilen, die bleiben sollen.
 */
export async function approveShopping(
  start: string,
  days: number,
  keys: string[],
): Promise<{ list: string; lines: number; recipes: number }> {
  const cfg = getConfig();
  const [plan, self] = await Promise.all([planned(start, days), mealieSelf()]);
  const lines = buildShoppingLines(plan, { householdSlug: self.householdSlug, staples: cfg.staples });
  const approved = new Set(keys);
  const payload = approvalPayload(plan, lines, approved);
  if (!payload.length) throw new Error("Es ist keine Zutat ausgewählt.");

  const list = await ensureShoppingList(cfg.mealieShoppingList);
  await mealie(`/households/shopping/lists/${list.id}/recipe`, { method: "POST", json: payload });

  return {
    list: list.name,
    lines: lines.filter((l) => approved.has(l.key)).length,
    recipes: payload.length,
  };
}

/* ── Wochenplan-Vorschlag ─────────────────────────────────────────────────── */

async function recipeOptions(): Promise<RecipeOption[]> {
  const page = await mealie<
    Page<{
      id: string;
      slug: string;
      name: string;
      tags?: MealieRef[];
      recipeCategory?: MealieRef[];
      totalTime?: string | null;
      rating?: number | null;
    }>
  >("/recipes", { query: { perPage: -1 } });
  return page.items.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    tags: (r.tags ?? []).map((t) => t.name),
    category: r.recipeCategory?.[0]?.name,
    totalTime: r.totalTime,
    rating: r.rating,
  }));
}

/** Wie weit zurueck "zuletzt gegessen" reicht. */
const RUECKBLICK_TAGE = 60;

async function planContext(start: string, days: number, entryType: EntryType) {
  const end = addDays(start, days - 1);
  const [recipes, history, inRange] = await Promise.all([
    recipeOptions(),
    planEntries(addDays(start, -RUECKBLICK_TAGE), addDays(start, -1)),
    planEntries(start, end),
  ]);
  const belegt = new Set(inRange.filter((e) => e.entryType === entryType).map((e) => e.date));
  return {
    recipes,
    rec: recency(history.map((h) => ({ date: h.date, recipeId: h.recipeId ?? null }))),
    slots: freeSlots(start, days, belegt),
    belegt: [...belegt].sort(),
  };
}

export interface PlanProposal {
  entryType: EntryType;
  days: (ProposalDay & { name: string; url: string })[];
  /** Tage, an denen schon etwas geplant ist - die fasst der Vorschlag nicht an. */
  skipped: string[];
  /** Gesetzt, wenn die KI nicht verfuegbar war und lokal geplant wurde. */
  fallback?: string;
}

async function decorate(days: ProposalDay[], recipes: RecipeOption[]) {
  const self = await mealieSelf();
  const byId = new Map(recipes.map((r) => [r.id, r]));
  return days.map((d) => {
    const r = byId.get(d.recipeId)!;
    return { ...d, name: r.name, url: recipeLink(self.groupSlug, r.slug) };
  });
}

export async function suggestPlan(
  start: string,
  days: number,
  entryType: EntryType,
  wishes: string,
): Promise<PlanProposal> {
  const ctx = await planContext(start, days, entryType);
  if (!ctx.recipes.length) {
    throw new Error("In Mealie gibt es noch keine Rezepte, aus denen sich ein Plan bauen ließe.");
  }
  if (!ctx.slots.length) {
    return { entryType, days: [], skipped: ctx.belegt };
  }

  // Ist die KI nicht erreichbar (Kontingent, Ueberlastung), wird trotzdem
  // geplant - lokal nach "am laengsten nicht gegessen". Ein Plan ohne
  // Wuensche ist besser als gar keiner, und du kannst einzelne Tage tauschen.
  let raw: unknown = {};
  let fallback: string | undefined;
  try {
    raw = await generateJson({
      prompt: plannerPrompt({
        recipes: ctx.recipes,
        rec: ctx.rec,
        slots: ctx.slots,
        today: today(),
        mahlzeit: MAHLZEIT[entryType],
        wishes,
      }),
      schema: PLANNER_SCHEMA,
    });
  } catch (err) {
    const grund = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.warn(`[wochenplan] KI nicht verfuegbar, plane lokal: ${grund}`);
    fallback =
      "Die KI war gerade nicht erreichbar. Dieser Vorschlag beruht nur darauf, was " +
      "am längsten nicht auf dem Tisch stand – deine Wünsche sind nicht berücksichtigt.";
  }
  const vorschlag = validateProposal(raw, ctx.slots, ctx.recipes, ctx.rec);
  const ersetzt = vorschlag.filter((d) => d.substituted).length;
  if (ersetzt && !fallback) console.log(`[wochenplan] ${ersetzt} Tag(e) lokal ergänzt - die KI lieferte dort nichts Gültiges.`);

  return {
    entryType,
    days: await decorate(vorschlag, ctx.recipes),
    skipped: ctx.belegt,
    ...(fallback ? { fallback } : {}),
  };
}

/** Ein anderes Gericht fuer einen Tag - ohne KI, nach "am laengsten nicht gegessen". */
export async function alternative(
  start: string,
  days: number,
  entryType: EntryType,
  exclude: string[],
): Promise<(ProposalDay & { name: string; url: string }) | undefined> {
  const ctx = await planContext(start, days, entryType);
  const alt = pickAlternative(ctx.recipes, new Set(exclude), ctx.rec);
  if (!alt) return undefined;
  const last = ctx.rec.get(alt.id)?.last;
  const [d] = await decorate(
    [
      {
        date: "",
        recipeId: alt.id,
        reason: last ? `Zuletzt am ${last.split("-").reverse().join(".")}` : "Noch nie im Plan",
      },
    ],
    ctx.recipes,
  );
  return d;
}

export async function applyPlan(
  entries: { date: string; recipeId: string }[],
  entryType: EntryType,
): Promise<number> {
  // Nacheinander statt parallel: Mealie verschickt zu jedem Eintrag ein
  // Ereignis, und die Reihenfolge im Plan soll der Reihenfolge der Tage folgen.
  for (const e of entries) {
    await mealie("/households/mealplans", {
      method: "POST",
      json: { date: e.date, entryType, recipeId: e.recipeId },
    });
  }
  return entries.length;
}

/* ── Was kann ich kochen? ─────────────────────────────────────────────────── */

export interface CookSuggestion {
  name: string;
  url: string;
  missing: string[];
}

/**
 * Rezepte zu dem, was da ist. Die Suche selbst macht Mealie - dafuer muessen
 * die Lebensmittel aber als Mealie-Lebensmittel bekannt sein. Was dort nicht
 * vorkommt, wird gemeldet statt still uebergangen.
 */
export async function cookSuggestions(
  vorhanden: string,
  maxMissing = 3,
): Promise<{ items: CookSuggestion[]; unknown: string[] }> {
  const namen = vorhanden
    .split(/,|;|\n|\bund\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of namen) {
    const page = await mealie<Page<MealieRef>>("/foods", { query: { search: name, perPage: 50 } });
    const spellings = (f: MealieRef) =>
      [f.name, f.pluralName, ...((f.aliases as { name?: string }[] | undefined) ?? []).map((a) => a.name)]
        .filter((v): v is string => typeof v === "string")
        .map(norm);
    const exakt = page.items.find((f) => spellings(f).includes(norm(name)));
    // Ohne exakten Treffer den naechstbesten nehmen ("Tomaten" -> "Tomate"),
    // aber nur, wenn die Suche genau einen liefert - sonst raten wir.
    const treffer = exakt ?? (page.items.length === 1 ? page.items[0] : undefined);
    if (treffer) ids.push(treffer.id);
    else unknown.push(name);
  }
  if (!ids.length) return { items: [], unknown };

  const self = await mealieSelf();
  const res = await mealie<{
    items: { recipe: { slug: string; name: string }; missingFoods: { name: string }[] }[];
  }>("/recipes/suggestions", {
    query: { foods: ids, maxMissingFoods: maxMissing, limit: 12, includeFoodsOnHand: true },
  });
  return {
    items: res.items.map((i) => ({
      name: i.recipe.name,
      url: recipeLink(self.groupSlug, i.recipe.slug),
      missing: i.missingFoods.map((f) => f.name),
    })),
    unknown,
  };
}
