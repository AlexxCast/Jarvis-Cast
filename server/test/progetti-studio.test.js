// Progetti di studio come in Claude: il PDF con le caratteristiche diventa istruzioni e file del progetto,
// i file allegati in chat restano nel progetto, il registro dei progressi guida le lezioni.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, projectName } from '../src/brain.js';
import * as projects from '../src/projects.js';
import { kvGet } from '../src/db.js';
import { handleApi } from '../src/api.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', JARVIS_TOKEN: 't' };
const NOW = '2026-11-20T11:00:00+01:00';
const systemOf = (call) => call.body.messages.find(m => m.role === 'system').content;
const SPEC = `Profilo dello studente per il tutor di inglese
Livello di partenza: A2. Obiettivo: B2.
Frasi brevi, una cosa alla volta, niente muri di testo.
Lezioni da 30 minuti con esempi di tecnologia.
Correggi un errore alla volta e fai ripetere la frase giusta.`;
const geminiPdf = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] } }] } });

test('crea un progetto nuovo con il PDF: il PDF diventa le istruzioni, parola per parola, e resta tra i file', async () => {
  const db = makeDb();
  const f = fakeFetch(() => { throw new Error('nessun modello serve'); });
  const out = await handleChat(db, ENV, deps(f), {
    text: "crea un nuovo progetto per imparare l'inglese B2, ti mando il PDF con tutte le caratteristiche",
    files: [{ name: 'profilo-tutor.pdf', content: '[Pagina 1]\n' + SPEC }],
  });
  assert.equal(f.calls.length, 0);
  const active = projects.getActive(db);
  assert.equal(active.project.name, 'Inglese B2');
  assert.equal(active.project.instructions, SPEC);
  assert.deepEqual(projects.listFiles(db, active.project.id).map(x => x.name), ['profilo-tutor.pdf']);
  assert.match(out.reply, /Inglese B2/);
  assert.match(out.reply, /istruzioni/);
  assert.ok(out.actions.includes('project_create'));
});

test('crea un progetto nuovo anche se uno simile esiste già, quando il Capo dice "nuovo"', async () => {
  const db = makeDb();
  const old = projects.createProject(db, { name: 'Inglese B2' }, NOW, 1);
  await handleChat(db, ENV, deps(fakeFetch(() => reply({}))), { text: 'crea un nuovo progetto inglese B2' });
  const active = projects.getActive(db);
  assert.notEqual(active.project.id, old);
  assert.equal(db.all('SELECT id FROM projects').length, 2);
  // "apri il progetto" invece entra in quello che c'è.
  await handleChat(db, ENV, deps(fakeFetch(() => reply({}))), { text: 'esci dalla progetto' });
  assert.equal(projects.getActive(db), null, '"dalla" detto a voce esce lo stesso');
});

test('un PDF allegato dentro il progetto resta nei file e i messaggi dopo lo vedono ancora', async () => {
  const db = makeDb();
  const id = projects.createProject(db, { name: 'Inglese B2' }, NOW, 1);
  projects.enterProject(db, id, {}, NOW, 2);
  const f = fakeFetch((url) => /:generateContent/.test(url) ? geminiPdf(SPEC) : reply({ reply: 'Ho letto il tuo profilo.' }));
  const out = await handleChat(db, ENV, deps(f), { text: 'prendi tutte le informazioni dal PDF e usale per il progetto', files: [{ name: 'profilo.pdf', encoding: 'base64', content: 'JVBERi0x' }] });
  assert.equal(out.reply, 'Ho letto il tuo profilo.');
  assert.equal(f.calls.filter(c => /:generateContent/.test(c.url)).length, 1, 'il PDF si legge una volta sola');
  assert.equal(projects.getProject(db, id).instructions, SPEC, 'progetto senza istruzioni + "progetto": il PDF diventa le istruzioni');
  assert.ok(out.actions.includes('project_file'));
  // Messaggio successivo, senza allegati: il contenuto c'è ancora.
  const g = fakeFetch(() => reply({ reply: 'Partiamo.' }));
  await handleChat(db, ENV, deps(g), { text: 'iniziamo la lezione' });
  const sys = systemOf(g.calls[0]);
  assert.match(sys, /ISTRUZIONI DEL PROGETTO\nProfilo dello studente/);
  assert.match(sys, /FILE DEL PROGETTO/);
  assert.match(sys, /METODO DI STUDIO/);
  assert.equal(kvGet(db, 'contextReport', null).tier, 'smart', 'nei progetti di studio rispondono i modelli smart');
});

test('materiale di studio in un progetto che ha già istruzioni: va nei file, le istruzioni non cambiano', async () => {
  const db = makeDb();
  const id = projects.createProject(db, { name: 'Inglese B2', instructions: 'Sei la tutor.' }, NOW, 1);
  projects.enterProject(db, id, {}, NOW, 2);
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Letto.' }))), { text: 'leggi questo testo', files: [{ name: 'reading.txt', content: 'The cat sat on the mat.' }] });
  assert.equal(projects.getProject(db, id).instructions, 'Sei la tutor.');
  assert.deepEqual(projects.listFiles(db, id).map(x => x.name), ['reading.txt']);
  // Rimandato con lo stesso nome: sostituisce, non duplica.
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Letto.' }))), { text: 'eccolo corretto', files: [{ name: 'reading.txt', content: 'The dog sat on the mat.' }] });
  assert.equal(projects.listFiles(db, id).length, 1);
  // "Usa questo come istruzioni" senza allegato: prende l'ultimo file.
  await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Fatto.' }))), { text: 'usa il file come istruzioni del progetto' });
  assert.equal(projects.getProject(db, id).instructions, 'The dog sat on the mat.');
});

