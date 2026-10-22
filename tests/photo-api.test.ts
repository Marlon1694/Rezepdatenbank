import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Die Upload-Strecke, ohne Netz nach draussen.
 *
 * Geprueft wird hier nicht, ob Gemini ein Rezept erkennt - das kann kein Test
 * ohne API. Geprueft wird, was davor und danach passiert: Was angenommen wird,
 * was abgewiesen wird, und ob nach einem abgewiesenen Upload wirklich nichts
 * liegen bleibt.
 */

const dataDir = mkdtempSync(join(tmpdir(), "rezepte-foto-"));

process.env.APP_TOKEN = "testtoken123";
process.env.NOTION_TOKEN = "ntn_test";
process.env.NOTION_DATABASE_ID = "0".repeat(32);
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "testkey";
process.env.YTDLP_AUTO_UPDATE = "false";
process.env.LOG_LEVEL = "silent";
process.env.MAX_PHOTOS_PER_JOB = "3";
// Klein genug, um die Groessengrenze ohne Megabyte-Testdaten auszuloesen.
process.env.MAX_PHOTO_BYTES = "2000";

const { buildApp } = await import("../src/server.ts");
const { closeDb } = await import("../src/jobs/store.ts");

let app: Awaited<ReturnType<typeof buildApp>>;
const auth = { authorization: "Bearer testtoken123" };

/** Ein winziges, gueltiges PNG - Inhalt egal, es wird hier nie gelesen. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Baut einen multipart-Body von Hand - kein Browser, kein FormData. */
function multipart(files: Array<{ name: string; data: Buffer }>): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----rezepttest";
  const teile: Buffer[] = [];

  for (const file of files) {
    teile.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="foto"; filename="${file.name}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  teile.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(teile),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function uploadDirs(): string[] {
  const root = join(dataDir, "uploads");
  return existsSync(root) ? readdirSync(root) : [];
}

