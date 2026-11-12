import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rezepte-revise-"));
process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "testkey";
process.env.YTDLP_AUTO_UPDATE = "false";
process.env.LOG_LEVEL = "silent";

/** Was die KI zuletzt zu sehen bekam, und was sie antwortet. */
const prompts: string[] = [];
let antwort: unknown;
vi.mock("../src/llm/gemini.ts", () => ({
  generateJson: vi.fn(async (opts: { prompt: string }) => {
    prompts.push(opts.prompt);
    return antwort;
  }),
  getGemini: () => {
    throw new Error("nicht benutzt");
  },
  getImageClient: () => {
    throw new Error("nicht benutzt");
  },
  resetGemini: () => {},
}));

const { buildApp } = await import("../src/server.ts");
const { closeDb, getJob, createPhotoJob, updateJob } = await import("../src/jobs/store.ts");
const { RecipeSchema } = await import("../src/llm/recipeSchema.ts");
const { mergeRevision } = await import("../src/llm/revise.ts");

let app: Awaited<ReturnType<typeof buildApp>>;
const auth = { authorization: "Bearer testtoken123", "content-type": "application/json" };

const bolognese = () =>
  RecipeSchema.parse({
    titel: "Bolognese",
    tags: ["Pasta"],
    portionen: "4",
    kueche: "Italienisch",
    schwierigkeit: "Leicht",
    zutaten: [
      {
        gruppe: "Zutaten",
        eintraege: [
          { menge: "500 g", zutat: "Hackfleisch", anzahl: 500, einheit: "g", lebensmittel: "Hackfleisch" },
          { menge: "200 ml", zutat: "Sahne", anzahl: 200, einheit: "ml", lebensmittel: "Sahne" },
        ],
      },
    ],
    schritte: ["Hack anbraten.", "Mit Sahne verfeinern."],
    schritte_zutaten: [["Hackfleisch"], ["Sahne"]],
    pro_tipp: "Lange köcheln lassen.",
  });

/** Die KI nimmt die Sahne raus - und laesst die optionalen Felder weg. */
const ohneSahne = {
  emoji: "🍝",
  titel: "Bolognese",
  tags: ["Pasta"],
  zeit_text: "",
  zutaten: [{ gruppe: "Zutaten", eintraege: [{ menge: "500 g", zutat: "Hackfleisch" }] }],
  schritte: ["Hack anbraten.", "Abschmecken."],
};

function jobMitRezept() {
  // Ein Entwurf, damit der Worker ihn nicht aufgreift.
  const job = createPhotoJob();
  updateJob(job.id, { status: "done", recipe: bolognese(), title: "Bolognese" });
  return job.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  prompts.length = 0;
  antwort = ohneSahne;
});

describe("POST /api/jobs/:id/revise", () => {
  it("liefert einen Vorschlag und speichert nichts", async () => {
    const id = jobMitRezept();
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/revise`,
      headers: auth,
      payload: { anweisung: "ohne Sahne" },
    });
    expect(res.statusCode).toBe(200);
    const { recipe } = res.json() as { recipe: { zutaten: { eintraege: { zutat: string }[] }[] } };
    expect(recipe.zutaten[0]!.eintraege.map((e) => e.zutat)).toEqual(["Hackfleisch"]);
    // Gespeichert ist weiter das Original - erst der Editor speichert.
    expect(getJob(id)!.recipe!.zutaten[0]!.eintraege).toHaveLength(2);
    expect(prompts[0]).toContain("ohne Sahne");
    expect(prompts[0]).toContain('"Sahne"');
  });

  it("verfeinert einen mitgeschickten Vorschlag statt wieder beim Original anzufangen", async () => {
    const id = jobMitRezept();
    const vorschlag = { ...bolognese(), titel: "Scharfe Bolognese" };
    await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/revise`,
      headers: auth,
      payload: { anweisung: "für 2 Personen", recipe: vorschlag },
    });
    expect(prompts[0]).toContain("Scharfe Bolognese");
  });

  it("weist eine leere Anweisung ab", async () => {
    const id = jobMitRezept();
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/revise`,
      headers: auth,
      payload: { anweisung: " " },
    });
    expect(res.statusCode).toBe(400);
    expect(prompts).toHaveLength(0);
  });

  it("braucht ein fertiges Rezept", async () => {
    const res404 = await app.inject({
      method: "POST",
      url: "/api/jobs/gibtsnicht/revise",
      headers: auth,
      payload: { anweisung: "schärfer" },
    });
    expect(res404.statusCode).toBe(404);

    const leer = createPhotoJob();
    const res409 = await app.inject({
      method: "POST",
      url: `/api/jobs/${leer.id}/revise`,
      headers: auth,
      payload: { anweisung: "schärfer" },
    });
    expect(res409.statusCode).toBe(409);
  });

  it("verlangt das Token", async () => {
    const id = jobMitRezept();
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/revise`,
      headers: { "content-type": "application/json" },
      payload: { anweisung: "schärfer" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("meldet einen unbrauchbaren Vorschlag verständlich", async () => {
    antwort = { titel: "Bolognese" };
    const id = jobMitRezept();
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/revise`,
      headers: auth,
      payload: { anweisung: "schärfer" },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain("unvollständig");
  });
});

describe("mergeRevision", () => {
  it("behält, was die KI bei den optionalen Feldern weglässt", () => {
    const r = mergeRevision(bolognese(), ohneSahne);
    expect(r.portionen).toBe("4");
    expect(r.kueche).toBe("Italienisch");
    expect(r.pro_tipp).toBe("Lange köcheln lassen.");
  });

  it("übernimmt, was die KI ausdrücklich ändert", () => {
    const r = mergeRevision(bolognese(), { ...ohneSahne, portionen: "2", pro_tipp: "" });
    expect(r.portionen).toBe("2");
    expect(r.pro_tipp).toBe("");
  });
});
