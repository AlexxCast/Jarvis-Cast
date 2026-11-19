// Crash test del 19/11/2026: frasi dette come le dice davvero il Capo (sgrammaticate, con "ehm", numeri a parole,
// parole ripetute, errori del riconoscimento vocale) e modelli che rispondono male. Ogni test è una falla trovata
// e chiusa: se torna rossa, la falla è tornata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, followupVerdict } from '../src/brain.js';
import { handleApi } from '../src/api.js';
import { writeStats, writeReport } from '../src/db.js';
import { parseDue, addReminder } from '../src/agenda.js';
import { applyDietAction, EMPTY_DIARY, loadDiary } from '../src/diet.js';
import { calleeOf } from '../src/phone.js';
import { cleanSpoken, isOnlyFiller, numbersToDigits } from '../src/parlato.js';
import * as cooking from '../src/cooking.js';
import { kvGet } from '../src/db.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
const TZ = 'Europe/Rome';
const SERA = Date.parse('2026-11-19T18:30:00+01:00');
const say = (db, f, text, clock = { ms: SERA }, opts = {}) => handleChat(db, ENV, { ...deps(f, clock), tz: TZ, schedule: () => {} }, { text, source: 'voice', sessionId: 'voce', ...opts });
const pcQueue = (db) => kvGet(db, 'devicesQueue', []);
const noModel = () => fakeFetch(() => { throw new Error('qui non deve servire un modello'); });

test('parlato: esitazioni, nome, parole doppie e numeri a parole', () => {
  assert.equal(cleanSpoken('eh metti un timer di dieci minuti per la pasta'), 'metti un timer di 10 minuti per la pasta');
  assert.equal(cleanSpoken("kestra mmh imposta timer di mezz'ora"), 'imposta timer di 30 minuti');
  assert.equal(cleanSpoken('allora kestra tra due minuti apri apri youtube'), 'tra 2 minuti apri youtube');
  assert.equal(cleanSpoken('non ho mangiato niente'), 'non ho mangiato niente', 'le parole vere restano');
  assert.equal(numbersToDigits('tra venticinque minuti'), 'tra 25 minuti');
  assert.equal(numbersToDigits("un quarto d'ora"), '15 minuti');
  for (const t of ['ehm', 'kestra', 'mm boh', 'Ehi Kestra...']) assert.ok(isOnlyFiller(t), t);
  for (const t of ['ciao kestra', 'no', 'sì']) assert.ok(!isOnlyFiller(t), t);
});

test('timer: "dieci minuti" a parole non diventa più un timer da 1 minuto', async () => {
  const cases = {
    'metti un timer di dieci minuti': /Timer da 10 minuti avviato/,
    'eh metti un timer di 10 minuti per la pasta': /Timer da 10 minuti per la pasta/,
    'mettimi un timer 5 minuti': /Timer da 5 minuti/,
    "kestra mmh imposta timer di mezz'ora": /Timer da 30 minuti/,
    'metti un timer di un minuto': /Timer da 1 minuto avviato/,
  };
  for (const [text, want] of Object.entries(cases)) {
    const db = makeDb();
    const out = await say(db, noModel(), text);
    assert.match(out.reply, want, text);
    assert.equal(out.model, 'jarvis-core');
    const t = kvGet(db, 'timedActions', [])[0];
    const minutes = Number(want.source.match(/\d+/)[0]);
    assert.equal(t.dueMs - SERA, minutes * 60_000, text);
  }
});

test('timer senza durata: chiede "di quanto" e la risposta successiva lo avvia', async () => {
  const db = makeDb();
  const clock = { ms: SERA };
  const ask = await say(db, noModel(), 'metti un timer', clock);
  assert.equal(ask.reply, 'Di quanto lo metto, Capo?');
  assert.equal(kvGet(db, 'timedActions', []).length, 0, 'nessun timer inventato');
  clock.ms += 4000;
  const go = await say(db, noModel(), 'dieci minuti', clock);
  assert.match(go.reply, /Timer da 10 minuti/);
});

