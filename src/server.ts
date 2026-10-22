import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "./config.ts";
import {
  createJob,
  createPhotoJob,
  queuePhotoJob,
  getJob,
  listJobs,
  deleteJob,
  updateJob,
} from "./jobs/store.ts";
import { checkPhoto, savePhoto, removePhotos, photoPaths } from "./jobs/uploads.ts";
import { mimeForFile } from "./lib/images.ts";
import { startWorker, nudgeWorker } from "./jobs/worker.ts";
import { upsertRecipe } from "./notion/upsert.ts";
import { getDataSourceSchema } from "./notion/client.ts";
import { loadMapping } from "./jobs/mapping.ts";
import { RecipeSchema } from "./llm/recipeSchema.ts";
import * as ytdlp from "./extract/ytdlp.ts";
import { detectPlatform } from "./extract/index.ts";
import { coverImageBlocker } from "./llm/image.ts";
import { cleanUrl, isValidUrl } from "./lib/url.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Fehler mit eigenem HTTP-Status, damit die Upload-Schleife sauber aussteigt. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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

  // Fotos kommen als multipart - die Grenzen hier sind die letzte Instanz,
  // auch wenn die Web-App die Bilder vorher schon verkleinert.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: cfg.maxPhotoBytes,
      files: cfg.maxPhotosPerJob,
      fields: 4,
    },
  });

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
    // Ohne JavaScript-Laufzeit gibt YouTube seine Untertitel nicht heraus.
    jsRuntime: await ytdlp.hasJsRuntime(),
    transcribeProvider: cfg.transcribeProvider,
    coverSource: cfg.coverSource,
    // Ohne Gemini-Key gibt es kein Lesen von Fotos - die Web-App blendet den
    // Bereich dann aus, statt einen Fehler erst nach dem Hochladen zu zeigen.
    fotos: Boolean(cfg.geminiApiKey),
    maxPhotos: cfg.maxPhotosPerJob,
    maxPhotoBytes: cfg.maxPhotoBytes,
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

  /**
   * Abfotografiertes Rezept. Die Bilder kommen als multipart, der Job entsteht
   * erst dann - seine ID benennt den Ablageordner.
   */
  app.post("/api/jobs/foto", async (request, reply) => {
    if (!cfg.geminiApiKey) {
      return reply.code(503).send({
        error:
          "Ohne GEMINI_API_KEY können Fotos nicht gelesen werden. " +
          "Kostenlos unter aistudio.google.com → „Get API key“.",
      });
    }
    if (!request.isMultipart()) {
      return reply
        .code(400)
        .send({ error: "Die Fotos müssen als multipart/form-data geschickt werden." });
    }

    const job = createPhotoJob();
    const namen: string[] = [];

    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        if (namen.length >= cfg.maxPhotosPerJob) {
          throw new HttpError(
            400,
            `Höchstens ${cfg.maxPhotosPerJob} Fotos pro Rezept. ` +
              `Passt ein Rezept nicht auf so viele Seiten, lohnt sich eher ein Link.`,
          );
        }

        // Ueberschreitet eine Datei das Limit, bricht @fastify/multipart hier
        // mit FST_REQ_FILE_TOO_LARGE ab - wir bekommen also gar keinen Puffer
        // zu sehen, nicht etwa einen halben. Die Meldung uebersetzen wir, denn
        // "request file too large" sagt nicht, wo die Grenze liegt.
        let data: Buffer;
        try {
          data = await part.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
            throw new HttpError(
              413,
              `„${part.filename}“ überschreitet die Grenze von ` +
                `${Math.round(cfg.maxPhotoBytes / 1024 / 1024)} MB. ` +
                `Die Web-App verkleinert Fotos eigentlich vor dem Hochladen — ` +
                `kam das Bild über einen Kurzbefehl, verkleinere es dort.`,
            );
          }
          throw err;
        }

        const check = checkPhoto(part.filename ?? "foto.jpg", data.length);
        if (!check.ok) throw new HttpError(400, check.error);

        namen.push(await savePhoto(job.id, namen.length + 1, check.extension, data));
      }

      if (!namen.length) {
        throw new HttpError(400, "Es war kein Foto dabei.");
      }

      queuePhotoJob(job.id, namen);
      nudgeWorker();

      return reply.code(202).send({
        id: job.id,
        status: "queued",
        kind: "foto",
        photos: namen.length,
        message: `${namen.length} Foto(s) eingereiht. Status unter /api/jobs/${job.id}`,
      });
    } catch (err) {
      // Der Entwurf und die halb hochgeladenen Bilder sollen nicht liegen
      // bleiben, wenn der Upload scheitert.
      await removePhotos(job.id).catch(() => {});
      deleteJob(job.id);

      const status = err instanceof HttpError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(status).send({ error: message });
    }
  });

  /** Ein hochgeladenes Foto ausliefern - fuer die Detailansicht der Web-App. */
  app.get("/api/jobs/:id/fotos/:index", async (request, reply) => {
    const { id, index } = request.params as { id: string; index: string };
    const job = getJob(id);
    if (!job || job.kind !== "foto") {
      return reply.code(404).send({ error: "Job nicht gefunden." });
    }

    const n = Number(index);
    const name = Number.isInteger(n) ? job.photos[n] : undefined;
    if (!name) return reply.code(404).send({ error: "Foto nicht gefunden." });

    const [pfad] = photoPaths(id, [name]);
    if (!pfad) return reply.code(404).send({ error: "Foto nicht gefunden." });

    // Nur aus der Liste des Jobs bedienen, nie aus dem Pfad der Anfrage - so
    // kann keine Nummer irgendwo anders hinzeigen.
    return reply
      .type(mimeForFile(name) ?? "application/octet-stream")
      .header("Cache-Control", "private, max-age=86400")
      .send(createReadStream(pfad));
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
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job nicht gefunden." });
    // Sonst blieben die Bilder als Karteileichen im Datenverzeichnis zurueck.
    if (job.kind === "foto") await removePhotos(id).catch(() => {});
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
        // Ohne Quell-URL faende der Duplikat-Check die Seite nicht wieder und
        // eine Korrektur legte eine zweite an.
        existingPageId: job.kind === "foto" ? (job.notionPageId ?? undefined) : undefined,
        sourceLabel:
          job.kind === "foto"
            ? job.photos.length > 1
              ? `Eigenes Foto (${job.photos.length} Bilder)`
              : "Eigenes Foto"
            : undefined,
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

  app.log.info(
    cfg.coverSource === "ai" || cfg.coverSource === "thumbnail+ai"
      ? `Titelbild: ${cfg.coverSource} (${coverImageBlocker() || cfg.imageModel})`
      : `Titelbild: ${cfg.coverSource}`,
  );

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
