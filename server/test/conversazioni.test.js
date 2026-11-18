// Prove di conversazioni vere, su più giorni e più chat: Kestra deve avere nel contesto quello che serve
// per capire frasi che da sole non dicono abbastanza. Il modello è finto: si controlla cosa riceve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat } from '../src/brain.js';
import * as memory from '../src/memory.js';
import * as semantic from '../src/semantic.js';
import * as initiative from '../src/initiative.js';
import * as continuity from '../src/continuity.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
const TZ = 'Europe/Rome';
const at = (iso) => Date.parse(iso);
const systemOf = (call) => call.body.messages[0].content;
const say = async (db, f, clock, text, opts = {}) => handleChat(db, ENV, { ...deps(f, clock), tz: TZ }, { text, ...opts });

test('conversazione su tre giorni: "domani ho l\'esame" diventa un filo che Kestra riprende da sola', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-18T21:00:00+01:00') };
  const f = fakeFetch(() => reply({ reply: 'In bocca al lupo, Capo.' }));
  await say(db, f, clock, 'domani ho l\'esame di statistica e sono in ansia');
  assert.equal(continuity.load(db).open.filter(o => o.kind === 'piano')[0].due, '2026-11-19');

  // Il giorno dopo, in un'altra chat: il filo è nel contesto anche se il Capo dice solo "ciao".
  clock.ms = at('2026-11-19T08:00:00+01:00');
  await say(db, f, clock, 'ciao Kestra', { sessionId: 'voce' });
  assert.match(systemOf(f.calls.at(-1)), /CONTINUITÀ[\s\S]*Filo aperto: "domani ho l'esame di statistica[^"]*" \(detto [^;]+; è oggi\)/);

  // Il giorno dopo ancora, senza che il Capo scriva: Kestra chiede com'è andata, una volta sola.
  clock.ms = at('2026-11-20T10:00:00+01:00');
  initiative.tick(db, clock.ms, TZ, { force: true });
  const asked = db.all("SELECT text FROM inbox WHERE kind = 'initiative'").map(r => r.text);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Ieri mi avevi detto: "domani ho l'esame di statistica[^"]*"\. Com'è andata\?/);
  initiative.tick(db, clock.ms + 3 * 3600_000, TZ, { force: true });
  assert.equal(db.all("SELECT text FROM inbox WHERE kind = 'initiative'").length, 1, 'niente doppioni');
});

test('conversazione: se il Capo ne parla da solo dopo la data, Kestra non chiede più', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-18T21:00:00+01:00') };
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  await say(db, f, clock, 'domani vado dal dentista alle 10');
  clock.ms = at('2026-11-19T18:00:00+01:00');
  await say(db, f, clock, 'il dentista mi ha tolto il dente, che male');
  clock.ms = at('2026-11-20T10:00:00+01:00');
  initiative.tick(db, clock.ms, TZ, { force: true });
  assert.equal(db.all("SELECT text FROM inbox WHERE kind = 'initiative'").length, 0);
});