test('azione programmata: "tra due minuti apri youtube sul pc" aspetta 2 minuti invece di partire subito', async () => {
  const db = makeDb();
  const out = await say(db, noModel(), 'tra due minuti apri youtube sul pc');
  assert.match(out.reply, /tra 2 minuti eseguirò/);
  assert.equal(pcQueue(db).length, 0, 'niente comando immediato');
});

test('PC: la risposta del modello che nomina il PC non trasforma un messaggio WhatsApp in un comando al computer', async () => {
  const db = makeDb();
  const f = fakeFetch(() => reply({ reply: 'Ok Capo, sul PC ti consiglio di chiudere le app.' }));
  const out = await say(db, f, 'apri whatsapp e scrivi a marco ciao');
  assert.ok(!out.actions.includes('pc_action'));
  assert.equal(pcQueue(db).length, 0);
});

test('PC: una domanda sul computer non fa partire comandi; una richiesta vera sì', async () => {
  const db = makeDb();
  const f = fakeFetch(() => reply({ reply: 'Ti consiglio di avviare la pulizia disco e di aprire il task manager.' }));
  await say(db, f, 'il mio computer è lento secondo te cosa devo fare?');
  assert.equal(pcQueue(db).length, 0);
  const g = fakeFetch(() => reply({ reply: 'Apro YouTube sul PC.' }));
  const out = await say(db, g, 'fammi vedere youtube sul pc');
  assert.ok(out.actions.includes('pc_action'), 'prima finiva nel "non ci sono riuscita"');
});

test('PC: spegnere o riavviare chiede conferma; "sì" esegue, "no aspetta" annulla', async () => {
  const db = makeDb();
  const clock = { ms: SERA };
  const q = await say(db, noModel(), 'spegni il pc', clock);
  assert.match(q.reply, /Spengo il PC\?/);
  assert.equal(pcQueue(db).length, 0);
  clock.ms += 3000;
  const yes = await say(db, noModel(), 'sì', clock);
  assert.match(yes.reply, /Spengo il PC tra 10 secondi/);
  assert.equal(pcQueue(db).length, 1);

  const db2 = makeDb();
  await say(db2, noModel(), 'riavvia il computer', clock);
  const no = await say(db2, noModel(), 'no aspetta', clock);
  assert.equal(no.reply, 'Ok, il PC resta acceso.');
  assert.equal(pcQueue(db2).length, 0);
});

test('telefonate: niente chiamate a "ehm", a "un taxi", "domani", "non chiamare"; ci si può correggere', () => {
  assert.equal(calleeOf('chiama ehm'), '');
  assert.equal(calleeOf('chiamami un taxi'), '');
  assert.equal(calleeOf('domani chiama il dentista'), '');
  assert.equal(calleeOf('lunedì chiama il dentista'), '');
  assert.equal(calleeOf('chiama il dentista venerdì'), '');
  assert.equal(calleeOf('non chiamare la mamma'), '');
  assert.equal(calleeOf('come si chiama quella canzone di vasco'), '');
  assert.equal(calleeOf('chiama la mamma no aspetta il papà'), 'papà');
  assert.equal(calleeOf('chiama mamma'), 'mamma');
});

test('telefonate: "domani chiama il dentista" non chiama adesso nemmeno se il modello promette', async () => {
  const db = makeDb();
  const f = fakeFetch(() => reply({ reply: 'Imposto il promemoria per domani, Capo.', actions: [{ type: 'add_reminder', text: 'Chiamare il dentista', due: '2026-11-20T09:00' }] }));
  const out = await say(db, f, 'domani chiama il dentista');
  assert.ok(!(out.device || []).some(d => d.type === 'call'));
});

