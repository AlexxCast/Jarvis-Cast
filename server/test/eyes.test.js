// Occhi di Kestra sul PC (19/11/2026): "che video ci sono", "il terzo", "guarda quel video lì", "vai giù"… "fermo".
// Frasi dette come le dice il Capo, con "ehm" e il nome storpiato; modelli con la vista che sbagliano o inventano.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, followupVerdict } from '../src/brain.js';
import { handleApi } from '../src/api.js';
import { heartbeat } from '../src/devices.js';
import { kvGet } from '../src/db.js';
import { makeDb, fakeFetch, deps } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g' };
const SERA = Date.parse('2026-11-19T22:30:00+01:00');
const noModel = () => fakeFetch(() => { throw new Error('qui non deve servire un modello'); });
const queue = (db) => kvGet(db, 'devicesQueue', []);
const last = (db) => queue(db).at(-1);

function setup({ eyes = true } = {}) {
  const db = makeDb();
  const clock = { ms: SERA };
  heartbeat(db, { id: 'desktop-casa', kind: 'desktop', name: 'PC CASA', poll: false, ...(eyes ? { caps: ['look', 'click', 'autoscroll'] } : {}) }, clock.ms);
  return { db, clock };
}
const say = (db, f, clock, text) => handleChat(db, ENV, { ...deps(f, clock), tz: 'Europe/Rome', schedule: () => {} }, { text, source: 'voice', sessionId: 'voce' });
const lookApi = (db, f, clock, b) => handleApi(db, ENV, { ...deps(f, clock), tz: 'Europe/Rome' }, new Request('https://x/api/pc/look', { method: 'POST', body: JSON.stringify(b) })).then(r => r.json());
const VIDEOS = JSON.stringify({ items: [
  { n: 1, label: 'Ligabue - Certe notti', x: 180, y: 300 },
  { n: 2, label: 'Gatto che suona il piano', x: 500, y: 300 },
  { n: 3, label: 'Ricetta carbonara', x: 820, y: 300 },
], pick: null, point: null, ask: '' });

test('occhi: "che video ci sono" → foto dello schermo, elenco numerato, poi "il terzo" senza modello', async () => {
  const { db, clock } = setup();
  const r = await say(db, noModel(), clock, 'ehm kestra che video ci sono sul pc');
  assert.match(r.reply, /Guardo lo schermo/);
  assert.deepEqual([last(db).kind, last(db).args], ['look', 'list']);

  clock.ms += 4000;
  const seen = await lookApi(db, fakeFetch(() => VIDEOS), clock, { image: 'AAAA', w: 1920, h: 1080, mode: 'list' });
  assert.equal(seen.ok, true);
  assert.match(seen.say, /1, Ligabue - Certe notti\. 2, Gatto che suona il piano\. 3, Ricetta carbonara/);
  assert.equal(seen.click, null);
  assert.ok(db.all("SELECT text FROM messages WHERE session = 'voce' AND role = 'assistant'").some(m => /Ricetta carbonara/.test(m.text)), 'resta nella chat');

  clock.ms += 3000;
  const t = await say(db, noModel(), clock, 'eh il terzo');
  assert.match(t.reply, /Apro il 3: Ricetta carbonara/);
  assert.deepEqual([last(db).kind, last(db).target], ['click', '820,300']);

  // Dopo il clic la pagina è cambiata: "l'ultimo" non clicca a caso sulle vecchie posizioni, riguarda lo schermo.
  clock.ms += 3000;
  await say(db, noModel(), clock, "apri l'ultimo");
  assert.deepEqual([last(db).kind, last(db).args], ['look', 'pick']);
});

test('occhi: ordinale fuori elenco, "l\'ultimo", e scorrere rende vecchio l\'elenco', async () => {
  const { db, clock } = setup();
  await say(db, noModel(), clock, 'cosa vedi sullo schermo del pc');
  await lookApi(db, fakeFetch(() => VIDEOS), clock, { image: 'AAAA', mode: 'list' });
  clock.ms += 2000;
  const r5 = await say(db, noModel(), clock, 'metti il quinto');
  assert.match(r5.reply, /Ne vedo solo 3/);
  const rl = await say(db, noModel(), clock, "apri l'ultimo video");
  assert.match(rl.reply, /Ricetta carbonara/);

  await lookApi(db, fakeFetch(() => VIDEOS), clock, { image: 'AAAA', mode: 'list' });
  clock.ms += 2000;
  await say(db, noModel(), clock, 'più giù');
  clock.ms += 2000;
  await say(db, noModel(), clock, 'il secondo');
  assert.deepEqual([last(db).kind, last(db).args], ['look', 'pick'], 'dopo lo scorrimento i numeri non valgono più');
});

test('occhi: "guarda quel video lì" e "quello col gatto" → il modello sceglie, il PC clicca', async () => {
  const { db, clock } = setup();
  await say(db, noModel(), clock, 'apri youtube sul pc');
  clock.ms += 5000;
  const r = await say(db, noModel(), clock, 'guarda quel video lì');
  assert.match(r.reply, /Guardo lo schermo e lo apro/);
  assert.deepEqual([last(db).kind, last(db).args, last(db).target], ['look', 'pick', 'guarda quel video lì']);
  await say(db, noModel(), clock, 'quello col gatto');
  assert.deepEqual([last(db).kind, last(db).args], ['look', 'pick']);

  const f = fakeFetch(() => JSON.stringify({ ...JSON.parse(VIDEOS), pick: 2 }));
  const seen = await lookApi(db, f, clock, { image: 'AAAA', w: 1920, h: 1080, cursor: { x: 960, y: 540 }, mode: 'pick', phrase: 'quello col gatto' });
  assert.deepEqual(seen.click, { x: 500, y: 300 });
  assert.match(seen.say, /Apro Gatto che suona il piano/);
  const sent = JSON.stringify(f.calls[0].body);
  assert.match(sent, /image_url/, 'la foto arriva al modello');
  assert.match(sent, /puntatore del mouse è a x=500, y=500/);
});

