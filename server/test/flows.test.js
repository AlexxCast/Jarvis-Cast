import test from 'node:test';
import assert from 'node:assert/strict';
import * as phone from '../src/phone.js';
import * as flows from '../src/flows.js';
import * as memory from '../src/memory.js';
import * as agents from '../src/agents.js';
import { handleChat } from '../src/brain.js';
import { handleApi } from '../src/api.js';
import { kvSet } from '../src/db.js';
import { makeDb, fakeFetch, deps } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
const HOME = { app: 'com.android.launcher', items: [] };
const APP = { app: 'com.joytify.music', items: [{ n: 1, kind: 'testo', text: 'Home' }, { n: 2, kind: 'bottone', text: '(icona: search)' }] };
const SEARCH = { app: 'com.joytify.music', items: [{ n: 5, kind: 'campo', text: 'Cerca brani o playlist' }] };
const noModel = () => fakeFetch(() => { throw new Error('non doveva chiamare il modello'); });

/** Prima esecuzione guidata dal modello: Jarvis impara il flow. */
async function learnSearch(db) {
  const moves = [{ do: 'open_app', text: 'Joytify' }, { do: 'tap', n: 2 }, { do: 'type', n: 5, text: 'rock' }, { do: 'done', say: 'Ecco il rock.' }];
  const f = fakeFetch((url, body, n) => JSON.stringify(moves[n - 1]));
  const screens = [HOME, APP, SEARCH, SEARCH];
  for (let i = 0; i < 4; i++) await phone.step(db, ENV, deps(f), { goal: 'cerca rock su Joytify', step: i, screen: screens[i] });
  return f;
}

test('flow appresi: imparato una volta, la seconda volta va da solo e cambia solo il parametro', async () => {
  const db = makeDb();
  const f = await learnSearch(db);
  assert.equal(f.calls.length, 4);
  const [saved] = flows.listFlows(db);
  assert.equal(saved.hasParam, true);
  assert.equal(saved.template, 'cerca {q} su Joytify');
  assert.deepEqual(saved.tokens, ['cerca', 'joytify'], 'il parametro non fa parte delle parole fisse');

  const m = noModel(), d = deps(m), goal = 'cerca jazz su Joytify';
  assert.deepEqual(await phone.step(db, ENV, d, { goal, step: 0, screen: HOME }), { do: 'open_app', text: 'Joytify', say: 'Apro Joytify.', auto: true });
  assert.deepEqual(await phone.step(db, ENV, d, { goal, step: 1, screen: APP }), { do: 'tap', n: 2, say: '', auto: true });
  assert.deepEqual(await phone.step(db, ENV, d, { goal, step: 2, screen: SEARCH }), { do: 'type', n: 5, text: 'jazz', say: '', auto: true });
  assert.equal((await phone.step(db, ENV, d, { goal, step: 3, screen: SEARCH })).do, 'done');
  assert.equal(m.calls.length, 0);
  assert.equal(flows.listFlows(db)[0].uses, 2);
});

test('flow appresi: obiettivi diversi o creativi non riusano il flow', async () => {
  const db = makeDb();
  await learnSearch(db);
  const [flow] = flows.listFlows(db);
  assert.equal(flows.scoreFlowMatch(flow, 'chiudi Joytify'), 0);
  assert.equal(flows.scoreFlowMatch(flow, 'cerca su Joytify'), 0, 'manca il parametro');
  assert.equal(flows.scoreFlowMatch(flow, 'cerca musica che mi piace su Joytify'), 0);
  assert.ok(flows.scoreFlowMatch(flow, 'cerca Vasco Rossi su Joytify') >= flows.PHONE_THRESHOLD);
  assert.equal(flows.extractParam(flow, 'cerca Vasco Rossi su Joytify'), 'Vasco Rossi');
  // Anche con molti usi, un compito diverso resta al modello.
  flow.uses = 50;
  assert.equal(flows.scoreFlowMatch(flow, 'chiudi Joytify'), 0);
});

