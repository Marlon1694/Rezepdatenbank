import type { PropertyInfo, DataSourceSchema } from "./client.ts";
import type { Recipe } from "../llm/recipeSchema.ts";

/**
 * Baut aus einem Rezept die Notion-Properties. Reine Funktionen, kein Netzwerk -
 * deshalb in tests/mapper.test.ts vollstaendig abgedeckt.
 */

/** Kanonische Rezeptfelder, die in Notion-Spalten wandern koennen. */
export type CanonicalField =
  | "titel"
  | "tags"
  | "zeit"
  | "quelle"
  | "portionen"
  | "kueche"
  | "datum"
  | "schwierigkeit"
  | "zutatenliste"
  | "status";

export type Mapping = Partial<Record<CanonicalField, string | null>>;

/**
 * Spaltennamen, die wir automatisch erkennen, wenn in config/notion-mapping.json
 * nichts Explizites steht. Reihenfolge = Priorität.
 */
const AUTO_NAMES: Record<Exclude<CanonicalField, "titel">, string[]> = {
  tags: ["tags", "tag", "schlagworte", "schlagwörter", "labels", "kategorien", "kategorie"],
  zeit: [
    "zubereitungszeit",
    "zeit",
    "dauer",
    "gesamtzeit",
    "kochzeit",
    "time",
    "duration",
    "prep time",
  ],
  quelle: ["quelle", "link", "url", "source", "video", "rezeptlink", "originallink"],
  portionen: ["portionen", "portion", "servings", "personen", "ergibt", "yield"],
  kueche: ["küche", "kueche", "cuisine", "land", "herkunft", "region"],
  datum: ["hinzugefügt", "hinzugefuegt", "erstellt", "datum", "date", "added", "erfasst"],
  schwierigkeit: ["schwierigkeitsgrad", "schwierigkeit", "aufwand", "difficulty", "level"],
  zutatenliste: ["zutaten", "ingredients", "zutatenliste"],
  status: ["status", "zustand", "fortschritt"],
};

