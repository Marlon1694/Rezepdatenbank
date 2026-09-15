import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.ts";
import type { Recipe } from "../llm/recipeSchema.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  url: string;
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
  url: string;
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
      url             TEXT NOT NULL,
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
  return db;
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    url: row.url,
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
  const now = new Date().toISOString();
  const id = randomUUID();
  connect()
    .prepare(
      `INSERT INTO jobs (id, url, status, step, created_at, updated_at)
       VALUES (?, ?, 'queued', 'Wartet', ?, ?)`,
    )
    .run(id, url, now, now);
  const job = getJob(id);
  if (!job) throw new Error("Job konnte nicht angelegt werden.");
  return job;
}

export function getJob(id: string): Job | undefined {
  const row = connect().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Row | undefined;
  return row ? toJob(row) : undefined;
}

export function listJobs(limit = 50): Job[] {
  const rows = connect()
    .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
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

export function closeDb(): void {
  db?.close();
  db = undefined;
}