test('flow sicurezza: mai in automatico pulsanti irreversibili, testi composti o campi sensibili', async () => {
  const db = makeDb();
  flows.saveFlowFromTrace(db, {
    goal: 'scrivi a Marco su WhatsApp', app: 'WhatsApp', params: [],
    steps: [
      { do: 'open_app', app: 'WhatsApp' },
      { do: 'tap', kind: 'testo', icon: '', textMatch: 'marco' },
      { do: 'type', kind: 'campo', icon: '', textMatch: 'messaggio', composed: true },
      { do: 'tap', kind: 'bottone', icon: 'send', textMatch: '' },
      { do: 'done' },
    ],
  }, 1000);
  const llm = fakeFetch(() => JSON.stringify({ do: 'type', n: 9, text: 'Arrivo' }));
  const d = deps(llm), goal = 'scrivi a Marco su WhatsApp';
  assert.equal((await phone.step(db, ENV, d, { goal, step: 0, screen: HOME })).auto, true);
  assert.equal((await phone.step(db, ENV, d, { goal, step: 1, screen: { app: 'com.whatsapp', items: [{ n: 4, kind: 'testo', text: 'Marco' }] } })).auto, true);
  // Il testo del messaggio lo scrive il modello, non il flow.
  const typed = await phone.step(db, ENV, d, { goal, step: 2, screen: { app: 'com.whatsapp', items: [{ n: 9, kind: 'campo', text: 'Messaggio' }] } });
  assert.equal(typed.auto, undefined);
  assert.equal(llm.calls.length, 1);

  // Un pulsante "invia" non viene mai toccato in automatico.
  assert.equal(flows.tryFlowStep(db, { goal: 'x', step: 0, screen: HOME }), null);
  const sendFlow = { id: 's', app: 'Posta', tokens: ['manda', 'posta'], steps: [{ do: 'tap', kind: 'bottone', icon: 'send', textMatch: '' }, { do: 'done' }], uses: 3 };
  kvSet(db, 'phoneFlows', [sendFlow]);
  assert.equal(flows.tryFlowStep(db, { goal: 'manda posta', step: 0, screen: { app: 'posta', items: [{ n: 1, kind: 'bottone', text: '(icona: send)' }] } }), null);
  // Né si scrive in un campo password.
  kvSet(db, 'phoneFlows', [{ id: 'p', app: 'Banca', tokens: ['apri', 'banca'], hasParam: false, steps: [{ do: 'tap', kind: 'campo', textMatch: 'password' }, { do: 'done' }], uses: 3 }]);
  assert.equal(flows.tryFlowStep(db, { goal: 'apri banca', step: 0, screen: { app: 'banca', items: [{ n: 1, kind: 'campo', text: 'Password' }] } }), null);
});

test('flow: schermo imprevisto passa al modello, che finisce il lavoro senza che il flow riparta a metà', async () => {
  const db = makeDb();
  await learnSearch(db);
  const llm = fakeFetch(() => JSON.stringify({ do: 'tap', n: 7 }));
  const d = deps(llm), goal = 'cerca pop su Joytify';
  assert.equal((await phone.step(db, ENV, d, { goal, step: 0, screen: HOME })).auto, true);
  const popup = { app: 'com.joytify.music', items: [{ n: 7, kind: 'bottone', text: 'Non ora' }] };
  assert.equal((await phone.step(db, ENV, d, { goal, step: 1, screen: popup })).auto, undefined);
  assert.equal(flows.listFlows(db)[0].fails, 1);
  // Passo successivo: decide ancora il modello, il flow non riapre l'app da capo.
  assert.equal((await phone.step(db, ENV, d, { goal, step: 2, screen: APP })).auto, undefined);
  assert.equal(llm.calls.length, 2);
});

