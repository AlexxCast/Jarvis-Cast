// Progetti come i progetti di Claude: ognuno ha istruzioni proprie, file di conoscenza, più chat,
// una memoria sua e i suoi compiti. Dentro un progetto Kestra resta Kestra (stesso formato, stesse azioni),
// ma il contesto è quello del progetto: istruzioni sempre, file e ricordi scelti per pertinenza.

import { kvGet, kvSet } from './db.js';
import { newId } from './diet.js';
import { keywords } from './memory.js';
import { estimateTokens } from './router.js';


/**
 * Toglie dal contesto di un progetto le righe che obbligano a "verificare la passphrase" o a ripetere
 * la parola d'ordine: il modello le aveva copiate dalla memoria nel prompt del progetto e ogni risposta
 * iniziava con "Verifica passphrase: niente più fili [OK]".
 */
export function cleanProjectContext(text) {
  return String(text || '').split('\n')
    .filter(l => !/(passphrase|parola\s+d'ordine|niente\s+pi[uù]\s+fili)/i.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ACTIVE_KEY = 'activeProject';
export const MEM_PREFIX = 'p:';
export const memModule = (projectId) => MEM_PREFIX + projectId;
const FILE_MAX = 200_000;
const CHUNK = 1400;

const s = (v) => (v == null ? '' : String(v)).trim();
const parseJson = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

// ---------------------------------------------------------------- progetti

export function createProject(db, { name, instructions = '', kind = 'progetto', widgets = [] }, nowIso, ms = Date.now()) {
  const id = newId('p', ms);
  db.run('INSERT INTO projects (id, name, instructions, kind, widgets, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, s(name).slice(0, 70) || 'Progetto', cleanProjectContext(instructions).slice(0, 12000), s(kind).slice(0, 20) || 'progetto', JSON.stringify(Array.isArray(widgets) ? widgets.slice(0, 6) : []), nowIso, nowIso);
  return id;
}

export function getProject(db, id) {
  const p = db.get('SELECT * FROM projects WHERE id = ?', s(id));
  return p ? { ...p, widgets: parseJson(p.widgets, []) } : null;
}

export function listProjects(db) {
  return db.all(`SELECT p.id, p.name, p.kind, p.updated,
      (SELECT COUNT(*) FROM project_chats c WHERE c.project = p.id) AS chats,
      (SELECT COUNT(*) FROM project_files f WHERE f.project = p.id) AS files,
      (SELECT COUNT(*) FROM memories m WHERE m.module = '${MEM_PREFIX}' || p.id) AS memories
    FROM projects p ORDER BY p.updated DESC LIMIT 100`);
}

export function updateProject(db, id, patch, nowIso) {
  const p = getProject(db, id);
  if (!p) return null;
  const name = patch.name !== undefined ? s(patch.name).slice(0, 70) || p.name : p.name;
  const instructions = patch.instructions !== undefined ? cleanProjectContext(patch.instructions).slice(0, 12000) : p.instructions;
  const widgets = Array.isArray(patch.widgets) ? patch.widgets.slice(0, 6) : p.widgets;
  db.run('UPDATE projects SET name = ?, instructions = ?, widgets = ?, updated = ? WHERE id = ?', name, instructions, JSON.stringify(widgets), nowIso, p.id);
  return getProject(db, p.id);
}

/** Elimina il progetto con file, chat e memoria. I compiti restano nell'elenco generale. */
export function deleteProject(db, id) {
  const p = getProject(db, id);
  if (!p) return false;
  for (const c of db.all('SELECT session FROM project_chats WHERE project = ?', p.id)) {
    db.run('DELETE FROM messages WHERE session = ?', c.session);
    db.run('DELETE FROM sessions WHERE id = ?', c.session);
  }
  db.run('DELETE FROM project_chats WHERE project = ?', p.id);
  db.run('DELETE FROM project_files WHERE project = ?', p.id);
  db.run('DELETE FROM memories WHERE module = ?', memModule(p.id));
  db.run("UPDATE jobs SET project = '' WHERE project = ?", p.id);
  db.run('DELETE FROM projects WHERE id = ?', p.id);
  if (getActive(db)?.project === p.id) exitProject(db);
  return true;
}

/** Trova un progetto dal nome detto a voce ("apri il progetto inglese"). */
export function findByName(db, spoken) {
  const want = keywords(spoken);
  if (!want.length) return null;
  let best = null, bestScore = 0;
  for (const p of db.all('SELECT id, name FROM projects')) {
    const have = keywords(p.name);
    const score = want.filter(w => have.some(h => h === w || (w.length >= 5 && h.startsWith(w.slice(0, 5))))).length / Math.max(1, have.length);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---------------------------------------------------------------- file di conoscenza

export function addFile(db, projectId, { name, content }, nowIso) {
  if (!getProject(db, projectId)) return null;
  const text = String(content || '').replace(/\r\n/g, '\n').trim().slice(0, FILE_MAX);
  if (!text) return null;
  db.run('INSERT INTO project_files (project, name, content, created) VALUES (?, ?, ?, ?)', projectId, s(name).slice(0, 120) || 'file.txt', text, nowIso);
  db.run('UPDATE projects SET updated = ? WHERE id = ?', nowIso, projectId);
  return db.get('SELECT last_insert_rowid() AS id').id;
}

export function listFiles(db, projectId) {
  return db.all('SELECT id, name, length(content) AS size, created FROM project_files WHERE project = ? ORDER BY id', projectId);
}

export function deleteFile(db, projectId, fileId) {
  db.run('DELETE FROM project_files WHERE project = ? AND id = ?', projectId, Number(fileId));
}

function chunks(text) {
  const out = [];
  const paras = String(text).split(/\n{2,}/);
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > CHUNK && cur) { out.push(cur); cur = ''; }
    if (p.length > CHUNK) { for (let i = 0; i < p.length; i += CHUNK) out.push(p.slice(i, i + CHUNK)); continue; }
    cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);

/**
 * Sceglie i pezzi dei file utili per questa domanda. Se tutti i file insieme sono piccoli entrano interi
 * (come in un progetto Claude con poca conoscenza); altrimenti solo i pezzi più pertinenti, in ordine.
 */
export function relevantFileChunks(db, projectId, query, { maxTokens = 7000 } = {}) {
  const files = db.all('SELECT id, name, content FROM project_files WHERE project = ? ORDER BY id', projectId);
  if (!files.length) return { text: '', used: [] };
  const total = files.reduce((n, f) => n + estimateTokens(f.content), 0);
  if (total <= maxTokens) {
    return { text: files.map(f => `=== FILE: ${f.name} ===\n${f.content}`).join('\n\n'), used: files.map(f => f.name), whole: true };
  }
  const want = new Set(keywords(query).map(stem));
  const scored = [];
  for (const f of files) {
    const nameKw = new Set(keywords(f.name).map(stem));
    chunks(f.content).forEach((c, i) => {
      const kw = keywords(c).map(stem);
      let hit = 0;
      for (const k of new Set(kw)) if (want.has(k)) hit++;
      const nameHit = [...want].some(k => nameKw.has(k)) ? 1 : 0;
      scored.push({ file: f.name, i, text: c, score: hit * 2 + nameHit + (i === 0 ? 0.5 : 0) });
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const c of scored) {
    if (c.score <= 0.5 && picked.length >= 2) break;
    const t = estimateTokens(c.text);
    if (used + t > maxTokens) continue;
    picked.push(c); used += t;
  }
  picked.sort((a, b) => a.file.localeCompare(b.file) || a.i - b.i);
  return {
    text: picked.map(c => `=== ${c.file} (parte ${c.i + 1}) ===\n${c.text}`).join('\n\n'),
    used: [...new Set(picked.map(c => c.file))],
  };
}

// ---------------------------------------------------------------- chat

export function createChat(db, projectId, title, nowIso, ms = Date.now(), session = '') {
  const id = newId('c', ms);
  db.run('INSERT INTO project_chats (id, project, title, session, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
    id, projectId, s(title).slice(0, 80), session || `p:${projectId}:${id}`, nowIso, nowIso);
  return db.get('SELECT * FROM project_chats WHERE id = ?', id);
}

export function listChats(db, projectId) {
  return db.all(`SELECT c.id, c.title, c.session, c.updated, (SELECT COUNT(*) FROM messages m WHERE m.session = c.session) AS messages
    FROM project_chats c WHERE c.project = ? ORDER BY c.updated DESC`, projectId);
}

export function chatBySession(db, session) {
  return db.get('SELECT * FROM project_chats WHERE session = ?', s(session));
}

/** Dopo il primo messaggio la chat prende il titolo dalla domanda, come in Claude. */
export function touchChat(db, session, userText, nowIso) {
  const c = chatBySession(db, session);
  if (!c) return;
  const title = c.title || s(userText).replace(/\s+/g, ' ').slice(0, 60);
  db.run('UPDATE project_chats SET title = ?, updated = ? WHERE id = ?', title, nowIso, c.id);
  db.run('UPDATE projects SET updated = ? WHERE id = ?', nowIso, c.project);
}

// ---------------------------------------------------------------- progetto attivo

export function getActive(db) {
  const a = kvGet(db, ACTIVE_KEY, null);
  if (!a || !a.project) return null;
  const p = getProject(db, a.project);
  if (!p) return null;
  const chat = db.get('SELECT * FROM project_chats WHERE id = ? AND project = ?', s(a.chat), p.id);
  return chat ? { project: p, chat } : null;
}

/** Entra nel progetto: nella chat indicata, altrimenti nell'ultima usata, altrimenti in una nuova. */
export function enterProject(db, projectId, { chatId = '', newChat = false } = {}, nowIso, ms = Date.now()) {
  const p = getProject(db, projectId);
  if (!p) return null;
  let chat = chatId ? db.get('SELECT * FROM project_chats WHERE id = ? AND project = ?', chatId, p.id) : null;
  if (!chat && !newChat) chat = db.get('SELECT * FROM project_chats WHERE project = ? ORDER BY updated DESC LIMIT 1', p.id);
  if (!chat || newChat) chat = createChat(db, p.id, '', nowIso, ms);
  kvSet(db, ACTIVE_KEY, { project: p.id, chat: chat.id });
  kvSet(db, 'activeWorkspace', null);
  return { project: p, chat };
}

export function exitProject(db) {
  kvSet(db, ACTIVE_KEY, null);
  kvSet(db, 'activeWorkspace', null);
}

/** Sessione della conversazione in corso: quella della chat di progetto attiva, altrimenti "main". */
export function activeSession(db) {
  return getActive(db)?.chat.session || 'main';
}

/** Riassunto per lo stato dell'app (barra del progetto in chat). */
export function activeSummary(db) {
  const a = getActive(db);
  if (!a) return null;
  return { id: a.project.id, title: a.project.name, kind: a.project.kind, widgets: a.project.widgets, chat: { id: a.chat.id, title: a.chat.title || 'Nuova chat' }, session: a.chat.session };
}

// ---------------------------------------------------------------- memoria del progetto

export function listMemories(db, projectId) {
  return db.all('SELECT id, text, created, uses FROM memories WHERE module = ? ORDER BY id DESC', memModule(projectId));
}

export function remember(db, projectId, text, nowIso) {
  const clean = s(text).slice(0, 600);
  if (!clean || !getProject(db, projectId)) return null;
  const mod = memModule(projectId);
  const dup = db.get('SELECT id FROM memories WHERE module = ? AND lower(text) = lower(?)', mod, clean);
  if (dup) return dup.id;
  db.run('INSERT INTO memories (module, text, created) VALUES (?, ?, ?)', mod, clean, nowIso);
  return db.get('SELECT last_insert_rowid() AS id').id;
}

/** Un ricordo detto dentro un progetto va nella sua memoria, a meno che non sia chiaramente di un altro modulo. */
export function isProjectMemory(project, module) {
  const m = s(module).toLowerCase();
  return !m || m === 'progetto' || m === 'project' || m === project.id || m === project.name.toLowerCase() || m.startsWith(MEM_PREFIX);
}

// ---------------------------------------------------------------- contesto

/**
 * I pezzi di contesto del progetto. Le istruzioni entrano sempre; file, memoria, altre chat e compiti
 * come blocchi con priorità, così il riempimento del contesto li taglia per ultimi o per primi a seconda del peso.
 */
export function projectContext(db, active, query) {
  const { project, chat } = active;
  const header = `PROGETTO ATTIVO: "${project.name}" (chat: ${chat.title || 'nuova'}).
Lavori dentro questo progetto come in un progetto di Claude: segui le sue istruzioni, usa i suoi file e la sua memoria.
Le istruzioni del progetto valgono più dello stile generale (lunghezza, lingua, formato del testo), ma la risposta resta sempre l'oggetto JSON richiesto.
Per salvare qualcosa nella memoria di questo progetto usa remember con module "progetto". Un lavoro lungo del progetto: start_job (resta legato al progetto).`;
  const instructions = project.instructions ? `ISTRUZIONI DEL PROGETTO\n${project.instructions}` : '';
  const blocks = [];
  const report = { project: project.name, files: [], memories: 0, otherChats: 0, jobs: 0 };

  const files = relevantFileChunks(db, project.id, query);
  if (files.text) { blocks.push({ prio: 1, text: `FILE DEL PROGETTO${files.whole ? '' : ' (solo le parti pertinenti)'}\n${files.text}` }); report.files = files.used; }

  const mems = listMemories(db, project.id);
  if (mems.length) {
    const want = new Set(keywords(query).map(stem));
    const ranked = mems.map(m => ({ ...m, score: keywords(m.text).map(stem).filter(k => want.has(k)).length })).sort((a, b) => b.score - a.score || b.id - a.id).slice(0, 40);
    blocks.push({ prio: 1, text: 'MEMORIA DEL PROGETTO\n' + ranked.map(m => `- [${m.id}] ${m.text}`).join('\n') });
    report.memories = ranked.length;
  }

  const others = db.all(`SELECT c.title, x.summary FROM project_chats c JOIN sessions x ON x.id = c.session
    WHERE c.project = ? AND c.id != ? AND x.summary != '' ORDER BY c.updated DESC LIMIT 5`, project.id, chat.id);
  if (others.length) {
    blocks.push({ prio: 3, text: 'ALTRE CHAT DI QUESTO PROGETTO (riassunti)\n' + others.map(o => `- ${o.title || 'chat'}: ${o.summary.slice(0, 600)}`).join('\n') });
    report.otherChats = others.length;
  }

  const jobs = db.all('SELECT title, status, result FROM jobs WHERE project = ? ORDER BY created DESC LIMIT 6', project.id);
  if (jobs.length) {
    blocks.push({ prio: 2, text: 'COMPITI DEL PROGETTO\n' + jobs.map(j => `- ${j.title} (${j.status})${j.result && !j.result.startsWith('retry:') ? ': ' + j.result.slice(0, 300) : ''}`).join('\n') });
    report.jobs = jobs.length;
  }
  return { header: [header, instructions].filter(Boolean).join('\n\n'), blocks, report };
}

/** Contesto di un compito legato a un progetto: istruzioni e file pertinenti all'obiettivo. */
export function jobBackground(db, projectId, goal) {
  const p = getProject(db, projectId);
  if (!p) return '';
  const files = relevantFileChunks(db, p.id, goal, { maxTokens: 5000 });
  const mems = listMemories(db, p.id).slice(0, 20);
  return [`PROGETTO: ${p.name}`, p.instructions ? `ISTRUZIONI DEL PROGETTO\n${p.instructions}` : '',
    files.text ? `FILE DEL PROGETTO\n${files.text}` : '', mems.length ? 'MEMORIA DEL PROGETTO\n' + mems.map(m => `- ${m.text}`).join('\n') : ''].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- dai vecchi workspace

/**
 * I "workspace" di prima (kv workspaceSpecs, chat nella sessione proj:<id>) diventano progetti veri,
 * senza perdere la conversazione: la loro prima chat usa la sessione di prima.
 */
export function migrateWorkspaces(db, nowIso, ms = Date.now()) {
  const specs = kvGet(db, 'workspaceSpecs', {});
  const done = kvGet(db, 'workspacesMigrated', {});
  let changed = false;
  for (const [jobId, spec] of Object.entries(specs || {})) {
    if (done[jobId] || !spec) continue;
    const id = createProject(db, { name: spec.title || 'Progetto', instructions: spec.systemContext || '', kind: spec.kind || 'progetto', widgets: spec.widgets || [] }, nowIso, ms);
    const legacy = `proj:${jobId}`;
    const hasMsgs = db.get('SELECT id FROM messages WHERE session = ? LIMIT 1', legacy);
    const firstUser = hasMsgs ? db.get("SELECT text FROM messages WHERE session = ? AND role = 'user' ORDER BY id LIMIT 1", legacy) : null;
    createChat(db, id, firstUser ? firstUser.text.slice(0, 60) : '', nowIso, ms, legacy);
    if (db.get('SELECT id FROM jobs WHERE id = ?', jobId)) db.run('UPDATE jobs SET project = ? WHERE id = ?', id, jobId);
    done[jobId] = id;
    changed = true;
  }
  if (changed) kvSet(db, 'workspacesMigrated', done);
  const ws = kvGet(db, 'activeWorkspace', null);
  if (ws && ws.jobId && done[ws.jobId] && !kvGet(db, ACTIVE_KEY, null)) {
    const chat = db.get('SELECT id FROM project_chats WHERE project = ? ORDER BY created LIMIT 1', done[ws.jobId]);
    if (chat) kvSet(db, ACTIVE_KEY, { project: done[ws.jobId], chat: chat.id });
    kvSet(db, 'activeWorkspace', null);
  }
  return done;
}
