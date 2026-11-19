// Kestra con il server "bloccato": scritture gratuite di Cloudflare finite. Le letture (grafo, storico, stato,
// progetti) devono rispondere lo stesso, la chat risponde e rimanda al telefono quello che non ha salvato,
// e /api/sync lo ripete dopo, una volta sola.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { wrapNodeSqlite, migrate, resetWriteBlock, writesBlocked } from '../src/db.js';
import { handleApi } from '../src/api.js';
import { fakeFetch, deps, reply, T0 } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

/** Database di prova con l'interruttore "limite di scritture finito", come quello vero di Cloudflare. */
function blockableDb() {
  const raw = new DatabaseSync(':memory:');
  const flag = { blocked: false };
  const fake = { prepare: (q) => { if (flag.blocked && WRITE_RE.test(q)) throw new Error('Exceeded allowed rows written in Durable Objects free tier.'); return raw.prepare(q); } };
  const db = wrapNodeSqlite(fake);
  migrate(db);
  return { db, flag };
}

const callOf = (db, d) => async (method, path, payload) => {
  const res = await handleApi(db, ENV, d, new Request('https://x' + path, { method, body: payload ? JSON.stringify(payload) : undefined }));
  return { status: res.status, body: await res.json() };
};

test('senza scritture: grafo, storico, stato, progetti e memoria si leggono lo stesso', async () => {
  resetWriteBlock();
  const { db, flag } = blockableDb();
  const d = { ...deps(fakeFetch(() => reply({ reply: 'Segnato.', actions: [{ type: 'remember', module: 'persone', text: 'Marco è mio cugino' }] }))), schedule: () => {} };
  const call = callOf(db, d);
  await call('POST', '/api/chat', { text: 'ricorda che Marco è mio cugino' });
  await call('POST', '/api/projects', { name: 'Tesi' });
  flag.blocked = true;
  for (const p of ['/api/state', '/api/history', '/api/graph', '/api/projects', '/api/memory', '/api/mind', '/api/jobs', '/api/models']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const st = await call('GET', '/api/state');
  assert.equal(st.body.server.writesBlocked, true);
  assert.ok(st.body.server.until > Date.now());
  assert.equal((await call('GET', '/api/history')).body.messages.length, 2);
  assert.ok((await call('GET', '/api/graph')).body.branches.length > 0);
  resetWriteBlock();
});

test('senza scritture: la chat risponde, avvisa e rimanda il pasto al telefono; /api/sync lo salva una volta', async () => {
  resetWriteBlock();
  const { db, flag } = blockableDb();
  const meal = { type: 'add_meal', meal: 'cena', description: 'pizza', items: [{ name: 'pizza', grams: 300, kcal: 800, protein: 30, carbs: 100, fat: 25 }] };
  const d = { ...deps(fakeFetch(() => reply({ reply: 'Ho segnato la pizza: 800 kcal.', actions: [meal] }))), schedule: () => {} };
  const call = callOf(db, d);
  flag.blocked = true;
  const out = await call('POST', '/api/chat', { text: 'ho mangiato una pizza' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.unsaved, true);
  assert.equal(out.body.pendingActions.length, 1);
  assert.match(out.body.reply, /telefono/);
  // Le modifiche fatte a mano invece rispondono 503 con il motivo: il telefono le mette in coda.
  const manual = await call('POST', '/api/actions', { actions: [meal] });
  assert.equal(manual.status, 503);
  assert.equal(manual.body.writesBlocked, true);
  // Il limite si azzera: il telefono rimanda tutto (due volte, come se la prima risposta si fosse persa).
  flag.blocked = false;
  const at = T0 - 3600_000;
  const ops = [
    { id: 'op1', kind: 'actions', at, actions: out.body.pendingActions },
    { id: 'op2', kind: 'history', at, messages: [{ role: 'user', text: 'ho mangiato una pizza', at }, { role: 'assistant', text: out.body.reply, at }] },
    { id: 'op3', kind: 'actions', at, actions: [{ type: 'phone_task', goal: 'manda un messaggio' }] },
  ];
  const s1 = await call('POST', '/api/sync', { ops });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.deepEqual(s1.body.done, ['op1', 'op2', 'op3']);
  assert.equal(s1.body.state.today.eaten, 800);
  const s2 = await call('POST', '/api/sync', { ops });
  assert.equal(s2.body.state.today.eaten, 800, 'non si applica due volte');
  assert.equal((await call('GET', '/api/history')).body.messages.length, 2);
  assert.equal(writesBlocked(), true, 'resta segnato fino a mezzanotte UTC');
  resetWriteBlock();
});

test('sync: un messaggio scritto offline va al modello con la sua ora, le azioni sul telefono no', async () => {
  resetWriteBlock();
  const { db } = blockableDb();
  const seen = [];
  const d = { ...deps(fakeFetch((url, body) => { seen.push(body.messages.at(-1).content); return reply({ reply: 'Registrato.', actions: [] }); })), schedule: () => {} };
  const call = callOf(db, d);
  const r = await call('POST', '/api/sync', { ops: [{ id: 'c1', kind: 'chat', at: T0 - 600_000, text: 'ho mangiato una mela' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.replies[0].reply, JSON.stringify(r.body.replies));
  assert.ok(seen.some(t => /server non rispondeva/.test(t) && /mela/.test(t)));
});

test('scritture finite durante un aggiornamento: le colonne nuove mancano ma /api/state risponde', async () => {
  resetWriteBlock();
  const { db, flag } = blockableDb();
  // Database "vecchio": code_proposals senza le colonne aggiunte dopo (area, attempts...).
  db.run('DROP TABLE code_proposals');
  db.run("CREATE TABLE code_proposals (id TEXT PRIMARY KEY, request TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL DEFAULT 0, files TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL)");
  db.run("INSERT INTO code_proposals (id, request, status, created, updated) VALUES ('c1', 'colori', 'ready', '2026-11-19', '2026-11-19')");
  db.run("DELETE FROM kv WHERE key = 'schemaSignature'");
  flag.blocked = true;
  assert.throws(() => migrate(db), /rows written/, 'la migrazione non deve fingere di essere riuscita');
  const d = { ...deps(fakeFetch(() => reply({}))), schedule: () => {} };
  const r = await handleApi(db, { ...ENV, GITHUB_TOKEN: 'x' }, d, new Request('https://x/api/state'));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.code[0].area, 'web');
  resetWriteBlock();
});
