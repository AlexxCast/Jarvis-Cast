import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, isAddressed } from '../src/brain.js';
import { buildMessages, parseReply, CORE_PROMPT } from '../src/context.js';
import { messagesTokens } from '../src/router.js';
import { loadDiary, saveDiary, EMPTY_DIARY, mergeLegacy } from '../src/diet.js';
import * as memory from '../src/memory.js';
import * as agenda from '../src/agenda.js';
import * as jobs from '../src/jobs.js';
import * as ui from '../src/ui.js';
import * as mood from '../src/mood.js';
import { handleApi } from '../src/api.js';
import { localToMs, nowIso } from '../src/clock.js';
import { makeDb, fakeFetch, deps, reply, T0 } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
const systemOf = (call) => call.body.messages[0].content;
function seeded() {
  const db = makeDb();
  const d = EMPTY_DIARY();
  d.profile = { ...d.profile, name: 'Alessio', birthDate: '1996-01-01', heightCm: 180, weightKg: 80 };
  saveDiary(db, d);
  return db;
}

test('parseReply: JSON puro, con blocco di codice, con testo attorno, o testo semplice', () => {
  assert.equal(parseReply('{"reply":"ciao","expect_reply":true,"actions":[{"type":"add_weight","kg":80}]}').actions.length, 1);
  assert.equal(parseReply('```json\n{"reply":"ciao"}\n```').reply, 'ciao');
  assert.equal(parseReply('Ecco: {"reply":"ok","actions":"x"} fine').actions.length, 0);
  const plain = parseReply('Buongiorno signore');
  assert.equal(plain.reply, 'Buongiorno signore');
  assert.equal(plain.parsed, false);
});

test('pasto registrato: azione applicata al diario e messaggi salvati', async () => {
  const db = seeded();
  const f = fakeFetch(() => reply({ reply: 'Registrato, signore.', card: 'Pranzo: 520 kcal', actions: [
    { type: 'add_meal', date: '2026-11-12', meal: 'pranzo', items: [{ name: 'Pasta', grams: 100, kcal: 520, protein: 20, carbs: 80, fat: 10 }] },
  ] }));
  const out = await handleChat(db, ENV, deps(f), { text: 'ho mangiato 100 grammi di pasta a pranzo' });
  assert.equal(out.reply, 'Registrato, signore.');
  assert.equal(out.card, 'Pranzo: 520 kcal');
  const d = loadDiary(db);
  assert.equal(d.meals.length, 1);
  assert.equal(d.meals[0].items[0].kcal, 520);
  assert.equal(db.all('SELECT role FROM messages').map(m => m.role).join(','), 'user,assistant');
  // Il modulo dieta era nel contesto, con data e ora nel fuso dell'utente.
  assert.match(systemOf(f.calls[0]), /REGOLE DIETA/);
  assert.match(systemOf(f.calls[0]), /giovedì 2026-11-12 ore 12:00/);
});

test('contesto modulare: la dieta completa entra solo quando serve, poi resta "calda" per qualche turno', async () => {
  const db = seeded();
  const f = fakeFetch(() => reply({ reply: 'ok' }));
  const d = deps(f);
  await handleChat(db, ENV, d, { text: 'che tempo fa su Marte?' });
  assert.doesNotMatch(systemOf(f.calls[0]), /REGOLE DIETA/);
  assert.match(systemOf(f.calls[0]), /DIETA OGGI/); // il riepilogo breve c'è sempre
  await handleChat(db, ENV, d, { text: 'quante calorie mi restano?' });
  assert.match(systemOf(f.calls[1]), /REGOLE DIETA/);
  await handleChat(db, ENV, d, { text: 'e domani?' });
  assert.match(systemOf(f.calls[2]), /REGOLE DIETA/); // sticky
});

