import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Die Mealie-Anbindung gegen ein nachgebautes Mealie.
 *
 * Das Double bildet das Verhalten von Mealie 3.29 nach, wie es im Quellcode
 * steht - vor allem die Stellen, an denen es still danebengeht:
 *
 *   - Tags, Kategorien, Lebensmittel und Einheiten findet Mealie beim
 *     Speichern NUR ueber ihre ID. Ohne gueltige ID fallen sie weg, ohne
 *     Fehlermeldung. Das Double tut dasselbe, damit ein Test merkt, wenn die
 *     App vergisst, sie vorher anzulegen.
 *   - PATCH ersetzt nur die mitgeschickten Felder.
 */

process.env.APP_TOKEN = "t";
process.env.NOTION_ENABLED = "false";
process.env.LOG_LEVEL = "silent";
process.env.NEW_RECIPE_STATUS = "Ausprobieren";

const TOKEN = "mealie-test-token";

interface Ref {
  id: string;
  name: string;
  slug?: string;
  [k: string]: unknown;
}

const state = {
  tags: [] as Ref[],
  categories: [] as Ref[],
  foods: [] as Ref[],
  units: [] as Ref[],
  recipes: new Map<string, Record<string, unknown>>(),
  images: [] as { slug: string; bytes: number; extension: string }[],
  requests: [] as string[],
};

let nextId = 1;
const id = () => `id-${nextId++}`;
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");

function reset() {
  state.tags = [{ id: "tag-schnell", name: "Schnell", slug: "schnell", groupId: "g" }];
  state.categories = [];
  state.foods = [{ id: "food-zwiebel", name: "Zwiebel", pluralName: "Zwiebeln", aliases: [] }];
  state.units = [
    { id: "unit-g", name: "Gramm", abbreviation: "g", aliases: [] },
    { id: "unit-el", name: "Esslöffel", abbreviation: "EL", aliases: [] },
  ];
  state.recipes.clear();
  state.images = [];
  state.requests = [];
}

/** Nimmt nur, was Mealie auch nehmen wuerde: Eintraege mit bekannter ID. */
function resolveById(list: Ref[], items: unknown): Ref[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((i) => list.find((x) => x.id === (i as Ref)?.id))
    .filter((x): x is Ref => Boolean(x));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "Unauthorized" });

    const raw = await readBody(req);
    const json = () => JSON.parse(raw.toString() || "{}");

    if (path === "/api/users/self") {
      return send(200, { id: "u1", username: "marlon", groupSlug: "home", household: "Family" });
    }

    for (const kind of ["tags", "categories"] as const) {
      if (path === `/api/organizers/${kind}`) {
        if (req.method === "GET") return send(200, { items: state[kind] });
        const body = json();
        const neu = { id: id(), name: body.name, slug: slugify(body.name), groupId: "g" };
        state[kind].push(neu);
        return send(201, neu);
      }
    }

    if (path === "/api/units") {
      if (req.method === "GET") return send(200, { items: state.units });
      const neu = { id: id(), aliases: [], ...json() };
      state.units.push(neu);
      return send(201, neu);
    }

    if (path === "/api/foods") {
      if (req.method === "GET") {
        // Wie Mealie: unscharfe Suche - "Ei" findet auch "Eis".
        const q = (url.searchParams.get("search") ?? "").toLowerCase();
        return send(200, { items: state.foods.filter((f) => f.name.toLowerCase().includes(q)) });
      }
      const neu = { id: id(), aliases: [], ...json() };
      state.foods.push(neu);
      return send(201, neu);
    }

    if (path === "/api/recipes" && req.method === "GET") {
      const filter = url.searchParams.get("queryFilter") ?? "";
      const m = /^orgURL = "(.*)"$/.exec(filter);
      const items = [...state.recipes.values()].filter((r) => !m || r.orgURL === m[1]);
      return send(200, { items });
    }

    if (path === "/api/recipes" && req.method === "POST") {
      const name = json().name as string;
      let slug = slugify(name);
      while (state.recipes.has(slug)) slug += "-1";
      state.recipes.set(slug, { id: id(), slug, name, tags: [], orgURL: null });
      return send(201, slug);
    }

    const bild = /^\/api\/recipes\/([^/]+)\/image$/.exec(path);
    if (bild?.[1] && req.method === "PUT") {
      const text = raw.toString("latin1");
      const ext = /name="extension"\r\n\r\n([a-z]+)/.exec(text)?.[1] ?? "";
      state.images.push({ slug: decodeURIComponent(bild[1]), bytes: raw.length, extension: ext });
      return send(200, { image: "x" });
    }

    const einzeln = /^\/api\/recipes\/([^/]+)$/.exec(path);
    if (einzeln?.[1]) {
      const slug = decodeURIComponent(einzeln[1]);
      const recipe = state.recipes.get(slug);
      if (!recipe) return send(404, { detail: "Recipe not found." });
      if (req.method === "GET") return send(200, recipe);
      if (req.method === "PATCH") {
        const body = json();
        const merged = { ...recipe, ...body };
        merged.tags = resolveById(state.tags, body.tags ?? recipe.tags);
        merged.recipeCategory = resolveById(state.categories, body.recipeCategory ?? []);
        merged.recipeIngredient = (body.recipeIngredient ?? []).map((i: Record<string, unknown>) => ({
          ...i,
          food: i.food ? (resolveById(state.foods, [i.food])[0] ?? null) : null,
          unit: i.unit ? (resolveById(state.units, [i.unit])[0] ?? null) : null,
        }));
        state.recipes.set(slug, merged);
        return send(200, merged);
      }
    }

    return send(404, { detail: `Double kennt ${req.method} ${path} nicht` });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MEALIE_URL = baseUrl;
  process.env.MEALIE_API_TOKEN = TOKEN;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const { resetConfigCache } = await import("../src/config.ts");
