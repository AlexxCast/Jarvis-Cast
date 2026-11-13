// Jarvis programmatore: su richiesta modifica la web app (solo la cartella web/), su un ramo a parte.
// Prima mostra un'anteprima funzionante (servita da /preview/<id>/ leggendo i file dal ramo),
// e la modifica va online solo quando l'utente approva: allora la pull request viene unita
// e Cloudflare pubblica la nuova versione. Senza GITHUB_TOKEN la funzione resta spenta.

import * as router from './router.js';
import { pushInbox, logEvent } from './db.js';
import { nowIso as nowIsoOf } from './clock.js';

const API = 'https://api.github.com';
const EDITABLE = /^web\/[\w./-]+\.(js|css|html|webmanifest)$/;
const MAX_FILE = 120_000;
const TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', webmanifest: 'application/manifest+json', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };

export const CODE_ACTIONS = new Set(['code_change', 'code_approve', 'code_discard']);
export const enabled = (env) => !!env.GITHUB_TOKEN;
const repoOf = (env) => env.GITHUB_REPO || 'AlexxCast/Jarvis-Cast';

export function listProposals(db) {
  return db.all('SELECT id, request, summary, status, branch, pr, error, created, updated FROM code_proposals ORDER BY created DESC LIMIT 10');
}
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
    if (!EDITABLE.test(path)) { errors.push(`${path}: si possono modificare solo i file della web app`); continue; }
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
  for (const [p, t] of Object.entries(out)) if (t.length > MAX_FILE) errors.push(`${p}: file troppo grande`);
  return { files: out, errors };
}

const SYSTEM = `Sei lo sviluppatore della web app di Jarvis (assistente personale, interfaccia in italiano, tema verde scuro).
La web app è fatta di moduli ES senza build: web/index.html, web/app.js (viste e logica, funzione h() per creare elementi), web/style.css, web/orb.js (la sfera).
Ricevi la richiesta dell'utente e i file attuali. Fai la modifica più piccola e pulita che la soddisfa, nello stile del codice esistente.
Regole: niente librerie esterne, niente dati inventati, non togliere funzioni esistenti, testi in italiano, accessibile.
Rispondi SOLO con JSON:
{"summary": "cosa cambia, in 1-3 frasi semplici per l'utente", "edits": [{"path": "web/app.js", "find": "testo esatto e univoco da sostituire (qualche riga)", "replace": "nuovo testo"}, {"path": "web/nuovo.js", "create": true, "content": "..."}]}
Il testo "find" deve essere copiato esattamente dal file e comparire una sola volta.`;

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
    const paths = tree.tree.filter(x => x.type === 'blob' && EDITABLE.test(x.path) && x.path !== 'web/sw.js').map(x => x.path);
    // La sfera si manda solo se la richiesta ne parla: è grande e di solito non serve.
    const wanted = paths.filter(x => x !== 'web/orb.js' || /sfera|orb|nodi|rami|animazion/i.test(p.request));
    const files = {};
    for (const path of wanted) files[path] = await gh(env, fetchFn, 'GET', `/repos/${repo}/contents/${path}?ref=${base}`, null, 'application/vnd.github.raw+json');

    let result = null, feedback = '';
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const res = await router.chat(db, env, {
        tier: 'smart', maxTokens: 6000, fetchFn, now: deps.now, tz: deps.tz,
        build: () => [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `RICHIESTA: ${p.request}\n\n${Object.entries(files).map(([k, v]) => `=== ${k} ===\n${v}`).join('\n\n')}${feedback}` },
        ],
      });
      const obj = parseJson(res.text);
      if (!obj || !Array.isArray(obj.edits) || !obj.edits.length) { feedback = '\n\nLa risposta precedente non era un JSON valido con "edits". Riprova.'; continue; }
      const applied = applyEdits(files, obj.edits);
      if (applied.errors.length) { feedback = `\n\nLa risposta precedente aveva errori, correggili:\n- ${applied.errors.join('\n- ')}`; continue; }
      result = { summary: String(obj.summary || 'Modifica alla web app').slice(0, 600), files: applied.files };
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
    const pr = await gh(env, fetchFn, 'POST', `/repos/${repo}/pulls`, {
      title: `Jarvis: ${p.request.slice(0, 70)}`, head: branch, base: 'main',
      body: `Modifica preparata da Jarvis su richiesta dell'utente.\n\n**Richiesta:** ${p.request}\n\n**Cosa cambia:** ${result.summary}\n\nFile: ${changed.join(', ')}\n\nVa online solo se l'utente approva dall'anteprima.`,
    });
    setStatus(db, id, { status: 'ready', summary: result.summary, branch, pr: pr.number, files: JSON.stringify(changed) }, at());
    pushInbox(db, at(), 'code', `Ho preparato la modifica "${p.request.slice(0, 60)}". Può vedere l'anteprima e approvarla.`);
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
  if (!p || !['ready', 'failed'].includes(p.status)) throw new Error('non c\'è una modifica da scartare');
  if (p.pr) {
    await gh(env, deps.fetchFn, 'PATCH', `/repos/${repoOf(env)}/pulls/${p.pr}`, { state: 'closed' }).catch(() => {});
    await gh(env, deps.fetchFn, 'DELETE', `/repos/${repoOf(env)}/git/refs/heads/${p.branch}`).catch(() => {});
  }
  setStatus(db, id, { status: 'discarded' }, nowIsoOf(deps.now(), deps.tz));
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
  const open = listProposals(db).filter(x => x.status === 'ready' || x.status === 'working');
  return `MODIFICARE L'APP (codice)
- Se l'utente chiede una funzione o un cambiamento che i riquadri (ui_pin/ui_note) non coprono, usa code_change {request: descrizione completa e autosufficiente della modifica}. Prepari una modifica alla web app con anteprima; va online solo se l'utente approva. Digli che lo avviserai quando l'anteprima è pronta.
- Se l'utente approva una modifica pronta ("approva", "unisci", "va bene così") usa code_approve {id}; se la rifiuta usa code_discard {id}.
- Modifiche in corso o pronte: ${open.map(x => `[${x.id}] ${x.status}: ${x.request.slice(0, 80)}`).join('; ') || 'nessuna'}.`;
}
