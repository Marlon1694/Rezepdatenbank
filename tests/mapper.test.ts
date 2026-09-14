import { describe, it, expect } from "vitest";
import {
  normalizeKey,
  findProperty,
  findTitleProperty,
  matchExistingOption,
  formatTags,
  toPropertyValue,
  buildProperties,
  availableExtraFields,
  knownTags,
  truncate,
} from "../src/notion/mapper.ts";
import type { DataSourceSchema, PropertyInfo } from "../src/notion/client.ts";
import type { Recipe } from "../src/llm/recipeSchema.ts";

function prop(name: string, type: string, options: string[] = []): PropertyInfo {
  return { name, type, options };
}

const schema: DataSourceSchema = {
  dataSourceId: "ds-1",
  databaseTitle: "Rezepte",
  properties: [
    prop("Name", "title"),
    prop("Tags", "multi_select", ["Schnell", "Vegetarisch", "Asiatisch"]),
    prop("Zubereitungszeit", "rich_text"),
    prop("Quelle", "url"),
    prop("Portionen", "number"),
    prop("Küche", "select", ["Italienisch", "Thai"]),
    prop("Hinzugefügt", "date"),
    prop("Koch", "people"),
  ],
};

const recipe: Recipe = {
  emoji: "🍝",
  titel: "Cremige Pilzpasta",
  tags: ["schnell", "#Vegetarisch", "Herbst"],
  zeit_text: "ca. 25 Minuten",
  zeit_minuten: 25,
  zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "200 g", zutat: "Pasta" }] }],
  schritte: ["Pasta kochen."],
  pro_tipp: "Nudelwasser aufheben.",
  portionen: "2",
  kueche: "italienisch",
};

describe("normalizeKey", () => {
  it("ignoriert Rauten, Groß-/Kleinschreibung und Mehrfach-Leerzeichen", () => {
    expect(normalizeKey("#Low  Carb ")).toBe("low carb");
    expect(normalizeKey("Zubereitungszeit")).toBe("zubereitungszeit");
  });
});

describe("findProperty", () => {
  it("findet die Title-Spalte über den Typ, nicht über den Namen", () => {
    const odd: PropertyInfo[] = [prop("Gericht", "title"), prop("Tags", "multi_select")];
    expect(findTitleProperty(odd)?.name).toBe("Gericht");
  });

  it("erkennt gängige Spaltennamen automatisch", () => {
    expect(findProperty(schema.properties, "tags")?.name).toBe("Tags");
    expect(findProperty(schema.properties, "zeit")?.name).toBe("Zubereitungszeit");
    expect(findProperty(schema.properties, "quelle")?.name).toBe("Quelle");
    expect(findProperty(schema.properties, "kueche")?.name).toBe("Küche");
  });

  it("lässt ein explizites Mapping gewinnen", () => {
    const props = [prop("Tags", "multi_select"), prop("Labels", "multi_select")];
    expect(findProperty(props, "tags", { tags: "Labels" })?.name).toBe("Labels");
  });

  it("schaltet ein Feld ab, wenn das Mapping null sagt", () => {
    expect(findProperty(schema.properties, "tags", { tags: null })).toBeUndefined();
  });

  it("gibt undefined zurück, wenn es keine passende Spalte gibt", () => {
    expect(findProperty([prop("Name", "title")], "quelle")).toBeUndefined();
  });
});

describe("Tag-Abgleich", () => {
  it("übernimmt die vorhandene Schreibweise statt eine Dublette anzulegen", () => {
    // Genau der Fall, den wir verhindern wollen: "Schnell" / "#Schnell" / "schnell".
    expect(matchExistingOption("schnell", ["Schnell"])).toBe("Schnell");
    expect(matchExistingOption("#SCHNELL", ["Schnell"])).toBe("Schnell");
  });

  it("gibt unbekannte Tags unverändert zurück", () => {
    expect(matchExistingOption("Herbst", ["Schnell"])).toBe("Herbst");
  });

  it("entfernt die Raute und entdoppelt", () => {
    expect(formatTags(["#Schnell", "schnell", "Herbst"], ["Schnell"], false)).toEqual([
      "Schnell",
      "Herbst",
    ]);
  });

  it("behält die Raute, wenn die Datenbank sie bereits führt", () => {
    // Der Bestand gewinnt - unabhängig von TAGS_WITH_HASH.
    expect(formatTags(["Schnell"], ["#Schnell"], false)).toEqual(["#Schnell"]);
  });

  it("ergänzt die Raute, wenn so konfiguriert", () => {
    expect(formatTags(["Schnell"], [], true)).toEqual(["#Schnell"]);
  });

  it("verwirft leere Tags", () => {
    expect(formatTags(["#", "  ", "Gut"], [], false)).toEqual(["Gut"]);
  });
});

