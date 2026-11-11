import { describe, it, expect } from "vitest";
import {
  buildShoppingLines,
  approvalPayload,
  formatQuantity,
  isStaple,
  type PlannedRecipe,
} from "../src/mealie/shopping.ts";
import {
  addDays,
  freeSlots,
  recency,
  pickAlternative,
  validateProposal,
  weekday,
  type RecipeOption,
} from "../src/mealie/planner.ts";

const zwiebel = { id: "f-zwiebel", name: "Zwiebel" };
const mehl = { id: "f-mehl", name: "Mehl" };
const salz = { id: "f-salz", name: "Salz" };
const butter = { id: "f-butter", name: "Butter", householdsWithIngredientFood: ["family"] };
const g = { id: "u-g", name: "Gramm", abbreviation: "g" };

function plan(over: Partial<PlannedRecipe> & Pick<PlannedRecipe, "recipeId" | "ingredients">): PlannedRecipe {
  return {
    entryId: over.recipeId,
    date: "2026-11-16",
    entryType: "dinner",
    slug: over.recipeId,
    name: over.recipeId,
    scale: 1,
    ...over,
  };
}

const gulasch = plan({
  recipeId: "gulasch",
  name: "Gulasch",
  ingredients: [
    { referenceId: "g1", quantity: 2, food: zwiebel },
    { referenceId: "g2", quantity: 1, food: salz },
    { referenceId: "g3", note: "eine Prise Kümmel" },
  ],
});
const kuchen = plan({
  recipeId: "kuchen",
  name: "Zwiebelkuchen",
  scale: 2,
  ingredients: [
    { referenceId: "k1", quantity: 250, unit: g, food: mehl },
    { referenceId: "k2", quantity: 3, food: zwiebel },
    { referenceId: "k3", quantity: 50, unit: g, food: butter },
  ],
});

const opts = { householdSlug: "family", staples: ["Salz", "Pfeffer", "Öl"] };

describe("buildShoppingLines", () => {
  const lines = buildShoppingLines([gulasch, kuchen], opts);
  const zeile = (label: string) => lines.find((l) => l.label.endsWith(label));

  it("fasst dasselbe Lebensmittel über die Woche zusammen - mit Portionsfaktor", () => {
    // Gulasch 2 Zwiebeln + Zwiebelkuchen 3 Zwiebeln × Faktor 2 = 8.
    expect(zeile("Zwiebel")?.label).toBe("8 Zwiebel");
    expect(zeile("Zwiebel")?.recipes).toEqual(["Gulasch", "Zwiebelkuchen"]);
    expect(zeile("Mehl")?.label).toBe("500 g Mehl");
  });

  it("wählt Vorrätiges und Grundausstattung vorab ab", () => {
    // Butter ist in Mealie für diesen Haushalt als vorrätig markiert.
    expect(zeile("Butter")?.onHand).toBe(true);
    // Salz ist Grundausstattung, auch ohne Kennzeichen in Mealie.
    expect(zeile("Salz")?.onHand).toBe(true);
    expect(zeile("Zwiebel")?.onHand).toBe(false);
  });

  it("lässt Freitext stehen, wie er ist", () => {
    expect(lines.find((l) => l.key.startsWith("n:"))?.label).toBe("eine Prise Kümmel");
  });

  it("sortiert erst das Einzukaufende, dann den Vorrat", () => {
    const erstesVorrat = lines.findIndex((l) => l.onHand);
    expect(lines.slice(erstesVorrat).every((l) => l.onHand)).toBe(true);
  });

  it("hält Mengen verschiedener Einheiten getrennt", () => {
    const zwei = buildShoppingLines(
      [
        plan({ recipeId: "a", ingredients: [{ referenceId: "a1", quantity: 200, unit: g, food: mehl }] }),
        plan({ recipeId: "b", ingredients: [{ referenceId: "b1", quantity: 2, food: mehl }] }),
      ],
      opts,
    );
    expect(zwei.map((l) => l.label).sort()).toEqual(["2 Mehl", "200 g Mehl"]);
  });
});

describe("approvalPayload", () => {
  const lines = buildShoppingLines([gulasch, kuchen], opts);
  const key = (label: string) => lines.find((l) => l.label.endsWith(label))!.key;

  it("schickt nur die freigegebenen Zutaten, je Rezept mit Portionsfaktor", () => {
    const payload = approvalPayload([gulasch, kuchen], lines, new Set([key("Zwiebel"), key("Mehl")]));
    expect(payload).toEqual([
      { recipeId: "gulasch", recipeIncrementQuantity: 1, recipeIngredients: [gulasch.ingredients[0]] },
      {
        recipeId: "kuchen",
        recipeIncrementQuantity: 2,
        recipeIngredients: [kuchen.ingredients[0], kuchen.ingredients[1]],
      },
    ]);
  });

  it("lässt ein Rezept ganz weg, wenn nichts davon freigegeben ist", () => {
    // Wichtig: Eine LEERE Zutatenliste darf nicht an Mealie gehen. Mealie
    // nähme fehlende Zutaten als "alle Zutaten" - genau das Gegenteil.
    const payload = approvalPayload([gulasch, kuchen], lines, new Set([key("Mehl")]));
    expect(payload.map((p) => p.recipeId)).toEqual(["kuchen"]);
    expect(payload.every((p) => p.recipeIngredients.length > 0)).toBe(true);
  });

  it("ignoriert unbekannte Schlüssel", () => {
    expect(approvalPayload([gulasch], lines, new Set(["f:gibts-nicht|u:"]))).toEqual([]);
  });
});