test('occhi: modello che sbaglia, inventa o non vede → niente clic a caso', async () => {
  const { db, clock } = setup();
  const pick = (out) => lookApi(db, fakeFetch(() => out), clock, { image: 'AAAA', mode: 'pick', phrase: 'il terzo' });
  let r = await pick('non saprei proprio');
  assert.equal(r.ok, false); assert.equal(r.click ?? null, null);
  r = await pick(JSON.stringify({ ...JSON.parse(VIDEOS), pick: 9 }));
  assert.equal(r.click, null, 'un numero che non esiste non diventa un clic');
  assert.match(r.say, /Dimmi il numero/);
  r = await pick(JSON.stringify({ items: [], pick: null, ask: 'Quale, quello rosso o quello blu?' }));
  assert.equal(r.click, null); assert.match(r.say, /quello rosso o quello blu/);
  r = await pick(JSON.stringify({ items: [{ label: 'X', x: 5000, y: -20 }], pick: 1 }));
  assert.deepEqual(r.click, { x: 1000, y: 0 }, 'coordinate fuori schermo riportate dentro');
  r = await lookApi(db, fakeFetch(() => ({ status: 503, json: { error: 'giù' } })), clock, { image: 'AAAA', mode: 'list' });
  assert.equal(r.ok, false); assert.match(r.say, /non riesco a guardare/i);
  r = await lookApi(db, noModel(), clock, { mode: 'list' });
  assert.equal(r.ok, false);
});

test('scorrimento continuo: "vai giù" scorre da solo, "fermo" lo ferma; "fermo" senza scorrimento non tocca il PC', async () => {
  const { db, clock } = setup();
  await say(db, noModel(), clock, 'apri prime video sul pc');
  const r = await say(db, noModel(), clock, 'vai giù');
  assert.match(r.reply, /Scendo\. Dimmi "fermo"/);
  assert.deepEqual([last(db).kind, last(db).target, last(db).args], ['scroll', 'down', 'auto']);
  assert.equal(r.expectReply, true, 'resta in ascolto per il "fermo"');
  clock.ms += 3000;
  const s = await say(db, noModel(), clock, 'fermo fermo');
  assert.equal(s.reply, 'Fermo.');
  assert.deepEqual([last(db).kind, last(db).target], ['scroll', 'stop']);

  const before = queue(db).length;
  clock.ms += 60_000;
  await say(db, fakeFetch(() => JSON.stringify({ reply: 'Ok.', actions: [] })), clock, 'fermo');
  assert.equal(queue(db).length, before, 'nessuno scorrimento in corso: "fermo" non manda niente al PC');

  heartbeat(db, { id: 'desktop-casa', kind: 'desktop', name: 'PC CASA', poll: false }, clock.ms); // il PC è ancora acceso
  await say(db, noModel(), clock, 'scorri su piano');
  assert.deepEqual([last(db).target, last(db).args], ['up', 'auto']);
  await say(db, noModel(), clock, 'torna un po su');
  assert.deepEqual(queue(db).slice(-2).map(c => c.target), ['stop', 'up']);
  // "un po' più giù" resta il passo singolo di prima
  await say(db, noModel(), clock, "un po' più giù");
  assert.equal(last(db).args, '');
});

test('occhi: commenti e richieste per altri non diventano clic', async () => {
  const { db, clock } = setup();
  await say(db, noModel(), clock, 'apri youtube sul pc');
  const n = queue(db).length;
  const chat = fakeFetch(() => JSON.stringify({ reply: 'Sì, è carino.', actions: [] }));
  for (const t of ['quello lì è bello', 'quella è mia sorella', 'quel film era bellissimo']) {
    await say(db, chat, clock, t);
    assert.equal(queue(db).length, n, t);
  }
  // "metti il video di Ligabue" resta la ricerca su YouTube che c'era già
  await say(db, noModel(), clock, 'metti il video di ligabue');
  assert.notEqual(last(db).kind, 'look');
});

test('occhi: programma del PC vecchio → lo dice invece di far finta', async () => {
  const { db, clock } = setup({ eyes: false });
  const r = await say(db, noModel(), clock, 'che video ci sono sul pc');
  assert.match(r.reply, /programma del PC va aggiornato/);
  assert.ok(!queue(db).some(c => c.kind === 'look'));
  await say(db, noModel(), clock, 'apri youtube sul pc');
  await say(db, noModel(), clock, 'vai giù');
  assert.deepEqual([last(db).kind, last(db).args], ['scroll', ''], 'il programma vecchio fa il passo singolo');
});

test('ascolto aperto: "fermo", "il terzo", "quello col gatto" passano senza dire Kestra', () => {
  for (const t of ['fermo', 'ferma lì', 'il terzo', 'quello col gatto', 'clicca sul secondo']) assert.equal(followupVerdict(t, 'Scendo.'), 'yes', t);
});