test('telefonate: il 112 si chiama solo dopo un "sì" (TV, frase a metà), subito se è un\'emergenza vera', async () => {
  const db = makeDb();
  const clock = { ms: SERA };
  const q = await say(db, noModel(), 'chiama il 112', clock);
  assert.match(q.reply, /Chiamo davvero il 112\?/);
  assert.ok(!(q.device || []).length);
  assert.equal(q.expectReply, true);
  clock.ms += 3000;
  const yes = await say(db, noModel(), 'sì chiama', clock);
  assert.deepEqual(yes.device, [{ type: 'call', name: '112' }]);

  const db2 = makeDb();
  const now = await say(db2, noModel(), "aiuto chiama il 112 c'è stato un incidente");
  assert.deepEqual(now.device, [{ type: 'call', name: '112' }]);

  // Anche quando è il modello a mettere la chiamata.
  const db3 = makeDb();
  const m = await say(db3, fakeFetch(() => reply({ reply: 'Chiamo il 113.', actions: [{ type: 'call', name: '113' }] })), 'eh fai il 113 dai');
  assert.ok(!m.device.some(d => d.type === 'call'));
  assert.match(m.reply, /Chiamo davvero il 113\?/);
});

test('pasti: numeri scritti come testo valgono, valori assurdi no, calorie mancanti stimate dalla tabella', () => {
  const d = EMPTY_DIARY();
  const ctx = { today: '2026-11-19', nowIso: '2026-11-19T13:00', ms: SERA };
  applyDietAction(d, { type: 'add_meal', meal: 'pranzo', items: [{ name: 'piadina', kcal: '320 kcal', grams: '110g' }] }, ctx);
  assert.equal(d.meals[0].items[0].kcal, 320, 'prima "320 kcal" diventava 0');
  assert.equal(d.meals[0].items[0].grams, 110);
  applyDietAction(d, { type: 'add_meal', meal: 'cena', items: [{ name: 'pizza', kcal: 99999, grams: -5 }] }, ctx);
  assert.ok(d.meals[1].items[0].kcal <= 5000 && d.meals[1].items[0].grams >= 0);
  applyDietAction(d, { type: 'add_meal', meal: 'spuntino', items: [{ name: 'banana', grams: 120 }] }, ctx);
  assert.ok(d.meals[2].items[0].kcal > 80 && d.meals[2].items[0].kcal < 130, 'banana stimata dalla tabella');
  applyDietAction(d, { type: 'add_weight', kg: 824 }, ctx); // "82 e 4" capito male
  assert.equal(d.weights.length, 0);
  applyDietAction(d, { type: 'add_weight', kg: '82,4' }, ctx);
  assert.equal(d.weights[0].kg, 82.4);
  applyDietAction(d, { type: 'set_steps', steps: '8.000 passi' }, ctx);
  assert.equal(d.steps['2026-11-19'], 8000);
});

test('dispensa: togliere "o" non svuota mezza dispensa', () => {
  const d = { ...EMPTY_DIARY(), pantry: [{ id: 'p1', name: 'pomodori' }, { id: 'p2', name: 'olio' }, { id: 'p3', name: 'tonno' }] };
  applyDietAction(d, { type: 'remove_pantry_item', name: 'o' }, { today: '2026-11-19', nowIso: '', ms: SERA });
  assert.equal(d.pantry.length, 3);
  applyDietAction(d, { type: 'remove_pantry_item', name: 'tonno' }, { today: '2026-11-19', nowIso: '', ms: SERA });
  assert.equal(d.pantry.length, 2);
});

