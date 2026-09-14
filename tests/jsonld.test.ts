import { describe, it, expect } from "vitest";
import {
  findRecipe,
  recipeToText,
  isoDurationToMinutes,
  extractJsonLdBlocks,
} from "../src/extract/jsonld.ts";
import { parsePage } from "../src/extract/web.ts";

const RECIPE_JSON = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Pilzpasta",
  description: "Cremig und schnell.",
  recipeIngredient: ["200 g Pasta", "250 g Champignons", "100 ml Sahne"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Pasta kochen." },
    { "@type": "HowToStep", text: "Pilze anbraten." },
  ],
  totalTime: "PT25M",
  recipeYield: "2 Portionen",
  recipeCuisine: "Italienisch",
  keywords: "schnell, vegetarisch",
  author: { "@type": "Person", name: "Marlon" },
};

function page(jsonLd: unknown): string {
  return `<!doctype html><html><head><title>Blog</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body><p>Hallo</p></body></html>`;
}

describe("extractJsonLdBlocks", () => {
  it("findet mehrere Blöcke", () => {
    const html = `${page({ "@type": "WebSite" })}<script type="application/ld+json">{"@type":"Person"}</script>`;
    expect(extractJsonLdBlocks(html)).toHaveLength(2);
  });

  it("überspringt kaputtes JSON, ohne die anderen mitzureißen", () => {
    const html =
      `<script type="application/ld+json">{ kaputt </script>` +
      `<script type="application/ld+json">{"@type":"Recipe","recipeIngredient":["Ei"]}</script>`;
    expect(extractJsonLdBlocks(html)).toHaveLength(1);
  });

  it("verträgt CDATA-Wrapper", () => {
    const html = `<script type="application/ld+json">// <![CDATA[
{"@type":"Recipe","recipeIngredient":["Ei"]}
// ]]></script>`;
    expect(extractJsonLdBlocks(html)).toHaveLength(1);
  });
});

describe("findRecipe", () => {
  it("liest ein einfaches Recipe-Objekt", () => {
    const recipe = findRecipe(page(RECIPE_JSON));
    expect(recipe?.name).toBe("Pilzpasta");
    expect(recipe?.ingredients).toHaveLength(3);
    expect(recipe?.instructions).toEqual(["Pasta kochen.", "Pilze anbraten."]);
    expect(recipe?.cuisine).toBe("Italienisch");
    expect(recipe?.author).toBe("Marlon");
  });

  it("zerlegt Keywords an Kommas", () => {
    expect(findRecipe(page(RECIPE_JSON))?.keywords).toEqual(["schnell", "vegetarisch"]);
  });

  it("findet das Rezept auch in einem @graph", () => {
    // So bauen es die meisten WordPress-SEO-Plugins.
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, RECIPE_JSON] };
    expect(findRecipe(page(graph))?.name).toBe("Pilzpasta");
  });

  it("kommt mit @type als Array zurecht", () => {
    const multi = { ...RECIPE_JSON, "@type": ["Recipe", "NewsArticle"] };
    expect(findRecipe(page(multi))?.name).toBe("Pilzpasta");
  });

  it("liest HowToSection mit verschachtelten Schritten", () => {
    const sectioned = {
      ...RECIPE_JSON,
      recipeInstructions: [
        {
          "@type": "HowToSection",
          name: "Vorbereitung",
          itemListElement: [{ "@type": "HowToStep", text: "Pilze putzen." }],
        },
      ],
    };
    expect(findRecipe(page(sectioned))?.instructions[0]).toContain("Pilze putzen.");
  });

  it("akzeptiert Zutaten als mehrzeiligen String", () => {
    const asString = { ...RECIPE_JSON, recipeIngredient: "200 g Pasta\n100 ml Sahne" };
    expect(findRecipe(page(asString))?.ingredients).toEqual(["200 g Pasta", "100 ml Sahne"]);
  });

  it("ignoriert ein Recipe ohne Zutaten und ohne Schritte", () => {
    const leer = { "@type": "Recipe", name: "Nur ein Name" };
    expect(findRecipe(page(leer))).toBeUndefined();
  });

  it("gibt undefined zurück, wenn die Seite kein Rezept enthält", () => {
    expect(findRecipe(page({ "@type": "WebSite", name: "Blog" }))).toBeUndefined();
  });
});

describe("recipeToText", () => {
  it("formt einen Text, der alle Angaben enthält", () => {
    const text = recipeToText(findRecipe(page(RECIPE_JSON))!);
    expect(text).toContain("Titel: Pilzpasta");
    expect(text).toContain("- 200 g Pasta");
    expect(text).toContain("1. Pasta kochen.");
    expect(text).toContain("Ergibt: 2 Portionen");
  });
});

describe("isoDurationToMinutes", () => {
  it("rechnet ISO-8601-Dauern um", () => {
    expect(isoDurationToMinutes("PT25M")).toBe(25);
    expect(isoDurationToMinutes("PT1H30M")).toBe(90);
    expect(isoDurationToMinutes("P1DT2H")).toBe(1560);
  });

  it("gibt null bei Unsinn oder Nichts zurück", () => {
    expect(isoDurationToMinutes(undefined)).toBeNull();
    expect(isoDurationToMinutes("bald")).toBeNull();
    expect(isoDurationToMinutes("PT0M")).toBeNull();
  });
});

describe("parsePage", () => {
  it("bevorzugt JSON-LD gegenüber dem Fließtext", () => {
    const result = parsePage(page(RECIPE_JSON), "https://blog.de/pasta");
    expect(result.jsonLd).toBeDefined();
    expect(result.text).toContain("- 200 g Pasta");
  });

  it("fällt auf den Seitentext zurück, wenn kein JSON-LD da ist", () => {
    const html = `<!doctype html><html><head><title>Omas Pasta</title></head>
      <body><article><h1>Omas Pasta</h1>
      <p>Man nehme 200 g Pasta und koche sie in Salzwasser, bis sie bissfest ist.
      Danach die Champignons in Butter anbraten und alles vermengen.</p>
      </article></body></html>`;
    const result = parsePage(html, "https://blog.de/pasta");
    expect(result.jsonLd).toBeUndefined();
    expect(result.text).toContain("200 g Pasta");
  });
});