test('flow: un compito ripreso a metà non sovrascrive il flow buono', () => {
  const db = makeDb();
  flows.recordTrace(db, { goal: 'metti radio su Joytify', step: 3, screen: SEARCH, move: { do: 'tap', n: 5 }, nowMs: 1 });
  flows.recordTrace(db, { goal: 'metti radio su Joytify', step: 4, screen: SEARCH, move: { do: 'done', say: 'ok' }, nowMs: 2 });
  assert.equal(flows.listFlows(db).length, 0);
});

test('gatekeeper locale: app, chiamate e flow appresi senza modello; il resto va al modello', async () => {
  const db = makeDb();
  kvSet(db, 'apps', ['Joytify', 'WhatsApp']);
  flows.saveFlowFromTrace(db, { goal: 'metti musica rock su Joytify', app: 'Joytify', params: [], steps: [{ do: 'open_app', app: 'Joytify' }, { do: 'done' }] }, 1000);
  const m = noModel(), d = deps(m);

  let r = await handleChat(db, ENV, d, { text: 'Jarvis apri Joytify' });
  assert.equal(r.model, 'local-gatekeeper');
  assert.deepEqual(r.device, [{ type: 'open_app', name: 'Joytify' }]);
  r = await handleChat(db, ENV, d, { text: 'chiama Marcolino' });
  assert.deepEqual(r.device, [{ type: 'call', name: 'Marcolino' }]);
  r = await handleChat(db, ENV, d, { text: 'metti musica rock su Joytify' });
  assert.deepEqual(r.device, [{ type: 'phone_task', goal: 'metti musica rock su Joytify' }]);
  assert.equal(m.calls.length, 0);
  assert.equal(db.all("SELECT role FROM messages").length, 6, 'la conversazione resta salvata');

  // Scelte creative, più richieste insieme, app sconosciute, domande: decide il modello.
  for (const text of ['metti musica che mi piace su Joytify', 'chiama mamma e dille che arrivo', 'apri Instagram', 'chi ha vinto ieri?']) {
    assert.equal(flows.gatekeepChat(db, text), null, text);
  }
  const withModel = fakeFetch(() => JSON.stringify({ reply: 'Metto la sua musica.', actions: [{ type: 'phone_task', goal: 'metti musica che mi piace su Joytify' }] }));
  r = await handleChat(db, ENV, deps(withModel), { text: 'metti musica che mi piace su Joytify' });
  assert.ok(withModel.calls.length >= 1);
  assert.notEqual(r.model, 'local-gatekeeper');
});

test('api /api/flows: elenca ed elimina i flow appresi', async () => {
  const db = makeDb();
  const saved = flows.saveFlowFromTrace(db, { goal: 'apri spotify', app: 'Spotify', params: [], steps: [{ do: 'open_app', app: 'Spotify' }, { do: 'done' }] }, 1000);
  const d = deps(fakeFetch(() => '{}'));
  const got = await (await handleApi(db, ENV, d, new Request('http://x/api/flows'))).json();
  assert.deepEqual(got.flows.map(f => f.id), [saved.id]);
  const del = await (await handleApi(db, ENV, d, new Request(`http://x/api/flows/${saved.id}`, { method: 'DELETE' }))).json();
  assert.equal(del.flows.length, 0);
});