test('memoria: remember crea il modulo, il ricordo torna solo quando è pertinente', async () => {
  const db = seeded();
  const f = fakeFetch((url, body, n) => n === 1
    ? reply({ reply: 'Me lo segno.', actions: [{ type: 'remember', module: 'Auto', text: 'La Panda fa il tagliando ogni 15000 km, ultimo a 45000.', description: 'manutenzione auto' }] })
    : reply({ reply: 'ok' }));
  const d = deps(f);
  await handleChat(db, ENV, d, { text: 'segnati che la Panda fa il tagliando ogni 15000 km' });
  assert.deepEqual(memory.listModules(db).map(m => [m.name, m.entries]), [['auto', 1]]);
  await handleChat(db, ENV, d, { text: 'raccontami una barzelletta', sessionId: 's2' });
  assert.doesNotMatch(systemOf(f.calls[1]), /tagliando/);
  assert.match(systemOf(f.calls[1]), /MODULI DI MEMORIA ESISTENTI: auto \(manutenzione auto\)/);
  await handleChat(db, ENV, d, { text: 'quando devo fare il prossimo tagliando?', sessionId: 's3' });
  assert.match(systemOf(f.calls[2]), /MEMORIA RILEVANTE[\s\S]*tagliando ogni 15000/);
  assert.equal(db.get('SELECT uses FROM memories').uses, 1);
});

test('memoria: niente doppioni, forget elimina anche il modulo vuoto', () => {
  const db = makeDb();
  const a = memory.remember(db, { module: 'lavoro', text: 'Riunione fissa il lunedì.' }, 'x');
  const b = memory.remember(db, { module: 'Lavoro', text: 'riunione fissa il lunedì.' }, 'x');
  assert.equal(a, b);
  memory.forget(db, a);
  assert.equal(memory.listModules(db).length, 0);
});

test('la sessione sopravvive al cambio di modello: stessa cronologia al nuovo provider', async () => {
  const db = seeded();
  let geminiDown = false;
  const f = fakeFetch((url) => (geminiDown && /generativelanguage/.test(url)) ? { status: 429, json: { error: { message: 'quota' } } } : reply({ reply: /groq/.test(url) ? 'da groq' : 'da gemini' }));
  const d = deps(f);
  const first = await handleChat(db, ENV, d, { text: 'mi chiamo Alessio e domani parto per Roma' });
  assert.equal(first.model, 'gemini:gemini-flash-latest');
  geminiDown = true;
  const second = await handleChat(db, ENV, d, { text: 'dove vado domani?' });
  assert.equal(second.reply, 'da groq');
  assert.equal(second.switched, true);
  assert.match(second.model, /^groq:/);
  const sent = f.calls.at(-1).body.messages;
  assert.match(JSON.stringify(sent), /domani parto per Roma/);
  assert.equal(sent.at(-1).role, 'user');
  assert.match(sent.at(-1).content, /dove vado domani\?/);
});

test('conversazioni lunghe: i messaggi vecchi diventano un riassunto', async () => {
  const db = seeded();
  const f = fakeFetch((url, body) => /Riassumi conversazioni/.test(body.messages[0].content) ? 'RIASSUNTO: l\'utente ha parlato di molte cose.' : reply({ reply: 'ok' }));
  const d = deps(f);
  for (let i = 0; i < 13; i++) await handleChat(db, ENV, d, { text: `messaggio numero ${i}` });
  const s = db.get("SELECT summary, summarized_upto FROM sessions WHERE id = 'main'");
  assert.match(s.summary, /RIASSUNTO/);
  assert.ok(s.summarized_upto > 0);
  await handleChat(db, ENV, d, { text: 'ultimo' });
  const call = f.calls.at(-1);
  assert.match(systemOf(call), /RIASSUNTO DELLA CONVERSAZIONE FINORA/);
  assert.doesNotMatch(JSON.stringify(call.body.messages.slice(1)), /messaggio numero 0\b/);
});

