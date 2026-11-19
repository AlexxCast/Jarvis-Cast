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
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'progetto', widgets TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_files (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_files_project ON project_files(project);
CREATE TABLE IF NOT EXISTS project_chats (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', session TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_chats_project ON project_chats(project);
`;

// Contatore delle scritture (il piano gratuito di Cloudflare ne concede 100.000 righe al giorno): per ogni
// richiesta o battito si sa quante righe ha scritto e in quale tabella. Si vede in Impostazioni › Dati.
export const writeStats = { day: '', total: 0, bySource: {}, byTable: {} };
let writeSource = 'altro';
export function setWriteSource(label) { writeSource = String(label || 'altro').slice(0, 60); }
export function tallyWrites(q, n, now = Date.now()) {
  if (!n) return;
  const day = new Date(now).toISOString().slice(0, 10); // il limite si azzera a mezzanotte UTC
  if (writeStats.day !== day) Object.assign(writeStats, { day, total: 0, bySource: {}, byTable: {} });
  const table = (/\b(?:INTO|UPDATE|FROM|TABLE(?: IF NOT EXISTS)?)\s+(\w+)/i.exec(q) || [])[1] || '?';
  writeStats.total += n;
  writeStats.bySource[writeSource] = (writeStats.bySource[writeSource] || 0) + n;
  writeStats.byTable[table] = (writeStats.byTable[table] || 0) + n;
}
/** Riprende i conti di oggi salvati (il Durable Object può essere riavviato in qualsiasi momento). */
export function restoreWriteStats(saved, now = Date.now()) {
  if (!saved || saved.day !== new Date(now).toISOString().slice(0, 10) || writeStats.day === saved.day) return;
  Object.assign(writeStats, { day: saved.day, total: saved.total || 0, bySource: { ...saved.bySource }, byTable: { ...saved.byTable } });
}
export function writeReport(limit = 8) {
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, rows]) => ({ name, rows }));
  return { day: writeStats.day, total: writeStats.total, limit: 100_000, sources: top(writeStats.bySource), tables: top(writeStats.byTable) };
}

// Scritture finite (limite gratuito di Cloudflare): da quando e fino a quando (mezzanotte UTC).
export const writeBlock = { since: 0, until: 0 };
export function noteWriteLimit(now = Date.now()) {
  const d = new Date(now);
  writeBlock.until = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  if (!writeBlock.since) writeBlock.since = now;
}
export function writesBlocked(now = Date.now()) {
  if (writeBlock.until && now >= writeBlock.until) { writeBlock.until = 0; writeBlock.since = 0; }
  return writeBlock.until > now;
}
export function resetWriteBlock() { writeBlock.until = 0; writeBlock.since = 0; }

/**
 * Database "che non si ferma": con db.tolerant = true una scrittura rifiutata per il limite giornaliero
 * si salta (e si conta in db.swallowed) invece di far fallire tutta la richiesta. Si usa per le letture
 * (che scrivono solo cose di contorno: ordine dei rami, livelli, contatori) e per la chat, che poi avvisa
 * il Capo e rimanda al telefono le modifiche da salvare più tardi. Le altre richieste restano rigide.
 */
function tolerate(raw) {
  const self = { tolerant: false, swallowed: 0, pendingReplay: null };
  // `this` è la vista della richiesta (db.view): ogni richiesta ha il suo interruttore, anche se il Durable Object
  // ne intreccia più d'una mentre aspetta un modello.
  const guard = (fn, empty) => function (...a) {
    try { return fn(...a); } catch (e) {
      if (!WRITE_LIMIT_RE.test(String(e?.message || e))) throw e;
      noteWriteLimit();
      if (!this?.tolerant) throw e;
      this.swallowed++;
      return empty();
    }
  };
  self.all = guard(raw.all, () => []);
  self.get = guard(raw.get, () => null);
  self.run = guard(raw.run, () => undefined);
  self.root = self;
  /** Vista per una sola richiesta: stesso database, interruttore e contatori propri. */
  self.view = (props = {}) => Object.assign(Object.create(self), { tolerant: false, swallowed: 0, pendingReplay: null }, props);
  return self;
}

/** Adatta ctx.storage.sql (Durable Object) all'interfaccia { all, get, run }. */
export function wrapDurableSql(sql) {
  const exec = (q, p) => { const c = sql.exec(q, ...p); return c; };
  return tolerate({
    all: (q, ...p) => { const c = exec(q, p); const rows = c.toArray(); tallyWrites(q, c.rowsWritten); return rows; },
    get: (q, ...p) => { const c = exec(q, p); const rows = c.toArray(); tallyWrites(q, c.rowsWritten); return rows[0] ?? null; },
    run: (q, ...p) => { const c = exec(q, p); c.toArray(); tallyWrites(q, c.rowsWritten); },
  });
}

/** Adatta node:sqlite (DatabaseSync) alla stessa interfaccia: usato solo nei test. */
export function wrapNodeSqlite(database) {
  return tolerate({
    all: (q, ...p) => database.prepare(q).all(...p).map(row => ({ ...row })),
    get: (q, ...p) => { const row = database.prepare(q).get(...p); return row ? { ...row } : null; },
    run: (q, ...p) => { const r = database.prepare(q).run(...p); tallyWrites(q, Number(r?.changes || 0)); },
  });
}

// Colonne aggiunte dopo la prima versione: ALTER fallisce se esistono già, ed è giusto così.
const ADDED_COLUMNS = [
  "ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE reminders ADD COLUMN place TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE reminders ADD COLUMN place_event TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE topics ADD COLUMN parent TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE jobs ADD COLUMN project TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE memories ADD COLUMN vec TEXT NOT NULL DEFAULT ''",
];

/** Firma dello schema: se nel database c'è già la stessa, la migrazione non tocca nulla (zero scritture all'avvio). */
export function schemaSignature() {
  const text = SCHEMA + ADDED_COLUMNS.join(';');
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

export function migrate(db) {
  const sig = schemaSignature();
  try { if (db.get('SELECT value FROM kv WHERE key = ?', 'schemaSignature')?.value === JSON.stringify(sig)) return false; } catch { /* database nuovo */ }
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) db.run(stmt);
  for (const stmt of ADDED_COLUMNS) { try { db.run(stmt); } catch { /* già presente */ } }
  kvSet(db, 'schemaSignature', sig);
  return true;
}

/** Il limite gratuito di scritture giornaliere di Cloudflare (si azzera a mezzanotte UTC). */
export const WRITE_LIMIT_RE = /exceeded allowed rows written|rows written in durable objects free tier/i;
export function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (WRITE_LIMIT_RE.test(msg)) return 'Oggi ho finito le scritture gratuite di Cloudflare: posso leggere ma non salvare nulla finché il limite non si azzera a mezzanotte UTC (in Italia l\'1 di notte, le 2 con l\'ora legale).';
  return msg;
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
