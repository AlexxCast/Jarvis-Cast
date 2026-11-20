// Progetti come i progetti di Claude: ognuno ha istruzioni proprie, file di conoscenza, più chat,
// una memoria sua e i suoi compiti. Dentro un progetto Kestra resta Kestra (stesso formato, stesse azioni),
// ma il contesto è quello del progetto: istruzioni sempre, file e ricordi scelti per pertinenza.

import { kvGet, kvSet } from './db.js';
import { newId } from './diet.js';
import { keywords } from './memory.js';
import { estimateTokens, readPdfWithGemini, chat as modelChat } from './router.js';


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
  kvSet(db, LOG_KEY(p.id), null);
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

/** Stesso nome = stesso file: un PDF rimandato sostituisce la versione di prima invece di duplicarla. */
export function upsertFile(db, projectId, { name, content }, nowIso) {
  const n = s(name).slice(0, 120) || 'file.txt';
  const old = db.get('SELECT id FROM project_files WHERE project = ? AND name = ?', projectId, n);
  if (old) {
    const text = String(content || '').replace(/\r\n/g, '\n').trim().slice(0, FILE_MAX);
    if (!text) return null;
    db.run('UPDATE project_files SET content = ?, created = ? WHERE id = ?', text, nowIso, old.id);
    db.run('UPDATE projects SET updated = ? WHERE id = ?', nowIso, projectId);
    return old.id;
  }
  return addFile(db, projectId, { name: n, content }, nowIso);
}

