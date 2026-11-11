import type { Recipe } from "../llm/recipeSchema.ts";
import type { GeneratedImage } from "../llm/image.ts";
import { getConfig } from "../config.ts";
import {
  mealie,
  mealieSelf,
  recipeLink,
  filterValue,
  MealieError,
  type Page,
} from "./client.ts";
import { mapRecipe, norm, type Lookups, type MealieRef } from "./mapper.ts";

export interface MealieUpsertInput {
  recipe: Recipe;
  /** Leer bei Fotos. Dient als Duplikat-Schluessel ueber orgURL. */
  sourceUrl: string;
  /** Bereits bekanntes Rezept dieses Jobs - geht dem URL-Abgleich vor. */
  existingSlug?: string;
  coverImage?: GeneratedImage;
  aiNotice?: string;
  /**
   * Ohne Quell-URL (Fotos, von Hand angelegte Notion-Seiten) ueber den exakten
   * Namen nach einem vorhandenen Rezept suchen. Nur fuer die Uebernahme des
   * Bestands gedacht: Dort soll ein zweiter Lauf nichts doppelt anlegen. Im
   * Alltag waeren zwei verschiedene "Pfannkuchen" dagegen gewollt.
   */
  dedupeByName?: boolean;
}

export interface MealieUpsertResult {
  slug: string;
  url: string;
  updated: boolean;
}

interface MealieRecipe {
  id: string;
  slug: string;
  name: string;
  tags?: MealieRef[];
}

/* ── Nachschlagen und Anlegen ─────────────────────────────────────────────── */

/**
 * Sucht ein vorhandenes Rezept. Zuerst ueber den gespeicherten Slug, sonst
 * ueber die Quell-URL - so landet derselbe Link nicht zweimal in Mealie, auch
 * wenn er ueber zwei verschiedene Jobs kam.
 */
export async function findExisting(
  input: Pick<MealieUpsertInput, "existingSlug" | "sourceUrl" | "dedupeByName" | "recipe">,
): Promise<MealieRecipe | undefined> {
  if (input.existingSlug) {
    try {
      return await mealie<MealieRecipe>(`/recipes/${encodeURIComponent(input.existingSlug)}`);
    } catch (err) {
      // In Mealie geloescht: dann eben neu anlegen, statt den Job scheitern zu lassen.
      if (!(err instanceof MealieError && err.status === 404)) throw err;
    }
  }
  if (!input.sourceUrl && !input.dedupeByName) return undefined;

  const filter = input.sourceUrl
    ? `orgURL = ${filterValue(input.sourceUrl)}`
    : `name = ${filterValue(input.recipe.titel)}`;
  const page = await mealie<Page<MealieRecipe>>("/recipes", {
    query: { queryFilter: filter, perPage: 1 },
  });
  const treffer = page.items[0];
  // Die Liste liefert nur eine Zusammenfassung; fuer die vorhandenen Tags
  // braucht es das ganze Rezept.
  return treffer ? mealie<MealieRecipe>(`/recipes/${encodeURIComponent(treffer.slug)}`) : undefined;
}

/**
 * Tags und Kategorien muessen in Mealie existieren, bevor ein Rezept sie
 * tragen kann: Mealie findet sie beim Speichern nur ueber ihre ID und legt
 * keine neuen an. Unbekannte werden deshalb hier angelegt.
 */
async function ensureOrganizers(
  kind: "tags" | "categories",
  names: string[],
): Promise<MealieRef[]> {
  const gewuenscht = [...new Map(names.filter(Boolean).map((n) => [norm(n), n.trim()])).values()];
  if (!gewuenscht.length) return [];

  const vorhanden = await mealie<Page<MealieRef>>(`/organizers/${kind}`, {
    query: { perPage: -1 },
  });
  const nachName = new Map(vorhanden.items.map((t) => [norm(t.name), t]));

  const result: MealieRef[] = [];
  for (const name of gewuenscht) {
    const da = nachName.get(norm(name));
    if (da) {
      result.push(da);
      continue;
    }
    const neu = await mealie<MealieRef>(`/organizers/${kind}`, {
      method: "POST",
      json: { name },
    });
    nachName.set(norm(name), neu);
    result.push(neu);
  }
  return result;
}

/** Alle Schreibweisen, unter denen eine Einheit oder ein Lebensmittel gemeint sein kann. */
function spellings(ref: MealieRef): string[] {
  const aliases = Array.isArray(ref.aliases)
    ? (ref.aliases as { name?: unknown }[]).map((a) => a.name)
    : [];
  return [ref.name, ref.pluralName, ref.abbreviation, ref.pluralAbbreviation, ...aliases]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map(norm);
}