describe("Hilfen", () => {
  it("formatiert Mengen deutsch", () => {
    expect(formatQuantity(0.5)).toBe("0,5");
    expect(formatQuantity(2)).toBe("2");
    expect(formatQuantity(1 / 3)).toBe("0,33");
  });

  it("erkennt Grundvorrat nur als ganzes Wort", () => {
    expect(isStaple("Salz und Pfeffer", ["Salz"])).toBe(true);
    expect(isStaple("Salzbrezel", ["Salz"])).toBe(false);
    expect(isStaple("2 EL Öl", ["Öl"])).toBe(true);
    expect(isStaple("Ölsardinen", ["Öl"])).toBe(false);
  });
});

/* ── Wochenplan ──────────────────────────────────────────────────────────── */

const rezepte: RecipeOption[] = ["a", "b", "c", "d", "e"].map((id) => ({
  id,
  slug: id,
  name: `Rezept ${id}`,
  tags: [],
}));

describe("Datumsrechnung", () => {
  it("rechnet über Monats- und Zeitumstellungsgrenzen", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26"); // Zeitumstellung 25.10.
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekday("2026-11-16")).toBe("Montag");
  });

  it("lässt belegte Tage aus", () => {
    expect(freeSlots("2026-11-16", 3, new Set(["2026-11-17"]))).toEqual(["2026-11-16", "2026-11-18"]);
  });
});

describe("validateProposal", () => {
  const slots = ["2026-11-16", "2026-11-17", "2026-11-18"];
  const rec = recency([
    { date: "2026-11-10", recipeId: "a" },
    { date: "2026-11-01", recipeId: "b" },
  ]);
  const ersterZufall = () => 0;

  it("übernimmt einen gültigen Vorschlag", () => {
    const r = validateProposal(
      {
        tage: [
          { datum: "2026-11-16", rezept_id: "c", grund: "Schnell" },
          { datum: "2026-11-17", rezept_id: "d", grund: "Lange her" },
          { datum: "2026-11-18", rezept_id: "e", grund: "Wochenende" },
        ],
      },
      slots,
      rezepte,
      rec,
      ersterZufall,
    );
    expect(r.map((d) => d.recipeId)).toEqual(["c", "d", "e"]);
    expect(r.every((d) => !d.substituted)).toBe(true);
  });

  it("ersetzt erfundene IDs, Doppelte und fehlende Tage", () => {
    const r = validateProposal(
      {
        tage: [
          { datum: "2026-11-16", rezept_id: "c" },
          { datum: "2026-11-17", rezept_id: "c" }, // doppelt
          { datum: "2026-11-18", rezept_id: "erfunden" },
          { datum: "2026-12-24", rezept_id: "d" }, // gar kein freier Tag
        ],
      },
      slots,
      rezepte,
      rec,
      ersterZufall,
    );
    expect(r).toHaveLength(3);
    expect(new Set(r.map((d) => d.recipeId)).size).toBe(3);
    expect(r[0]).toMatchObject({ recipeId: "c" });
    expect(r[1]!.substituted).toBe(true);
    expect(r[2]!.substituted).toBe(true);
  });

  it("übersteht eine völlig unbrauchbare Antwort", () => {
    const r = validateProposal("Unsinn", slots, rezepte, rec, ersterZufall);
    expect(r).toHaveLength(3);
    expect(r.every((d) => d.substituted)).toBe(true);
  });

  it("lässt Tage frei, wenn es weniger Rezepte als Tage gibt", () => {
    const r = validateProposal({}, slots, rezepte.slice(0, 2), rec, ersterZufall);
    expect(r).toHaveLength(2);
  });
});

describe("pickAlternative", () => {
  it("nimmt bevorzugt Nie-Gegessenes und lange nicht Gegessenes", () => {
    const rec = recency([
      { date: "2026-11-10", recipeId: "a" },
      { date: "2026-11-01", recipeId: "b" },
      { date: "2026-11-12", recipeId: "c" },
      { date: "2026-11-11", recipeId: "d" },
      { date: "2026-11-09", recipeId: "e" },
    ]);
    // Alle schon gegessen: das älteste zuerst.
    expect(pickAlternative(rezepte, new Set(), rec, () => 0)?.id).toBe("b");
    // Mit einem nie gegessenen: das.
    const mitNeu = [...rezepte, { id: "neu", slug: "neu", name: "Neu", tags: [] }];
    expect(pickAlternative(mitNeu, new Set(), rec, () => 0)?.id).toBe("neu");
  });

  it("schließt aus, was schon im Plan steht", () => {
    expect(pickAlternative(rezepte, new Set(["a", "b", "c", "d", "e"]), new Map())).toBeUndefined();
  });
});
