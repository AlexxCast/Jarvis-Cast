// Ricordi per significato e cassetti chiesti dal modello.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as memory from '../src/memory.js';
import * as semantic from '../src/semantic.js';
import { handleChat } from '../src/brain.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
// Finte impronte: ogni testo diventa un vettore in base all'area di vita di cui parla.
const AREAS = [/allen|palestr|stanc|distrutt|sport/i, /esam|studi|univers/i, /mangi|pranz|cena|calori/i];
const vecOf = (t) => { const v = Array(256).fill(0); AREAS.forEach((re, i) => { if (re.test(t)) v[i] = 1; }); v[255] = 0.3; return v; };
const embedder = (body) => ({ embeddings: body.requests.map(r => ({ values: vecOf(r.content.parts[0].text) })) });

test('significato: "sono distrutto" ritrova la palestra anche senza parole in comune', async () => {
  const db = makeDb();
  memory.remember(db, { module: 'palestra', text: 'Si allena lunedì e giovedì alle 18' }, '2026-11-18T10:00:00Z');
  memory.remember(db, { module: 'studio', text: 'Esame di statistica il 21 novembre' }, '2026-11-18T10:00:00Z');
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  f.embed = embedder;
  assert.equal(await semantic.backfill(db, ENV, f), 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memories WHERE vec = ''").n, 0);
  // Solo parole: niente palestra.
  assert.equal(memory.recall(db, 'sono distrutto da stamattina').entries.filter(e => e.module === 'palestra').length, 0);
  // Con il significato: entra la palestra, non lo studio.
  const qvec = await semantic.embedQuery(ENV, f, 'sono distrutto da stamattina');
  const got = memory.recall(db, 'sono distrutto da stamattina', { qvec }).entries.map(e => e.module);
  assert.deepEqual(got, ['palestra']);
  // Nel contesto della chat.
  await handleChat(db, ENV, deps(f), { text: 'sono distrutto da stamattina' });
  assert.match(f.calls[0].body.messages[0].content, /MEMORIA RILEVANTE[\s\S]*Si allena lunedì/);
});

test('significato: se Gemini non risponde si usa solo la ricerca per parole', async () => {
  const db = makeDb();
  memory.remember(db, { module: 'palestra', text: 'Si allena lunedì e giovedì' }, '2026-11-18T10:00:00Z');
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  const out = await handleChat(db, ENV, deps(f), { text: 'quando mi alleno?' });
  assert.equal(out.reply, 'Ok.');
  assert.match(f.calls[0].body.messages[0].content, /Si allena lunedì/);
});

test('recall: il modello chiede un cassetto che mancava e risponde di nuovo con quei ricordi', async () => {
  const db = makeDb();
  memory.remember(db, { module: 'sonno', text: 'Dorme male quando beve caffè dopo le 17' }, '2026-11-18T10:00:00Z');
  let n = 0;
  const f = fakeFetch((url, body) => {
    n++;
    if (n === 1) return reply({ reply: 'Controllo.', actions: [{ type: 'recall', module: 'sonno' }] });
    return reply({ reply: 'Forse è il caffè del pomeriggio.' });
  });
  const out = await handleChat(db, ENV, deps(f), { text: 'perché stanotte non ho chiuso occhio?' });
  assert.equal(n, 2);
  assert.match(f.calls[1].body.messages[0].content, /Dorme male quando beve caffè/);
  assert.equal(out.reply, 'Forse è il caffè del pomeriggio.');
  assert.ok(!out.actions.includes('recall'));
});

test('significato: con tanti ricordi entra solo quello che spicca, non tutto ciò che somiglia un po\'', async () => {
  const db = makeDb();
  const texts = ['Si allena lunedì e giovedì', 'Esame di statistica il 21 novembre', 'A cena mangia leggero', 'Studia la mattina presto', 'Pranza alle 13', 'Ha l\'esame di inglese a gennaio'];
  texts.forEach((t, i) => memory.remember(db, { module: 'm' + i, text: t }, '2026-11-18T10:00:00Z'));
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  f.embed = embedder;
  await semantic.backfill(db, ENV, f);
  const qvec = await semantic.embedQuery(ENV, f, 'sono distrutto');
  const got = memory.recall(db, 'sono distrutto', { qvec }).entries.map(e => e.text);
  assert.deepEqual(got, ['Si allena lunedì e giovedì']);
});
