import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, deps, fakeFetch, reply } from './helpers.js';
import { handleApi } from '../src/api.js';
import { writeStats, tallyWrites, restoreWriteStats, writeReport } from '../src/db.js';

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
