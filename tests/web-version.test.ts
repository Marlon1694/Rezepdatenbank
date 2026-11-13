import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rezepte-webversion-"));
process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "testkey";
process.env.YTDLP_AUTO_UPDATE = "false";
process.env.LOG_LEVEL = "silent";

const { buildApp } = await import("../src/server.ts");
const { closeDb } = await import("../src/jobs/store.ts");
const { webVersion, versionedIndex } = await import("../src/webVersion.ts");

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Web-App nach einem Update", () => {
  it("nennt ihre Fassung ohne Token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { webVersion: string }).webVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("liefert die Startseite mit Fassung an Skripten und Stylesheet", async () => {
    const { webVersion: v } = (await app.inject({ method: "GET", url: "/api/version" })).json() as {
      webVersion: string;
    };
    for (const url of ["/", "/index.html", "/wochenplan-irgendwas"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain(`<meta name="web-version" content="${v}">`);
      expect(res.body).toContain(`<script src="app.js?v=${v}"></script>`);
      expect(res.body).toContain(`<link rel="stylesheet" href="style.css?v=${v}">`);
    }
  });

  it("lässt den Browser jede Datei kurz nachfragen statt sie blind zu behalten", async () => {
    const res = await app.inject({ method: "GET", url: "/app.js?v=egal" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("liefert unter /api weiterhin keine Startseite", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/gibtsnicht",
      headers: { authorization: "Bearer testtoken123" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("webVersion", () => {
  it("ändert sich mit dem Inhalt und bleibt sonst gleich", () => {
    const dir = mkdtempSync(join(tmpdir(), "rezepte-web-"));
    writeFileSync(join(dir, "app.js"), "alt");
    writeFileSync(join(dir, "notizen.txt"), "zählt nicht");
    const a = webVersion(dir);
    expect(webVersion(dir)).toBe(a);
    writeFileSync(join(dir, "notizen.txt"), "anders");
    expect(webVersion(dir)).toBe(a);
    writeFileSync(join(dir, "app.js"), "neu");
    expect(webVersion(dir)).not.toBe(a);
    rmSync(dir, { recursive: true, force: true });
  });

  it("hängt die Fassung nur an eigene Skripte", () => {
    const html =
      '<meta charset="utf-8">\n<link rel="stylesheet" href="style.css">\n' +
      '<script src="app.js"></script><script src="https://example.com/x.js"></script>';
    const out = versionedIndex(html, "abc");
    expect(out).toContain('<script src="app.js?v=abc">');
    expect(out).toContain('<script src="https://example.com/x.js">');
    expect(out).toContain('href="style.css?v=abc"');
  });
});
