import test from 'node:test';
import assert from 'node:assert/strict';
import * as coder from '../src/coder.js';
import { makeDb, deps, T0 } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GITHUB_TOKEN: 'gh', GITHUB_REPO: 'me/repo' };
const AGENDA = "// Promemoria\nexport function quanti(list) {\n  return list.length;\n}\n";
const BRAIN = "export const CLAIM_WORDS = /fatto/;\nexport function onesto(t) { return CLAIM_WORDS.test(t); }\n";

/** Finto GitHub con rami, controlli (check-runs) e registri dei test; il modello risponde con model(body, n). */
function world(model, { checks = () => ({ check_runs: [] }), logs = 'not ok 1 - quanti\n  error: expected 2 actual 1' } = {}) {
  const main = { 'web/app.js': 'x', 'server/src/agenda.js': AGENDA, 'server/src/brain.js': BRAIN, 'server/src/db.js': 'db', 'server/test/helpers.js': 'helpers' };
  const gh = { calls: [], main: { ...main }, base: { ...main }, branches: {}, merged: [], n: 0 };
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (/generativelanguage|groq|nvidia|openrouter/.test(url)) {
      gh.n++;
      const content = model(JSON.parse(init.body), gh.n);
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 100 } }));
    }
    const path = url.replace('https://api.github.com', '');
    gh.calls.push(`${method} ${path.split('?')[0]}`);
    const ok = (o, s = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status: s });
    if (path === '/repos/me/repo/git/ref/heads/main') return ok({ object: { sha: gh.merged.length ? 'main2' : 'base' } });
    const tree = /^\/repos\/me\/repo\/git\/trees\/([^?]+)/.exec(path);
    if (tree) { const ref = decodeURIComponent(tree[1]); const files = gh.branches[ref] || (ref === 'base' ? gh.base : gh.main); return ok({ tree: Object.keys(files).map(p => ({ path: p, type: 'blob', sha: 'sha-' + p })) }); }
    const raw = /^\/repos\/me\/repo\/contents\/(.+)\?ref=(.+)$/.exec(path);
    if (raw && method === 'GET') {
      const ref = decodeURIComponent(raw[2]);
      const files = ref === 'base' ? gh.base : gh.branches[ref] || gh.main;
      return files[raw[1]] == null ? ok('no', 404) : ok(files[raw[1]]);
    }
    if (path === '/repos/me/repo/git/refs' && method === 'POST') { const b = JSON.parse(init.body); gh.branches[b.ref.replace('refs/heads/', '')] = { ...gh.main }; return ok({}, 201); }
    const put = /^\/repos\/me\/repo\/contents\/(.+)$/.exec(path);
    if (put && method === 'PUT') { const b = JSON.parse(init.body); gh.branches[b.branch][put[1]] = Buffer.from(b.content, 'base64').toString('utf8'); return ok({}, 201); }
    if (put && method === 'DELETE') { const b = JSON.parse(init.body); delete gh.branches[b.branch][put[1]]; return ok({}); }
    if (path === '/repos/me/repo/pulls' && method === 'POST') { const b = JSON.parse(init.body); gh.lastHead = b.head; return ok({ number: 50 + Object.keys(gh.branches).length }, 201); }
    const merge = /^\/repos\/me\/repo\/pulls\/(\d+)\/merge$/.exec(path);
    if (merge) { gh.main = { ...gh.branches[gh.lastHead] }; gh.merged.push(Number(merge[1])); return ok({ merged: true }); }
    if (/\/check-runs/.test(path)) { const c = checks(); return c.status ? ok(c.body || 'no', c.status) : ok(c); }
    if (/\/actions\/jobs\/\d+\/logs/.test(path)) return ok(logs);
    if (method === 'DELETE' || method === 'PATCH') return ok({});
    return ok('?', 500);
  };
  return { gh, fn };
}

const NEED = JSON.stringify({ need: ['server/src/agenda.js'] });
const GOOD = JSON.stringify({ summary: 'Conta anche i promemoria fatti.', edits: [
  { path: 'server/src/agenda.js', find: 'return list.length;', replace: 'return list.length + 0;' },
  { path: 'server/test/kestra-quanti.test.js', create: true, content: "import test from 'node:test';\ntest('quanti', () => {});\n" },
] });
const green = () => ({ check_runs: [{ id: 7, name: 'Server e web (test)', status: 'completed', conclusion: 'success' }, { id: 8, name: 'Workers Builds: jarvis-cast', status: 'completed', conclusion: 'failure' }] });
const red = () => ({ check_runs: [{ id: 7, name: 'Server e web (test)', status: 'completed', conclusion: 'failure', output: { summary: 'fallito' } }] });

test('regole: file protetti, pezzi di sicurezza, test obbligatorio, test esistenti intoccabili', () => {
  const files = { 'server/src/brain.js': BRAIN, 'server/src/agenda.js': AGENDA, 'server/test/brain.test.js': 'vecchio' };
  const has = (edits, re) => coder.applyEdits(files, edits).errors.some(e => re.test(e));
  assert.ok(has([{ path: 'server/src/db.js', find: 'a', replace: 'b' }], /protetto/));
  assert.ok(has([{ path: 'server/src/coder.js', find: 'a', replace: 'b' }], /protetto/));
  assert.ok(has([{ path: 'server/src/brain.js', find: 'return CLAIM_WORDS.test(t);', replace: 'return false;' }, { path: 'server/test/kestra-x.test.js', create: true, content: 't' }], /CLAIM_WORDS/));
  assert.ok(has([{ path: 'server/src/agenda.js', find: 'return list.length;', replace: 'return 1;' }], /senza un test/));
  assert.ok(has([{ path: 'server/test/brain.test.js', find: 'vecchio', replace: 'nuovo' }], /test esistenti/));
  assert.deepEqual(coder.applyEdits(files, JSON.parse(GOOD).edits).errors, []);
});