test('promemoria: date scritte in tutti i modi dei modelli', () => {
  const at = (due) => { const ms = parseDue(due, SERA, TZ); return ms == null ? null : new Date(ms).toLocaleString('it-IT', { timeZone: TZ }); };
  assert.equal(at('2026-11-20T07:00:00Z'), '20/11/2026, 08:00:00', 'la Z conta (prima un\'ora di sfasamento)');
  assert.equal(at('2026-11-20T08:00:00+01:00'), '20/11/2026, 08:00:00');
  assert.equal(at('2026-11-20T8:00'), '20/11/2026, 08:00:00');
  assert.equal(at('20/11/2026 08:00'), '20/11/2026, 08:00:00');
  assert.equal(at('2026-11-20'), '20/11/2026, 09:00:00');
  assert.equal(at('08:00'), '20/11/2026, 08:00:00', 'solo l\'ora detta la sera: domattina');
  assert.equal(at('2026-11-19T10:00'), '20/11/2026, 10:00:00', '"oggi alle 10" detto alle 18:30 non suona subito');
  assert.equal(at('2026-11-20T25:00'), null);
  assert.equal(at('2026-11-15T10:00'), null, 'data vecchia: meglio chiedere');
  // Dall'interfaccia un orario passato resta com'è (suona subito).
  const db = makeDb();
  const id = addReminder(db, { text: 'x', due: '2026-11-19T10:00' }, SERA, TZ);
  assert.ok(db.get('SELECT due FROM reminders WHERE id = ?', id).due < SERA);
});

test('cucina: "ok fatto", "il prossimo", "kestra avanti", "puoi ripetere", "come?" senza modello', async () => {
  const db = makeDb();
  cooking.apply(db, { type: 'recipe', title: 'Piadina', ingredients: [{ name: 'piadina', qty: '1' }], steps: ['Scalda.', 'Farcisci.', 'Chiudi.', 'Servi.'] });
  const seq = [['ok fatto', 2], ['puoi ripetere', 2], ['il prossimo', 3], ['come?', 3], ['torna indietro', 2], ['kestra avanti', 3], ['avanti avanti', 4], ['ripeti per favore', 4]];
  for (const [text, step] of seq) {
    const out = await say(db, noModel(), text);
    assert.match(out.reply, new RegExp(`^Passo ${step} di 4`), text);
  }
});

test('solo esitazione: "ehm" o "kestra" non chiamano un modello né scrivono nel database', async () => {
  const db = makeDb();
  const out = await say(db, noModel(), 'ehm');
  assert.equal(out.reply, 'Dimmi, Capo.');
  assert.equal(db.all('SELECT id FROM messages').length, 0);
  const tv = await say(db, noModel(), 'mmh', { ms: SERA }, { followup: true });
  assert.equal(tv.ignored, true);
});

test('conversazione aperta: tre parole qualsiasi della TV non bastano più per far rispondere Kestra', () => {
  assert.equal(followupVerdict('buonasera a tutti'), 'ask');
  assert.equal(followupVerdict('a voi la linea'), 'ask');
  assert.equal(followupVerdict('sì grazie'), 'yes');
  assert.equal(followupVerdict('va bene'), 'yes');
  assert.equal(followupVerdict('e poi?'), 'yes');
  assert.equal(followupVerdict('metti la musica'), 'yes');
  assert.equal(followupVerdict('trenta grammi', 'Quanti grammi erano?'), 'yes');
});

test('modelli giù o risposte rotte: mai un crash, sempre una risposta onesta', async () => {
  const bad = {
    'tutti 429': () => ({ status: 429, json: {} }), 'tutti 500': () => ({ status: 500, json: {} }), 'vuota': () => '',
    'JSON tagliato': () => '{"reply":"Ho registrato la piadina, Capo","actions":[{"type":"add_meal","meal":"pranzo","items":[{"name":"piadina","kcal":3',
    'azioni spazzatura': () => reply({ reply: 'Fatto.', actions: [{ type: 'teletrasporto' }, null, 5, 'x', { type: 'add_reminder' }] }),
    'promessa falsa': () => reply({ reply: 'Ho aggiunto la piadina al pranzo, Capo.' }),
  };
  for (const [name, h] of Object.entries(bad)) {
    const out = await say(makeDb(), fakeFetch(h), 'o mangiato a pranzo una piadina col crudo');
    assert.ok(typeof out.reply === 'string' && out.reply.length > 5, name);
    assert.doesNotMatch(out.reply, /^Fatto|Ho aggiunto|Ho registrato/, `${name}: non deve dire di averlo fatto`);
  }
});