async function ensureUnits(names: string[]): Promise<Map<string, MealieRef>> {
  const map = new Map<string, MealieRef>();
  const gewuenscht = [...new Set(names.filter(Boolean).map(norm))];
  if (!gewuenscht.length) return map;

  // Einheiten sind wenige - alle auf einmal ist billiger als je eine Suche.
  const alle = await mealie<Page<MealieRef>>("/units", { query: { perPage: -1 } });
  for (const unit of alle.items) {
    for (const s of spellings(unit)) if (!map.has(s)) map.set(s, unit);
  }

  for (const name of gewuenscht) {
    if (map.has(name)) continue;
    const original = names.find((n) => norm(n) === name) ?? name;
    const neu = await mealie<MealieRef>("/units", {
      method: "POST",
      json: { name: original, abbreviation: original, useAbbreviation: true },
    });
    map.set(name, neu);
  }
  return map;
}

async function ensureFoods(names: string[]): Promise<Map<string, MealieRef>> {
  const map = new Map<string, MealieRef>();
  const gewuenscht = [...new Map(names.filter(Boolean).map((n) => [norm(n), n.trim()])).values()];

  for (const name of gewuenscht) {
    // Lebensmittel koennen in die Tausende gehen (Mealie bringt auf Wunsch
    // eine deutsche Grundausstattung mit). Deshalb gezielt suchen statt alles
    // laden - und dann nur einen exakten Treffer nehmen, denn die Suche ist
    // unscharf: "Ei" fände sonst "Eis".
    const page = await mealie<Page<MealieRef>>("/foods", {
      query: { search: name, perPage: 50 },
    });
    const exakt = page.items.find((f) => spellings(f).includes(norm(name)));
    if (exakt) {
      map.set(norm(name), exakt);
      continue;
    }
    const neu = await mealie<MealieRef>("/foods", { method: "POST", json: { name } });
    map.set(norm(name), neu);
  }
  return map;
}

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

async function uploadImage(slug: string, image: GeneratedImage): Promise<void> {
  const extension = EXTENSION[image.mimeType] ?? "jpg";
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image.data)], { type: image.mimeType }), `titelbild.${extension}`);
  form.append("extension", extension);
  await mealie(`/recipes/${encodeURIComponent(slug)}/image`, { method: "PUT", form });
}

/* ── Anlegen oder aktualisieren ───────────────────────────────────────────── */

export async function upsertMealieRecipe(input: MealieUpsertInput): Promise<MealieUpsertResult> {
  const cfg = getConfig();
  const { recipe } = input;

  const existing = await findExisting(input);

  // Der Status fuer neue Rezepte wird in Mealie zum Tag - eine Status-Spalte
  // gibt es dort nicht. Nur beim Anlegen: Wer "Ausprobieren" in Mealie schon
  // entfernt hat, bekommt es durch einen erneuten Import nicht zurueck.
  const tagNamen = [...recipe.tags];
  if (!existing && cfg.newRecipeStatus) tagNamen.push(cfg.newRecipeStatus);

  const neueTags = await ensureOrganizers("tags", tagNamen);
  // Tags, die du in Mealie selbst vergeben hast, bleiben erhalten.
  const tags = [
    ...new Map([...(existing?.tags ?? []), ...neueTags].map((t) => [t.id, t])).values(),
  ];

  const [category] = recipe.kueche ? await ensureOrganizers("categories", [recipe.kueche]) : [];

  const eintraege = recipe.zutaten.flatMap((g) => g.eintraege);
  const [foods, units] = await Promise.all([
    ensureFoods(eintraege.map((z) => z.lebensmittel ?? "").filter(Boolean)),
    ensureUnits(
      eintraege
        .filter((z) => z.lebensmittel)
        .map((z) => z.einheit ?? "")
        .filter(Boolean),
    ),
  ]);

  const lookups: Lookups = { tags, category, foods, units };

  const slug =
    existing?.slug ??
    (await mealie<string>("/recipes", { method: "POST", json: { name: recipe.titel } }));

  const gespeichert = await mealie<MealieRecipe>(`/recipes/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    json: mapRecipe(recipe, lookups, { sourceUrl: input.sourceUrl, aiNotice: input.aiNotice }),
  });
  // Mealie leitet den Slug aus dem Namen ab - hat sich der Titel geaendert,
  // kann er nach dem Speichern ein anderer sein.
  const endSlug = gespeichert?.slug || slug;

  if (input.coverImage) {
    try {
      await uploadImage(endSlug, input.coverImage);
    } catch (err) {
      // Wie bei Notion: Am Titelbild darf das Rezept nicht scheitern.
      console.warn(`[mealie] Titelbild nicht hochgeladen: ${String(err)}`);
    }
  }

  const self = await mealieSelf();
  console.log(`[mealie] ${existing ? "aktualisiert" : "angelegt"}: ${endSlug}`);
  return { slug: endSlug, url: recipeLink(self.groupSlug, endSlug), updated: Boolean(existing) };
}
