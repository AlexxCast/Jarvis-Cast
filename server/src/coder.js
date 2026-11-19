// Jarvis programmatore: su richiesta modifica la web app e, con più regole, anche il server, su un ramo a parte.
// Web app: prima mostra un'anteprima funzionante (servita da /preview/<id>/ leggendo i file dal ramo).
// Server: niente anteprima visiva, ma la modifica deve portare un test nuovo e passare TUTTI i test su GitHub;
// se i test falliscono Kestra legge l'errore e corregge da sola (al massimo due volte), altrimenti si ferma e lo dice.
// In entrambi i casi va online solo quando l'utente approva: allora la pull request viene unita e Cloudflare
// pubblica la nuova versione. "Annulla l'ultima modifica" la toglie (code_revert). Senza GITHUB_TOKEN è tutto spento.
// Questo file, il database, l'ingresso con il token e le API non si possono modificare da qui: così Kestra
// non può togliersi da sola i limiti, i controlli di onestà o la protezione dei dati.

import * as router from './router.js';
import { pushInbox, logEvent } from './db.js';
import { nowIso as nowIsoOf, localToMs } from './clock.js';

const API = 'https://api.github.com';
const EDITABLE_WEB = /^web\/[\w./-]+\.(js|css|html|webmanifest)$/;
const EDITABLE_SERVER = /^server\/(src\/[\w.-]+\.js|test\/[\w.-]+\.test\.js)$/;
const EDITABLE = { test: (p) => EDITABLE_WEB.test(p) || EDITABLE_SERVER.test(p) };
/** File che Kestra non può toccare: sé stessa, il database (dati del Capo), l'ingresso con il token, le API. */
export const LOCKED = new Set(['server/src/coder.js', 'server/src/db.js', 'server/src/index.js', 'server/src/api.js', 'server/src/forward.js', 'server/test/helpers.js']);
/** Pezzi di sicurezza che una modifica non può togliere (controllo di onestà, conferme al telefono, token). */
export const GUARDS = ['CLAIM_WORDS', 'holdEmergencyCall', 'guardMove', 'INTERNAL_JARVIS_WORDS', 'sameToken', 'phonePending', 'pcConfirm', 'callConfirm'];
const isServer = (p) => p.startsWith('server/');
/** Tentativi automatici di correzione quando i test su GitHub falliscono. */
export const FIX_ROUNDS = 2;
const TEST_CHECK = /server e web|test/i;
const MAX_FILE = 160_000;
const TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', webmanifest: 'application/manifest+json', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };

export const CODE_ACTIONS = new Set(['code_change', 'code_approve', 'code_discard', 'code_revert']);
export const enabled = (env) => !!env.GITHUB_TOKEN;
const repoOf = (env) => env.GITHUB_REPO || 'AlexxCast/Jarvis-Cast';