const { resetMealieCache } = await import("../src/mealie/client.ts");
const { upsertMealieRecipe } = await import("../src/mealie/recipes.ts");
const { mapIngredients, parseServings, ingredientNote, norm } = await import(
  "../src/mealie/mapper.ts"
);
const { RecipeSchema } = await import("../src/llm/recipeSchema.ts");

beforeEach(() => {
  reset();
  resetConfigCache();
  resetMealieCache();
});

const rezept = (over: Record<string, unknown> = {}) =>
  RecipeSchema.parse({
    emoji: "🧅",
    titel: "Zwiebelkuchen",
    tags: ["schnell", "Herbst"],
    zeit_text: "ca. 60 Minuten",
    zutaten: [
      {
        gruppe: "Für den Teig",
        eintraege: [
          { menge: "250 g", zutat: "Mehl", anzahl: 250, einheit: "g", lebensmittel: "Mehl" },
          { menge: null, zutat: "Salz" },
        ],
      },
      {
        gruppe: "Für den Belag",
        eintraege: [
          {
            menge: "2",
            zutat: "Zwiebeln, fein gewürfelt",
            anzahl: 2,
            lebensmittel: "Zwiebel",
          },
          { menge: "1 EL", zutat: "Kümmel", anzahl: 1, einheit: "EL", lebensmittel: "Kümmel" },
        ],
      },
    ],
    schritte: ["Teig kneten.", "Belag verteilen.", "Backen."],
    pro_tipp: "Mit Federweißer servieren.",
    portionen: "4 Personen",
    kueche: "Pfälzisch",
    ...over,
  });

