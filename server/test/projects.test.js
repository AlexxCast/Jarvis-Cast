// Progetti come i progetti di Claude (istruzioni, file, più chat, memoria e compiti propri)
// e gestione intelligente di contesto e memoria.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat } from '../src/brain.js';
import * as projects from '../src/projects.js';
import * as memory from '../src/memory.js';
import * as jobs from '../src/jobs.js';
import { kvGet, kvSet } from '../src/db.js';
import { handleApi } from '../src/api.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', JARVIS_TOKEN: 't' };
const NOW = '2026-11-18T20:00:00+01:00';
const systemOf = (call) => call.body.messages.find(m => m.role === 'system').content;

function englishProject(db) {
  const id = projects.createProject(db, { name: 'Inglese B2', instructions: 'Sei la tutor di inglese del Capo. Correggi un errore alla volta.' }, NOW, 1);
  projects.addFile(db, id, { name: 'programma.txt', content: 'Lezione 1: Present Perfect.\n\nLezione 2: Past Simple e verbi irregolari.' }, NOW);
  return id;
}

test('progetti: dentro un progetto la risposta usa istruzioni e file del progetto, e resta Kestra (JSON e azioni)', async () => {
  const db = makeDb();
  const id = englishProject(db);
  projects.enterProject(db, id, {}, NOW, 2);
  const f = fakeFetch(() => reply({ reply: 'Partiamo dal Present Perfect.' }));
  const out = await handleChat(db, ENV, deps(f), { text: 'iniziamo la lezione di oggi' });
  assert.equal(out.reply, 'Partiamo dal Present Perfect.');
  const sys = systemOf(f.calls[0]);
  assert.match(sys, /Sei KESTRA/);
  assert.match(sys, /ISTRUZIONI DEL PROGETTO\nSei la tutor di inglese/);
  assert.match(sys, /FILE DEL PROGETTO\n=== FILE: programma.txt ===/);
  // La conversazione sta nella chat del progetto, non nella chat principale.
  const active = projects.getActive(db);
  assert.equal(db.all('SELECT id FROM messages WHERE session = ?', active.chat.session).length, 2);
  assert.equal(db.all("SELECT id FROM messages WHERE session = 'main'").length, 0);
  assert.equal(projects.listChats(db, id)[0].title, 'iniziamo la lezione di oggi');
  // Il resoconto del contesto dice cosa è entrato.
  const rep = kvGet(db, 'contextReport', null);
  assert.equal(rep.project.project, 'Inglese B2');
  assert.deepEqual(rep.project.files, ['programma.txt']);
  assert.ok(rep.sections.some(s => s.name.startsWith("File del progetto")));
});

test('progetti: i ricordi detti nel progetto restano nel progetto, i compiti sono legati al progetto', async () => {
  const db = makeDb();
  const id = englishProject(db);
  projects.enterProject(db, id, {}, NOW, 2);
  const d = deps(fakeFetch(() => reply({ reply: 'Me lo segno.', actions: [{ type: 'remember', module: 'progetto', text: 'Il Capo confonde since e for' }, { type: 'start_job', title: 'Esercizi', goal: 'Prepara 10 esercizi su since e for' }] })));
  await handleChat(db, ENV, d, { text: 'ricordati che confondo since e for e preparami degli esercizi' });
  assert.equal(projects.listMemories(db, id).length, 1);
  assert.equal(memory.recall(db, 'since for confondo').entries.length, 0, 'fuori dal progetto non esce');
  assert.equal(d.jobs[0].project, id);
  const jid = jobs.createJob(db, d.jobs[0], 3, 'Europe/Rome');
  assert.equal(db.get('SELECT project FROM jobs WHERE id = ?', jid).project, id);
});

test('progetti: una chat nuova vede il riassunto delle altre chat dello stesso progetto', async () => {
  const db = makeDb();
  const id = englishProject(db);
  const first = projects.enterProject(db, id, {}, NOW, 2);
  db.run('INSERT INTO sessions (id, summary) VALUES (?, ?)', first.chat.session, 'Abbiamo ripassato il Present Perfect: errori sugli ausiliari.');
  db.run('UPDATE project_chats SET title = ? WHERE id = ?', 'Present Perfect', first.chat.id);
  const f = fakeFetch(() => reply({ reply: 'Ok.' }));
  await handleChat(db, ENV, deps(f), { text: 'nuova chat' });
  await handleChat(db, ENV, deps(f), { text: 'cosa abbiamo fatto la volta scorsa?' });
  assert.match(systemOf(f.calls[0]), /ALTRE CHAT DI QUESTO PROGETTO[\s\S]*Present Perfect: Abbiamo ripassato/);
  assert.equal(projects.listChats(db, id).length, 2);
});

test('progetti: a voce si entra, si crea e si esce', async () => {
  const db = makeDb();
  englishProject(db);
  const d = deps(fakeFetch(() => reply({ reply: 'x' })));
  let out = await handleChat(db, ENV, d, { text: 'apri il progetto inglese' });
  assert.equal(out.reply, 'Siamo nel progetto "Inglese B2".');
  out = await handleChat(db, ENV, d, { text: 'esci dal progetto' });
  assert.match(out.reply, /Sono uscita dal progetto "Inglese B2"/);
  assert.equal(projects.getActive(db), null);
  out = await handleChat(db, ENV, d, { text: 'crea un progetto chiamato Tesi magistrale' });
  assert.match(out.reply, /Ho creato il progetto "Tesi magistrale"/);
  assert.equal(projects.getActive(db).project.name, 'Tesi magistrale');
});

