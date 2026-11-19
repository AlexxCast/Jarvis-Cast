// Autonomia: motore di iniziativa, notifiche del telefono, apprendimento dalle correzioni.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as initiative from '../src/initiative.js';
import * as lessons from '../src/lessons.js';
import * as memory from '../src/memory.js';
import { handleChat } from '../src/brain.js';
import { kvGet, logEvent } from '../src/db.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
const TZ = 'Europe/Rome';
const at = (iso) => Date.parse(iso);
const inbox = (db) => db.all('SELECT kind, text FROM inbox ORDER BY id');

test('iniziativa: un errore ripetuto viene detto una volta sola, non a ogni giro', () => {
  const db = makeDb();
  const ms = at('2026-11-18T15:00:00+01:00');
  for (let i = 0; i < 4; i++) logEvent(db, '2026-11-18T14:3' + i + ':00+01:00', 'error', `azione dichiarata ma non eseguita (update_meal): pranzo ${i}`);
  assert.deepEqual(initiative.tick(db, ms, TZ), ['sent']);
  assert.match(inbox(db)[0].text, /è fallito 4 volte/);
  assert.equal(initiative.tick(db, ms + 11 * 60_000, TZ).length, 0, 'stessa chiave: niente doppione');
});

test('iniziativa: le scadenze nei ricordi arrivano tre giorni prima e il giorno prima', () => {
  const db = makeDb();
  memory.remember(db, { module: 'studio', text: 'Esame di statistica il 21 novembre alle 9' }, '2026-11-01T10:00:00+01:00');
  memory.remember(db, { module: 'studio', text: 'Mi piace studiare la mattina' }, '2026-11-01T10:00:00+01:00');
  assert.equal(initiative.dateIn('consegna 3/12', '2026-11-18'), '2026-12-03');
  assert.equal(initiative.dateIn('volo il 5 gennaio', '2026-12-20'), '2027-01-05');
  initiative.tick(db, at('2026-11-18T10:00:00+01:00'), TZ);
  assert.match(inbox(db).at(-1).text, /tra tre giorni c'è questo: "Esame di statistica/);
  initiative.tick(db, at('2026-11-20T10:00:00+01:00'), TZ);
  assert.match(inbox(db).at(-1).text, /domani c'è questo/);
  assert.equal(inbox(db).length, 2);
});

test('iniziativa: di notte gli avvisi aspettano il mattino e arrivano riuniti', () => {
  const db = makeDb();
  const night = at('2026-11-18T23:30:00+01:00');
  assert.equal(initiative.propose(db, { key: 'a', text: 'Primo avviso.' }, night, TZ), 'queued');
  assert.equal(initiative.propose(db, { key: 'b', text: 'Secondo avviso.' }, night, TZ), 'queued');
  assert.equal(inbox(db).length, 0);
  initiative.tick(db, at('2026-11-19T07:30:00+01:00'), TZ);
  assert.match(inbox(db)[0].text, /mentre dormivi: Primo avviso\. — Secondo avviso\./);
  // Spenta: nessun avviso normale.
  initiative.saveSettings(db, { level: 'off' });
  assert.equal(initiative.propose(db, { key: 'c', text: 'x' }, at('2026-11-19T12:00:00+01:00'), TZ), 'off');
});

test('notifiche: un messaggio urgente avvisa subito, i codici non vengono salvati, le promo vengono scartate', async () => {
  const db = makeDb();
  const ms = at('2026-11-18T23:50:00+01:00');
  const r = initiative.ingestNotifications(db, [
    { app: 'com.whatsapp', label: 'WhatsApp', title: 'Mamma', text: 'Chiamami appena puoi è urgente' },
    { app: 'com.bank', label: 'Banca', title: 'Accesso', text: 'Il tuo codice di verifica è 482913' },
    { app: 'com.shop', label: 'Shop', title: 'Black Friday', text: '50% di sconto solo oggi' },
  ], ms, TZ);
  assert.deepEqual(r, { stored: 2, alerts: 1 });
  assert.match(inbox(db)[0].text, /Mamma ti ha scritto su WhatsApp e sembra urgente/);
  const saved = kvGet(db, 'phoneNotifications', []);
  assert.ok(!JSON.stringify(saved).includes('482913'));
  // "Chi mi ha scritto?": le notifiche entrano nel contesto.
  const f = fakeFetch(() => reply({ reply: 'Ti ha scritto la mamma.' }));
  await handleChat(db, ENV, deps(f), { text: 'chi mi ha scritto?' });
  assert.match(f.calls[0].body.messages[0].content, /NOTIFICHE RECENTI DEL TELEFONO[\s\S]*WhatsApp: Mamma/);
});

test('correzioni: la regola imparata torna nel contesto le volte dopo', async () => {
  const db = makeDb();
  // Il modello scrive la regola con learn.
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Giusto, metto Vasco su Joytify.', actions: [{ type: 'learn', rule: 'Per la musica il Capo usa Joytify, non Spotify' }] }))), { text: 'no, ti ho detto Joytify non Spotify' });
  assert.equal(lessons.list(db).length, 1);
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  await handleChat(db, ENV, deps(f), { text: 'metti un po\' di musica rilassante' });
  assert.match(f.calls[0].body.messages[0].content, /LEZIONI IMPARATE[\s\S]*Joytify, non Spotify/);
  // Regola quasi uguale: si aggiorna, non si duplica.
  lessons.learn(db, 'Per la musica il Capo usa sempre Joytify e non Spotify', '2026-11-18T20:00:00Z');
  assert.equal(lessons.list(db).length, 1);
});

test('correzioni: senza regola dal modello si impara lo scambio, ma un "no" a una domanda non è una correzione', async () => {
  const db = makeDb();
  const d = deps(fakeFetch(() => reply({ reply: 'Vuoi che lo registri come pranzo?' })));
  await handleChat(db, ENV, d, { text: 'ho mangiato un panino' });
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Va bene.' }))), { text: 'no lascia stare per ora grazie' });
  assert.equal(lessons.list(db).length, 0);
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Apro Maps.', actions: [{ type: 'open_app', name: 'Maps' }] }))), { text: 'portami a casa' });
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Scusa, apro Waze.', actions: [{ type: 'open_app', name: 'Waze' }] }))), { text: 'non intendevo Maps, uso sempre Waze' });
  assert.match(lessons.list(db)[0].rule, /non andava bene "Apro Maps\."[\s\S]*uso sempre Waze/);
});

test('compiti: "riprova il compito" rimette in coda l\'ultimo compito fallito', async () => {
  const db = makeDb();
  db.run("INSERT INTO jobs (id, title, goal, status, created, updated) VALUES ('j1', 'Piano settimanale', 'x', 'failed', '2026-11-18', '2026-11-18')");
  const out = await handleChat(db, ENV, deps(fakeFetch(() => reply({}))), { text: 'riprova il compito' });
  assert.match(out.reply, /Riprovo "Piano settimanale"/);
  assert.equal(db.get("SELECT status FROM jobs WHERE id = 'j1'").status, 'planning');
});