test('tono: Kestra dà del tu e dice "Capo", anche nelle risposte locali', async () => {
  for (const text of ['metti un timer di 5 minuti', 'fai partire il cronometro', 'a posto così', 'chiama mamma', 'apri youtube sul pc']) {
    const out = await say(makeDb(), noModel(), text);
    assert.doesNotMatch(out.reply, /\bsignore\b|\bPuò\b|\bLe mostro\b|\bvuole\b/i, text);
  }
});

test('scritture: leggere la sfera non riscrive più gli argomenti annidati (il limite di Cloudflare finiva così)', async () => {
  const db = makeDb();
  const d = deps(fakeFetch(() => '{}'));
  const now = '2026-11-19T10:00';
  db.run("INSERT INTO topics (module, name, label, uses, last_used, parent) VALUES ('dieta', 'pasta', 'Pasta', 5, ?, '')", now);
  ['carbonara', 'amatriciana', 'pesto', 'gricia', 'puttanesca', 'norma', 'arrabbiata', 'vongole', 'ragu', 'funghi'].forEach((w, i) =>
    db.run("INSERT INTO topics (module, name, label, uses, last_used, parent) VALUES ('dieta', ?, ?, 1, ?, 'pasta')", 'p' + i, w, now));
  const graph = () => handleApi(db, {}, d, new Request('https://x/api/graph'));
  await graph();
  Object.assign(writeStats, { day: new Date(d.now()).toISOString().slice(0, 10), total: 0, bySource: {}, byTable: {} });
  for (let i = 0; i < 20; i++) await graph();
  assert.equal(writeReport().total, 0, 'prima: 10 righe a ogni lettura');
});

test('API: 51 rotte con corpi spazzatura non danno mai errore 500', async () => {
  const db = makeDb();
  const d = { ...deps(fakeFetch(() => reply({ reply: 'ok' }))), schedule: () => {} };
  const paths = ['/api/chat', '/api/actions', '/api/reminders', '/api/places', '/api/place-event', '/api/phone/step', '/api/apps', '/api/notify',
    '/api/devices/heartbeat', '/api/devices/result', '/api/devices/command', '/api/memory', '/api/projects', '/api/jobs', '/api/steps', '/api/profile',
    '/api/import/legacy', '/api/addressed', '/api/skills/run', '/api/initiative', '/api/workspace/toggle'];
  const bodies = ['', 'null', '[]', '{}', '"testo"', '{rotto', JSON.stringify({ text: 123, items: 'x', apps: 'x', screen: 'x', due: {}, goal: 7, name: ['x'] })];
  for (const p of paths) for (const m of ['POST', 'PUT']) for (const b of bodies) {
    const res = await handleApi(db, ENV, d, new Request('https://x' + p, { method: m, body: b }));
    assert.ok(res.status < 500, `${m} ${p} ${b} → ${res.status}`);
  }
});

// ---------------------------------------------------------------- Seconda parte: automatismi, dispositivi, navigazione dal vivo
import * as phone from '../src/phone.js';
import * as flows from '../src/flows.js';
import { canonicalPcName } from '../src/jarvis_core.js';

const chatPc = async (lines) => {
  const db = makeDb();
  const clock = { ms: SERA };
  const out = [];
  let seen = 0;
  for (const text of lines) {
    clock.ms += 8000;
    const r = await say(db, fakeFetch(() => reply({ reply: 'MODELLO' })), text, clock);
    const q = pcQueue(db);
    out.push({ r, pc: q.slice(seen) });
    seen = q.length;
  }
  return out;
};

test('PC: frasi che raccontano un problema non bloccano, non sospendono e non riavviano il PC', async () => {
  for (const text of ['il pc si blocca sempre quando apro chrome', 'il computer va in sleep da solo', 'il pc si riavvia da solo da ieri', 'ho comprato un pc nuovo']) {
    const [{ r, pc }] = await chatPc([text]);
    assert.equal(pc.length, 0, text);
    assert.notEqual(r.model, 'jarvis-core', `${text}: risponde il modello`);
  }
});

