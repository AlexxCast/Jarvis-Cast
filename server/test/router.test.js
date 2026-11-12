import test from 'node:test';
import assert from 'node:assert/strict';
import * as router from '../src/router.js';
import { kvSet } from '../src/db.js';
import { makeDb, fakeFetch, T0 } from './helpers.js';

const MODELS = [
  { provider: 'gemini', model: 'a-flash', tiers: ['fast', 'smart', 'vision'], ctx: 100000, rpm: 10, rpd: 100, free: true, prio: 10 },
  { provider: 'groq', model: 'b-llama', tiers: ['fast', 'smart'], ctx: 100000, rpm: 30, free: true, prio: 20 },
  { provider: 'anthropic', model: 'c-paid', tiers: ['fast', 'smart', 'vision'], ctx: 200000, free: false, prio: 90 },
];
const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', ANTHROPIC_API_KEY: 'a' };
const setup = () => { const db = makeDb(); kvSet(db, 'models', MODELS); return db; };
const build = () => [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ciao' }];
const run = (db, fetchFn, over = {}) => router.chat(db, ENV, { tier: 'fast', build, fetchFn, now: () => over.ms ?? T0, tz: 'Europe/Rome', ...over });

test('usa il modello con priorità più alta e conta l\'uso', async () => {
  const db = setup();
  const f = fakeFetch(() => 'ok');
  const res = await run(db, f);
  assert.equal(res.key, 'gemini:a-flash');
  assert.equal(res.switched, false);
  assert.match(f.calls[0].url, /generativelanguage/);
  assert.equal(f.calls[0].headers.authorization, 'Bearer g');
  assert.equal(router.status(db, ENV, T0)[0].requestsToday, 1);
});

test('cambio anticipato: all\'80% del limite passa al modello successivo PRIMA dell\'errore', async () => {
  const db = setup();
  const f = fakeFetch(() => 'ok');
  const used = [];
  for (let i = 0; i < 10; i++) used.push((await run(db, f, { preferKey: 'gemini:a-flash' })).key);
  // rpm 10 → le prime 7 richieste restano sotto l'80%, dall'ottava si cambia senza aver mai ricevuto un 429.
  assert.deepEqual(used.slice(0, 7), Array(7).fill('gemini:a-flash'));
  assert.deepEqual(used.slice(7), Array(3).fill('groq:b-llama'));
  assert.equal(f.calls.filter(c => /generativelanguage/.test(c.url)).length, 7);
  const events = db.all("SELECT text FROM events WHERE kind = 'switch'");
  assert.ok(events.length >= 1);
  assert.match(events[0].text, /gemini:a-flash → groq:b-llama/);
});

test('al minuto successivo torna al modello principale', async () => {
  const db = setup();
  const f = fakeFetch(() => 'ok');
  for (let i = 0; i < 9; i++) await run(db, f);
  const res = await run(db, f, { ms: T0 + 61_000 });
  assert.equal(res.key, 'gemini:a-flash');
});

test('429: stessa richiesta ripetuta subito su un altro provider, il primo va in pausa', async () => {
  const db = setup();
  const f = fakeFetch((url) => /generativelanguage/.test(url) ? { status: 429, json: { error: { message: 'quota' } }, headers: { 'retry-after': '120' } } : 'risposta groq');
  const res = await run(db, f);
  assert.equal(res.text, 'risposta groq');
  assert.equal(res.key, 'groq:b-llama');
  const st = router.status(db, ENV, T0).find(m => m.key === 'gemini:a-flash');
  assert.ok(st.blockedForSec > 100 && st.blockedForSec <= 120);
  // Durante la pausa non viene nemmeno contattato.
  const f2 = fakeFetch(() => 'ok');
  await run(db, f2);
  assert.equal(f2.calls.length, 1);
  assert.match(f2.calls[0].url, /groq/);
});

test('modello ritirato (404) disattivato per un giorno', async () => {
  const db = setup();
  const f = fakeFetch((url) => /generativelanguage/.test(url) ? { status: 404, json: { error: { message: 'model not found' } } } : 'ok');
  await run(db, f);
  assert.ok(router.status(db, ENV, T0)[0].blockedForSec > 23 * 3600);
});

test('i modelli a pagamento entrano solo quando i gratuiti non sono disponibili', async () => {
  const db = setup();
  const f = fakeFetch((url, body) => /anthropic/.test(url)
    ? { status: 200, json: { content: [{ type: 'text', text: 'da claude' }], usage: { input_tokens: 5, output_tokens: 5 } } }
    : { status: 500, json: { error: { message: 'down' } } });
  const res = await run(db, f);
  assert.equal(res.key, 'anthropic:c-paid');
  assert.equal(res.text, 'da claude');
  const call = f.calls.at(-1);
  assert.equal(call.headers['x-api-key'], 'a');
  assert.equal(call.body.system, 'sys');
  assert.deepEqual(call.body.messages, [{ role: 'user', content: 'ciao' }]);
});

test('le immagini vanno solo ai modelli che le leggono', async () => {
  const db = setup();
  const ranked = router.rank(db, ENV, { tier: 'fast', needsVision: true, ms: T0 });
  assert.deepEqual(ranked.map(r => r.key), ['gemini:a-flash', 'anthropic:c-paid']);
});

test('provider senza chiave ignorati; senza nessuna chiave errore chiaro', async () => {
  const db = setup();
  assert.deepEqual(router.rank(db, { GROQ_API_KEY: 'q' }, { tier: 'fast', ms: T0 }).map(r => r.key), ['groq:b-llama']);
  await assert.rejects(router.chat(db, {}, { build, fetchFn: fakeFetch(() => 'ok'), now: () => T0 }), /Nessuna chiave API/);
});

test('tutti esauriti: errore con l\'elenco dei tentativi', async () => {
  const db = setup();
  const f = fakeFetch(() => ({ status: 429, json: { error: { message: 'rate' } } }));
  await assert.rejects(run(db, f), (e) => e.tried.length === 3 && /esauriti/.test(e.message));
});

test('intestazioni x-ratelimit: sotto il 20% residuo il modello passa in fondo', async () => {
  const db = setup();
  const f = fakeFetch((url) => /generativelanguage/.test(url)
    ? { status: 200, json: { choices: [{ message: { content: 'ok' } }] }, headers: { 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-limit-requests': '100' } }
    : 'ok');
  assert.equal((await run(db, f)).key, 'gemini:a-flash');
  assert.equal((await run(db, f)).key, 'groq:b-llama');
});

test('il contesto viene ricostruito per ogni modello provato', async () => {
  const db = setup();
  const seen = [];
  const f = fakeFetch((url) => /generativelanguage/.test(url) ? { status: 503, json: {} } : 'ok');
  await router.chat(db, ENV, { build: (m) => { seen.push(m.model); return build(); }, fetchFn: f, now: () => T0 });
  assert.deepEqual(seen, ['a-flash', 'b-llama']);
});

test('classificazione della complessità', () => {
  assert.equal(router.classifyTier('aggiungi 100 grammi di pasta'), 'fast');
  assert.equal(router.classifyTier('pianificami i pasti della settimana'), 'smart');
  assert.equal(router.classifyTier('cosa vedi?', true), 'vision');
});
