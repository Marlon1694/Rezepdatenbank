import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "./config.ts";
import { createJob, getJob, listJobs, deleteJob, updateJob } from "./jobs/store.ts";
import { startWorker, nudgeWorker } from "./jobs/worker.ts";
import { upsertRecipe } from "./notion/upsert.ts";
import { getDataSourceSchema } from "./notion/client.ts";
import { loadMapping } from "./jobs/mapping.ts";
import { RecipeSchema } from "./llm/recipeSchema.ts";
import * as ytdlp from "./extract/ytdlp.ts";
import { detectPlatform } from "./extract/index.ts";
import { cleanUrl, isValidUrl } from "./lib/url.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Vergleich in konstanter Zeit, damit das Token nicht erraten werden kann. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Baut die App, ohne zu lauschen und ohne den Worker zu starten.
 * Damit laesst sie sich in Tests ueber app.inject() ansprechen.
 */
export async function buildApp() {
  const cfg = getConfig();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1024 * 1024,
  });

  // Ein leerer Body mit "application/json" ist fuer Fastify von Haus aus ein
  // Fehler (FST_ERR_CTP_EMPTY_JSON_BODY, HTTP 400). Genau so rufen aber viele
  // Clients Aktionen ohne Nutzdaten auf - die eigene Web-App tat es, iOS-Kurz-
  // befehle tun es ebenfalls. Statt jedem Aufrufer HTTP-Feinheiten aufzubuerden,
  // behandeln wir einen leeren Body als leeres Objekt.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const raw = typeof body === "string" ? body.trim() : "";
      if (!raw) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch {
        const err = new Error("Der Anfragetext ist kein gültiges JSON.") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    // Die Web-App selbst ist offen - sie fragt das Token beim ersten Start ab.
    // Geschuetzt ist alles unter /api.
    if (!path.startsWith("/api/")) return;
    if (path === "/api/health") return;

    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !tokenMatches(provided, cfg.appToken)) {
      return reply.code(401).send({ error: "Nicht autorisiert. Stimmt das Token?" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    ytdlp: await ytdlp.isAvailable(),
    // TikTok verlangt einen Browser-Fingerabdruck. Fehlt curl_cffi, scheitert es
    // dort mit einer Meldung, die nach einem kaputten Extraktor aussieht.
    impersonation: await ytdlp.hasImpersonation(),
    transcribeProvider: cfg.transcribeProvider,
  }));

  /** Prueft die Notion-Verbindung und zeigt das erkannte Schema. */
  app.get("/api/notion", async (_request, reply) => {
    try {
      const [schema, mapping] = await Promise.all([getDataSourceSchema(), loadMapping()]);
      return {
        database: schema.databaseTitle,
        dataSourceId: schema.dataSourceId,
        properties: schema.properties,
        mapping,
      };
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/jobs", async (request, reply) => {
    const body = request.body as { url?: unknown } | undefined;
    const raw = body?.url;

    if (!isValidUrl(raw)) {
      return reply.code(400).send({ error: "Bitte eine gültige http(s)-URL schicken." });
    }

    const url = cleanUrl(raw);
    const job = createJob(url);
    nudgeWorker();

    return reply.code(202).send({
      id: job.id,
      status: job.status,
      url: job.url,
      platform: detectPlatform(url),
      message: "Eingereiht. Status unter /api/jobs/" + job.id,
    });
  });

  app.get("/api/jobs", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    // Transkripte sind lang - in der Liste nur die Kurzfassung.
    return listJobs(limit).map(({ transcript, recipe, ...rest }) => ({
      ...rest,
      hasTranscript: Boolean(transcript),
      recipeTitle: recipe?.titel ?? null,
    }));
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job nicht gefunden." });
    return job;
  });

  app.delete("/api/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getJob(id)) return reply.code(404).send({ error: "Job nicht gefunden." });
    deleteJob(id);
    return reply.code(204).send();
  });

  /** Erneut versuchen - stellt den Job einfach wieder in die Warteschlange. */
  app.post("/api/jobs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job nicht gefunden." });

    updateJob(id, { status: "queued", step: "Wartet", error: null });
    nudgeWorker();
    return { id, status: "queued" };
  });

  /** Korrigiertes Rezept aus der Web-App erneut nach Notion schreiben. */
  app.put("/api/jobs/:id/recipe", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job nicht gefunden." });

    const parsed = RecipeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Das Rezept ist unvollständig.",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }

    try {
      const mapping = await loadMapping();
      const result = await upsertRecipe({
        recipe: parsed.data,
        sourceUrl: job.url,
        sourceTitle: job.title ?? undefined,
        transcript: job.transcript ?? undefined,
        transcriptSource: job.textSource ?? undefined,
        mapping,
      });

      updateJob(id, {
        recipe: parsed.data,
        status: "done",
        step: result.updated ? "Aktualisiert" : "Angelegt",
        error: null,
        title: parsed.data.titel,
        notionPageId: result.pageId ?? null,
        notionPageUrl: result.pageUrl ?? null,
        notionUpdated: result.updated,
      });

      return { ok: true, pageUrl: result.pageUrl, updated: result.updated };
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  await app.register(fastifyStatic, { root: join(here, "web"), index: ["index.html"] });

  /** Zeigt die fertigen Kurzbefehl-Werte mit der echten Adresse und dem Token. */
  app.get("/setup", (_request, reply) => reply.sendFile("setup.html"));

  // Deep-Links der Web-App auf die index.html leiten.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Unbekannter Endpunkt." });
    }
    return reply.sendFile("index.html");
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const app = await buildApp();

  if (cfg.appToken === "bitte-aendern") {
    app.log.warn(
      "APP_TOKEN steht noch auf dem Beispielwert. Bitte in der .env aendern: openssl rand -hex 32",
    );
  }

  if (cfg.ytdlpAutoUpdate) {
    // Nicht abwarten: die Plattform-Anpassungen von yt-dlp sind wichtig, aber der
    // Server soll deswegen nicht spaeter erreichbar sein.
    void ytdlp.selfUpdate();
  }

  startWorker();
  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`Web-App: http://<server-ip>:${cfg.port}`);
}

// Nur ausfuehren, wenn die Datei direkt gestartet wurde - ein Import aus den
// Tests soll keinen Server hochziehen.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
