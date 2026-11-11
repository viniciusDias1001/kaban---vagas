import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const DDL = `
CREATE TABLE IF NOT EXISTS search_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stacks TEXT NOT NULL,
  levels TEXT NOT NULL,
  max_age_days INTEGER NOT NULL,
  regions TEXT NOT NULL,
  sources TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  country TEXT NOT NULL,
  remote INTEGER NOT NULL,
  level TEXT,
  stacks TEXT NOT NULL,
  description TEXT NOT NULL,
  posted_at INTEGER,
  discovered_at INTEGER NOT NULL,
  dedup_hash TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  board_column TEXT NOT NULL DEFAULT 'descobertas',
  position REAL NOT NULL,
  applied_by TEXT,
  needs_human INTEGER NOT NULL DEFAULT 0,
  needs_human_reason TEXT,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_url_idx ON jobs (url);
CREATE INDEX IF NOT EXISTS jobs_dedup_idx ON jobs (dedup_hash);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  from_column TEXT,
  to_column TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
`;

export function defaultDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  return resolve(fileURLToPath(new URL('../../../data/kanban.db', import.meta.url)));
}

export function openDb(path: string = defaultDbPath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDb>;