test('buildMessages: rispetta la finestra dei modelli piccoli tenendo il nucleo e il messaggio', () => {
  const parts = {
    core: CORE_PROMPT('Alessio', 'oggi'), brief: 'DIETA OGGI: x', rules: 'R'.repeat(2000),
    blocks: [{ prio: 1, text: 'P1 ' + 'a'.repeat(3000) }, { prio: 4, text: 'P4 ' + 'b'.repeat(40000) }],
    memories: ['- ricordo'], history: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turno ${i} ` + 'c'.repeat(600) })),
    summary: 'riassunto', userText: 'domanda finale',
  };
  const small = buildMessages({ ctx: 8000 }, parts);
  const big = buildMessages({ ctx: 1000000 }, parts);
  assert.ok(messagesTokens(small) <= 8000 * 0.6);
  assert.match(small[0].content, /Sei JARVIS/);
  assert.doesNotMatch(small[0].content, /P4 /);
  assert.equal(small.at(-1).content, 'domanda finale');
  assert.match(big[0].content, /P4 /);
  assert.ok(big.length > small.length);
  assert.equal(big[1].role, 'user');
});

test('errore dei provider: risposta gentile, nessuna eccezione', async () => {
  const db = seeded();
  const out = await handleChat(db, ENV, deps(fakeFetch(() => ({ status: 500, json: {} }))), { text: 'ciao' });
  assert.equal(out.error, true);
  assert.match(out.reply, /esauriti|non raggiungibili/);
});

test('isAddressed: SI/NO dal modello veloce', async () => {
  const db = makeDb();
  assert.equal(await isAddressed(db, ENV, deps(fakeFetch(() => 'SI')), 'senti jarvis che ore sono'), true);
  assert.equal(await isAddressed(db, ENV, deps(fakeFetch(() => 'NO.')), 'ieri ho visto il film con jarvis'), false);
});

test('promemoria: orario locale, scadenza nella posta in arrivo', () => {
  const db = makeDb();
  assert.equal(nowIso(localToMs('2026-11-12T18:30', 'Europe/Rome'), 'Europe/Rome'), '2026-11-12T18:30');
  assert.equal(nowIso(localToMs('2026-07-01T09:00', 'Europe/Rome'), 'Europe/Rome'), '2026-07-01T09:00');
  const id = agenda.addReminder(db, { text: 'Chiamare il dentista', due: '2026-11-12T18:30' }, T0, 'Europe/Rome');
  assert.ok(id);
  assert.equal(agenda.addReminder(db, { text: 'x', due: 'boh' }, T0, 'Europe/Rome'), null);
  assert.equal(agenda.fireDue(db, T0, 'Europe/Rome'), localToMs('2026-11-12T18:30', 'Europe/Rome'));
  assert.equal(db.all('SELECT * FROM inbox').length, 0);
  assert.equal(agenda.fireDue(db, T0 + 7 * 3600_000, 'Europe/Rome'), null);
  assert.deepEqual(db.all('SELECT kind, text FROM inbox'), [{ kind: 'reminder', text: 'Chiamare il dentista' }]);
});

test('compito in background: piano, passi con contesto pulito, sintesi e avviso', async () => {
  const db = seeded();
  const f = fakeFetch((url, body) => {
    const sys = body.messages[0].content;
    if (/pianificatore/.test(sys)) return JSON.stringify({ reply: 'ok', steps: [{ title: 'Menu', instruction: 'Scrivi il menu', tier: 'fast' }, { title: 'Spesa', instruction: 'Scrivi la lista della spesa', tier: 'fast' }] });
    if (/Unisci i risultati/.test(sys)) return 'PIANO FINALE';
    return /Spesa/.test(body.messages[1].content.split('PASSO DA SVOLGERE ORA')[1]) ? 'lista spesa' : 'menu settimanale';
  });
  const d = deps(f);
  jobs.createJob(db, { title: 'Piano pasti', goal: 'Pianifica i pasti della settimana e la spesa' }, T0, d.tz);
  const delays = [];
  for (let i = 0; i < 6; i++) { const x = await jobs.advance(db, ENV, d); delays.push(x); if (x == null) break; }
  assert.deepEqual(delays, [1000, 1000, 1000, null]);
  const job = jobs.listJobs(db)[0];
  assert.equal(job.status, 'done');
  assert.equal(job.result, 'PIANO FINALE');
  assert.deepEqual(job.steps.map(s => s.status), ['done', 'done']);
  // Il secondo passo ha ricevuto il risultato del primo, non tutta la conversazione.
  assert.match(f.calls[2].body.messages[1].content, /RISULTATI DEI PASSI PRECEDENTI[\s\S]*menu settimanale/);
  assert.match(db.get('SELECT text FROM inbox').text, /Ho completato "Piano pasti"/);
});

test('start_job dalla chat avvia il compito', async () => {
  const db = seeded();
  const d = deps(fakeFetch(() => reply({ reply: 'Ci penso io.', actions: [{ type: 'start_job', title: 'Piano', goal: 'Fai un piano di allenamento di 4 settimane' }] })));
  await handleChat(db, ENV, d, { text: 'preparami un piano di allenamento' });
  assert.equal(d.jobs.length, 1);
  assert.equal(d.jobs[0].title, 'Piano');
});

test('import dal vecchio diario: unisce senza duplicare e non cancella', () => {
  const cur = EMPTY_DIARY();
  cur.meals.push({ id: 'm1', date: '2026-11-10', meal: 'cena', items: [] });
  cur.steps['2026-11-10'] = 9000;
  const legacy = { profile: { name: 'Alessio', birthDate: '1996-01-01', heightCm: 180, weightKg: 82, sex: 'M', goal: 'dimagrire' },
    meals: [{ id: 'm1', date: '2026-11-10', meal: 'cena', items: [] }, { id: 'm0', date: '2026-11-01', meal: 'pranzo', items: [] }],
    weights: [{ date: '2026-11-01', kg: 82 }], steps: { '2026-11-10': 4000, '2026-11-01': 7000 }, pantry: [{ id: 'p1', name: 'Riso' }], savedRecipes: [], activities: [] };
  const merged = mergeLegacy(mergeLegacy(cur, legacy), legacy); // due volte: deve restare uguale
  assert.equal(merged.meals.length, 2);
  assert.equal(merged.weights.length, 1);
  assert.deepEqual(merged.steps, { '2026-11-10': 9000, '2026-11-01': 7000 });
  assert.equal(merged.profile.name, 'Alessio');
  assert.equal(merged.pantry.length, 1);
});

test('API: stato, azioni manuali, import, passi, posta in arrivo', async () => {
  const db = makeDb();
  const d = { ...deps(fakeFetch(() => reply({}))), schedule: () => {} };
  const call = async (method, path, payload) => {
    const res = await handleApi(db, ENV, d, new Request('https://x' + path, { method, body: payload ? JSON.stringify(payload) : undefined }));
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('GET', '/api/state')).body.today.profileComplete, false);
  const imp = await call('POST', '/api/import/legacy', { diary: { profile: { birthDate: '1996-01-01', heightCm: 180, weightKg: 80 }, meals: [{ id: 'a', date: '2026-11-12', meal: 'pranzo', items: [{ name: 'x', kcal: 500 }] }], chat: [{ role: 'user', text: 'ciao', at: '2026-11-01T10:00' }] } });
  assert.equal(imp.body.meals, 1);
  assert.equal(imp.body.state.today.eaten, 500);
  assert.equal((await call('GET', '/api/history')).body.messages.length, 1);
  assert.equal((await call('POST', '/api/import/legacy', { diary: {} })).status, 400);
  await call('POST', '/api/steps', { date: '2026-11-12', steps: 6000 });
  const st = await call('POST', '/api/actions', { actions: [{ type: 'delete_meal', id: 'a' }, { type: 'start_job', goal: 'x' }, { type: 'add_pantry_item', name: 'Uova', quantity: '6' }] });
  assert.deepEqual(st.body.applied, ['delete_meal', 'add_pantry_item']);
  assert.equal(st.body.state.today.eaten, 0);
  assert.equal(st.body.state.today.steps, 6000);
  await call('POST', '/api/reminders', { text: 'Prova', due: '2026-11-12T10:00' }); // già scaduto
  assert.equal((await call('POST', '/api/inbox/consume')).body.items.length, 1);
  assert.equal((await call('POST', '/api/inbox/consume')).body.items.length, 0);
  assert.equal((await call('GET', '/api/inbox')).body.items.length, 1);
  assert.equal((await call('PUT', '/api/models', { models: [{ provider: 'boh', model: 'x' }] })).status, 400);
  assert.equal((await call('PUT', '/api/models', { models: [{ provider: 'groq', model: 'nuovo', tiers: ['fast'] }] })).body.count, 1);
  assert.equal((await call('GET', '/api/models')).body.models.length, 1);
  assert.equal((await call('GET', '/api/boh')).status, 404);
  assert.equal((await call('POST', '/api/chat', undefined)).status, 200);
});

test('aprire app e indirizzi: le azioni vengono inoltrate al telefono, quelle non valide scartate', async () => {
  const db = makeDb();
  const out = await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Apro Spotify, signore.', actions: [
    { type: 'open_app', name: 'Spotify' }, { type: 'open_app', name: '  ' },
    { type: 'open_url', url: 'https://example.com/a' }, { type: 'open_url', url: 'javascript:alert(1)' }, { type: 'open_url', url: 'http://example.com' },
  ] }))), { text: 'aprimi Spotify' });
  assert.deepEqual(out.device, [{ type: 'open_app', name: 'Spotify' }, { type: 'open_url', url: 'https://example.com/a' }]);
  assert.deepEqual(out.actions, ['open_app', 'open_url']);
});

test('sfera: la mappa ha un ramo per modulo e ogni risposta dice quali rami ha acceso', async () => {
  const db = seeded();
  const f = fakeFetch((url, body, n) => n === 1
    ? reply({ reply: 'Me lo segno.', actions: [{ type: 'remember', module: 'Auto', text: 'La Panda fa il tagliando ogni 15000 km.' }] })
    : reply({ reply: 'ok' }));
  const d = deps(f);
  const first = await handleChat(db, ENV, d, { text: 'segnati che la Panda fa il tagliando ogni 15000 km' });
  assert.ok(first.touched.includes('auto'), 'il modulo appena creato si accende');
  const g = memory.graph(db);
  const auto = g.branches.find(b => b.id === 'auto');
  assert.equal(auto.kind, 'module');
  assert.match(auto.children[0].label, /tagliando/);
  assert.ok(g.branches.some(b => b.id === 'dieta'));

  const second = await handleChat(db, ENV, d, { text: 'quando devo fare il prossimo tagliando?', sessionId: 's2' });
  assert.deepEqual(second.touched, ['auto']);
  assert.deepEqual(second.touchedLeaves, [auto.children[0].id]);
  assert.equal(second.tier, 'fast');

  const res = await handleApi(db, ENV, d, new Request('https://x/api/graph'));
  assert.equal((await res.json()).branches.length, g.branches.length);
});

test('sfera: ogni argomento di cui si parla diventa un nodo, sotto la sua area', async () => {
  const db = seeded();
  const f = fakeFetch(() => reply({ reply: 'Certo.', topics: [{ area: 'Programmazione', topic: 'Programmazione a oggetti' }, { area: 'programmazione', topic: 'ereditarietà' }] }));
  const d = deps(f);
  const out = await handleChat(db, ENV, d, { text: 'spiegami la programmazione orientata agli oggetti' });
  assert.deepEqual(out.touched, ['programmazione']);
  assert.deepEqual(out.touchedLeaves, ['t:programmazione/programmazione-a-oggetti', 't:programmazione/ereditarieta']);
  await handleChat(db, ENV, d, { text: 'e il polimorfismo?' });
  const prog = memory.graph(db).branches.find(b => b.id === 'programmazione');
  assert.deepEqual(prog.children.map(c => c.label).sort(), ['Programmazione a oggetti', 'ereditarietà']);
  // L'area resta anche senza ricordi salvati, e forget di altri ricordi non la cancella.
  memory.remember(db, { module: 'auto', text: 'Tagliando a 60000 km' }, '2026-11-13T10:00');
  memory.forget(db, db.get('SELECT id FROM memories').id);
  assert.ok(memory.graph(db).branches.some(b => b.id === 'programmazione'));
  assert.ok(!memory.graph(db).branches.some(b => b.id === 'auto'));
  assert.match(systemOf(f.calls[0]), /"topics"/);
});

test('parseReply: argomenti ripuliti e al massimo tre', () => {
  const r = parseReply(JSON.stringify({ reply: 'ok', topics: [{ area: 'a', topic: 'x' }, { area: '' }, 'no', { area: 'b' }, { area: 'c' }, { area: 'd' }] }));
  assert.deepEqual(r.topics, [{ area: 'a', topic: 'x' }, { area: 'b', topic: '' }, { area: 'c', topic: '' }]);
  assert.deepEqual(parseReply('testo semplice').topics, []);
});

test('sfera: Sport è un ramo a parte, con un nodo per tipo di attività', async () => {
  const db = seeded();
  const d0 = loadDiary(db);
  d0.activities = [
    { id: 'a1', date: '2026-11-10', type: 'corsa', description: '', durationMin: 30, kcalBurned: 300 },
    { id: 'a2', date: '2026-11-12', type: 'Corsa', description: '', durationMin: 25, kcalBurned: 250 },
    { id: 'a3', date: '2026-11-11', type: 'palestra', description: '', durationMin: 60, kcalBurned: 400 },
  ];
  saveDiary(db, d0);
  const f = fakeFetch(() => reply({ reply: 'Bene.', topics: [{ area: 'sport', topic: 'tecnica di corsa' }] }));
  const d = deps(f);
  const out = await handleChat(db, ENV, d, { text: 'come miglioro la corsa?' });
  assert.ok(out.touched.includes('sport'));
  const g = await (await handleApi(db, ENV, d, new Request('https://x/api/graph'))).json();
  const sport = g.branches.find(b => b.id === 'sport');
  assert.deepEqual(sport.children.map(c => c.label), ['tecnica di corsa', 'corsa · 2 volte, ultima 11-12', 'palestra · una volta, ultima 11-11']);
  assert.equal(g.branches.filter(b => b.id === 'sport').length, 1);
});

test('personalizzare l\'app: "voglio vedere sempre il deficit" fissa il riquadro, e si può togliere', async () => {
  const db = seeded();
  const f = fakeFetch((url, body, n) => n === 1
    ? reply({ reply: 'Fatto, signore: lo vedrà sempre nella schermata principale.', actions: [{ type: 'ui_pin', widget: 'deficit_cumulativo', where: 'jarvis' }, { type: 'ui_note', text: 'Niente dolci dopo cena', where: 'oggi' }] })
    : reply({ reply: 'ok' }));
  const d = deps(f);
  const out = await handleChat(db, ENV, d, { text: 'voglio vedere sempre il deficit accumulato' });
  assert.equal(out.layoutChanged, true);
  assert.match(systemOf(f.calls[0]), /PERSONALIZZARE L'APP[\s\S]*deficit_cumulativo/);
  const state = await (await handleApi(db, ENV, d, new Request('https://x/api/state'))).json();
  assert.deepEqual(state.layout.jarvis, [{ type: 'deficit_cumulativo' }]);
  assert.equal(state.layout.oggi[0].text, 'Niente dolci dopo cena');
  // Le istruzioni per l'interfaccia entrano solo quando servono.
  await handleChat(db, ENV, d, { text: 'ho mangiato una mela', sessionId: 's2' });
  assert.doesNotMatch(systemOf(f.calls[1]), /PERSONALIZZARE L'APP/);
  // Togliere a mano dalla schermata, con la ✕.
  const noteId = state.layout.oggi[0].id;
  const res = await (await handleApi(db, ENV, d, new Request('https://x/api/actions', { method: 'POST', body: JSON.stringify({ actions: [{ type: 'ui_unpin', widget: 'deficit_cumulativo', where: 'jarvis' }, { type: 'ui_unpin', widget: noteId, where: 'oggi' }] }) }))).json();
  assert.deepEqual(res.state.layout, { jarvis: [], oggi: [] });
  // Riquadri inventati vengono ignorati.
  assert.equal(ui.applyUiAction(db, { type: 'ui_pin', widget: 'grafico_magico' }), false);
});

test('promemoria che si ripetono: "ogni sera butta la spazzatura" torna ogni giorno alla stessa ora', () => {
  const db = makeDb();
  const tz = 'Europe/Rome';
  const id = agenda.addReminder(db, { text: 'Butta la spazzatura', due: '2026-11-12T21:00', repeat: 'giorno' }, T0, tz);
  assert.ok(id);
  // Scatta alle 21 del 12: notifica e passa al 13 alle 21.
  let next = agenda.fireDue(db, localToMs('2026-11-12T21:01', tz), tz);
  assert.equal(next, localToMs('2026-11-13T21:00', tz));
  assert.equal(db.all("SELECT * FROM inbox WHERE kind = 'reminder'").length, 1);
  // Server fermo per tre giorni: una sola notifica, poi la prossima sera.
  next = agenda.fireDue(db, localToMs('2026-11-16T10:00', tz), tz);
  assert.equal(next, localToMs('2026-11-16T21:00', tz));
  assert.equal(db.all("SELECT * FROM inbox WHERE kind = 'reminder'").length, 2);
  // Attraverso il cambio d'ora resta alle 21 locali; feriali salta il fine settimana; mese tiene il giorno.
  assert.equal(agenda.nextOccurrence(localToMs('2027-03-27T21:00', tz), 'giorno', localToMs('2027-03-27T21:01', tz), tz), localToMs('2027-03-28T21:00', tz));
  assert.equal(agenda.nextOccurrence(localToMs('2026-11-13T08:00', tz), 'feriali', localToMs('2026-11-13T09:00', tz), tz), localToMs('2026-11-16T08:00', tz));
  assert.equal(agenda.nextOccurrence(localToMs('2026-01-31T09:00', tz), 'mese', localToMs('2026-01-31T10:00', tz), tz), localToMs('2026-02-28T09:00', tz));
  assert.equal(agenda.listReminders(db, tz)[0].repeat, 'giorno');
  // done_reminder lo ferma per sempre.
  agenda.doneReminder(db, id);
  assert.equal(agenda.listReminders(db, tz).length, 0);
});

test('umore: le emozioni spostano gli ormoni, che tornano piano alla quiete; entrano nel contesto', async () => {
  const db = seeded();
  const H = 3600_000;
  assert.equal(mood.current(db, T0).dominant, 'quiete');
  mood.feel(db, 'entusiasmo', 1, T0);
  const hot = mood.current(db, T0);
  assert.equal(hot.dominant, 'gioia');
  assert.ok(hot.gioia > 0.7 && hot.calma < 0.55);
  const later = mood.current(db, T0 + 12 * H);
  assert.ok(later.gioia < 0.5 && later.dominant === 'quiete', 'dopo 12 ore è quasi tornato alla quiete');
  mood.feel(db, 'parola-sconosciuta', 1, T0);
  const f = fakeFetch(() => reply({ reply: 'Mi spiace, signore.', mood: { emozione: 'preoccupazione', intensita: 0.8 } }));
  await handleChat(db, ENV, deps(f), { text: 'ho perso le chiavi' });
  assert.match(systemOf(f.calls[0]), /STATO D'ANIMO/);
  const state = await (await handleApi(db, ENV, deps(f), new Request('https://x/api/state'))).json();
  assert.ok(state.mood.tensione > 0.3);
});

test('promemoria legati a un luogo: salvati da telefono, consegnati all\'arrivo e mai dal timer', async () => {
  const db = makeDb();
  const d = { ...deps(fakeFetch(() => reply({ reply: 'Va bene, signore.', actions: [
    { type: 'add_reminder', text: 'Butta la spazzatura', place: 'a casa', when: 'arrivo', repeat: 'sempre' },
    { type: 'add_reminder', text: 'Compra il latte', place: 'Casa', when: 'uscita' },
    { type: 'save_place', name: 'Casa' },
  ] }))), schedule: () => {} };
  const call = async (method, path, payload) => {
    const res = await handleApi(db, ENV, d, new Request('https://x' + path, { method, body: payload ? JSON.stringify(payload) : undefined }));
    return { status: res.status, body: await res.json() };
  };
  const out = await handleChat(db, ENV, d, { text: 'quando arrivo a casa ricordami di buttare la spazzatura' });
  assert.deepEqual(out.device, [{ type: 'save_place', name: 'Casa' }], 'la posizione la prende il telefono');
  let list = agenda.listReminders(db, 'Europe/Rome');
  assert.equal(list.length, 2);
  assert.equal(list[0].place, 'casa');
  assert.equal(list[0].placeKnown, false);
  assert.match(agenda.agendaContext(db, 'Europe/Rome'), /luogo non ancora salvato/);
  // Il timer non li tocca.
  assert.equal(agenda.fireDue(db, T0 + 86_400_000, 'Europe/Rome'), null);
  assert.equal((await call('POST', '/api/places', { name: 'Casa', lat: 'x', lon: 9 })).status, 400);
  const saved = await call('POST', '/api/places', { name: 'Casa', lat: 45.46, lon: 9.19 });
  assert.deepEqual(saved.body.places.map(p => [p.key, p.radius]), [['casa', 150]]);
  assert.equal(saved.body.reminders[0].placeKnown, true);
  assert.equal((await call('GET', '/api/state')).body.places.length, 1);
  // Arrivo: solo quello di arrivo; si ripete, quindi resta attivo.
  assert.deepEqual((await call('POST', '/api/place-event', { place: 'casa', event: 'arrivo' })).body.items, ['Butta la spazzatura']);
  assert.deepEqual((await call('POST', '/api/place-event', { place: 'casa', event: 'arrivo' })).body.items, [], 'GPS che balla: niente doppioni');
  assert.deepEqual((await call('POST', '/api/place-event', { place: 'casa', event: 'uscita' })).body.items, ['Compra il latte']);
  list = agenda.listReminders(db, 'Europe/Rome');
  assert.deepEqual(list.map(r => r.text), ['Butta la spazzatura'], 'quello senza ripetizione è fatto');
  assert.equal((await call('POST', '/api/inbox/consume')).body.items.length, 0, 'già notificati dal telefono');
  await call('DELETE', '/api/places/casa');
  assert.equal((await call('GET', '/api/places')).body.places.length, 0);
});
