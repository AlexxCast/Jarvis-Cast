import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat } from '../src/brain.js';
import { handleApi } from '../src/api.js';
import * as coder from '../src/coder.js';
import { makeDb, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GITHUB_TOKEN: 'gh', GITHUB_REPO: 'me/repo' };
const APP = "function viewOggi() {\n  return [h('h2', {}, 'Oggi')];\n}\n";
const INDEX = '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>';

/** Finto GitHub + finto modello, con registro delle chiamate. */
function world({ edits }) {
  const gh = { calls: [], files: { 'web/app.js': APP, 'web/index.html': INDEX, 'web/style.css': 'body{}' }, branch: {} };
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (/generativelanguage|groq|openrouter/.test(url)) {
      const content = typeof edits === 'function' ? edits(JSON.parse(init.body)) : edits;
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 100 } }));
    }
    const path = url.replace('https://api.github.com', '');
    gh.calls.push(`${method} ${path.split('?')[0]}`);
    const ok = (o, s = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status: s });
    if (path === '/repos/me/repo/git/ref/heads/main') return ok({ object: { sha: 'base' } });
    if (path.startsWith('/repos/me/repo/git/trees/base')) return ok({ tree: Object.keys(gh.files).map(p => ({ path: p, type: 'blob', sha: 'sha-' + p })).concat([{ path: 'server/src/index.js', type: 'blob', sha: 'x' }]) });
    const raw = /^\/repos\/me\/repo\/contents\/(.+)\?ref=(.+)$/.exec(path);
    if (raw && method === 'GET') { const f = raw[2] === 'base' ? gh.files[raw[1]] : gh.branch[raw[1]] ?? gh.files[raw[1]]; return f == null ? ok('no', 404) : ok(f); }
    if (path === '/repos/me/repo/git/refs' && method === 'POST') return ok({}, 201);
    const put = /^\/repos\/me\/repo\/contents\/(.+)$/.exec(path);
    if (put && method === 'PUT') { const b = JSON.parse(init.body); gh.branch[put[1]] = Buffer.from(b.content, 'base64').toString('utf8'); return ok({}, 201); }
    if (path === '/repos/me/repo/pulls' && method === 'POST') return ok({ number: 42 }, 201);
    if (path === '/repos/me/repo/pulls/42/merge') return ok({ merged: true });
    if (path === '/repos/me/repo/pulls/42') return ok({});
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return ok('?', 500);
  };
  return { gh, fn };
}

const EDIT = JSON.stringify({ summary: 'Aggiunge il deficit nella scheda Oggi.', edits: [{ path: 'web/app.js', find: "h('h2', {}, 'Oggi')", replace: "h('h2', {}, 'Oggi'), h('p', {}, 'Deficit')" }] });

test('applyEdits: sostituzioni univoche, solo nella web app', () => {
  const r = coder.applyEdits({ 'web/app.js': 'a b a' }, [
    { path: 'web/app.js', find: 'b', replace: 'B' },
    { path: 'web/app.js', find: 'a', replace: 'x' },
    { path: 'server/src/index.js', find: 'x', replace: 'y' },
    { path: 'web/nuovo.js', create: true, content: 'export {}' },
  ]);
  assert.equal(r.files['web/app.js'], 'a B a');
  assert.equal(r.files['web/nuovo.js'], 'export {}');
  assert.equal(r.errors.length, 2);
});

test('Jarvis programmatore: richiesta a voce → ramo, pull request e anteprima; approvazione → unione', async () => {
  const db = makeDb();
  const { gh, fn } = world({ edits: (body) => (/Sei JARVIS/.test(body.messages[0].content)
    ? reply({ reply: 'Preparo la modifica, la avviso quando l\'anteprima è pronta.', actions: [{ type: 'code_change', request: 'Mostra il deficit nella scheda Oggi' }] })
    : EDIT) });
  const d = deps(fn);
  const out = await handleChat(db, ENV, d, { text: 'voglio una funzione che mostri il deficit nella scheda oggi' });
  assert.ok(out.actions.includes('code_change'));
  const [p] = coder.listProposals(db);
  assert.equal(p.status, 'ready', p.error);
  assert.equal(p.pr, 42);
  assert.match(gh.branch['web/app.js'], /Deficit/);
  assert.ok(!gh.calls.some(c => c.includes('server/src')), 'il server non si tocca');

  // Anteprima: index.html del ramo, con i file riscritti verso /preview/ e la barra Approva/Scarta.
  const html = await (await handleApi(db, ENV, d, new Request(`https://x/preview/${p.id}/`))).text();
  assert.match(html, new RegExp(`src="/preview/${p.id}/app.js"`));
  assert.match(html, /Approva/);
  const js = await (await handleApi(db, ENV, d, new Request(`https://x/preview/${p.id}/app.js`))).text();
  assert.match(js, /Deficit/);
  assert.equal((await handleApi(db, ENV, d, new Request('https://x/preview/sconosciuto/'))).status, 404);

  const state = await (await handleApi(db, ENV, d, new Request('https://x/api/state'))).json();
  assert.equal(state.code[0].id, p.id);

  const ok = await handleApi(db, ENV, d, new Request(`https://x/api/code/${p.id}/approve`, { method: 'POST' }));
  assert.equal(ok.status, 200);
  assert.ok(gh.calls.includes('PUT /repos/me/repo/pulls/42/merge'));
  assert.equal(coder.listProposals(db)[0].status, 'approved');
});

test('Jarvis programmatore: se il modello sbaglia riprova con gli errori, poi si arrende e lo dice', async () => {
  const db = makeDb();
  let n = 0;
  const bad = JSON.stringify({ summary: 'x', edits: [{ path: 'web/app.js', find: 'non esiste', replace: 'y' }] });
  const { gh, fn } = world({ edits: (body) => { n++; if (n === 2) assert.match(body.messages[1].content, /non è stato trovato/); return bad; } });
  const id = coder.propose(db, 'cambia qualcosa', Date.now(), 'Europe/Rome');
  await coder.work(db, ENV, deps(fn), id);
  const p = coder.listProposals(db)[0];
  assert.equal(p.status, 'failed');
  assert.equal(n, 2);
  assert.ok(!gh.calls.some(c => c.startsWith('POST /repos/me/repo/git/refs')), 'nessun ramo creato');
  assert.match(db.get("SELECT text FROM inbox WHERE kind = 'code'").text, /Non sono riuscito/);
});

test('senza GITHUB_TOKEN la funzione è spenta', async () => {
  const db = makeDb();
  const res = await handleApi(db, { GEMINI_API_KEY: 'g' }, deps(async () => new Response('{}')), new Request('https://x/api/code', { method: 'POST', body: JSON.stringify({ request: 'x' }) }));
  assert.equal(res.status, 400);
  assert.equal(coder.codePrompt({}, db), '');
});
