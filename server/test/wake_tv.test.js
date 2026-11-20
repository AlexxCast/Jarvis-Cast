// Falsi allarmi con TV e video (20/11/2026): dopo un "Kestra" sentito dal modello del telefono la prima frase
// passa dal filtro TV, così Kestra non risponde ai dialoghi di un film o di TikTok.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, followupVerdict } from '../src/brain.js';
import { kvGet } from '../src/db.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };

test('dopo il nome: le frasi corte non passano da sole, i comandi chiari sì', () => {
  assert.equal(followupVerdict('ma dai davvero'), 'yes', 'a conversazione aperta resta come prima');
  assert.equal(followupVerdict('ma dai davvero', '', { afterWake: true }), 'ask');
  assert.equal(followupVerdict('sì', 'Vuoi che lo segni?', { afterWake: true }), 'ask');
  assert.equal(followupVerdict('che ore sono', '', { afterWake: true }), 'yes');
  assert.equal(followupVerdict('che tempo fa domani', '', { afterWake: true }), 'yes');
  assert.equal(followupVerdict('aggiungi 200 grammi di pasta a pranzo', '', { afterWake: true }), 'yes');
  assert.equal(followupVerdict('apri whatsapp', '', { afterWake: true }), 'yes');
});

test('dopo il nome con un video sul telefono: il dialogo del video viene ignorato in silenzio', async () => {
  const db = makeDb();
  let prompt = '';
  const f = fakeFetch((url, body) => { prompt = body.messages?.[0]?.content || ''; return 'NO'; });
  const out = await handleChat(db, ENV, deps(f), { text: 'no amore non te ne andare ti prego', source: 'voice', afterWake: true, media: true });
  assert.equal(out.ignored, true);
  assert.equal(out.reply, '');
  assert.equal(f.calls.length, 1, 'una sola chiamata breve al modello');
  assert.match(prompt, /video o musica/);
  assert.equal(db.all('SELECT id FROM messages').length, 0);
  assert.equal(kvGet(db, 'ignoredHeard', []).length, 1);
});

test('dopo il nome: una richiesta vera passa e riceve risposta', async () => {
  const db = makeDb();
  const g = fakeFetch((url, body) => body.max_tokens <= 10 ? 'SI' : reply({ reply: 'Domani alle 7.' }));
  const ok = await handleChat(db, ENV, deps(g), { text: 'a che ora ho la palestra domani', source: 'voice', afterWake: true });
  assert.notEqual(ok.ignored, true);
  assert.equal(ok.reply, 'Domani alle 7.');
});

test('dopo il nome: se il modello non risponde, la richiesta non si perde', async () => {
  const db = makeDb();
  const h = fakeFetch((url, body) => { if (body.max_tokens <= 10) throw new Error('rete'); return reply({ reply: 'Ok.' }); });
  const out = await handleChat(db, ENV, deps(h), { text: 'ricordami di chiamare la mamma stasera', source: 'voice', afterWake: true });
  assert.notEqual(out.ignored, true);
});

test('dopo il nome senza video sul telefono: la richiesta non viene mai scartata (regressione 2.45)', async () => {
  const db = makeDb();
  const f = fakeFetch((url, body) => body.max_tokens <= 10 ? 'NO' : reply({ reply: 'Bravo Capo, quanti chilometri?' }));
  const out = await handleChat(db, ENV, deps(f), { text: 'volevo dirti che oggi sono andato a correre', source: 'voice', afterWake: true });
  assert.notEqual(out.ignored, true);
  assert.equal(out.reply, 'Bravo Capo, quanti chilometri?');
  assert.equal(kvGet(db, 'ignoredHeard', []).length, 0);
});