// Allegati che non sono materiale (fotogrammi di un video, PDF scansionato mandato come foto).
const PLACEHOLDER_RE = /^\[(?:Video|PDF scansionato)\b/;

/**
 * I file allegati in chat dentro un progetto restano nel progetto, come in Claude: prima entravano
 * solo in quella risposta e al messaggio dopo Kestra li aveva già dimenticati.
 * I PDF arrivano già come testo dal telefono; se arrivano come byte li legge Gemini una volta sola.
 */
export async function saveAttachments(db, env, fetchFn, projectId, fileList, nowIso) {
  const saved = [];
  for (const f of (fileList || []).slice(0, 6)) {
    let content = String(f?.content || '');
    if (!content || PLACEHOLDER_RE.test(content)) continue;
    if (f.encoding === 'base64') {
      if (!/\.pdf$/i.test(String(f.name || ''))) continue;
      content = await readPdfWithGemini(env, fetchFn, content.replace(/^data:[^,]+,/, ''), 'Estrai fedelmente tutto il testo, le tabelle, le regole e le istruzioni di questo PDF, senza riassumere.') || '';
      if (!content) { saved.push({ name: f.name, failed: true }); continue; }
    }
    const id = upsertFile(db, projectId, { name: f.name, content }, nowIso);
    if (id) saved.push({ id, name: s(f.name).slice(0, 120), chars: Math.min(content.length, FILE_MAX), text: content.slice(0, FILE_MAX) });
  }
  return saved;
}

const INSTR_MAX = 12000;

/**
 * Le istruzioni di un progetto a partire da un documento che lo descrive (es. il PDF con le
 * caratteristiche del tutor). Se il documento ci sta, entra parola per parola: è quello che fa
 * Claude con le istruzioni di progetto, e un riassunto perderebbe le regole. Se è più lungo, un
 * modello forte ne ricava le istruzioni operative complete; il documento intero resta tra i file.
 */
export async function instructionsFromDoc(db, env, fetchFn, text, { tz } = {}) {
  const clean = cleanProjectContext(String(text || '').replace(/\[Pagina \d+\]\s*/g, '').replace(/[ \t]+\n/g, '\n'));
  if (!clean) return '';
  if (clean.length <= INSTR_MAX) return clean;
  try {
    const res = await modelChat(db, env, {
      tier: 'smart', best: true, maxTokens: 4000, fetchFn, tz,
      build: () => [
        { role: 'system', content: `Ricavi le ISTRUZIONI DI PROGETTO per un'assistente IA da un documento che descrive come deve lavorare (ruolo, profilo dello studente o dell'utente, obiettivi, metodo, regole, formato, cose da evitare). Riporta TUTTE le regole e i dati concreti con le parole del documento: non riassumere, togli solo ripetizioni e parti che non servono a lavorare. Massimo 10.000 caratteri, testo semplice con titoletti. Solo le istruzioni, niente commenti.` },
        { role: 'user', content: clean.slice(0, 60000) },
      ],
    });
    const out = cleanProjectContext(String(res.text || '').replace(/^```\w*\n?|```$/g, '')).trim();
    if (out.length > 400) return out.slice(0, INSTR_MAX);
  } catch { /* sotto: l'inizio del documento */ }
  return clean.slice(0, INSTR_MAX);
}

/** Cambia le istruzioni del progetto: replace le sostituisce, append aggiunge una regola in fondo. */
export function setInstructions(db, projectId, text, mode = 'append', nowIso) {
  const p = getProject(db, projectId);
  const t = cleanProjectContext(text);
  if (!p || !t) return null;
  const next = mode === 'replace' || !p.instructions ? t : `${p.instructions}\n- ${t}`;
  return updateProject(db, p.id, { instructions: next.slice(-INSTR_MAX) }, nowIso);
}

// ---------------------------------------------------------------- registro dei progressi

/**
 * Il registro del progetto: lezioni fatte, esercizi e quiz con il punteggio, errori, livello e
 * prossimo passo. È quello che permette a Kestra di riprendere da dove si era rimasti e di far
 * ripassare gli errori che tornano, anche in una chat nuova o in un compito in background.
 */
const LOG_KEY = (id) => 'plog:' + id;
const LOG_MAX = 300;
const LOG_KINDS = new Set(['lezione', 'esercizio', 'quiz', 'errore', 'nota', 'verifica']);

export function getLog(db, projectId) {
  const v = kvGet(db, LOG_KEY(projectId), null);
  return v && Array.isArray(v.entries) ? v : { level: '', next: '', entries: [] };
}

export function addLog(db, projectId, a, nowIso) {
  if (!getProject(db, projectId)) return null;
  const log = getLog(db, projectId);
  const kind = LOG_KINDS.has(s(a.kind).toLowerCase()) ? s(a.kind).toLowerCase() : 'nota';
  // I modelli scrivono i campi a modo loro (note, result, summary, description…): si accetta tutto.
  const text = s(a.text || a.note || a.notes || a.result || a.summary || a.description || a.details || a.feedback).slice(0, 400);
  const topic = s(a.topic).slice(0, 60);
  // "7/10" o "70%" nel punteggio, oppure score + max/total.
  let score = null, max = null;
  const frac = /^(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/.exec(s(a.score));
  if (frac) { score = Number(frac[1].replace(',', '.')); max = Number(frac[2].replace(',', '.')); }
  else if (/%$/.test(s(a.score))) { score = Number(s(a.score).replace('%', '').replace(',', '.')); max = 100; }
  else if (a.score !== '' && a.score != null && Number.isFinite(Number(a.score))) score = Math.max(0, Number(a.score));
  const mx = a.max ?? a.total ?? a.out_of ?? a.of;
  if (max == null && Number.isFinite(Number(mx)) && Number(mx) > 0) max = Number(mx);
  if (score != null && !Number.isFinite(score)) score = null;
  const rawErr = a.errors ?? a.mistakes ?? a.error ?? [];
  const errors = (Array.isArray(rawErr) ? rawErr : [rawErr]).map(e => s(typeof e === 'object' && e ? (e.text || e.error || e.wrong || JSON.stringify(e)) : e).slice(0, 120)).filter(Boolean).slice(0, 8);
  const any = text || topic || errors.length || score != null;
  if (!any && !a.level && !a.next) return null;
  if (any) log.entries.push({ at: nowIso, kind, topic, text, ...(score != null ? { score } : {}), ...(max ? { max } : {}), ...(errors.length ? { errors } : {}) });
  if (a.level) log.level = s(a.level).slice(0, 60);
  if (!text && !topic && !errors.length && score != null) log.entries[log.entries.length - 1].text = kind;
  if (a.next) log.next = s(a.next).slice(0, 300);
  log.entries = log.entries.slice(-LOG_MAX);
  kvSet(db, LOG_KEY(projectId), log);
  return log;
}

export function clearLog(db, projectId) { kvSet(db, LOG_KEY(projectId), null); }

/** Riepilogo del registro: totali, media dei punteggi, errori che tornano, ultime voci. */
export function logSummary(log, { last = 12 } = {}) {
  const e = log.entries || [];
  if (!e.length && !log.level && !log.next) return null;
  const count = (k) => e.filter(x => x.kind === k).length;
  const scored = e.filter(x => x.score != null && x.max);
  const avg = scored.length ? Math.round(scored.reduce((n, x) => n + x.score / x.max, 0) / scored.length * 100) : null;
  const errCount = new Map();
  for (const x of e) for (const er of (x.errors || (x.kind === 'errore' && x.text ? [x.text] : []))) {
    const k = er.toLowerCase(); const c = errCount.get(k) || { text: er, n: 0, lastAt: '' };
    c.n++; c.lastAt = x.at; errCount.set(k, c);
  }
  const recurring = [...errCount.values()].sort((a, b) => b.n - a.n || b.lastAt.localeCompare(a.lastAt)).slice(0, 8);
  const topics = [...new Set(e.filter(x => x.topic && (x.kind === 'lezione' || x.kind === 'esercizio' || x.kind === 'quiz')).map(x => x.topic))].slice(-15);
  return { level: log.level, next: log.next, lessons: count('lezione'), exercises: count('esercizio') + count('quiz'), avg, recurring, topics, recent: e.slice(-last) };
}

function logBlock(log) {
  const sum = logSummary(log);
  if (!sum) return '';
  const lines = ['REGISTRO DEI PROGRESSI (da qui sai a che punto siete: riprendi da qui, non ricominciare da capo)'];
  if (sum.level) lines.push(`Livello attuale: ${sum.level}`);
  lines.push(`Lezioni fatte: ${sum.lessons} · esercizi e quiz: ${sum.exercises}${sum.avg != null ? ` · media ${sum.avg}%` : ''}`);
  if (sum.topics.length) lines.push('Argomenti già fatti: ' + sum.topics.join(', '));
  if (sum.recurring.length) lines.push('Errori da ripassare (quante volte): ' + sum.recurring.map(r => `${r.text} (${r.n})`).join('; '));
  if (sum.next) lines.push(`Prossimo passo deciso: ${sum.next}`);
  lines.push('Ultime voci:');
  for (const x of sum.recent) lines.push(`- ${String(x.at).slice(0, 10)} ${x.kind}${x.topic ? ' · ' + x.topic : ''}${x.score != null && x.max ? ` · ${x.score}/${x.max}` : ''}${x.text ? ': ' + x.text : ''}${x.errors ? ' [errori: ' + x.errors.join('; ') + ']' : ''}`);
  return lines.join('\n');
}

// Progetto per imparare l'inglese: il telefono ascolta in inglese durante la lezione.
export const ENGLISH_RE = /\b(ingles\w*|english|ielts|toefl|cambridge|first\s+certificate)\b/i;
export const isEnglishProject = (p) => !!p && ENGLISH_RE.test(`${p.name}\n${String(p.instructions || '').slice(0, 3000)}`);

/** Come deve ascoltare il telefono adesso: in inglese, con pause lunghe, se è aperto un progetto di inglese. */
export function listenMode(db) {
  const a = getActive(db);
  if (a && isEnglishProject(a.project)) return { lang: 'en-US', alt: 'it-IT', silenceMs: 3500, project: a.project.name };
  return { lang: 'it-IT', silenceMs: 0 };
}

const EN_WORDS = new Set('the a an i you he she it we they is are was were am be been have has had do does did will would can could should to of in on at for with my your his her our their this that these those yesterday today tomorrow went go going got make made eat ate breakfast lunch dinner after before and but because when while what where who why how not dont didnt im its there here very some any morning evening night then'.split(' '));
const IT_WORDS = new Set('il lo la le gli un una di da in con su per che non e è sono ho hai ha abbiamo come cosa quando perché questo questa quello quella ieri oggi domani poi anche ma ancora già fatto fare dire andiamo iniziamo facciamo ok sì si no mi ti ci vi del della dei nel nella al alla'.split(' '));

/** Una frase (anche trascritta male) che è più inglese che italiano: in lezione è un esercizio, non un comando. */
export function looksEnglish(text) {
  const w = String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-zà-ù]+/).filter(Boolean);
  if (w.length < 2) return false;
  let en = 0, it = 0;
  for (const x of w) { if (EN_WORDS.has(x)) en++; if (IT_WORDS.has(x)) it++; }
  return en >= 2 && en > it * 1.5;
}