describe("toPropertyValue", () => {
  it("bedient jeden unterstützten Spaltentyp", () => {
    expect(toPropertyValue(prop("t", "rich_text"), "Hallo")).toEqual({
      rich_text: [{ type: "text", text: { content: "Hallo" } }],
    });
    expect(toPropertyValue(prop("n", "number"), "25")).toEqual({ number: 25 });
    expect(toPropertyValue(prop("u", "url"), "https://x.de")).toEqual({ url: "https://x.de" });
    expect(toPropertyValue(prop("d", "date"), "2026-09-14")).toEqual({
      date: { start: "2026-09-14" },
    });
    expect(toPropertyValue(prop("c", "checkbox"), "ja")).toEqual({ checkbox: true });
  });

  it("versteht auch ein Komma als Dezimaltrennzeichen", () => {
    expect(toPropertyValue(prop("n", "number"), "2,5")).toEqual({ number: 2.5 });
  });

  it("lässt nicht befüllbare Spaltentypen aus", () => {
    expect(toPropertyValue(prop("p", "people"), "Marlon")).toBeUndefined();
    expect(toPropertyValue(prop("f", "formula"), "x")).toBeUndefined();
  });

  it("lässt leere Werte aus statt leere Felder zu schreiben", () => {
    expect(toPropertyValue(prop("t", "rich_text"), "")).toBeUndefined();
    expect(toPropertyValue(prop("t", "rich_text"), null)).toBeUndefined();
    expect(toPropertyValue(prop("m", "multi_select"), [])).toBeUndefined();
  });

  it("lässt eine unparsbare Zahl aus, statt den Job zu kippen", () => {
    expect(toPropertyValue(prop("n", "number"), "keine Ahnung")).toBeUndefined();
  });
});

describe("buildProperties", () => {
  it("baut Titel mit Emoji, abgeglichene Tags und die Quelle", () => {
    const { properties } = buildProperties(recipe, schema, {
      sourceUrl: "https://youtu.be/abc",
      tagsWithHash: false,
      now: new Date("2026-09-14T10:00:00Z"),
    });

    expect(properties.Name).toEqual({
      title: [{ type: "text", text: { content: "🍝 Cremige Pilzpasta" } }],
    });
    // "schnell" und "#Vegetarisch" treffen auf bestehende Optionen.
    expect(properties.Tags).toEqual({
      multi_select: [{ name: "Schnell" }, { name: "Vegetarisch" }, { name: "Herbst" }],
    });
    expect(properties.Quelle).toEqual({ url: "https://youtu.be/abc" });
    expect(properties.Hinzugefügt).toEqual({ date: { start: "2026-09-14" } });
    expect(properties.Küche).toEqual({ select: { name: "Italienisch" } });
  });

  it("schreibt Minuten in eine Number-Spalte und Klartext in eine Text-Spalte", () => {
    const text = buildProperties(recipe, schema, { sourceUrl: "u", tagsWithHash: false });
    expect(text.properties.Zubereitungszeit).toEqual({
      rich_text: [{ type: "text", text: { content: "ca. 25 Minuten" } }],
    });

    const numericSchema: DataSourceSchema = {
      ...schema,
      properties: [prop("Name", "title"), prop("Zubereitungszeit", "number")],
    };
    const num = buildProperties(recipe, numericSchema, { sourceUrl: "u", tagsWithHash: false });
    expect(num.properties.Zubereitungszeit).toEqual({ number: 25 });
  });

  it("überspringt fehlende Spalten und meldet sie zurück", () => {
    const minimal: DataSourceSchema = {
      ...schema,
      properties: [prop("Name", "title")],
    };
    const { properties, skipped } = buildProperties(recipe, minimal, {
      sourceUrl: "https://x.de",
      tagsWithHash: false,
    });
    expect(Object.keys(properties)).toEqual(["Name"]);
    expect(skipped).toContain("tags");
    expect(skipped).toContain("quelle");
  });

  it("wirft eine verständliche Meldung, wenn es keine Title-Spalte gibt", () => {
    const broken: DataSourceSchema = { ...schema, properties: [prop("Tags", "multi_select")] };
    expect(() =>
      buildProperties(recipe, broken, { sourceUrl: "u", tagsWithHash: false }),
    ).toThrow(/Title-Spalte/);
  });
});

describe("Prompt-Hilfen", () => {
  it("bietet nur Zusatzfelder an, für die es auch eine Spalte gibt", () => {
    expect(availableExtraFields(schema)).toEqual(["portionen", "kueche"]);
    const ohne: DataSourceSchema = { ...schema, properties: [prop("Name", "title")] };
    expect(availableExtraFields(ohne)).toEqual([]);
  });

  it("reicht die bekannten Tags an den Prompt durch", () => {
    expect(knownTags(schema)).toEqual(["Schnell", "Vegetarisch", "Asiatisch"]);
  });
});

describe("truncate", () => {
  it("respektiert Notions 2000-Zeichen-Grenze pro Textelement", () => {
    const result = truncate("a".repeat(2500));
    expect(result).toHaveLength(2000);
    expect(result.endsWith("…")).toBe(true);
  });

  it("lässt kurzen Text unangetastet", () => {
    expect(truncate("kurz")).toBe("kurz");
  });
});