test('conversazione tra chat: "allora, a che punto siamo?" ritrova cosa si è fatto a voce poco prima', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-18T18:00:00+01:00') };
  const f = fakeFetch((url, body, n) => n === 1
    ? reply({ reply: 'Fatto: ti ricordo di chiamare Luca alle 20.', actions: [{ type: 'add_reminder', text: 'Chiamare Luca', due: '2026-11-18T20:00' }] })
    : reply({ reply: 'Ok.' }));
  await say(db, f, clock, 'ricordami di chiamare Luca alle 20', { sessionId: 'voce', source: 'voice' });
  clock.ms += 10 * 60_000;
  await say(db, f, clock, 'allora, a che punto siamo?', { sessionId: 'main' });
  const sys = systemOf(f.calls.at(-1));
  assert.match(sys, /Ultime azioni fatte: promemoria creato \(10 min fa, in un'altra chat\)/);
  assert.match(sys, /Ultimo scambio altrove, 10 min fa: il Capo "ricordami di chiamare Luca alle 20"/);
});

test('conversazione lunga: dopo 30 messaggi un dettaglio detto all\'inizio arriva dal riassunto', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-18T10:00:00+01:00') };
  const f = fakeFetch((url, body) => /^Riassumi/.test(body.messages[0].content)
    ? 'Il Capo organizza un viaggio a Lisbona dal 5 all\'8 dicembre; volo Ryanair da Venezia a 89 euro andata e ritorno.'
    : reply({ reply: 'Ok, segnato.' }));
  await say(db, f, clock, 'sto organizzando Lisbona dal 5 all\'8 dicembre, il volo da Venezia costa 89 euro');
  for (let i = 0; i < 15; i++) { clock.ms += 60_000; await say(db, f, clock, `altra cosa numero ${i} sul viaggio: museo, ristorante, tram ${i}`); }
  clock.ms += 60_000;
  await say(db, f, clock, 'quanto costava il volo che ti ho detto all\'inizio?');
  assert.match(systemOf(f.calls.at(-1)), /RIASSUNTO DELLA CONVERSAZIONE FINORA[\s\S]*89 euro/);
});

test('una frase, più cassetti: "sono a pezzi, ho dormito 4 ore e domani ho l\'interrogazione"', async () => {
  const db = makeDb();
  const AREAS = [/allen|palestr|pezzi|stanc/i, /dorm|sonno|notte/i, /esam|interrog|studi/i, /cucin|ricett|pasta/i];
  const vecOf = (t) => { const v = Array(256).fill(0); AREAS.forEach((re, i) => { if (re.test(t)) v[i] = 1; }); v[255] = 0.2; return v; };
  const notes = [
    ['palestra', 'Si allena il lunedì e il giovedì alle 18'], ['sonno', 'Se dorme meno di 6 ore il giorno dopo è nervoso'],
    ['studio', 'Ripassa meglio la mattina con le mappe'], ['cucina', 'La sua ricetta preferita è la carbonara'],
    ['cucina', 'Odia i funghi'], ['auto', 'La Panda fa il tagliando a 60000 km'], ['casa', 'Il condominio si paga a marzo'],
  ];
  for (const [module, text] of notes) memory.remember(db, { module, text }, '2026-11-01T10:00:00Z');
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  f.embed = (body) => ({ embeddings: body.requests.map(r => ({ values: vecOf(r.content.parts[0].text) })) });
  await semantic.backfill(db, ENV, f);
  const clock = { ms: at('2026-11-18T22:00:00+01:00') };
  await say(db, f, clock, 'sono a pezzi, ho dormito 4 ore e domani ho l\'interrogazione');
  const mem = /MEMORIA RILEVANTE\n([\s\S]*?)(\n\n|$)/.exec(systemOf(f.calls.at(-1)))?.[1] || '';
  for (const m of ['(palestra)', '(sonno)', '(studio)']) assert.ok(mem.includes(m), `manca ${m} in:\n${mem}`);
  for (const m of ['(cucina)', '(auto)', '(casa)']) assert.ok(!mem.includes(m), `non doveva entrare ${m}`);
});

test('nessun crash: messaggi vuoti, lunghissimi, solo emoji, e un modello che risponde male', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-18T12:00:00+01:00') };
  let n = 0;
  const f = fakeFetch(() => { n++; return n % 2 ? 'non è JSON {{{' : reply({ reply: 'Ok.' }); });
  for (const text of ['🙂🙂🙂', 'a'.repeat(20000), 'e quindi?', 'domani 31/02 ho una cosa', 'il 45 dicembre parto']) {
    const out = await say(db, f, clock, text);
    assert.equal(typeof out.reply, 'string');
    clock.ms += 60_000;
  }
  assert.equal(continuity.planDate('il 45 dicembre parto', '2026-11-18'), null);
});