export function listProposals(db) {
  let rows;
  try {
    rows = db.all('SELECT id, request, summary, status, branch, pr, error, created, updated, area, attempts, files FROM code_proposals ORDER BY created DESC LIMIT 10');
  } catch (e) {
    // Colonne nuove non ancora create (migrazione bloccata dal limite di scritture): si legge quello che c'è.
    if (!/no such column/i.test(String(e?.message || e))) throw e;
    rows = db.all('SELECT * FROM code_proposals ORDER BY created DESC LIMIT 10').map(x => ({ area: 'web', attempts: 0, ...x }));
  }
  return rows.map(x => ({ ...x, files: safeList(x.files) }));
}
const safeList = (t) => { try { const v = JSON.parse(t || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const getProposal = (db, id) => db.get('SELECT * FROM code_proposals WHERE id = ?', String(id || ''));
const setStatus = (db, id, fields, nowIso) => {
  const keys = Object.keys(fields);
  db.run(`UPDATE code_proposals SET ${keys.map(k => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`, ...keys.map(k => fields[k]), nowIso, id);
};

async function gh(env, fetchFn, method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetchFn(API + path, {
    method,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept, 'user-agent': 'jarvis-cast', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return accept.includes('raw') ? res.text() : res.status === 204 ? null : res.json();
}
const b64 = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

/** Applica le modifiche "cerca e sostituisci" del modello. Ogni testo da cercare deve esistere una volta sola. */
export function applyEdits(files, edits) {
  const out = { ...files };
  const errors = [];
  for (const e of edits) {
    const path = String(e.path || '');
    if (!EDITABLE.test(path) || LOCKED.has(path)) { errors.push(`${path}: ${LOCKED.has(path) ? 'questo file è protetto e non si può modificare' : 'si possono modificare solo i file della web app e del server (server/src, nuovi test in server/test)'}`); continue; }
    if (path.startsWith('server/test/') && !e.create && !String(path).includes('/kestra-')) { errors.push(`${path}: i test esistenti non si toccano: aggiungi un file di test nuovo (server/test/kestra-<nome>.test.js)`); continue; }
    if (e.create) {
      if (out[path] != null) { errors.push(`${path}: esiste già`); continue; }
      out[path] = String(e.content || '');
      continue;
    }
    const cur = out[path];
    if (cur == null) { errors.push(`${path}: file inesistente`); continue; }
    const find = String(e.find || '');
    const n = find ? cur.split(find).length - 1 : 0;
    if (n !== 1) { errors.push(`${path}: il testo da sostituire ${n ? 'compare ' + n + ' volte' : 'non è stato trovato'}: ${find.slice(0, 80)}`); continue; }
    out[path] = cur.replace(find, () => String(e.replace ?? ''));
  }
  for (const [p, t] of Object.entries(out)) if (t.length > MAX_FILE && t !== files[p]) errors.push(`${p}: file troppo grande`);
  // I pezzi di sicurezza devono restare tutti: contarli prima e dopo.
  for (const [p, t] of Object.entries(out)) {
    if (files[p] == null || t === files[p]) continue;
    for (const g of GUARDS) if (t.split(g).length < files[p].split(g).length) errors.push(`${p}: non puoi togliere o indebolire "${g}" (controllo di sicurezza)`);
  }
  // Il server si cambia solo con un test nuovo che dimostra che la modifica funziona.
  const changed = Object.keys(out).filter(p => out[p] !== files[p]);
  if (changed.some(p => p.startsWith('server/src/')) && !changed.some(p => p.startsWith('server/test/'))) {
    errors.push('hai cambiato il server senza un test: aggiungi un file nuovo server/test/kestra-<nome>.test.js (node:test + assert, vedi helpers.js) che provi la modifica');
  }
  return { files: out, errors };
}

const SYSTEM = `Sei lo sviluppatore della web app di Jarvis (assistente personale, interfaccia in italiano, tema verde scuro).
La web app è fatta di moduli ES senza build: web/index.html, web/app.js (viste e logica, funzione h() per creare elementi), web/style.css, web/orb.js (la sfera).
Ricevi la richiesta dell'utente e i file attuali. Fai la modifica più piccola e pulita che la soddisfa, nello stile del codice esistente.
Regole: niente librerie esterne, niente dati inventati, non togliere funzioni esistenti, testi in italiano, accessibile.
Rispondi SOLO con JSON:
{"summary": "cosa cambia, in 1-3 frasi semplici per l'utente", "edits": [{"path": "web/app.js", "find": "testo esatto e univoco da sostituire (qualche riga)", "replace": "nuovo testo"}, {"path": "web/nuovo.js", "create": true, "content": "..."}]}
Il testo "find" deve essere copiato esattamente dal file e comparire una sola volta.
Se per fare la modifica serve cambiare come Kestra ragiona o lavora (server), ricevi anche l'INDICE DEL SERVER: prima chiedi i file che ti servono rispondendo SOLO {"need": ["server/src/nome.js", ...]} (al massimo 4), poi farai le modifiche.
Regole del server: moduli ES per Cloudflare Workers (niente librerie npm, niente fs), testi e commenti in italiano, non togliere controlli di sicurezza,
non cambiare il formato dei dati salvati. Ogni modifica al server DEVE creare un test nuovo "server/test/kestra-<nome>.test.js" con node:test e
assert/strict che importa i moduli da '../src/...' e usa makeDb/fakeFetch/deps/T0 da './helpers.js'. I test esistenti non si modificano.`;

const SERVER_INDEX_NOTE = `I test girano su GitHub con "npm test" (node --test). helpers.js esporta: makeDb() (database in memoria), fakeFetch(handler) (finto provider: handler(url, body) → stringa o {status, json}), deps(fetchFn) ({now, tz, fetchFn}), T0 (12/11/2026 12:00 Roma), reply(obj) (risposta JSON di Kestra).`;

function parseJson(text) {
  const t = String(text || '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  try { return JSON.parse(a >= 0 ? t.slice(a, b + 1) : t); } catch { return null; }
}

/** Crea la proposta e la mette in lavorazione. Ritorna l'id. */
export function propose(db, request, ms, tz) {
  const id = 'c' + ms.toString(36) + crypto.getRandomValues(new Uint32Array(2)).reduce((s, x) => s + x.toString(36), '');
  const at = nowIsoOf(ms, tz);
  db.run('INSERT INTO code_proposals (id, request, status, created, updated) VALUES (?, ?, ?, ?, ?)', id, String(request).slice(0, 2000), 'working', at, at);
  return id;
}

/** Lavora la proposta: legge i file, chiede le modifiche al modello, crea ramo, commit e pull request. */
export async function work(db, env, deps, id) {
  const p = getProposal(db, id);
  if (!p) return;
  const fetchFn = deps.fetchFn, repo = repoOf(env), at = () => nowIsoOf(deps.now(), deps.tz);
  try {
    const main = await gh(env, fetchFn, 'GET', `/repos/${repo}/git/ref/heads/main`);
    const base = main.object.sha;
    const tree = await gh(env, fetchFn, 'GET', `/repos/${repo}/git/trees/${base}?recursive=1`);
    const paths = tree.tree.filter(x => x.type === 'blob' && EDITABLE_WEB.test(x.path) && x.path !== 'web/sw.js').map(x => x.path);
    const serverPaths = tree.tree.filter(x => x.type === 'blob' && /^server\/src\/[\w.-]+\.js$/.test(x.path) && !LOCKED.has(x.path)).map(x => x.path);
    // La sfera si manda solo se la richiesta ne parla: è grande e di solito non serve.
    const wanted = paths.filter(x => x !== 'web/orb.js' || /sfera|orb|nodi|rami|animazion/i.test(p.request));
    const files = {};
    const load = async (path) => { files[path] = await gh(env, fetchFn, 'GET', `/repos/${repo}/contents/${path}?ref=${base}`, null, 'application/vnd.github.raw+json'); };
    for (const path of wanted) await load(path);
    const index = serverPaths.length ? `INDICE DEL SERVER (file che puoi chiedere): ${serverPaths.join(', ')}\n${SERVER_INDEX_NOTE}` : '';

    let result = null, feedback = '', asked = false;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const res = await router.chat(db, env, {
        tier: 'smart', best: true, maxTokens: 8000, fetchFn, now: deps.now, tz: deps.tz,
        build: () => [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `RICHIESTA: ${p.request}\n\n${index}\n\n${Object.entries(files).map(([k, v]) => `=== ${k} ===\n${v}`).join('\n\n')}${feedback}` },
        ],
      });
      const obj = parseJson(res.text);
      // Il modello chiede i file del server che gli servono: si caricano e si riprova (una volta, non conta come tentativo).
      if (obj && Array.isArray(obj.need) && obj.need.length && !asked) {
        asked = true;
        const need = obj.need.map(String).filter(x => serverPaths.includes(x) || x === 'server/test/helpers.js').slice(0, 4);
        for (const path of need) await load(path);
        if (need.length && !files['server/test/helpers.js']) await load('server/test/helpers.js').catch(() => {});
        attempt--;
        continue;
      }
      if (!obj || !Array.isArray(obj.edits) || !obj.edits.length) { feedback = '\n\nLa risposta precedente non era un JSON valido con "edits". Riprova.'; continue; }
      const applied = applyEdits(files, obj.edits);
      if (applied.errors.length) { feedback = `\n\nLa risposta precedente aveva errori, correggili:\n- ${applied.errors.join('\n- ')}`; continue; }
      result = { summary: String(obj.summary || 'Modifica a Kestra').slice(0, 600), files: applied.files };
    }
    if (!result) throw new Error('il modello non è riuscito a preparare una modifica valida' + (feedback ? ': ' + feedback.trim().slice(0, 300) : ''));

    const changed = Object.keys(result.files).filter(k => result.files[k] !== files[k]);
    if (!changed.length) throw new Error('nessun file cambiato');
    const branch = `jarvis/${id}`;
    await gh(env, fetchFn, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: base });
    const shaOf = Object.fromEntries(tree.tree.map(x => [x.path, x.sha]));
    for (const path of changed) {
      await gh(env, fetchFn, 'PUT', `/repos/${repo}/contents/${path}`, { message: `Jarvis: ${result.summary.slice(0, 60)}`, content: b64(result.files[path]), branch, ...(shaOf[path] ? { sha: shaOf[path] } : {}) });
    }
    const server = changed.some(isServer);
    const pr = await gh(env, fetchFn, 'POST', `/repos/${repo}/pulls`, {
      title: `Jarvis: ${p.request.slice(0, 70)}`, head: branch, base: 'main',
      body: `Modifica preparata da Jarvis su richiesta dell'utente.\n\n**Richiesta:** ${p.request}\n\n**Cosa cambia:** ${result.summary}\n\nFile: ${changed.join(', ')}\n\n${server ? 'Tocca il server: va online solo se i test passano e l\'utente approva.' : 'Va online solo se l\'utente approva dall\'anteprima.'}`,
    });
    // created: i file nuovi, per poterli togliere con "annulla".
    const created = changed.filter(x => files[x] == null);
    setStatus(db, id, { status: server ? 'testing' : 'ready', summary: result.summary, branch, pr: pr.number, files: JSON.stringify(changed), area: server ? 'server' : 'web', base, created_files: JSON.stringify(created) }, at());
    if (server) deps.schedule?.(deps.now() + 90_000);
    else pushInbox(db, at(), 'code', `Ho preparato la modifica "${p.request.slice(0, 60)}". Può vedere l'anteprima e approvarla.`);
  } catch (e) {
    logEvent(db, at(), 'error', `codice ${id}: ${e.message}`);
    setStatus(db, id, { status: 'failed', error: String(e.message).slice(0, 400) }, at());
    pushInbox(db, at(), 'code', `Non sono riuscito a preparare la modifica "${p.request.slice(0, 60)}": ${String(e.message).slice(0, 160)}`);
  }
}

/** Unisce la pull request: Cloudflare pubblica la nuova versione in un paio di minuti. */
export async function approve(db, env, deps, id) {
  const p = getProposal(db, id);
  if (!p || p.status !== 'ready') throw new Error('non c\'è una modifica pronta da approvare');
  await gh(env, deps.fetchFn, 'PUT', `/repos/${repoOf(env)}/pulls/${p.pr}/merge`, { merge_method: 'squash', commit_title: `Jarvis: ${p.request.slice(0, 70)}` });
  setStatus(db, id, { status: 'approved' }, nowIsoOf(deps.now(), deps.tz));
}

export async function discard(db, env, deps, id) {
  const p = getProposal(db, id);
  if (!p || !['ready', 'failed', 'testing'].includes(p.status)) throw new Error('non c\'è una modifica da scartare');
  if (p.pr) {
    await gh(env, deps.fetchFn, 'PATCH', `/repos/${repoOf(env)}/pulls/${p.pr}`, { state: 'closed' }).catch(() => {});
    await gh(env, deps.fetchFn, 'DELETE', `/repos/${repoOf(env)}/git/refs/heads/${p.branch}`).catch(() => {});
  }
  setStatus(db, id, { status: 'discarded' }, nowIsoOf(deps.now(), deps.tz));
}

/** L'ultima modifica approvata (o quella indicata), per "annulla". */
const lastApproved = (db, id) => (id ? getProposal(db, id) : null) || db.get("SELECT * FROM code_proposals WHERE status = 'approved' ORDER BY updated DESC LIMIT 1");

/**
 * Annulla una modifica già online: rimette i file com'erano prima (quelli nuovi si cancellano) su un ramo,
 * apre la pull request e la unisce subito, perché l'ha chiesto il Capo. Cloudflare ripubblica in un paio di minuti.
 */
export async function revert(db, env, deps, id) {
  const p = lastApproved(db, id);
  if (!p || p.status !== 'approved' || !p.base) throw new Error('non c\'è una modifica approvata da annullare');
  const fetchFn = deps.fetchFn, repo = repoOf(env), at = () => nowIsoOf(deps.now(), deps.tz);
  const main = await gh(env, fetchFn, 'GET', `/repos/${repo}/git/ref/heads/main`);
  const tree = await gh(env, fetchFn, 'GET', `/repos/${repo}/git/trees/${main.object.sha}?recursive=1`);
  const shaOf = Object.fromEntries(tree.tree.map(x => [x.path, x.sha]));
  const branch = `jarvis/annulla-${p.id}`;
  await gh(env, fetchFn, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha });
  const created = new Set(safeList(p.created_files));
  for (const path of safeList(p.files)) {
    const message = `Jarvis: annulla "${p.request.slice(0, 50)}"`;
    if (created.has(path)) { if (shaOf[path]) await gh(env, fetchFn, 'DELETE', `/repos/${repo}/contents/${path}`, { message, branch, sha: shaOf[path] }); continue; }
    const old = await gh(env, fetchFn, 'GET', `/repos/${repo}/contents/${path}?ref=${p.base}`, null, 'application/vnd.github.raw+json');
    await gh(env, fetchFn, 'PUT', `/repos/${repo}/contents/${path}`, { message, content: b64(old), branch, ...(shaOf[path] ? { sha: shaOf[path] } : {}) });
  }
  const pr = await gh(env, fetchFn, 'POST', `/repos/${repo}/pulls`, { title: `Jarvis: annulla "${p.request.slice(0, 60)}"`, head: branch, base: 'main', body: `Annullamento chiesto dall'utente della modifica #${p.pr}.` });
  await gh(env, fetchFn, 'PUT', `/repos/${repo}/pulls/${pr.number}/merge`, { merge_method: 'squash', commit_title: `Jarvis: annulla "${p.request.slice(0, 60)}"` });
  setStatus(db, p.id, { status: 'reverted' }, at());
  return p;
}

/** Righe utili di un registro dei test: i "not ok", gli errori e le asserzioni, senza il rumore. */
export function testErrors(log) {
  const lines = String(log || '').split('\n').map(l => l.replace(/^\S+Z\s/, '').trimEnd());
  const keep = lines.filter(l => /not ok|Error|error:|assert|expected|actual|SyntaxError|Cannot find|is not defined|failureType|location:|✖/i.test(l));
  return (keep.length ? keep : lines.slice(-40)).slice(0, 60).join('\n').slice(0, 4000);
}

/** Legge lo stato dei test di GitHub su un ramo: 'pending' | 'success' | 'failure' | 'nopermission', con i dettagli. */
async function readTests(env, fetchFn, repo, branch) {
  try {
    const r = await gh(env, fetchFn, 'GET', `/repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=50`);
    const runs = (r.check_runs || []).filter(c => TEST_CHECK.test(c.name) && !/workers builds|android/i.test(c.name));
    if (!runs.length) return { state: 'pending' };
    if (runs.some(c => c.status !== 'completed')) return { state: 'pending' };
    const bad = runs.find(c => !['success', 'skipped', 'neutral'].includes(c.conclusion));
    if (!bad) return { state: 'success' };
    let log = String(bad.output?.summary || bad.output?.text || '');
    try { log = await gh(env, fetchFn, 'GET', `/repos/${repo}/actions/jobs/${bad.id}/logs`, null, 'application/vnd.github.raw+json'); } catch { /* senza permesso Actions: si usa il riassunto */ }
    return { state: 'failure', log: testErrors(log) || 'i test non sono passati' };
  } catch (e) {
    if (/: 40[34] /.test(String(e.message))) return { state: 'nopermission' };
    throw e;
  }
}

/**
 * Controlla le modifiche al server che aspettano i test (dal battito del Durable Object).
 * Verdi → pronte da approvare. Rosse → Kestra corregge da sola con l'errore dei test (FIX_ROUNDS volte), poi si arrende.
 * Ritorna true se qualcosa aspetta ancora (richiamare tra un minuto).
 */
export async function checkTests(db, env, deps) {
  if (!enabled(env)) return false;
  const waiting = db.all("SELECT * FROM code_proposals WHERE status = 'testing'");
  if (!waiting.length) return false;
  const fetchFn = deps.fetchFn, repo = repoOf(env), at = () => nowIsoOf(deps.now(), deps.tz);
  for (const p of waiting) {
    try {
      const t = await readTests(env, fetchFn, repo, p.branch);
      if (t.state === 'pending') {
        const age = deps.now() - (localToMs(p.updated, deps.tz) ?? deps.now());
        if (Number.isFinite(age) && age > 40 * 60_000) {
          setStatus(db, p.id, { status: 'failed', error: 'i test su GitHub non sono partiti entro 40 minuti' }, at());
          pushInbox(db, at(), 'code', `La modifica "${p.request.slice(0, 60)}" è ferma: i test su GitHub non sono partiti. Riprova più tardi.`);
        }
        continue;
      }
      if (t.state === 'nopermission') {
        setStatus(db, p.id, { status: 'failed', error: 'il GITHUB_TOKEN non può leggere i test: aggiungi il permesso "Checks: Read" (e "Actions: Read" per gli errori)' }, at());
        pushInbox(db, at(), 'code', `Ho preparato "${p.request.slice(0, 60)}", ma non posso leggere i test su GitHub: al token GITHUB_TOKEN manca il permesso "Checks: Read".`);
        continue;
      }
      if (t.state === 'success') {
        setStatus(db, p.id, { status: 'ready', error: '' }, at());
        pushInbox(db, at(), 'code', `La modifica "${p.request.slice(0, 60)}" ha passato tutti i test${p.attempts ? ` (dopo ${p.attempts} ${p.attempts === 1 ? 'correzione' : 'correzioni'} mia)` : ''}. Dimmi "approva" per metterla online.`);
        continue;
      }
      if ((p.attempts || 0) >= FIX_ROUNDS) {
        setStatus(db, p.id, { status: 'failed', error: `i test non passano: ${t.log.slice(0, 300)}` }, at());
        pushInbox(db, at(), 'code', `Non sono riuscita a far passare i test di "${p.request.slice(0, 60)}" dopo ${FIX_ROUNDS} correzioni: la lascio ferma, non va online.`);
        continue;
      }
      await fixRound(db, env, deps, p, t.log);
    } catch (e) {
      logEvent(db, at(), 'error', `test codice ${p.id}: ${e.message}`);
    }
  }
  return db.all("SELECT id FROM code_proposals WHERE status = 'testing'").length > 0;
}

/** Una correzione: il modello vede i file del ramo e l'errore dei test, e manda le modifiche sullo stesso ramo. */
async function fixRound(db, env, deps, p, log) {
  const fetchFn = deps.fetchFn, repo = repoOf(env), at = () => nowIsoOf(deps.now(), deps.tz);
  const changed = safeList(p.files);
  const files = {};
  for (const path of changed) files[path] = await gh(env, fetchFn, 'GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(p.branch)}`, null, 'application/vnd.github.raw+json').catch(() => null);
  // Anche la versione di partenza: i pezzi di sicurezza si contano rispetto a main, non rispetto al ramo.
  const original = {};
  for (const path of changed) original[path] = await gh(env, fetchFn, 'GET', `/repos/${repo}/contents/${path}?ref=${p.base}`, null, 'application/vnd.github.raw+json').catch(() => null);
  const current = Object.fromEntries(Object.entries(files).filter(([, v]) => v != null));
  const res = await router.chat(db, env, {
    tier: 'smart', best: true, maxTokens: 8000, fetchFn, now: deps.now, tz: deps.tz,
    build: () => [
      { role: 'system', content: SYSTEM + '\n\nSTAI CORREGGENDO una modifica già fatta: i test su GitHub sono falliti. Correggi il codice (o il test nuovo, se è il test a essere sbagliato). Rispondi SOLO con JSON {"summary": "...", "edits": [...]} sui file qui sotto. Un file nuovo già creato si modifica con find/replace, non con create.' },
      { role: 'user', content: `RICHIESTA ORIGINALE: ${p.request}\n\nERRORI DEI TEST:\n${log}\n\n${SERVER_INDEX_NOTE}\n\n${Object.entries(current).map(([k, v]) => `=== ${k} ===\n${v}`).join('\n\n')}` },
    ],
  });
  const obj = parseJson(res.text);
  const edits = Array.isArray(obj?.edits) ? obj.edits.map(e => ({ ...e, create: false })) : [];
  // I test nuovi di Kestra (kestra-*) si possono correggere; i file protetti e i pezzi di sicurezza restano bloccati.
  const applied = applyEdits(current, edits);
  const base = Object.fromEntries(Object.entries(original).filter(([, v]) => v != null));
  const guardErrors = [];
  for (const [path, text] of Object.entries(applied.files)) {
    if (base[path] == null) continue;
    for (const g of GUARDS) if (text.split(g).length < base[path].split(g).length) guardErrors.push(`${path}: ${g}`);
  }
  const fixedFiles = Object.keys(applied.files).filter(k => applied.files[k] !== current[k]);
  const attempts = (p.attempts || 0) + 1;
  if (!edits.length || applied.errors.filter(e => !/senza un test/.test(e)).length || guardErrors.length || !fixedFiles.length) {
    setStatus(db, p.id, { attempts }, at());
    if (attempts >= FIX_ROUNDS) {
      setStatus(db, p.id, { status: 'failed', error: `correzione non valida: ${[...applied.errors, ...guardErrors].join('; ').slice(0, 300) || 'nessuna modifica'}` }, at());
      pushInbox(db, at(), 'code', `Non sono riuscita a correggere "${p.request.slice(0, 60)}": i test non passano, la lascio ferma.`);
    }
    return;
  }
  const tree = await gh(env, fetchFn, 'GET', `/repos/${repo}/git/trees/${encodeURIComponent(p.branch)}?recursive=1`);
  const shaOf = Object.fromEntries((tree.tree || []).map(x => [x.path, x.sha]));
  for (const path of fixedFiles) {
    await gh(env, fetchFn, 'PUT', `/repos/${repo}/contents/${path}`, { message: `Jarvis: correzione dopo i test (${attempts})`, content: b64(applied.files[path]), branch: p.branch, ...(shaOf[path] ? { sha: shaOf[path] } : {}) });
  }
  setStatus(db, p.id, { attempts, summary: obj.summary ? `${p.summary} (corretta: ${String(obj.summary).slice(0, 200)})` : p.summary }, at());
  logEvent(db, at(), 'code', `modifica ${p.id}: correzione ${attempts} dopo i test`);
}

const PREVIEW_BAR = (id) => `<div id="jarvis-preview" style="position:fixed;left:8px;right:8px;top:8px;z-index:99;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#0d2a0d;border:1px solid #39ff14;border-radius:12px;padding:8px 12px;font:14px system-ui;color:#e5f6e5">
<b style="flex:1;min-width:140px">Anteprima della modifica</b>
<button data-a="approve" style="background:#39ff14;color:#003300;border:0;border-radius:8px;padding:8px 12px;font-weight:650">Approva</button>
<button data-a="discard" style="background:none;color:#f87171;border:1px solid #1f3a1f;border-radius:8px;padding:8px 12px">Scarta</button>
<button data-a="close" style="background:none;color:#e5f6e5;border:1px solid #1f3a1f;border-radius:8px;padding:8px 12px">Chiudi</button></div>
<script>document.getElementById('jarvis-preview').addEventListener('click', async (e) => {
  const a = e.target.dataset && e.target.dataset.a; if (!a) return;
  if (a === 'close') { location.href = '/'; return; }
  const token = localStorage.getItem('jarvis_token') || (window.JarvisNative && JSON.parse(window.JarvisNative.getConfig() || '{}').token) || '';
  const r = await fetch('/api/code/${id}/' + a, { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  alert(r.ok ? (a === 'approve' ? 'Approvata: sarà online tra un paio di minuti.' : 'Modifica scartata.') : (j.error || 'Errore'));
  location.href = '/';
});</script>`;

/** Serve i file della web app così come sono sul ramo della proposta. */
export async function servePreview(db, env, deps, pathname) {
  const m = /^\/preview\/([a-z0-9]+)\/?(.*)$/.exec(pathname);
  const p = m && getProposal(db, m[1]);
  if (!p || p.status !== 'ready') return new Response('Anteprima non disponibile', { status: 404 });
  const rel = m[2] || 'index.html';
  if (!/^[\w./-]+$/.test(rel) || rel.includes('..')) return new Response('Percorso non valido', { status: 400 });
  const ext = rel.split('.').pop();
  // I file di testo arrivano dal ramo; immagini e il resto dalla versione pubblicata.
  if (!/^(js|css|html|webmanifest)$/.test(ext)) return new Response(null, { status: 302, headers: { location: '/' + rel } });
  let text;
  try { text = await gh(env, deps.fetchFn, 'GET', `/repos/${repoOf(env)}/contents/web/${rel}?ref=${encodeURIComponent(p.branch)}`, null, 'application/vnd.github.raw+json'); }
  catch { return new Response('File non trovato', { status: 404 }); }
  if (rel === 'index.html') {
    text = text.replace(/(src|href)="\/(?!\/)(app\.js|orb\.js|style\.css)"/g, `$1="/preview/${p.id}/$2"`)
      .replace(/<script[^>]*sw\.js[^>]*><\/script>/g, '')
      .replace('</body>', `${PREVIEW_BAR(p.id)}</body>`);
  }
  return new Response(text, { headers: { 'content-type': TYPES[ext] || 'text/plain', 'cache-control': 'no-store' } });
}

export function codePrompt(env, db) {
  if (!enabled(env)) return '';
  const open = listProposals(db).filter(x => ['ready', 'working', 'testing'].includes(x.status));
  const lastOk = listProposals(db).find(x => x.status === 'approved');
  return `MODIFICARE L'APP (codice)
- Se l'utente chiede una funzione o un cambiamento che i riquadri (ui_pin/ui_note) non coprono, usa code_change {request: descrizione completa e autosufficiente della modifica}. Puoi cambiare la web app (con anteprima) e anche come lavori tu, cioè il server (ragionamento, memoria, azioni, dieta, agenda...): lì prepari la modifica con un test nuovo e aspetti che TUTTI i test passino su GitHub, correggendo da sola se falliscono. Va online solo se l'utente approva. Digli che lo avviserai quando è pronta.
- Non puoi modificare il database, il token, le API né i controlli di sicurezza (onestà sulle azioni, conferme sul telefono): se te lo chiede, spiega che quelle parti le cambia solo lui con una PR.
- Se l'utente approva una modifica pronta ("approva", "unisci", "va bene così") usa code_approve {id}; se la rifiuta usa code_discard {id}. Una modifica in prova ("testing") non si approva: aspetta i test.
- Se dice che una modifica già online ha rotto qualcosa o chiede di annullarla ("annulla l'ultima modifica", "torna come prima") usa code_revert {id} (id facoltativo: senza, annulla l'ultima approvata).
- Modifiche in corso o pronte: ${open.map(x => `[${x.id}] ${x.status}${x.area === 'server' ? ' (server)' : ''}: ${x.request.slice(0, 80)}`).join('; ') || 'nessuna'}.${lastOk ? ` Ultima approvata: [${lastOk.id}] ${lastOk.request.slice(0, 80)}.` : ''}`;
}