/** Kleinschreibung, ohne '#', ohne Mehrfach-Leerzeichen. Basis fuer jeden Vergleich. */
export function normalizeKey(value: string): string {
  return value
    .replace(/^#+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Findet die Title-Spalte ueber ihren Typ, nicht ueber ihren Namen. */
export function findTitleProperty(props: PropertyInfo[]): PropertyInfo | undefined {
  return props.find((p) => p.type === "title");
}

export function findProperty(
  props: PropertyInfo[],
  field: CanonicalField,
  mapping: Mapping = {},
): PropertyInfo | undefined {
  if (field === "titel") return findTitleProperty(props);

  const explicit = mapping[field];
  if (explicit === null) return undefined; // bewusst abgeschaltet
  if (explicit) {
    const wanted = normalizeKey(explicit);
    return props.find((p) => normalizeKey(p.name) === wanted);
  }

  for (const candidate of AUTO_NAMES[field]) {
    const hit = props.find((p) => normalizeKey(p.name) === candidate);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Gleicht einen Wert gegen bereits vorhandene Optionen ab. Verhindert, dass ueber die
 * Monate "Schnell", "#Schnell" und "schnell" als drei getrennte Optionen entstehen.
 * Kein Treffer -> der Wert wird unveraendert zurueckgegeben und Notion legt ihn neu an.
 */
export function matchExistingOption(value: string, options: string[]): string {
  const key = normalizeKey(value);
  return options.find((o) => normalizeKey(o) === key) ?? value;
}

/** Bringt Tags in die Schreibweise, die in dieser Datenbank ueblich ist. */
export function formatTags(
  tags: string[],
  existingOptions: string[],
  withHash: boolean,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of tags) {
    const bare = raw.replace(/^#+/, "").trim();
    if (!bare) continue;

    const key = normalizeKey(bare);
    if (seen.has(key)) continue;
    seen.add(key);

    const matched = matchExistingOption(bare, existingOptions);
    // Fuehrt die DB ihre Tags bereits mit '#', uebernehmen wir das - egal was
    // TAGS_WITH_HASH sagt. Der Bestand gewinnt, sonst entstehen Dubletten.
    const dbUsesHash = matched.startsWith("#");
    const shouldHash = dbUsesHash || (withHash && matched === bare);

    out.push(shouldHash && !matched.startsWith("#") ? `#${matched}` : matched);
  }
  return out;
}

/** Schneidet Text auf Notions Limit von 2000 Zeichen pro rich_text-Element. */
export function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function richText(content: string) {
  return [{ type: "text" as const, text: { content: truncate(content) } }];
}

/**
 * Giesst einen Wert in die Form, die der jeweilige Spaltentyp erwartet.
 * Passt der Typ nicht (z.B. Zahl in eine people-Spalte), gibt es undefined und die
 * Spalte wird ausgelassen - ein unpassender Wert darf nie den ganzen Job kippen.
 */
export function toPropertyValue(
  prop: PropertyInfo,
  value: string | number | string[] | null,
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;

  const asText = Array.isArray(value) ? value.join(", ") : String(value);

  switch (prop.type) {
    case "title":
      return { title: richText(asText) };
    case "rich_text":
      return { rich_text: richText(asText) };
    case "number": {
      const n = typeof value === "number" ? value : Number.parseFloat(asText.replace(",", "."));
      return Number.isFinite(n) ? { number: n } : undefined;
    }
    case "url":
      return { url: asText };
    case "date":
      return { date: { start: asText } };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "select":
      return { select: { name: matchExistingOption(asText, prop.options) } };
    case "status":
      return { status: { name: matchExistingOption(asText, prop.options) } };
    case "multi_select": {
      const list = Array.isArray(value) ? value : [asText];
      return {
        multi_select: list.map((v) => ({ name: matchExistingOption(v, prop.options) })),
      };
    }
    default:
      // people, files, relation, formula, rollup, created_time, ... koennen wir nicht
      // sinnvoll aus einem Rezept befuellen.
      return undefined;
  }
}

export interface BuildOptions {
  sourceUrl: string;
  tagsWithHash: boolean;
  mapping?: Mapping;
  /**
   * Fester Wert fuer die Status-Spalte bei neu erfassten Rezepten. Kommt aus der
   * Konfiguration, nicht vom Modell - ein Arbeitsstand ist nichts, was sich aus
   * einem Video ablesen liesse.
   */
  newRecipeStatus?: string;
  /** Ueberschreibbar fuer deterministische Tests. */
  now?: Date;
}

export interface BuildResult {
  properties: Record<string, unknown>;
  /** Felder, fuer die keine passende Spalte existiert - fuer Logs und die Web-App. */
  skipped: CanonicalField[];
}

export function buildProperties(
  recipe: Recipe,
  schema: DataSourceSchema,
  opts: BuildOptions,
): BuildResult {
  const props = schema.properties;
  const mapping = opts.mapping ?? {};
  const properties: Record<string, unknown> = {};
  const skipped: CanonicalField[] = [];

  const assign = (field: CanonicalField, value: string | number | string[] | null) => {
    const prop = findProperty(props, field, mapping);
    if (!prop) {
      if (value !== null && value !== "" && !(Array.isArray(value) && !value.length)) {
        skipped.push(field);
      }
      return;
    }
    const built = toPropertyValue(prop, value);
    if (built) properties[prop.name] = built;
    else skipped.push(field);
  };

  const titleProp = findTitleProperty(props);
  if (!titleProp) {
    throw new Error(
      "Die Notion-Datenbank hat keine Title-Spalte. Das kann eigentlich nicht sein — " +
        "bitte 'npm run inspect:notion' ausführen und die Ausgabe prüfen.",
    );
  }
  properties[titleProp.name] = {
    title: richText(`${recipe.emoji} ${recipe.titel}`.trim()),
  };

  const tagsProp = findProperty(props, "tags", mapping);
  if (tagsProp) {
    const tags = formatTags(recipe.tags, tagsProp.options, opts.tagsWithHash);
    const built = toPropertyValue(tagsProp, tags);
    if (built) properties[tagsProp.name] = built;
  } else if (recipe.tags.length) {
    skipped.push("tags");
  }

  // Number-Spalte bekommt die Minuten, Textspalte den Klartext.
  const zeitProp = findProperty(props, "zeit", mapping);
  if (zeitProp) {
    const value = zeitProp.type === "number" ? recipe.zeit_minuten : recipe.zeit_text;
    const built = toPropertyValue(zeitProp, value);
    if (built) properties[zeitProp.name] = built;
  } else if (recipe.zeit_text) {
    skipped.push("zeit");
  }

  assign("quelle", opts.sourceUrl);
  assign("portionen", recipe.portionen);
  assign("kueche", recipe.kueche);
  assign("schwierigkeit", recipe.schwierigkeit);

  // Grundzutaten ohne Mengen - wie bei den Tags gegen den Bestand abgeglichen,
  // sonst stehen "Sahne" und "sahne" bald als zwei Optionen nebeneinander.
  const zutatenProp = findProperty(props, "zutatenliste", mapping);
  if (zutatenProp && recipe.zutaten_namen.length) {
    const namen = formatTags(recipe.zutaten_namen, zutatenProp.options, false);
    const built = toPropertyValue(zutatenProp, namen);
    if (built) properties[zutatenProp.name] = built;
  }

  if (opts.newRecipeStatus) {
    assign("status", opts.newRecipeStatus);
  }

  const datumProp = findProperty(props, "datum", mapping);
  if (datumProp && (datumProp.type === "date" || datumProp.type === "rich_text")) {
    const iso = (opts.now ?? new Date()).toISOString().slice(0, 10);
    const built = toPropertyValue(datumProp, iso);
    if (built) properties[datumProp.name] = built;
  }

  return { properties, skipped };
}

/** Zusatzfelder, die das Modell befuellen kann - sofern es dafuer eine Spalte gibt. */
export type ExtraField = "portionen" | "kueche" | "schwierigkeit" | "zutatenliste";

const EXTRA_FIELDS: ExtraField[] = ["portionen", "kueche", "schwierigkeit", "zutatenliste"];

/**
 * Welche Zusatzfelder soll das Modell ueberhaupt befuellen? Nur die, fuer die es auch
 * eine Spalte gibt - sonst erfindet es Portionsangaben, die nirgends landen.
 */
export function availableExtraFields(
  schema: DataSourceSchema,
  mapping: Mapping = {},
): ExtraField[] {
  return EXTRA_FIELDS.filter((f) => findProperty(schema.properties, f, mapping));
}

/**
 * Bestehende Optionen einer Spalte - wandern als Hinweis in den Prompt, damit das
 * Modell vorhandene Werte wiederverwendet statt Synonyme zu erfinden.
 */
export function knownOptions(
  schema: DataSourceSchema,
  field: CanonicalField,
  mapping: Mapping = {},
): string[] {
  return findProperty(schema.properties, field, mapping)?.options ?? [];
}

/** Alle bekannten Tag-Optionen der DB - wandern als Hinweis in den Prompt. */
export function knownTags(schema: DataSourceSchema, mapping: Mapping = {}): string[] {
  return findProperty(schema.properties, "tags", mapping)?.options ?? [];
}