/** Liegengebliebene Entwuerfe - direkt aus der Tabelle, an der API vorbei. */
function entwuerfe(): number {
  const db = new Database(join(dataDir, "jobs.db"), { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'draft'`).get() as {
      n: number;
    };
    return row.n;
  } finally {
    db.close();
  }
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

describe("POST /api/jobs/foto", () => {
  it("nimmt mehrere Fotos an und reiht sie in der gegebenen Reihenfolge ein", async () => {
    const { payload, headers } = multipart([
      { name: "seite1.png", data: PNG },
      { name: "seite2.png", data: PNG },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/foto",
      headers: { ...auth, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { id: string; photos: number; kind: string };
    expect(body.photos).toBe(2);
    expect(body.kind).toBe("foto");

    const job = (await app.inject({ method: "GET", url: `/api/jobs/${body.id}`, headers: auth }))
      .json() as { kind: string; photos: string[]; url: string };
    expect(job.kind).toBe("foto");
    // Die Namen vergibt der Server selbst - der Name des Clients bestimmt nur
    // die Endung. Sonst koennte er hineinreden, wohin geschrieben wird.
    expect(job.photos).toEqual(["1.png", "2.png"]);
    expect(job.url).toBe("");
  });

  it("weist ohne Token ab", async () => {
    const { payload, headers } = multipart([{ name: "a.png", data: PNG }]);
    const res = await app.inject({ method: "POST", url: "/api/jobs/foto", headers, payload });
    expect(res.statusCode).toBe(401);
  });

  it("weist ein fremdes Dateiformat ab und laesst nichts zurueck", async () => {
    const vorher = uploadDirs().length;

    const { payload, headers } = multipart([{ name: "rezept.pdf", data: PNG }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/foto",
      headers: { ...auth, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Bildformat");

    // Der Kern dieses Tests: Es bleibt nichts liegen. Direkt in der Tabelle
    // nachsehen, nicht ueber /api/jobs - die Liste blendet Entwuerfe per SQL
    // aus, dort waere ein liegengebliebener Entwurf also unsichtbar und die
    // Zusicherung wertlos.
    expect(uploadDirs().length).toBe(vorher);
    expect(entwuerfe()).toBe(0);
  });

  it("weist mehr Fotos ab, als erlaubt sind", async () => {
    const vorher = uploadDirs().length;
    const { payload, headers } = multipart(
      Array.from({ length: 4 }, (_, i) => ({ name: `${i}.png`, data: PNG })),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/foto",
      headers: { ...auth, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(uploadDirs().length).toBe(vorher);
    expect(entwuerfe()).toBe(0);
  });

  it("weist ein zu grosses Foto ab, statt es halb zu speichern", async () => {
    const vorher = uploadDirs().length;
    // Fastify bricht bei Ueberschreitung nicht ab, sondern liefert die Datei
    // abgeschnitten aus. Ohne die Pruefung auf "truncated" landete ein halbes
    // Bild auf der Platte - und das Modell bekaeme Matsch zu sehen.
    const zuGross = Buffer.concat([PNG, Buffer.alloc(5000, 0x41)]);
    const { payload, headers } = multipart([{ name: "riesig.png", data: zuGross }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/foto",
      headers: { ...auth, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(413);
    expect(uploadDirs().length).toBe(vorher);
    expect(entwuerfe()).toBe(0);
  });

  it("weist einen leeren Upload ab", async () => {
    const { payload, headers } = multipart([]);
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/foto",
      headers: { ...auth, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("kein Foto");
  });

  it("weist eine Anfrage ohne multipart ab", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/foto",
      headers: { ...auth, "content-type": "application/json" },
      payload: { url: "https://example.com" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/jobs/:id/fotos/:index", () => {
  it("liefert das Bild mit passendem Typ aus", async () => {
    const { payload, headers } = multipart([{ name: "seite.png", data: PNG }]);
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/api/jobs/foto",
        headers: { ...auth, ...headers },
        payload,
      })
    ).json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${id}/fotos/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it("laesst sich nicht aus dem Ordner herauslocken", async () => {
    const { payload, headers } = multipart([{ name: "seite.png", data: PNG }]);
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/api/jobs/foto",
        headers: { ...auth, ...headers },
        payload,
      })
    ).json() as { id: string };

    // Bedient wird ausschliesslich aus der Liste des Jobs. Was hier steht, ist
    // ein Index - kein Pfad, der irgendwohin zeigen koennte.
    for (const böse of ["../../../../etc/passwd", "-1", "99", "abc", "0.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${id}/fotos/${encodeURIComponent(böse)}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("DELETE /api/jobs/:id", () => {
  it("entfernt die Bilder mit", async () => {
    const { payload, headers } = multipart([{ name: "seite.png", data: PNG }]);
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/api/jobs/foto",
        headers: { ...auth, ...headers },
        payload,
      })
    ).json() as { id: string };

    expect(existsSync(join(dataDir, "uploads", id))).toBe(true);

    const res = await app.inject({ method: "DELETE", url: `/api/jobs/${id}`, headers: auth });
    expect(res.statusCode).toBe(204);
    // Sonst sammeln sich die Bilder gelöschter Jobs für immer im Datenordner an.
    expect(existsSync(join(dataDir, "uploads", id))).toBe(false);
  });
});

describe("Datenbank-Migration", () => {
  it("ergänzt die neuen Spalten in einer bestehenden Datenbank", async () => {
    // Eine Datenbank, wie sie vor dieser Erweiterung angelegt wurde. Ohne
    // Migration liefe der Server darauf auf einen SQL-Fehler, weil
    // CREATE TABLE IF NOT EXISTS eine vorhandene Tabelle unverändert lässt.
    const altDir = mkdtempSync(join(tmpdir(), "rezepte-alt-"));
    const alt = new Database(join(altDir, "jobs.db"));
    alt.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL,
        step TEXT NOT NULL DEFAULT '', error TEXT, title TEXT, platform TEXT,
        text_source TEXT, transcript TEXT, recipe_json TEXT,
        notion_page_id TEXT, notion_page_url TEXT,
        notion_updated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, duration_ms INTEGER
      );
      INSERT INTO jobs (id, url, status, created_at, updated_at)
      VALUES ('alt-1', 'https://youtu.be/x', 'done', '2026-01-01', '2026-01-01');
    `);
    alt.close();

    const merker = process.env.DATA_DIR;
    process.env.DATA_DIR = altDir;
    try {
      const store = await import("../src/jobs/store.ts");
      store.closeDb();
      const { resetConfigCache } = await import("../src/config.ts");
      resetConfigCache();

      // Lesen allein beweist nichts: getJob() faellt fuer fehlende Spalten auf
      // Standardwerte zurueck und bestuende den Test auch ohne Migration.
      // Der Fehler schlaegt beim SCHREIBEN zu - INSERT auf eine Spalte, die
      // es nicht gibt. Also genau das hier pruefen.
      const neu = store.createPhotoJob();
      expect(neu.kind).toBe("foto");
      store.queuePhotoJob(neu.id, ["1.jpg"]);
      expect(store.getJob(neu.id)?.photos).toEqual(["1.jpg"]);

      const alt1 = store.getJob("alt-1");
      expect(alt1).toBeDefined();
      // Alte Zeilen stammen alle aus der Link-Zeit.
      expect(alt1?.kind).toBe("link");
      expect(alt1?.photos).toEqual([]);

      store.closeDb();
    } finally {
      process.env.DATA_DIR = merker;
      const { resetConfigCache } = await import("../src/config.ts");
      resetConfigCache();
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});
