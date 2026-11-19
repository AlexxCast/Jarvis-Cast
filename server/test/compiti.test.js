import test from 'node:test';
import assert from 'node:assert/strict';
import * as router from '../src/router.js';
import * as jobs from '../src/jobs.js';
import { kvSet, kvGet } from '../src/db.js';
import { DEFAULT_MODELS } from '../src/models.js';
import { localToMs } from '../src/clock.js';
import { makeDb, fakeFetch, deps, T0 } from './helpers.js';

// Due modelli "smart": uno veloce ma medio (prio alta) e uno lento ma fortissimo (deep, q 10).
const MODELS = [
  { provider: 'gemini', model: 'veloce-flash', tiers: ['fast', 'smart'], ctx: 100000, free: true, prio: 10, q: 6 },
  { provider: 'groq', model: 'medio-70b', tiers: ['fast', 'smart'], ctx: 100000, free: true, prio: 20, q: 5 },
  { provider: 'nvidia', model: 'kimi-forte', tiers: ['deep'], ctx: 100000, free: true, prio: 33, q: 10 },
];
const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', NVIDIA_API_KEY: 'n' };
// modelsRemoved: nei test conta solo questo elenco, senza i modelli nuovi del catalogo.
const setup = () => { const db = makeDb(); kvSet(db, 'models', MODELS); kvSet(db, 'modelsRemoved', DEFAULT_MODELS.map(m => `${m.provider}:${m.model}`)); return db; };

test('la chat dal vivo resta sul modello veloce; i compiti in background vanno al più forte (anche "deep")', () => {
  const db = setup();
  const live = router.rank(db, ENV, { tier: 'smart', ms: T0 }).map(c => c.key);
  assert.equal(live[0], 'gemini:veloce-flash');
  assert.ok(!live.includes('nvidia:kimi-forte'), 'i modelli deep non entrano mai nella chat dal vivo');
  const best = router.rank(db, ENV, { tier: 'smart', best: true, ms: T0 }).map(c => c.key);
  assert.equal(best[0], 'nvidia:kimi-forte');
  // avoid: il modello che ha sbagliato va in fondo, per avere un secondo parere.
  assert.equal(router.rank(db, ENV, { tier: 'smart', best: true, avoid: ['nvidia:kimi-forte'], ms: T0 })[0].key, 'gemini:veloce-flash');
});

test('un elenco modelli personalizzato vecchio riceve i nuovi modelli del catalogo, uno salvato adesso no', () => {
  const db = makeDb();
  kvSet(db, 'models', MODELS);
  const keys = router.loadModels(db).map(m => `${m.provider}:${m.model}`);
  assert.ok(keys.includes('nvidia:moonshotai/kimi-k3.1-pro'));
  assert.ok(DEFAULT_MODELS.filter(m => m.added).every(m => keys.includes(`${m.provider}:${m.model}`)));
  kvSet(db, 'modelsRemoved', DEFAULT_MODELS.map(m => `${m.provider}:${m.model}`));
  assert.equal(router.loadModels(db).length, MODELS.length);
});

test('Workers AI tramite il binding, senza chiavi; un errore di quota passa al modello successivo', async () => {
  const db = makeDb();
  kvSet(db, 'models', [
    { provider: 'workersai', model: '@cf/qwen/qwen3.8-27b', tiers: ['fast'], ctx: 100000, free: true, prio: 1, q: 7 },
    { provider: 'groq', model: 'riserva', tiers: ['fast'], ctx: 100000, free: true, prio: 5 },
  ]);
  const seen = [];
  let quota = false;
  const env = { GROQ_API_KEY: 'q', AI: { run: async (model, input) => { seen.push({ model, input }); if (quota) throw new Error('4006: daily free allocation of 10,000 neurons exceeded'); return { response: 'ciao dal cloud' }; } } };
  const build = () => [{ role: 'user', content: 'ciao' }];
  const r1 = await router.chat(db, env, { tier: 'fast', build, fetchFn: fakeFetch(() => 'groq'), now: () => T0 });
  assert.equal(r1.text, 'ciao dal cloud');
  assert.equal(seen[0].model, '@cf/qwen/qwen3.8-27b');
  assert.equal(seen[0].input.reasoning_effort, 'low');
  quota = true;
  const r2 = await router.chat(db, env, { tier: 'fast', build, fetchFn: fakeFetch(() => 'groq'), now: () => T0 + 1000 });
  assert.equal(r2.key, 'groq:riserva');
});