// Progetti di studio: lingua, esame, corso. Ricevono il metodo del tutor oltre alle istruzioni.
export const STUDY_RE = /\b(ingles\w*|english|tedesc\w*|francese|spagnol\w*|lingu[ae]|[abc][12]\b|ielts|toefl|cambridge|tutor|lezion\w*|studi\w*|esam\w*|corso|grammatic\w*|vocabolari\w*|ripass\w*|quiz)\b/i;
export const isStudyProject = (p) => !!p && (p.kind === 'tutor' || p.kind === 'studio' || STUDY_RE.test(`${p.name}\n${String(p.instructions || '').slice(0, 3000)}`));

const STUDY_METHOD = `METODO DI STUDIO (vale sotto le ISTRUZIONI DEL PROGETTO: se dicono altro, vincono loro)
- Sei la tutor di questo percorso. Parti dal REGISTRO DEI PROGRESSI: livello, ultimo argomento, errori da ripassare, prossimo passo. All'inizio di una sessione proponi in una frase da dove ripartire.
- Un esercizio o una domanda alla volta: aspetta la risposta, poi correggi e passa alla successiva.
- CORREZIONE: confronta la risposta del Capo parola per parola con la forma corretta e segnala OGNI errore (verbo, tempo, ortografia, ordine, articolo), anche quelli negli esempi che ha ricopiato senza correggerli. Per ogni errore: quello che ha scritto → la forma giusta → il perché in poche parole. Non dire "bene" a una frase che contiene ancora un errore. Se una frase ha più soluzioni giuste accettale, ma non accettare una forma sbagliata (es. "the phone was ringing" dove serve l'azione puntuale "rang").
- Quello che il Capo dice o scrive IN INGLESE durante la lezione è sempre materiale dell'esercizio: correggilo. Non trasformarlo MAI in pasti, promemoria, note, ricordi o azioni sul telefono, anche se parla di cibo o di cose da fare.
- Non dire "avvio in background" per un esercizio breve: fallo subito in questa risposta.
- Quiz: annuncia quante domande sono, falle una alla volta, alla fine dai il punteggio.
- Ripassa gli errori che tornano mescolandoli alle cose nuove (ripetizione distanziata). Alza o abbassa la difficoltà in base ai risultati.
- Registra SEMPRE con project_log: a fine lezione (kind "lezione", topic, cosa avete fatto, next), a fine esercizio o quiz (kind "esercizio" o "quiz" con score e max ed errors), quando noti un errore nuovo (errors). Se il livello cambia, mettilo in level.
- Materiale lungo da studiare (dispense, schede, liste di vocaboli, test completi): start_job, così lo preparano i modelli più forti con le istruzioni del progetto. Spiegazioni ed esercizi brevi falli subito qui.
- In questo progetto la reply può essere lunga quanto serve per la lezione e può usare elenchi brevi; resta leggibile ad alta voce.
- Se il Capo risponde a voce, la trascrizione può storpiare le parole: se una parola non ha senso, dì cosa hai capito e chiedi conferma invece di indovinare; correggi grammatica e lessico, non l'ortografia di parole trascritte male. Parla al Capo al maschile.`;

