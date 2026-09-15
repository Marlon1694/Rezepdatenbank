import { describe, it, expect } from "vitest";
import { buildProperties, availableExtraFields, knownOptions } from "../src/notion/mapper.ts";
import { RecipeSchema } from "../src/llm/recipeSchema.ts";
import type { DataSourceSchema } from "../src/notion/client.ts";

/**
 * Gegen ein realistisches Schema, wie scripts/inspect-notion-db.ts es ausliest -
 * mit allen Spaltentypen, die in einer Rezept-Datenbank vorkommen. Damit ist
 * geprueft, dass die Zuordnung an einem echten Aufbau stimmt und nicht nur an
 * einem ausgedachten Beispiel.
 *
 * Die Kennung ist bewusst ein Platzhalter: In einer Datenbank-ID steckt zwar kein
 * Zugang - dafuer braucht es das Integrations-Token - aber sie benennt einen
 * fremden Arbeitsbereich, und das gehoert nicht in oeffentlichen Quelltext.
 */
const rezeptbuch: DataSourceSchema = {
  dataSourceId: "00000000-0000-0000-0000-000000000000",
  databaseTitle: "Rezeptbuch",
  properties: [
    { name: "Schwierigkeitsgrad", type: "select", options: ["Mittel", "Schwer", "Leicht"] },
    { name: "Bewertung", type: "select", options: ["⭐️", "⭐️⭐️", "⭐️⭐️⭐️", "⭐️⭐️⭐️⭐️", "⭐️⭐️⭐️⭐️⭐️"] },
    {
      name: "Status",
      type: "status",
      options: ["Als nächstes ausprobieren", "Ausprobieren", "Perfektioniert", "Ausprobiert"],
    },
    {
      name: "Kategorien",
      type: "multi_select",
      options: ["Backen", "Brot", "Brötchen", "Cremig", "Fischgericht", "Fitness"],
    },
    { name: "Kochzeit", type: "rich_text", options: [] },
    { name: "URL", type: "url", options: [] },
    { name: "Zutaten", type: "multi_select", options: ["Sahne", "Lachs"] },
    { name: "Name", type: "title", options: [] },
  ],
};

const modellAntwort = {
  emoji: "🐟",
  titel: "Lachs in Sahnesauce",
  tags: ["fischgericht", "Cremig", "Feierabend"],
  zeit_text: "ca. 25 Minuten",
  zeit_minuten: 25,
  zutaten: [
    {
      gruppe: "Zutaten",
      eintraege: [
        { menge: "2", zutat: "Lachsfilets" },
        { menge: "200 ml", zutat: "Sahne" },
        { zutat: "Salz" },
      ],
    },
  ],
  schritte: ["Lachs braten.", "Sahne angießen."],
  pro_tipp: "Dill erst am Ende zugeben.",
  schwierigkeit: "leicht",
  zutaten_namen: ["Lachs", "sahne", "Dill"],
};

const opts = {
  sourceUrl: "https://www.youtube.com/watch?v=abc",
  tagsWithHash: false,
  newRecipeStatus: "Ausprobieren",
};

describe("Zuordnung auf die Datenbank Rezeptbuch", () => {
  const recipe = RecipeSchema.parse(modellAntwort);

  it("trifft alle Kernspalten", () => {
    const { properties } = buildProperties(recipe, rezeptbuch, opts);

    expect(properties.Name).toEqual({
      title: [{ type: "text", text: { content: "🐟 Lachs in Sahnesauce" } }],
    });
    expect(properties.Kochzeit).toEqual({
      rich_text: [{ type: "text", text: { content: "ca. 25 Minuten" } }],
    });
    expect(properties.URL).toEqual({ url: "https://www.youtube.com/watch?v=abc" });
  });

  it("nutzt vorhandene Kategorien wieder statt Dubletten anzulegen", () => {
    const { properties } = buildProperties(recipe, rezeptbuch, opts);
    // "fischgericht" trifft auf "Fischgericht", "Feierabend" ist neu.
    expect(properties.Kategorien).toEqual({
      multi_select: [{ name: "Fischgericht" }, { name: "Cremig" }, { name: "Feierabend" }],
    });
  });

  it("schreibt den Schwierigkeitsgrad in der Schreibweise der Datenbank", () => {
    const { properties } = buildProperties(recipe, rezeptbuch, opts);
    // Modell liefert "leicht", die Spalte kennt "Leicht".
    expect(properties.Schwierigkeitsgrad).toEqual({ select: { name: "Leicht" } });
  });

  it("befüllt die Zutaten-Spalte mit Grundzutaten und gleicht sie ab", () => {
    const { properties } = buildProperties(recipe, rezeptbuch, opts);
    expect(properties.Zutaten).toEqual({
      multi_select: [{ name: "Lachs" }, { name: "Sahne" }, { name: "Dill" }],
    });
  });

  it("setzt bei neuen Rezepten den konfigurierten Status", () => {
    const { properties } = buildProperties(recipe, rezeptbuch, opts);
    expect(properties.Status).toEqual({ status: { name: "Ausprobieren" } });
  });

  it("lässt den Status beim Aktualisieren unangetastet", () => {
    // Der wichtigste Fall: ein erneut geteiltes Rezept darf einen bereits auf
    // "Perfektioniert" gesetzten Stand nicht auf Anfang zurückwerfen.
    const { properties } = buildProperties(recipe, rezeptbuch, {
      ...opts,
      newRecipeStatus: undefined,
    });
    expect(properties.Status).toBeUndefined();
  });

  it("fasst die Bewertung nicht an", () => {
    // Die vergibt der Mensch nach dem Kochen, nicht das Modell.
    const { properties } = buildProperties(recipe, rezeptbuch, opts);
    expect(properties.Bewertung).toBeUndefined();
  });

  it("fordert vom Modell genau die Zusatzfelder an, für die es Spalten gibt", () => {
    // Portionen und Küche fehlen in dieser Datenbank - danach wird nicht gefragt.
    expect(availableExtraFields(rezeptbuch)).toEqual(["schwierigkeit", "zutatenliste"]);
  });

  it("reicht vorhandene Zutaten-Optionen an den Prompt durch", () => {
    expect(knownOptions(rezeptbuch, "zutatenliste")).toEqual(["Sahne", "Lachs"]);
  });

  it("meldet keine fehlenden Pflichtfelder", () => {
    const { skipped } = buildProperties(recipe, rezeptbuch, opts);
    expect(skipped).not.toContain("titel");
    expect(skipped).not.toContain("tags");
    expect(skipped).not.toContain("quelle");
  });
});