test('compito "fai questo e poi quello": il revisore boccia un passo, si rifà con un altro modello e le azioni partono una volta sola', async () => {
  const db = setup();
  let firstTry = true;
  const f = fakeFetch((url, body) => {
    const sys = body.messages[0].content, usr = body.messages[1].content;
    if (/pianificatore/.test(sys)) return JSON.stringify({ steps: [
      { id: 'n1', role: 'Esecutore', title: 'Promemoria dentista', instruction: 'Crea il promemoria per il dentista domani alle 9', done: 'promemoria creato', tier: 'smart' },
      { id: 'n2', role: 'Ricercatore', title: 'Orari farmacia', instruction: 'Trova gli orari della farmacia', tier: 'smart', dependsOn: ['n1'] },
    ] });
    if (/revisore severo/.test(sys)) {
      // Prima versione senza data: bocciata. Seconda: approvata.
      return JSON.stringify(/"due"/.test(usr) ? { ok: true } : { ok: false, problemi: 'manca la data del promemoria' });
    }
    if (/revisore finale/.test(sys)) return JSON.stringify({ completo: true, mancano: [] });
    if (/Unisci i risultati/.test(sys)) return 'Promemoria creato e orari trovati.';
    if (/Promemoria dentista/.test(usr.split('PASSO DA SVOLGERE ORA')[1] || '')) {
      if (firstTry) { firstTry = false; return 'Fatto il promemoria.\n```azioni\n[{"type":"add_reminder","text":"Dentista"}]\n```'; }
      assert.match(usr, /manca la data/, 'il nuovo tentativo riceve le critiche del revisore');
      return 'Promemoria creato.\n```azioni\n[{"type":"add_reminder","text":"Dentista","due":"2026-11-13T09:00"}]\n```';
    }
    return 'La farmacia è aperta 8-20.';
  });
  const d = deps(f);
  jobs.createJob(db, { title: 'Commissioni', goal: 'Ricordami il dentista domani alle 9 e poi trova gli orari della farmacia' }, T0, d.tz);
  for (let i = 0; i < 12; i++) { if (await jobs.advance(db, ENV, d) == null) break; }
  const job = jobs.listJobs(db)[0];
  assert.equal(job.status, 'done');
  // Un solo promemoria, quello giusto: il tentativo bocciato non ha lasciato doppioni.
  const rem = db.all('SELECT text, due FROM reminders');
  assert.equal(rem.length, 1);
  assert.equal(rem[0].due, localToMs('2026-11-13T09:00', 'Europe/Rome'));
  // Il passo rifatto è andato a un modello diverso da quello che aveva sbagliato.
  const stepCalls = f.calls.filter(c => /PASSO DA SVOLGERE ORA \(1/.test(c.body.messages[1].content));
  assert.equal(stepCalls.length, 2);
  assert.notEqual(stepCalls[0].url, stepCalls[1].url);
  // Pianificazione e passi sono andati al modello più forte (NVIDIA "deep").
  assert.match(f.calls[0].url, /nvidia/);
  assert.match(db.get("SELECT text FROM inbox WHERE kind = 'job' ORDER BY id DESC").text, /Ho fatto: 1 promemoria/);
});

test('il revisore finale trova una richiesta dimenticata e aggiunge il passo invece di dire "fatto" a metà', async () => {
  const db = setup();
  let finalChecks = 0;
  const f = fakeFetch((url, body) => {
    const sys = body.messages[0].content, usr = body.messages[1].content;
    if (/pianificatore/.test(sys)) return JSON.stringify({ steps: [{ id: 'n1', title: 'Lista spesa', instruction: 'Scrivi la lista della spesa', tier: 'fast' }] });
    if (/revisore finale/.test(sys)) { finalChecks++; return JSON.stringify({ completo: false, mancano: [{ title: 'Ricorda il latte', instruction: 'Salva in memoria che il Capo beve latte di avena' }] }); }
    if (/revisore severo/.test(sys)) return JSON.stringify({ ok: true });
    if (/Unisci/.test(sys)) return 'Tutto fatto.';
    if (/Ricorda il latte/.test(usr)) return 'Salvato.\n```azioni\n[{"type":"remember","module":"generale","text":"Il Capo beve latte di avena."}]\n```';
    return 'pane, uova';
  });
  const d = deps(f);
  jobs.createJob(db, { title: 'Spesa', goal: 'Fai la lista della spesa e ricordati che bevo latte di avena' }, T0, d.tz);
  for (let i = 0; i < 12; i++) { if (await jobs.advance(db, ENV, d) == null) break; }
  const job = jobs.listJobs(db)[0];
  assert.equal(job.status, 'done');
  assert.equal(job.steps.length, 2);
  assert.equal(finalChecks, 1, 'il controllo finale aggiunge passi una volta sola');
  assert.ok(db.all('SELECT text FROM memories').some(m => /avena/.test(m.text)));
});

test('un passo può chiedere internet con "CERCA:" e riceve i risultati veri', async () => {
  const db = setup();
  const f = fakeFetch((url, body) => {
    const sys = body.messages?.[0]?.content || '', usr = body.messages?.[1]?.content || '';
    if (/pianificatore/.test(sys)) return JSON.stringify({ steps: [{ id: 'n1', title: 'Prezzo', instruction: 'Trova il prezzo del treno Klagenfurt-Vienna', tier: 'fast' }] });
    if (/revisore/.test(sys)) return JSON.stringify({ ok: true, completo: true, mancano: [] });
    if (/nodo-agente/.test(sys)) return /RISULTATI/i.test(usr) || /Klagenfurt-Vienna: 39/.test(usr) ? 'Costa circa 39 euro.' : 'CERCA: prezzo treno Klagenfurt Vienna';
    return 'ok';
  });
  f.search = true;
  const d = deps(f);
  jobs.createJob(db, { title: 'Treno', goal: 'Quanto costa il treno per Vienna?' }, T0, d.tz);
  for (let i = 0; i < 8; i++) { if (await jobs.advance(db, ENV, d) == null) break; }
  const job = db.get('SELECT steps FROM jobs');
  assert.match(JSON.parse(job.steps)[0].output, /39 euro|CERCA/);
  assert.ok(f.calls.filter(c => /nodo-agente/.test(c.body.messages?.[0]?.content || '')).length >= 2, 'dopo la ricerca il passo viene rifatto con i risultati');
});

test('parser: blocco azioni, richiesta web e giudizio del revisore', () => {
  assert.deepEqual(jobs.parseStepActions('ok\n```azioni\n[{"type":"remember","text":"x"}]\n```').actions, [{ type: 'remember', text: 'x' }]);
  assert.equal(jobs.parseStepActions('ok\n```azioni\n[{rotto\n```').actions, null);
  assert.deepEqual(jobs.webAsk('CERCA: meteo Vienna'), { kind: 'search', q: 'meteo Vienna' });
  assert.equal(jobs.webAsk('Il risultato è lungo e non chiede nulla'), null);
  assert.deepEqual(jobs.parseVerdict('{"ok": false, "problemi": "manca X"}'), { ok: false, problems: 'manca X' });
  assert.equal(jobs.parseVerdict('boh').ok, true);
});

test('le azioni sul telefono di un compito non partono da sole: restano in sospeso per il Capo', () => {
  const db = makeDb();
  const out = jobs.runStepActions(db, [{ type: 'phone_task', goal: 'Scrivi a Marco su WhatsApp' }], { ms: T0, tz: 'Europe/Rome', nowIso: '2026-11-12T12:00', today: '2026-11-12' });
  assert.deepEqual(out.phone, ['Scrivi a Marco su WhatsApp']);
  assert.equal(kvGet(db, 'phonePending', null).goal, 'Scrivi a Marco su WhatsApp');
  assert.match(db.get('SELECT text FROM inbox').text, /mi serve il telefono/);
});
