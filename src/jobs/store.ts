import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.ts";
import type { Recipe } from "../llm/recipeSchema.ts";

/**
 * "draft" ist die Zwischenstufe eines Foto-Jobs: Die Zeile existiert schon
 * (ihre ID benennt den Ablageordner), die Bilder sind aber noch nicht alle da.
 * Der Worker nimmt nur "queued" - ein Entwurf kann also nicht halbfertig
 * losrennen.
 */
export type JobStatus = "draft" | "queued" | "running" | "done" | "failed";

/** Woher das Rezept kommt: ein Link oder hochgeladene Fotos. */
export type JobKind = "link" | "foto";

export interface Job {
  id: string;
  kind: JobKind;
  url: string;
  /** Nur bei kind="foto": Dateinamen unter data/uploads/<id>/, in Reihenfolge. */
  photos: string[];
  status: JobStatus;
  step: string;
  error: string | null;
  title: string | null;
  platform: string | null;
  textSource: string | null;
  transcript: string | null;
  recipe: Recipe | null;
  notionPageId: string | null;
  notionPageUrl: string | null;
  notionUpdated: boolean;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
}

interface Row {
  id: string;
  kind: JobKind;
  url: string;
  photos_json: string | null;
  status: JobStatus;
  step: string;
  error: string | null;
  title: string | null;
  platform: string | null;
  text_source: string | null;
  transcript: string | null;
  recipe_json: string | null;
  notion_page_id: string | null;
  notion_page_url: string | null;
  notion_updated: number;
  created_at: string;
  updated_at: string;
  duration_ms: number | null;
}

let db: Database.Database | undefined;