test('PC: comandi di sistema e "chiudi tutto" si ripetono e aspettano il sì', async () => {
  const [a, b] = await chatPc(['esegui comando del C:\\Windows sul pc', 'sì']);
  assert.match(a.r.reply, /"del C:\\Windows"\? Dimmi "sì"/);
  assert.equal(a.pc.length, 0);
  assert.deepEqual(b.pc.map(c => [c.kind, c.target]), [['shell', 'del C:\\Windows']]);
  const [c, d] = await chatPc(['chiudi tutto sul pc', 'no']);
  assert.match(c.r.reply, /Chiudo tutti i programmi sul PC\?/);
  assert.equal(c.pc.length + d.pc.length, 0);
});

test('navigazione dal vivo: "scorri ancora", "più giù", "torna su", "metti la canzone…" restano sul PC', async () => {
  const steps = await chatPc(['scorri giù sul pc', 'scorri ancora', 'più giù', 'torna su', 'metti la canzone di vasco albachiara']);
  assert.deepEqual(steps.slice(0, 4).map(s => s.pc.map(c => c.kind + ':' + c.target).join()), ['scroll:down', 'scroll:down', 'scroll:down', 'scroll:up']);
  assert.deepEqual(steps[4].pc.map(c => [c.kind, c.target]), [['play_youtube', 'vasco albachiara']]);
});

test('navigazione dal vivo: "scrivi a Marco…" è un messaggio, non testo da digitare sul PC; "ma no sul telefono" sposta', async () => {
  const [, msg] = await chatPc(['apri youtube sul pc', 'scrivi a marco che arrivo tra 10 minuti']);
  assert.equal(msg.pc.length, 0);
  const [, tel] = await chatPc(['apri youtube sul pc', 'ma no sul telefono']);
  assert.deepEqual(tel.r.device, [{ type: 'open_url', url: 'https://www.youtube.com' }]);
});

test('navigazione dal vivo: "clicca sul primo video" non finge di saperlo fare', async () => {
  const [, c] = await chatPc(['apri youtube sul pc', 'clicca sul primo video']);
  assert.equal(c.pc.length, 0);
  assert.match(c.r.reply, /dimmi una parola del titolo/);
});

test('PC: nomi storpiati dal riconoscimento ("giotube", "tipo spotify", "crome") aprono l\'app giusta', async () => {
  assert.equal(canonicalPcName('giotube'), 'youtube');
  assert.equal(canonicalPcName('spotifai'), 'spotify');
  assert.equal(canonicalPcName('netflics'), 'netflix');
  assert.equal(canonicalPcName('crome'), 'chrome');
  assert.equal(canonicalPcName('word'), 'word', 'nomi veri restano');
  const [a] = await chatPc(['apri apri giotube sul pc']);
  assert.deepEqual(a.pc.map(c => c.target), ['https://www.youtube.com']);
  const [b] = await chatPc(['eh apri tipo spotify sul computer']);
  assert.deepEqual(b.pc.map(c => c.target), ['https://open.spotify.com']);
});