describe("upsertMealieRecipe", () => {
  it("legt ein neues Rezept vollständig an", async () => {
    const r = await upsertMealieRecipe({
      recipe: rezept(),
      sourceUrl: "https://example.com/zwiebelkuchen",
      coverImage: { data: Buffer.from("bild"), mimeType: "image/jpeg" },
    });

    expect(r.updated).toBe(false);
    expect(r.url).toBe(`${baseUrl}/g/home/r/${r.slug}`);

    const gespeichert = state.recipes.get(r.slug)!;
    expect(gespeichert.name).toBe("Zwiebelkuchen");
    expect(gespeichert.orgURL).toBe("https://example.com/zwiebelkuchen");
    expect(gespeichert.recipeServings).toBe(4);
    expect(gespeichert.totalTime).toBe("ca. 60 Minuten");
    expect((gespeichert.recipeInstructions as unknown[]).length).toBe(3);
    expect(gespeichert.notes).toEqual([{ title: "💡 Pro-Tipp", text: "Mit Federweißer servieren." }]);
    expect(state.images).toEqual([{ slug: r.slug, bytes: expect.any(Number), extension: "jpg" }]);
  });

  it("legt fehlende Tags an, statt sie stillschweigend zu verlieren", async () => {
    // Der Kern: Mealie speichert einen Tag nur mit gültiger ID. Ohne vorheriges
    // Anlegen stünde das Rezept ohne "Herbst" da, und niemand merkte es.
    const r = await upsertMealieRecipe({ recipe: rezept(), sourceUrl: "" });
    const namen = (state.recipes.get(r.slug)!.tags as Ref[]).map((t) => t.name).sort();
    expect(namen).toEqual(["Ausprobieren", "Herbst", "Schnell"]);

    // "schnell" traf den vorhandenen Tag "Schnell" - kein Duplikat in klein.
    expect(state.tags.filter((t) => norm(t.name) === "schnell")).toHaveLength(1);
  });

  it("legt die Küche als Kategorie an", async () => {
    const r = await upsertMealieRecipe({ recipe: rezept(), sourceUrl: "" });
    expect((state.recipes.get(r.slug)!.recipeCategory as Ref[]).map((c) => c.name)).toEqual([
      "Pfälzisch",
    ]);
  });

  it("verknüpft Zutaten mit Lebensmitteln und Einheiten", async () => {
    const r = await upsertMealieRecipe({ recipe: rezept(), sourceUrl: "" });
    const zutaten = state.recipes.get(r.slug)!.recipeIngredient as Record<string, unknown>[];

    // Vorhandenes wird gefunden: "Zwiebel" (auch als Plural), "g", "EL".
    expect((zutaten[2]!.food as Ref).id).toBe("food-zwiebel");
    expect((zutaten[0]!.unit as Ref).id).toBe("unit-g");
    expect((zutaten[3]!.unit as Ref).id).toBe("unit-el");
    // Fehlendes wird angelegt und verknüpft, statt wegzufallen.
    expect((zutaten[0]!.food as Ref).name).toBe("Mehl");
    expect((zutaten[3]!.food as Ref).name).toBe("Kümmel");

    // Der Zubereitungshinweis wandert in die Notiz.
    expect(zutaten[2]!.note).toBe("fein gewürfelt");
    // Ohne Zerlegung bleibt es Freitext - kein Fehler, nur nicht zusammenfassbar.
    expect(zutaten[1]!.food).toBeNull();
    expect(zutaten[1]!.note).toBe("Salz");
    // Gruppen werden zur Überschrift am ersten Eintrag.
    expect(zutaten.map((z) => z.title)).toEqual(["Für den Teig", null, "Für den Belag", null]);
  });

  it("findet ein Rezept über die Quell-URL wieder, statt es doppelt anzulegen", async () => {
    const erst = await upsertMealieRecipe({ recipe: rezept(), sourceUrl: "https://x.de/a" });
    const zweit = await upsertMealieRecipe({
      recipe: rezept({ schritte: ["Neu."] }),
      sourceUrl: "https://x.de/a",
    });
    expect(zweit.updated).toBe(true);
    expect(zweit.slug).toBe(erst.slug);
    expect(state.recipes.size).toBe(1);
  });

  it("vergibt den Status-Tag nur beim Anlegen und behält eigene Tags", async () => {
    const erst = await upsertMealieRecipe({ recipe: rezept(), sourceUrl: "https://x.de/b" });

    // In Mealie selbst: "Ausprobieren" entfernt, "Lieblingsessen" vergeben.
    const lieb = { id: "tag-lieb", name: "Lieblingsessen", slug: "lieblingsessen" };
    state.tags.push(lieb);
    const rec = state.recipes.get(erst.slug)!;
    rec.tags = (rec.tags as Ref[]).filter((t) => t.name !== "Ausprobieren").concat(lieb);

    await upsertMealieRecipe({ recipe: rezept(), sourceUrl: "https://x.de/b" });
    const namen = (state.recipes.get(erst.slug)!.tags as Ref[]).map((t) => t.name).sort();
    expect(namen).toEqual(["Herbst", "Lieblingsessen", "Schnell"]);
  });

  it("legt ein in Mealie gelöschtes Rezept neu an", async () => {
    const r = await upsertMealieRecipe({
      recipe: rezept(),
      sourceUrl: "",
      existingSlug: "gibt-es-nicht-mehr",
    });
    expect(r.updated).toBe(false);
    expect(state.recipes.has(r.slug)).toBe(true);
  });

  it("nimmt bei unscharfer Suche nur den exakten Treffer", async () => {
    state.foods.push({ id: "food-eis", name: "Eis", aliases: [] });
    const r = await upsertMealieRecipe({
      recipe: rezept({
        zutaten: [
          { gruppe: "Zutaten", eintraege: [{ menge: "2", zutat: "Eier", anzahl: 2, lebensmittel: "Ei" }] },
        ],
      }),
      sourceUrl: "",
    });
    const zutat = (state.recipes.get(r.slug)!.recipeIngredient as Record<string, unknown>[])[0]!;
    expect((zutat.food as Ref).name).toBe("Ei");
    expect((zutat.food as Ref).id).not.toBe("food-eis");
  });

  it("meldet ein abgelehntes Token verständlich", async () => {
    process.env.MEALIE_API_TOKEN = "falsch";
    resetConfigCache();
    try {
      await expect(upsertMealieRecipe({ recipe: rezept(), sourceUrl: "" })).rejects.toThrow(
        /API-Token abgelehnt/,
      );
    } finally {
      process.env.MEALIE_API_TOKEN = TOKEN;
      resetConfigCache();
    }
  });

  it("meldet ein nicht erreichbares Mealie mit Hinweis auf die Adresse", async () => {
    process.env.MEALIE_URL = "http://127.0.0.1:1";
    resetConfigCache();
    try {
      await expect(upsertMealieRecipe({ recipe: rezept(), sourceUrl: "" })).rejects.toThrow(
        /nicht erreichbar.*localhost/s,
      );
    } finally {
      process.env.MEALIE_URL = baseUrl;
      resetConfigCache();
    }
  });
});

describe("Mapper", () => {
  it("liest Portionen aus Text", () => {
    expect(parseServings("4")).toBe(4);
    expect(parseServings("für 4 Personen")).toBe(4);
    expect(parseServings("2,5 Liter")).toBe(2.5);
    expect(parseServings("ein Blech")).toBeUndefined();
    expect(parseServings(null)).toBeUndefined();
  });

  it("trennt den Zubereitungshinweis vom Lebensmittel", () => {
    expect(ingredientNote("Zwiebeln, fein gewürfelt", "Zwiebel")).toBe("fein gewürfelt");
    expect(ingredientNote("Butter (zimmerwarm)", "Butter")).toBe("zimmerwarm");
    expect(ingredientNote("Mehl", "Mehl")).toBe("");
  });

  it("verträgt Rezepte von vor der Erweiterung", () => {
    // Ältere Rezepte in der Datenbank haben weder anzahl noch lebensmittel.
    const alt = {
      zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "200 g", zutat: "Pasta" }] }],
    } as never;
    const [z] = mapIngredients(alt, { foods: new Map(), units: new Map() });
    expect(z).toMatchObject({ food: null, note: "200 g Pasta", title: null });
  });
});