test('registro dei progressi: project_log scrive, il contesto dopo dice livello, errori che tornano e prossimo passo', async () => {
  const db = makeDb();
  const id = projects.createProject(db, { name: 'Inglese B2', instructions: 'Sei la tutor di inglese.' }, NOW, 1);
  projects.enterProject(db, id, {}, NOW, 2);
  const f = fakeFetch(() => reply({ reply: 'Quiz finito: 7 su 10.', actions: [
    { type: 'project_log', kind: 'quiz', topic: 'Present perfect', text: 'quiz di 10 domande', score: 7, max: 10, errors: ['since/for', 'been/gone'], level: 'A2+', next: 'ripassare since/for e iniziare il past perfect' },
    { type: 'project_instructions', text: 'Quando parlo in inglese aspetta che finisca, non interrompere.' },
  ] }));
  const out = await handleChat(db, ENV, deps(f), { text: 'ho finito il quiz' });
  assert.ok(out.actions.includes('project_log') && out.actions.includes('project_instructions'));
  projects.addLog(db, id, { kind: 'esercizio', topic: 'Since e for', score: 3, max: 5, errors: ['since/for'] }, NOW);
  const sum = projects.logSummary(projects.getLog(db, id));
  assert.equal(sum.level, 'A2+');
  assert.equal(sum.avg, 65);
  assert.deepEqual(sum.recurring[0], { text: 'since/for', n: 2, lastAt: NOW });
  assert.match(projects.getProject(db, id).instructions, /Sei la tutor di inglese\.\n- Quando parlo in inglese aspetta/);
  const g = fakeFetch(() => reply({ reply: 'Riprendiamo da since e for.' }));
  await handleChat(db, ENV, deps(g), { text: 'riprendiamo' });
  const sys = systemOf(g.calls[0]);
  assert.match(sys, /REGISTRO DEI PROGRESSI/);
  assert.match(sys, /Livello attuale: A2\+/);
  assert.match(sys, /Errori da ripassare \(quante volte\): since\/for \(2\)/);
  assert.match(sys, /Prossimo passo deciso: ripassare since\/for/);
  // Fuori dal progetto project_log non scrive nulla.
  projects.exitProject(db);
  const h = fakeFetch(() => reply({ reply: 'Ok.', actions: [{ type: 'project_log', text: 'x' }] }));
  const o2 = await handleChat(db, ENV, deps(h), { text: 'segna che ho studiato' });
  assert.ok(!o2.actions.includes('project_log'));
});

test('API del progetto: progressi nel dettaglio, azzera registro, usa un file come istruzioni', async () => {
  const db = makeDb();
  const id = projects.createProject(db, { name: 'Inglese B2' }, NOW, 1);
  projects.addLog(db, id, { kind: 'lezione', topic: 'Past simple', text: 'verbi irregolari', next: 'quiz' }, NOW);
  const fid = projects.addFile(db, id, { name: 'spec.txt', content: SPEC }, NOW);
  const d = deps(fakeFetch(() => reply({})));
  const call = async (method, path) => (await handleApi(db, ENV, d, new Request('https://x' + path, { method, headers: { authorization: 'Bearer t' } }))).json();
  let r = await call('GET', `/api/projects/${id}`);
  assert.equal(r.progress.lessons, 1);
  assert.equal(r.progress.next, 'quiz');
  r = await call('POST', `/api/projects/${id}/files/${fid}`);
  assert.equal(r.project.instructions, SPEC);
  r = await call('DELETE', `/api/projects/${id}/progress`);
  assert.equal(r.progress, null);
});

test('documento lungo: le istruzioni le ricava un modello forte, il documento intero resta nei file', async () => {
  const db = makeDb();
  const long = (SPEC + '\n\n').repeat(60);
  const f = fakeFetch(() => 'ISTRUZIONI\n' + 'Regola: correggi un errore alla volta. '.repeat(20));
  const instr = await projects.instructionsFromDoc(db, ENV, f, long, { tz: 'Europe/Rome' });
  assert.equal(f.calls.length, 1);
  assert.match(instr, /^ISTRUZIONI\nRegola/);
  assert.ok(instr.length <= 12000);
});

test('nome del progetto dal parlato', () => {
  assert.equal(projectName("imparare l'inglese B2 con queste caratteristiche"), 'Inglese B2');
  assert.equal(projectName('tesi di laurea'), 'Tesi di laurea');
  assert.equal(projectName("l'inglese B2 e ti mando il pdf"), 'Inglese B2');
});

test('PDF del progetto: con la quota dei flash finita lo legge un Gemini lite; se falliscono tutti si dice perché', async () => {
  const db = makeDb();
  const id = projects.createProject(db, { name: 'Inglese B2' }, NOW, 1);
  const call = async (fetchFn) => {
    const d = deps(fetchFn);
    const res = await handleApi(db, ENV, d, new Request(`https://x/api/projects/${id}/files`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'profilo.pdf', encoding: 'base64', content: 'JVBERi0x' }) }));
    return { status: res.status, body: await res.json() };
  };
  const quota = { status: 429, json: { error: { message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } } };
  let r = await call(fakeFetch((url) => /lite/.test(url) ? geminiPdf(SPEC) : quota));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files.map(f => f.name), ['profilo.pdf']);
  r = await call(fakeFetch(() => quota));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /quota di Gemini finita/);
});
