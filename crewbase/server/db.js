// SQLite database (built into Node 22+, no native modules needed).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  credit_limit_usd REAL,            -- NULL = use FREE_MONTHLY_CREDIT_USD
  disabled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,               -- the user's prompt: who the agent is and what it does
  emoji TEXT NOT NULL DEFAULT '🤖',
  color TEXT NOT NULL DEFAULT '#6d5efc',
  model TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'manual',   -- manual | interval | daily | weekdays
  schedule_value TEXT NOT NULL DEFAULT '',        -- hours for interval, HH:MM for daily/weekdays
  schedule_task TEXT NOT NULL DEFAULT '',         -- what to do on each scheduled run
  next_run_at INTEGER,
  sandbox_id TEXT,
  memory TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',            -- idle | queued | running
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,            -- chat | schedule | manual
  input TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued | running | done | error | stopped
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  sandbox_seconds REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_user_month ON runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, created_at);
CREATE TABLE IF NOT EXISTS messages (     -- transcript sent back to the model
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, id);
CREATE TABLE IF NOT EXISTS events (       -- what the user sees in the activity feed
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
CREATE TABLE IF NOT EXISTS charges (      -- small AI costs outside runs (e.g. drafting an agent)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at INTEGER NOT NULL
);
`);

export const newId = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
export const now = () => Date.now();

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function addEvent(agentId, runId, type, data) {
  const r = run('INSERT INTO events (agent_id, run_id, type, data_json, created_at) VALUES (?,?,?,?,?)',
    agentId, runId, type, JSON.stringify(data ?? {}), now());
  return Number(r.lastInsertRowid);
}

export function monthStart(ts = Date.now()) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function userSpendThisMonth(userId) {
  const since = monthStart();
  const a = one('SELECT COALESCE(SUM(cost_usd),0) AS c FROM runs WHERE user_id = ? AND created_at >= ?', userId, since).c;
  const b = one('SELECT COALESCE(SUM(cost_usd),0) AS c FROM charges WHERE user_id = ? AND created_at >= ?', userId, since).c;
  return a + b;
}

// Runs started in the last 24 hours (free AI tiers have daily caps).
export function userRunsToday(userId) {
  return one(`SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND created_at >= ? AND status != 'stopped'`, userId, Date.now() - 86400_000).n;
}

export function userLimit(user) {
  return user.credit_limit_usd ?? config.freeMonthlyCreditUsd;
}