test('progetti: file grandi entrano solo nelle parti pertinenti', () => {
  const db = makeDb();
  const id = projects.createProject(db, { name: 'Esame' }, NOW, 1);
  const filler = Array.from({ length: 200 }, (_, i) => `Paragrafo ${i}: argomenti generali di storia antica e medievale senza nulla di specifico.`).join('\n\n');
  projects.addFile(db, id, { name: 'dispense.txt', content: filler + '\n\nIl teorema di Pitagora lega i cateti all\'ipotenusa.\n\n' + filler }, NOW);
  const r = projects.relevantFileChunks(db, id, 'spiegami il teorema di pitagora', { maxTokens: 1500 });
  assert.match(r.text, /Pitagora/);
  assert.ok(r.text.length < 7000);
  assert.deepEqual(r.used, ['dispense.txt']);
});

test('progetti: i vecchi workspace diventano progetti senza perdere la conversazione', async () => {
  const db = makeDb();
  kvSet(db, 'workspaceSpecs', { j1: { title: 'Tutor inglese', kind: 'tutor', systemContext: 'Regole DSA.\nVerifica passphrase: niente più fili [OK]', widgets: [{ type: 'timer', minutes: 30 }] } });
  kvSet(db, 'activeWorkspace', { title: 'Tutor inglese', jobId: 'j1' });
  db.run("INSERT INTO messages (session, role, text, at) VALUES ('proj:j1', 'user', 'ciao tutor', ?)", NOW);
  const f = fakeFetch(() => reply({ reply: 'Ciao Capo.' }));
  await handleChat(db, ENV, deps(f), { text: 'riprendiamo' });
  const a = projects.getActive(db);
  assert.equal(a.project.name, 'Tutor inglese');
  assert.equal(a.chat.session, 'proj:j1');
  assert.doesNotMatch(a.project.instructions, /passphrase/);
  assert.equal(db.all("SELECT id FROM messages WHERE session = 'proj:j1'").length, 3);
  assert.equal(kvGet(db, 'activeWorkspace', null), null);
});

test('progetti: API per creare, caricare file, entrare e leggere la chat giusta', async () => {
  const db = makeDb();
  const d = deps(fakeFetch(() => reply({})));
  const call = async (method, path, b) => {
    const res = await handleApi(db, ENV, d, new Request('https://x' + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }));
    return res.json();
  };
  const { id } = await call('POST', '/api/projects', { name: 'Viaggio Giappone', instructions: 'Budget 3000 euro.' });
  let det = await call('POST', `/api/projects/${id}/files`, { name: 'voli.txt', content: 'Volo Vienna-Tokyo il 3 aprile.' });
  assert.equal(det.files.length, 1);
  det = await call('POST', `/api/projects/${id}/memory`, { text: 'Preferisce i ryokan' });
  assert.equal(det.memories.length, 1);
  const st = await call('POST', `/api/projects/${id}/enter`, {});
  assert.equal(st.state.activeProject.title, 'Viaggio Giappone');
  db.run('INSERT INTO messages (session, role, text, at) VALUES (?, ?, ?, ?)', st.state.activeProject.session, 'user', 'quanto costa?', NOW);
  const h = await call('GET', '/api/history');
  assert.equal(h.messages.length, 1);
  const mind = await call('GET', '/api/mind');
  assert.equal(mind.projects[0].name, 'Viaggio Giappone');
  await call('DELETE', `/api/projects/${id}`);
  assert.equal(projects.listProjects(db).length, 0);
  assert.equal(projects.getActive(db), null);
});

test('memoria: richiamo per radice delle parole e consolidamento dei doppioni', () => {
  const db = makeDb();
  memory.remember(db, { module: 'palestra', text: 'Il Capo si allena il lunedì e il giovedì' }, NOW);
  memory.remember(db, { module: 'auto', text: 'La Panda ha il tagliando a 15000 km' }, NOW);
  const r = memory.recall(db, 'quando faccio gli allenamenti?');
  assert.equal(r.entries[0].module, 'palestra');
  assert.ok(!r.entries.some(e => e.module === 'auto'));

  memory.remember(db, { module: 'lavoro', text: 'La riunione con il professore è il martedì alle 10' }, NOW);
  memory.remember(db, { module: 'lavoro', text: 'Riunione con il professore il martedì alle 10.' }, NOW);
  memory.remember(db, { module: 'lavoro', text: 'Consegna della tesi a marzo' }, NOW);
  assert.equal(memory.consolidate(db), 1);
  const left = db.all("SELECT text FROM memories WHERE module = 'lavoro' ORDER BY id").map(r => r.text);
  assert.deepEqual(left, ['Riunione con il professore il martedì alle 10.', 'Consegna della tesi a marzo']);
});
