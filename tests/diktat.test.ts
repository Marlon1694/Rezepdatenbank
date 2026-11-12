import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rezepte-diktat-"));
process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "testkey";
process.env.YTDLP_AUTO_UPDATE = "false";
process.env.LOG_LEVEL = "silent";

const { buildApp } = await import("../src/server.ts");
const { closeDb, getJob } = await import("../src/jobs/store.ts");
const { dictationNotice } = await import("../src/jobs/pipeline.ts");
const { buildModeSection } = await import("../src/llm/prompt.ts");

let app: Awaited<ReturnType<typeof buildApp>>;
const auth = { authorization: "Bearer testtoken123" };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function multipart(name: string, data: Buffer) {
  const b = "----diktat";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="audio"; filename="${name}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${b}` },
  };
}

describe("POST /api/jobs/diktat", () => {
  it("reiht ein Diktat als Text ein und hebt den Text auf", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/diktat",
      headers: { ...auth, "content-type": "application/json" },
      payload: { text: "  Mach mir was aus Kartoffeln und Schnitzel  " },
    });
    expect(res.statusCode).toBe(202);
    const job = getJob((res.json() as { id: string }).id)!;
    expect(job.kind).toBe("diktat");
    // Der Text liegt im Transkript - ein zweiter Anlauf braucht nichts anderes.
    expect(job.transcript).toBe("Mach mir was aus Kartoffeln und Schnitzel");
  });

  it("weist ein leeres Diktat ab", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/diktat",
      headers: { ...auth, "content-type": "application/json" },
      payload: { text: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("verlangt das Token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/diktat",
      headers: { "content-type": "application/json" },
      payload: { text: "Pfannkuchen" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/jobs/diktat/audio", () => {
  it("nimmt ein Sprachmemo an", async () => {
    const { payload, headers } = multipart("Neue Aufnahme.m4a", Buffer.from("audio"));
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/diktat/audio",
      headers: { ...auth, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(202);
    const job = getJob((res.json() as { id: string }).id)!;
    expect(job.kind).toBe("diktat");
    expect(job.photos).toEqual(["1.m4a"]);
    // Eingereiht, kein Entwurf mehr - ob der Worker schon zugegriffen hat, ist
    // im Test Zufall.
    expect(job.status).not.toBe("draft");
  });

  it("weist ein Bild ab und lässt nichts liegen", async () => {
    const root = join(dataDir, "uploads");
    const vorher = existsSync(root) ? readdirSync(root).length : 0;
    const { payload, headers } = multipart("foto.jpg", Buffer.from("x"));
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/diktat/audio",
      headers: { ...auth, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("keine Audiodatei");
    expect(existsSync(root) ? readdirSync(root).length : 0).toBe(vorher);
  });
});

describe("Hinweis oben auf der Seite", () => {
  it("nennt einen bloßen Wunsch ehrlich als frei entwickelt", () => {
    expect(dictationNotice("Mach mir was aus Kartoffeln und Schnitzel")).toContain(
      "nach deinem Wunsch entwickelt",
    );
  });

  it("nennt ein ausführliches Diktat als ergänzt", () => {
    const diktat =
      "Für vier Personen 800 g Kartoffeln schälen und in Salzwasser kochen. " +
      "4 Schnitzel klopfen, salzen, pfeffern und in 2 Eiern und 100 g Semmelbröseln " +
      "wenden. In Butterschmalz goldbraun braten und mit Zitrone servieren.";
    expect(dictationNotice(diktat)).toContain("(ergänzt)");
  });
});

describe("Prompt für Diktate", () => {
  it("setzt „Nichts erfinden“ nur eingeschränkt aus und gibt dem Gesagten Vorrang", () => {
    const text = buildModeSection("diktat");
    expect(text).toContain("Gesprochenes Diktat");
    expect(text).toContain("hat Vorrang");
    expect(text).toContain("(ergänzt)");
    // Selbstkorrekturen beim Sprechen sind normal - die letzte gilt.
    expect(text).toContain("gilt die Korrektur");
  });
});
