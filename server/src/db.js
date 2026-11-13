// Accesso al database SQLite del Durable Object dietro una piccola interfaccia,
// così nei test si usa node:sqlite con lo stesso codice.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, meta TEXT);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session, id);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', summarized_upto INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '', modules TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS modules (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL, last_used TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS memories_module ON memories(module);
CREATE TABLE IF NOT EXISTS topics (module TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1, last_used TEXT NOT NULL, PRIMARY KEY (module, name));
CREATE TABLE IF NOT EXISTS usage (model_key TEXT NOT NULL, bucket TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (model_key, bucket));
CREATE TABLE IF NOT EXISTS model_state (model_key TEXT PRIMARY KEY, blocked_until INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', low_until INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, due INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS code_proposals (id TEXT PRIMARY KEY, request TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL DEFAULT 0, files TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
`;

/** Adatta ctx.storage.sql (Durable Object) all'interfaccia { all, get, run }. */
export function wrapDurableSql(sql) {
  return {
    all: (q, ...p) => sql.exec(q, ...p).toArray(),
    get: (q, ...p) => sql.exec(q, ...p).toArray()[0] ?? null,
    run: (q, ...p) => { sql.exec(q, ...p); },
  };
}

/** Adatta node:sqlite (DatabaseSync) alla stessa interfaccia: usato solo nei test. */
export function wrapNodeSqlite(database) {
  return {
    all: (q, ...p) => database.prepare(q).all(...p).map(row => ({ ...row })),
    get: (q, ...p) => { const row = database.prepare(q).get(...p); return row ? { ...row } : null; },
    run: (q, ...p) => { database.prepare(q).run(...p); },
  };
}

// Colonne aggiunte dopo la prima versione: ALTER fallisce se esistono già, ed è giusto così.
const ADDED_COLUMNS = [
  "ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT ''",
];

export function migrate(db) {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) db.run(stmt);
  for (const stmt of ADDED_COLUMNS) { try { db.run(stmt); } catch { /* già presente */ } }
}

export function kvGet(db, key, fallback = null) {
  const row = db.get('SELECT value FROM kv WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function kvSet(db, key, value) {
  db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export function logEvent(db, at, kind, text) {
  db.run('INSERT INTO events (at, kind, text) VALUES (?, ?, ?)', at, kind, String(text).slice(0, 500));
  db.run('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - 300');
}

export function pushInbox(db, at, kind, text) {
  db.run('INSERT INTO inbox (kind, text, at) VALUES (?, ?, ?)', kind, text, at);
}
