// Il Worker non deve mai rispondere con una 500 muta quando il Durable Object si blocca.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardToBrain } from '../src/forward.js';

const envWith = (fetchImpl) => ({ JARVIS: { idFromName: () => 'id', get: () => ({ fetch: fetchImpl }) } });

test('inoltro: un riavvio passeggero del Durable Object si riprova una volta', async () => {
  let n = 0;
  const env = envWith(async () => { if (n++ === 0) throw new Error('Durable Object reset because its code was updated.'); return Response.json({ ok: true }); });
  const res = await forwardToBrain(env, new Request('https://x/api/chat', { method: 'POST', body: '{"text":"ciao"}' }));
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test('inoltro: un errore vero arriva all\'app con il motivo, non come "Errore 500"', async () => {
  const env = envWith(async () => { throw new Error('Exceeded CPU time limit'); });
  const res = await forwardToBrain(env, new Request('https://x/api/state'));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /Exceeded CPU time limit/);
});

test('scritture: il battito del PC ogni 2 secondi non scrive nel database a ogni giro', async () => {
  const { makeDb } = await import('./helpers.js');
  const devices = await import('../src/devices.js');
  const { kvGet } = await import('../src/db.js');
  const db = makeDb();
  let writes = 0;
  const run = db.run.bind(db);
  db.run = (sql, ...a) => { if (/devicesRegistry/.test(JSON.stringify(a)) || /devicesRegistry/.test(sql)) writes++; return run(sql, ...a); };
  const t0 = Date.parse('2026-11-18T20:00:00Z');
  for (let i = 0; i < 300; i++) devices.heartbeat(db, { kind: 'desktop', name: 'PC', metrics: { cpu: i % 50, ram: 40, activeWindow: 'Finestra ' + i }, apps: ['Chrome'] }, t0 + i * 2000);
  assert.ok(writes <= 3, `scritture: ${writes}`); // 10 minuti di battiti: la prima, poi una ogni 5 minuti
  const pc = devices.listDevices(db, t0 + 299 * 2000)[0];
  assert.equal(pc.online, true);
  assert.equal(pc.metrics.activeWindow, 'Finestra 299', 'lo stato più recente resta disponibile');
  assert.equal(kvGet(db, 'devicesRegistry')[0].apps[0], 'Chrome');
  // Le app cambiano: si salva subito.
  devices.heartbeat(db, { kind: 'desktop', name: 'PC', apps: ['Chrome', 'Word'] }, t0 + 600_100);
  assert.deepEqual(kvGet(db, 'devicesRegistry')[0].apps, ['Chrome', 'Word']);
});

test('avvio: la migrazione non riscrive nulla se lo schema è già aggiornato', async () => {
  const { makeDb } = await import('./helpers.js');
  const { migrate } = await import('../src/db.js');
  const db = makeDb();
  assert.equal(migrate(db), false);
});

test('richieste: il PC chiede ogni 2 secondi mentre il Capo usa Kestra, più di rado quando è tutto fermo', async () => {
  const { makeDb } = await import('./helpers.js');
  const devices = await import('../src/devices.js');
  const db = makeDb();
  const t0 = Date.parse('2026-11-18T20:00:00Z');
  assert.equal(devices.heartbeat(db, { kind: 'desktop' }, t0).nextPollMs, 8000);
  assert.equal(devices.heartbeat(db, { kind: 'desktop', poll: false }, t0).nextPollMs, 30000);
  devices.markActive(db, t0);
  assert.equal(devices.heartbeat(db, { kind: 'desktop' }, t0 + 60_000).nextPollMs, 2000);
  assert.equal(devices.heartbeat(db, { kind: 'desktop' }, t0 + 11 * 60_000).nextPollMs, 8000);
  devices.enqueueCommand(db, 'desktop', { kind: 'open_app', target: 'Chrome' }, t0 + 12 * 60_000);
  assert.equal(devices.heartbeat(db, { kind: 'desktop' }, t0 + 12 * 60_000 + 5000).nextPollMs, 2000);
});