test('modifica al server: chiede i file, scrive il test, aspetta i test verdi, poi si approva', async () => {
  const db = makeDb();
  let checks = () => ({ check_runs: [] });
  const { gh, fn } = world((body, n) => (n === 1 ? NEED : GOOD), { checks: () => checks() });
  const d = { ...deps(fn), schedule: () => {} };
  const id = coder.propose(db, 'conta anche i promemoria fatti', T0, 'Europe/Rome');
  await coder.work(db, ENV, d, id);
  let p = coder.listProposals(db)[0];
  assert.equal(p.status, 'testing', p.error);
  assert.equal(p.area, 'server');
  assert.deepEqual(p.files.sort(), ['server/src/agenda.js', 'server/test/kestra-quanti.test.js']);
  // Il modello aveva chiesto agenda.js: gli è arrivato insieme a helpers.js.
  assert.ok(gh.calls.includes('GET /repos/me/repo/contents/server/src/agenda.js'));
  await assert.rejects(coder.approve(db, ENV, d, id), /non c'è una modifica pronta/, 'in prova non si approva');

  assert.equal(await coder.checkTests(db, ENV, d), true, 'test non ancora partiti: si aspetta');
  checks = green;
  assert.equal(await coder.checkTests(db, ENV, d), false);
  p = coder.listProposals(db)[0];
  assert.equal(p.status, 'ready');
  assert.match(db.get("SELECT text FROM inbox WHERE kind = 'code' ORDER BY id DESC").text, /passato tutti i test/);
  await coder.approve(db, ENV, d, id);
  assert.equal(coder.listProposals(db)[0].status, 'approved');
  assert.match(gh.main['server/src/agenda.js'], /\+ 0/);
});

test('test rossi: Kestra legge l\'errore e corregge da sola sullo stesso ramo; dopo troppe correzioni si ferma', async () => {
  const db = makeDb();
  const prompts = [];
  const FIX = JSON.stringify({ summary: 'sistemato', edits: [{ path: 'server/src/agenda.js', find: 'return list.length + 0;', replace: 'return list.length + 1;' }] });
  const { gh, fn } = world((body, n) => { prompts.push(body.messages[1].content); return n === 1 ? NEED : n === 2 ? GOOD : FIX.replace('+ 1', '+ ' + n).replace('+ 0;', n === 3 ? '+ 0;' : `+ ${n - 1};`); }, { checks: red });
  const d = { ...deps(fn), schedule: () => {} };
  const id = coder.propose(db, 'conta anche i promemoria fatti', T0, 'Europe/Rome');
  await coder.work(db, ENV, d, id);
  const branch = coder.listProposals(db)[0].branch;
  assert.equal(await coder.checkTests(db, ENV, d), true);
  assert.match(prompts[2], /ERRORI DEI TEST:[\s\S]*not ok 1 - quanti/, 'la correzione riceve l\'errore vero dei test');
  assert.match(gh.branches[branch]['server/src/agenda.js'], /\+ 3;/);
  assert.equal(coder.listProposals(db)[0].attempts, 1);
  assert.equal(coder.listProposals(db)[0].status, 'testing');
  await coder.checkTests(db, ENV, d); // seconda correzione
  assert.equal(coder.listProposals(db)[0].attempts, 2);
  await coder.checkTests(db, ENV, d); // ancora rosso: basta
  const p = coder.listProposals(db)[0];
  assert.equal(p.status, 'failed');
  assert.match(p.error, /i test non passano/);
  assert.equal(gh.merged.length, 0, 'niente va online con i test rossi');
});

test('token senza permesso di leggere i test: si ferma e dice quale permesso aggiungere', async () => {
  const db = makeDb();
  const { fn } = world((body, n) => (n === 1 ? NEED : GOOD), { checks: () => ({ status: 403, body: 'Resource not accessible by personal access token' }) });
  const d = { ...deps(fn), schedule: () => {} };
  const id = coder.propose(db, 'x', T0, 'Europe/Rome');
  await coder.work(db, ENV, d, id);
  await coder.checkTests(db, ENV, d);
  assert.match(coder.listProposals(db)[0].error, /Checks: Read/);
});

test('"annulla l\'ultima modifica": rimette i file di prima, cancella quelli nuovi e la unisce subito', async () => {
  const db = makeDb();
  const { gh, fn } = world((body, n) => (n === 1 ? NEED : GOOD), { checks: green });
  const d = { ...deps(fn), schedule: () => {} };
  const id = coder.propose(db, 'conta anche i promemoria fatti', T0, 'Europe/Rome');
  await coder.work(db, ENV, d, id);
  await coder.checkTests(db, ENV, d);
  await coder.approve(db, ENV, d, id);
  assert.ok(gh.main['server/test/kestra-quanti.test.js']);
  await coder.revert(db, ENV, d); // senza id: l'ultima approvata
  assert.equal(gh.main['server/src/agenda.js'], AGENDA);
  assert.equal(gh.main['server/test/kestra-quanti.test.js'], undefined);
  assert.equal(coder.listProposals(db)[0].status, 'reverted');
  assert.equal(gh.merged.length, 2);
});
