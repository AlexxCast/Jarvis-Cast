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
