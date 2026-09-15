import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * HTTP-Ebene, ohne lauschenden Server und ohne Netzwerk nach draussen.
 *
 * Diese Tests entstanden aus einem echten Fehler: die Web-App schickte bei
 * "Erneut versuchen" und "Loeschen" den Header Content-Type: application/json
 * ohne Body. Fastify weist das mit HTTP 400 ab - die Knoepfe taten daraufhin
 * scheinbar gar nichts.
 */

const dataDir = mkdtempSync(join(tmpdir(), "rezepte-test-"));

process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.DATA_DIR = dataDir;
process.env.YTDLP_AUTO_UPDATE = "false";
process.env.LOG_LEVEL = "silent";

const { buildApp } = await import("../src/server.ts");
const { closeDb } = await import("../src/jobs/store.ts");

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

async function createJob(url = "https://youtu.be/abc123") {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { ...auth, "content-type": "application/json" },
    payload: { url },
  });
  return res.json() as { id: string; url: string; platform: string };
}

describe("Zugriffsschutz", () => {
  it("laesst /api/health ohne Token durch", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("weist /api/jobs ohne Token ab", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(res.statusCode).toBe(401);
  });

  it("weist ein falsches Token ab", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs",
      headers: { authorization: "Bearer falsch" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("weist ein Token gleicher Laenge ab (kein Praefix-Vergleich)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs",
      headers: { authorization: "Bearer testtoken124" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Jobs anlegen", () => {
  it("entfernt Tracking-Parameter aus geteilten Links", async () => {
    const job = await createJob(
      "https://www.tiktok.com/@koch/video/123?is_from_webapp=1&utm_source=x",
    );
    expect(job.url).toBe("https://www.tiktok.com/@koch/video/123");
    expect(job.platform).toBe("TikTok");
  });

  it("weist eine unbrauchbare URL ab", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { ...auth, "content-type": "application/json" },
      payload: { url: "keine-url" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Aktionen ohne Body", () => {
  // Der eigentliche Regressionstest: so rief die Web-App auf, als die Knoepfe
  // wirkungslos waren - Content-Type gesetzt, aber nichts im Body.
  it("nimmt 'Erneut versuchen' mit Content-Type json und leerem Body an", async () => {
    const job = await createJob("https://youtu.be/emptybody");
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/retry`,
      headers: { ...auth, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
  });

  it("nimmt 'Loeschen' mit Content-Type json und leerem Body an", async () => {
    const job = await createJob("https://youtu.be/emptybody2");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/jobs/${job.id}`,
      headers: { ...auth, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(204);
  });

  it("weist kaputtes JSON weiterhin mit 400 ab", async () => {
    // Nachsicht bei leerem Body heisst nicht Nachsicht bei Unsinn.
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{kaputt",
    });
    expect(res.statusCode).toBe(400);
  });

  it("nimmt 'Erneut versuchen' ohne Body an", async () => {
    const job = await createJob("https://youtu.be/retry01");
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/retry`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "queued" });
  });

  it("nimmt 'Loeschen' ohne Body an", async () => {
    const job = await createJob("https://youtu.be/delete01");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/jobs/${job.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);

    const gone = await app.inject({
      method: "GET",
      url: `/api/jobs/${job.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(404);
  });

  it("meldet 404 bei einem unbekannten Job statt 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/gibtsnicht/retry",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Routen", () => {
  it("liefert die Web-App aus", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Rezepte");
  });

  it("liefert die Kurzbefehl-Hilfe unter /setup", async () => {
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Kurzbefehl");
  });

  it("antwortet auf unbekannte API-Pfade mit JSON, nicht mit HTML", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/gibtsnicht",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });
});