test('grafo e multi-agente locale: i flow appresi creano il ramo autonomo e gli agenti locali ordinano memoria e grafo', async () => {
  const db = makeDb();
  // Il ramo automazioni è sempre visibile nel grafo (con il prefisso musicale predefinito finché non ci sono altri flow).
  assert.equal(memory.graph(db).branches.some(b => b.id === 'automazioni'), true);
  const saved = flows.saveFlowFromTrace(db, { goal: 'apri spotify', app: 'Spotify', params: [], steps: [{ do: 'open_app', app: 'Spotify' }, { do: 'done' }] }, 1000);
  const g = memory.graph(db);
  const autoBranch = g.branches.find(b => b.id === 'automazioni');
  assert.ok(autoBranch);
  assert.equal(autoBranch.auto, true);
  assert.equal(autoBranch.kind, 'flow');
  assert.equal(autoBranch.children[0].id, 'f:' + saved.id);
  assert.equal(autoBranch.children[0].auto, true);

  // Prefisso automatico per ricerca musica vaga ("cerca una musica che mi piace"):
  // Passo 0 apre Joytify in automatico, Passo 1 tocca la ricerca in automatico, Passo 2 passa al modello IA per scegliere!
  const llm = fakeFetch(() => JSON.stringify({ do: 'type', n: 5, text: 'Queen Bohemian Rhapsody', say: 'Cerco Queen.' }));
  const d = deps(llm);
  const goal = 'cerca una musica che mi piace';
  assert.deepEqual(await phone.step(db, ENV, d, { goal, step: 0, screen: HOME }), { do: 'open_app', text: 'Joytify', say: 'Apro Joytify.', auto: true });
  assert.deepEqual(await phone.step(db, ENV, d, { goal, step: 1, screen: APP }), { do: 'tap', n: 2, say: '', auto: true });
  assert.equal(llm.calls.length, 0, 'apertura app e tocco ricerca senza chiamare il modello');
  const step2 = await phone.step(db, ENV, d, { goal, step: 2, screen: SEARCH });
  assert.equal(step2.auto, undefined, 'sul campo di ricerca interviene il modello IA');
  assert.equal(llm.calls.length, 1);

  // MemoryAgent estrae ricordi espliciti ("ricordati che...") senza LLM
  const extracted = agents.MemoryAgent.extractExplicit(db, 'Ricordati che sono allergico alle arachidi', 2000);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].branch, 'salute');

  // FlowAgent pota i flow che falliscono troppo
  kvSet(db, 'phoneFlows', [{ ...saved, fails: 4, uses: 1 }]);
  assert.equal(agents.FlowAgent.prune(db), 1);
  assert.equal(flows.listFlows(db).length, 0);

  // GraphAgent: scarta nodi generici/meta nella dieta e riduce il ramo quando l'utente lo chiede
  memory.touchTopics(db, [
    { area: 'dieta', topic: 'colazione' },
    { area: 'dieta', topic: 'gestione nodi' },
    { area: 'dieta', topic: 'intolleranza lattosio' },
  ], '2026-11-15T10:00');
  const dietBranch = memory.graph(db).branches.find(b => b.id === 'dieta');
  assert.deepEqual(dietBranch.children.map(c => c.label), ['intolleranza lattosio']);
  const cmd = agents.GraphAgent.detectCleanCommand('il grafo della dieta è troppo grande riducilo a 3 nodi');
  assert.deepEqual(cmd, { branch: 'dieta', maxNodes: 3 });
  agents.GraphAgent.cleanBranch(db, cmd.branch, cmd.maxNodes);

  // Anche se il modello non compila "topics" o non emette phone_task ma promette di cercare,
  // l'automazione viene aggiunta in automatico al ramo Automazioni e i nuovi nodi vengono generati nel grafo.
  const noTopicsModel = fakeFetch(() => JSON.stringify({ reply: 'Certamente signore, cerco subito Vasco Rossi su Joytify.' }));
  const chatRes = await handleChat(db, ENV, deps(noTopicsModel), { text: 'Jarvis cerca Vasco Rossi su Joytify' });
  assert.equal(chatRes.device[0]?.type, 'phone_task');
  assert.ok(chatRes.touched.includes('automazioni'));
  assert.ok(chatRes.touched.includes('intrattenimento'));
  const gAfter = memory.graph(db);
  const autoAfter = gAfter.branches.find(b => b.id === 'automazioni');
  assert.ok(autoAfter.children.some(c => /vasco rossi/i.test(c.label)));
  const intrAfter = gAfter.branches.find(b => b.id === 'intrattenimento');
  assert.ok(intrAfter && intrAfter.children.some(c => /joytify/i.test(c.label)));

  // Jarvis Core (IA proprietaria interna) e Manager Multi-Dispositivo (PC + Telefono):
  // risolve i comandi per il PC Desktop senza chiamare modelli esterni.
  const zeroLlm = noModel();
  const hb = await (await handleApi(db, ENV, deps(zeroLlm), new Request('http://x/api/devices/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ id: 'desktop-pc', kind: 'desktop', name: 'PC Alessio', platform: 'Windows 11', metrics: { cpu: 18, ram: 42, activeWindow: 'VS Code' } }),
  }))).json();
  assert.equal(hb.device.online, true);

  const pcOpen = await handleChat(db, ENV, deps(zeroLlm), { text: 'Jarvis apri Chrome sul PC' });
  assert.equal(pcOpen.model, 'jarvis-core');
  assert.ok(pcOpen.touched.includes('automazioni'));
  assert.equal(zeroLlm.calls.length, 0);

  // Il prossimo heartbeat del PC ritira il comando "open_app Chrome" dalla coda
  const hb2 = await (await handleApi(db, ENV, deps(zeroLlm), new Request('http://x/api/devices/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ id: 'desktop-pc', kind: 'desktop', name: 'PC Alessio' }),
  }))).json();
  assert.equal(hb2.commands.length, 1);
  assert.equal(hb2.commands[0].kind, 'open_app');
  assert.equal(hb2.commands[0].target.toLowerCase(), 'chrome');

  const pcStatus = await handleChat(db, ENV, deps(zeroLlm), { text: 'Jarvis qual è lo stato del PC?' });
  assert.equal(pcStatus.model, 'jarvis-core');
  assert.match(pcStatus.reply, /RAM al 42%/);

  // Deduplicazione semantica e annidamento pulito (casi reali: "lettura whatsapp" vs "lettura messaggi WhatsApp",
  // "comunicazione" dentro "comunicazioni", "ristoranti tipici Klagenfurt" sotto "Klagenfurt", automazioni duplicate).
  assert.equal(memory.sameTopic('lettura whatsapp', 'lettura messaggi WhatsApp'), true);
  assert.equal(memory.sameTopic('comunicazione', 'comunicazioni'), true);
  memory.touchTopics(db, [
    { area: 'comunicazioni', topic: 'comunicazione' },
    { area: 'comunicazioni', topic: 'generale' },
    { area: 'comunicazioni', topic: 'ascolto' },
    { area: 'comunicazioni', topic: 'WhatsApp' },
    { area: 'comunicazioni', topic: 'lettura messaggi WhatsApp' },
    { area: 'comunicazioni', topic: 'lettura whatsapp' },
  ], '2026-11-16T12:00');
  memory.tidyTopics(db);
  const comTopics = db.all("SELECT name, label, parent FROM topics WHERE module = 'comunicazioni'");
  assert.equal(comTopics.length, 2, 'restano solo WhatsApp e un unico nodo lettura annidato');
  const childCom = comTopics.find(t => t.name !== 'whatsapp');
  assert.equal(childCom.parent, 'whatsapp');
  assert.match(childCom.label, /^lettura/i);
  assert.doesNotMatch(childCom.label, /whatsapp/i, 'il nome del genitore non viene ripetuto nel figlio');

  // Amministratore autonomo (auto-interrogazione a zero crediti), diagnostica in sovraimpressione e task Antigravity con schermo PC.
  const diagRes = await handleChat(db, ENV, deps(zeroLlm), { text: 'Jarvis fammi una diagnostica del sistema' });
  assert.equal(diagRes.model, 'jarvis-core');
  assert.ok(diagRes.visual && diagRes.visual.kind === 'bars');
  assert.ok(diagRes.device.some(d => d.type === 'visual'));

  const agyRes = await handleChat(db, ENV, deps(zeroLlm), { text: 'Jarvis fai partire un task a Antigravity sul progetto Jarvis-Cast per ottimizzare il codice' });
  assert.equal(agyRes.model, 'jarvis-core');
  assert.ok(agyRes.visual && agyRes.visual.kind === 'image');
  assert.match(agyRes.visual.url, /^\/api\/devices\/screen/);
  assert.ok(agyRes.device.some(d => d.type === 'visual'));
});