test('automatismi del telefono: "eh cerca tipo ligabue su joytify" ripete il compito imparato scrivendo solo "ligabue"', async () => {
  const db = makeDb();
  const clock = { ms: SERA };
  const S = [{ app: 'launcher', items: [{ n: 1, kind: 'icona', text: 'Joytify' }] }, { app: 'com.joytify', items: [{ n: 1, kind: 'pulsante', text: '(icona: search) Cerca' }] },
    { app: 'com.joytify', items: [{ n: 1, kind: 'campo', text: 'Cerca brani [cursore qui]' }] }, { app: 'com.joytify', items: [{ n: 2, kind: 'pulsante', text: '(icona: play) Riproduci' }] }];
  const moves = [{ do: 'open_app', text: 'Joytify' }, { do: 'tap', n: 1 }, { do: 'type', n: 1, text: 'vasco' }, { do: 'tap', n: 2 }, { do: 'done', say: 'Parte.' }];
  let k = 0;
  const f = fakeFetch(() => JSON.stringify(moves[k++]));
  for (let i = 0; i < 5; i++) { clock.ms += 2000; await phone.step(db, ENV, deps(f, clock), { goal: 'cerca vasco su joytify', step: i, screen: S[Math.min(i, 3)], history: [] }); }
  const hit = flows.gatekeepChat(db, 'eh cerca tipo ligabue su joytify', { nowMs: clock.ms });
  assert.deepEqual(hit.device, [{ type: 'phone_task', goal: 'cerca ligabue su joytify' }]);
  const typed = [];
  for (let i = 0; i < 5; i++) { clock.ms += 2000; const m = await phone.step(db, ENV, deps(noModel(), clock), { goal: hit.device[0].goal, step: i, screen: S[Math.min(i, 3)], history: [] }); if (m.do === 'type') typed.push(m.text); }
  assert.deepEqual(typed, ['ligabue']);
  assert.equal(flows.findMatchingSkill(db, 'non aprire youtube sul pc'), null);
});

test('telefono: regole sempre valide, qualunque mossa dica il modello', () => {
  const scr = (text) => ({ app: 'x', items: [{ n: 1, kind: 'pulsante', text }] });
  assert.equal(phone.guardMove({ do: 'type', n: 1, text: 'segreto' }, scr('Password [cursore qui]'), 'accedi', true).do, 'ask');
  assert.equal(phone.guardMove({ do: 'tap', n: 1 }, scr('Paga ora 18,50 €'), 'ordina la pizza', true).do, 'ask', 'pagare chiede sempre');
  assert.equal(phone.guardMove({ do: 'tap', n: 1 }, scr('Elimina per tutti'), 'pulisci', true).do, 'ask');
  assert.equal(phone.guardMove({ do: 'tap', n: 1 }, scr('(icona: send)'), 'scrivi a marco', false).do, 'ask', 'voce non riconosciuta: si chiede');
  assert.equal(phone.guardMove({ do: 'tap', n: 1 }, scr('(icona: send)'), 'scrivi a marco', true).do, 'tap', 'voce del Capo: si invia');
  assert.equal(phone.guardMove({ do: 'tap', n: 1 }, scr('(icona: send)'), "scrivi a marco (l'utente ha confermato: procedi)", false).do, 'tap');
  assert.equal(phone.guardMove({ do: 'tap', n: 9 }, scr('Ok'), 'x', true).do, 'ask', 'tasto che non esiste');
});

test('telefono: dopo "Invio il messaggio. Procedo?" il "sì invialo" riprende il compito con la conferma, il "no" lo ferma', async () => {
  const db = makeDb();
  db.run("INSERT INTO kv (key, value) VALUES ('phonePending', ?)", JSON.stringify({ goal: 'scrivi a marco ciao su whatsapp', say: 'Invio il messaggio. Procedo?', at: SERA }));
  const yes = await say(db, noModel(), 'sì invialo', { ms: SERA + 5000 });
  assert.deepEqual(yes.device, [{ type: 'phone_task', goal: "scrivi a marco ciao su whatsapp (l'utente ha confermato: procedi)" }]);
  const db2 = makeDb();
  db2.run("INSERT INTO kv (key, value) VALUES ('phonePending', ?)", JSON.stringify({ goal: 'scrivi a marco ciao', say: 'Invio il messaggio. Procedo?', at: SERA }));
  const no = await say(db2, noModel(), 'no lascia stare', { ms: SERA + 5000 });
  assert.equal(no.reply, 'Ok, mi fermo.');
  assert.equal(kvGet(db2, 'phonePending', 'x'), null);
});