const PROJECT_ACTIONS = `AZIONI DEL PROGETTO
- project_instructions {text, mode: "append"|"replace"}: quando il Capo dice come deve funzionare il progetto d'ora in poi ("da ora in poi...", "nel progetto voglio che..."), aggiungi la regola alle istruzioni (append). replace solo se chiede di riscriverle tutte.
- project_log {kind: "lezione"|"esercizio"|"quiz"|"errore"|"nota"|"verifica", topic, text, score, max, errors: ["..."], level, next}: scrive nel registro dei progressi del progetto.`;

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
  const study = isStudyProject(project);
  const header = `PROGETTO ATTIVO: "${project.name}" (chat: ${chat.title || 'nuova'}).
Lavori dentro questo progetto come in un progetto di Claude: segui le sue istruzioni, usa i suoi file e la sua memoria.
Le istruzioni del progetto valgono più dello stile generale (lunghezza, lingua, formato del testo), ma la risposta resta sempre l'oggetto JSON richiesto.
Per salvare qualcosa nella memoria di questo progetto usa remember con module "progetto". Un lavoro lungo del progetto: start_job (resta legato al progetto).
${PROJECT_ACTIONS}`;
  const instructions = project.instructions ? `ISTRUZIONI DEL PROGETTO\n${project.instructions}` : 'ISTRUZIONI DEL PROGETTO: ancora nessuna. Se il Capo spiega come deve funzionare il progetto, salvale con project_instructions.';
  const blocks = [];
  const report = { project: project.name, files: [], memories: 0, otherChats: 0, jobs: 0 };

  const log = logBlock(getLog(db, project.id));
  if (log) { blocks.push({ prio: 1, text: log }); report.log = true; }

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
  return { header: [header, instructions, study ? STUDY_METHOD : ''].filter(Boolean).join('\n\n'), blocks, report, study };
}

/** Contesto di un compito legato a un progetto: istruzioni e file pertinenti all'obiettivo. */
export function jobBackground(db, projectId, goal) {
  const p = getProject(db, projectId);
  if (!p) return '';
  const files = relevantFileChunks(db, p.id, goal, { maxTokens: 5000 });
  const mems = listMemories(db, p.id).slice(0, 20);
  return [`PROGETTO: ${p.name}`, p.instructions ? `ISTRUZIONI DEL PROGETTO\n${p.instructions}` : '', logBlock(getLog(db, p.id)),
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
