import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, deps, fakeFetch, reply } from './helpers.js';
import { handleApi } from '../src/api.js';
import { writeStats, tallyWrites, restoreWriteStats, writeReport, kvSet } from '../src/db.js';

const call = (db, d, method, path, b) => handleApi(db, {}, d, new Request('https://x' + path, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).then(r => r.json());

test('scritture: il contatore dice chi ha scritto e in quale tabella', async () => {
  const db = makeDb();
  const d = deps(fakeFetch(() => reply({ reply: 'Sono le 12.' })));
  writeStats.day = '';
  await call(db, d, 'POST', '/api/chat', { text: 'che ore sono', source: 'voice' });
  await call(db, d, 'GET', '/api/state');
  const r = await call(db, d, 'GET', '/api/writes');
  assert.ok(r.total > 0 && r.limit === 100000);
  assert.equal(r.sources[0].name, 'POST /api/chat');
  assert.ok(r.tables.some(t => t.name === 'messages'));
  assert.ok(!r.sources.some(s => s.name === 'GET /api/state'), 'leggere lo stato non deve scrivere');
});

test('scritture: si azzerano a mezzanotte UTC e si riprendono dopo un riavvio', () => {
  const t1 = Date.UTC(2026, 10, 19, 23, 50), t2 = Date.UTC(2026, 10, 20, 0, 10);
  writeStats.day = '';
  tallyWrites('INSERT INTO kv (key, value) VALUES (?, ?)', 3, t1);
  assert.equal(writeReport().total, 3);
  tallyWrites('UPDATE topics SET uses = 1', 2, t2);
  assert.equal(writeReport().total, 2);
  const saved = JSON.parse(JSON.stringify(writeStats));
  writeStats.day = '';
  restoreWriteStats(saved, t2);
  assert.equal(writeReport().total, 2);
  assert.equal(writeReport().tables[0].name, 'topics');
});

test('scritture: rileggere la sfera e il battito a vuoto non scrivono nulla', async () => {
  const { T0: t0 } = await import('./helpers.js');
  const memory = await import('../src/memory.js');
  const jarvisCore = await import('../src/jarvis_core.js');
  const agenda = await import('../src/agenda.js');
  const db = makeDb();
  const d = deps(fakeFetch(() => reply({ reply: 'ok' })));
  const iso = new Date(t0).toISOString();
  const tops = [];
  for (const area of ['lavoro', 'casa', 'telefono']) {
    tops.push({ area, topic: 'WhatsApp' }, { area, topic: 'Klagenfurt' });
    for (let i = 0; i < 8; i++) tops.push({ area, topic: `lettura WhatsApp ${i}x`, parent: 'WhatsApp' }, { area, topic: `ristoranti Klagenfurt n${i}` });
  }
  memory.touchTopics(db, tops, iso);
  await call(db, d, 'GET', '/api/graph'); // il primo giro riordina davvero (annida i figli)
  const beat = () => { d.clock.ms += 15 * 60_000; jarvisCore.selfInterrogate(db, {}, d.clock.ms, 'Europe/Rome'); agenda.fireDue(db, d.clock.ms, 'Europe/Rome'); };
  beat();
  writeStats.day = ''; writeStats.total = 0;
  for (let i = 0; i < 5; i++) { await call(db, d, 'GET', '/api/graph'); await call(db, d, 'GET', '/api/mind'); }
  for (let i = 0; i < 5; i++) beat();
  assert.equal(writeStats.total, 0, `scritture inutili: ${JSON.stringify(writeStats.byTable)}`);
  // Un argomento nuovo si riordina alla lettura successiva, come prima.
  memory.touchTopics(db, [{ area: 'lavoro', topic: 'impostazioni privacy WhatsApp' }], iso);
  await call(db, d, 'GET', '/api/graph');
  assert.equal(db.get("SELECT parent FROM topics WHERE module = 'lavoro' AND label LIKE 'impostazioni privacy%'")?.parent, 'whatsapp');
});

test('scritture: salvare in kv lo stesso valore non costa righe', () => {
  const db = makeDb();
  kvSet(db, 'x', { a: 1 });
  writeStats.day = ''; writeStats.total = 0;
  kvSet(db, 'x', { a: 1 });
  assert.equal(writeStats.total, 0);
  kvSet(db, 'x', { a: 2 });
  assert.equal(writeStats.total, 1);
});

test('scritture: la chat che aspetta il modello non viene contata alla sfera letta nel frattempo', async () => {
  const db = makeDb();
  let release, reached; const gate = new Promise(r => { release = r; }); const hit = new Promise(r => { reached = r; });
  const d = deps(fakeFetch(async () => { reached(); await gate; return reply({ reply: 'Ho segnato la riunione con Marco.', topics: [{ area: 'lavoro', topic: 'riunione con Marco' }] }); }));
  const env = { GROQ_API_KEY: 'q' };
  const req = (method, path, b) => handleApi(db, env, d, new Request('https://x' + path, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).then(r => r.json());
  writeStats.day = '';
  const chat = req('POST', '/api/chat', { text: 'spiegami bene come funziona la fotosintesi nelle piante', source: 'voice' });
  await hit;
  await req('GET', '/api/graph');
  release(); await chat;
  assert.ok(!writeStats.bySource['GET /api/graph'], `la sfera non scrive: ${JSON.stringify(writeStats.bySource)}`);
  assert.ok(writeStats.bySource['POST /api/chat'] > 5);
  assert.ok(writeReport().pairs.some(p => p.name === 'POST /api/chat › messages'));
});