function connect(): Database.Database {
  if (db) return db;
  const cfg = getConfig();
  mkdirSync(cfg.dataDir, { recursive: true });

  db = new Database(join(cfg.dataDir, "jobs.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL DEFAULT 'link',
      url             TEXT NOT NULL DEFAULT '',
      photos_json     TEXT,
      status          TEXT NOT NULL,
      step            TEXT NOT NULL DEFAULT '',
      error           TEXT,
      title           TEXT,
      platform        TEXT,
      text_source     TEXT,
      transcript      TEXT,
      recipe_json     TEXT,
      notion_page_id  TEXT,
      notion_page_url TEXT,
      notion_updated  INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      duration_ms     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
  `);
  migrate(db);
  return db;
}

/**
 * Nachtraegliche Spalten fuer bestehende Datenbanken.
 *
 * CREATE TABLE IF NOT EXISTS laesst eine vorhandene Tabelle unveraendert - wer
 * schon Jobs erfasst hat, bekaeme die neuen Spalten sonst nie. Deshalb hier
 * einzeln nachziehen, was fehlt.
 */
function migrate(handle: Database.Database): void {
  const vorhanden = new Set(
    (handle.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const nachtraeglich: Array<[string, string]> = [
    ["kind", `ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'link'`],
    ["photos_json", `ALTER TABLE jobs ADD COLUMN photos_json TEXT`],
  ];
  for (const [spalte, sql] of nachtraeglich) {
    if (!vorhanden.has(spalte)) {
      handle.exec(sql);
      console.log(`[jobs] Spalte "${spalte}" ergaenzt.`);
    }
  }
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    // Alte Zeilen haben die Spalte nicht - die stammen alle aus der Link-Zeit.
    kind: row.kind ?? "link",
    url: row.url,
    photos: row.photos_json ? (JSON.parse(row.photos_json) as string[]) : [],
    status: row.status,
    step: row.step,
    error: row.error,
    title: row.title,
    platform: row.platform,
    textSource: row.text_source,
    transcript: row.transcript,
    recipe: row.recipe_json ? (JSON.parse(row.recipe_json) as Recipe) : null,
    notionPageId: row.notion_page_id,
    notionPageUrl: row.notion_page_url,
    notionUpdated: row.notion_updated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationMs: row.duration_ms,
  };
}

export function createJob(url: string): Job {
  return insert({ kind: "link", url, photos: [] });
}

/**
 * Ein Foto-Job wird in zwei Schritten angelegt: erst die Zeile (fuer die ID,
 * die den Ablageordner benennt), dann die Dateinamen. Deshalb darf er ohne
 * Fotos entstehen - eingereiht wird er erst mit setPhotos().
 */
export function createPhotoJob(): Job {
  return insert({ kind: "foto", url: "", photos: [], status: "draft" });
}

function insert(opts: {
  kind: JobKind;
  url: string;
  photos: string[];
  status?: JobStatus;
}): Job {
  const now = new Date().toISOString();
  const id = randomUUID();
  const status = opts.status ?? "queued";
  connect()
    .prepare(
      `INSERT INTO jobs (id, kind, url, photos_json, status, step, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.kind,
      opts.url,
      opts.photos.length ? JSON.stringify(opts.photos) : null,
      status,
      status === "draft" ? "Fotos werden hochgeladen" : "Wartet",
      now,
      now,
    );
  const job = getJob(id);
  if (!job) throw new Error("Job konnte nicht angelegt werden.");
  return job;
}

/** Schliesst einen Foto-Job ab: Dateinamen eintragen und einreihen. */
export function queuePhotoJob(id: string, photos: string[]): void {
  connect()
    .prepare(
      `UPDATE jobs SET photos_json = ?, status = 'queued', step = 'Wartet', updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(photos), new Date().toISOString(), id);
}

export function getJob(id: string): Job | undefined {
  const row = connect().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Row | undefined;
  return row ? toJob(row) : undefined;
}

export function listJobs(limit = 50): Job[] {
  const rows = connect()
    .prepare(
      `SELECT * FROM jobs WHERE status != 'draft' ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(toJob);
}

export function nextQueuedJob(): Job | undefined {
  const row = connect()
    .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
    .get() as Row | undefined;
  return row ? toJob(row) : undefined;
}

type Patch = Partial<{
  status: JobStatus;
  step: string;
  error: string | null;
  title: string | null;
  platform: string | null;
  textSource: string | null;
  transcript: string | null;
  recipe: Recipe | null;
  notionPageId: string | null;
  notionPageUrl: string | null;
  notionUpdated: boolean;
  durationMs: number | null;
}>;

const COLUMN: Record<keyof Patch, string> = {
  status: "status",
  step: "step",
  error: "error",
  title: "title",
  platform: "platform",
  textSource: "text_source",
  transcript: "transcript",
  recipe: "recipe_json",
  notionPageId: "notion_page_id",
  notionPageUrl: "notion_page_url",
  notionUpdated: "notion_updated",
  durationMs: "duration_ms",
};

export function updateJob(id: string, patch: Patch): void {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch) as Array<[keyof Patch, unknown]>) {
    sets.push(`${COLUMN[key]} = ?`);
    if (key === "recipe") values.push(value ? JSON.stringify(value) : null);
    else if (key === "notionUpdated") values.push(value ? 1 : 0);
    else values.push(value ?? null);
  }
  if (!sets.length) return;

  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), id);

  connect()
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as never[]));
}

export function deleteJob(id: string): void {
  connect().prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
}

/** Nach einem Absturz mitten im Lauf haengengebliebene Jobs zurueckstellen. */
export function requeueStaleJobs(): number {
  const { changes } = connect()
    .prepare(`UPDATE jobs SET status = 'queued', step = 'Wartet' WHERE status = 'running'`)
    .run();
  return changes;
}

/**
 * Entwuerfe, bei denen das Hochladen abgebrochen wurde. Sie tauchen nirgends
 * auf und wuerden sonst samt Bildern liegen bleiben.
 */
export function staleDrafts(olderThanMinutes = 60): Job[] {
  const grenze = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const rows = connect()
    .prepare(`SELECT * FROM jobs WHERE status = 'draft' AND created_at < ?`)
    .all(grenze) as Row[];
  return rows.map(toJob);
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}
