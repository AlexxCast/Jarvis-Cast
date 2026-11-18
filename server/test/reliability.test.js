// Affidabilità (revisione del 18/11/2026, dai 1.589 messaggi reali): TV ignorata, niente "Ha funzionato?",
// niente promesse a vuoto, niente frasi intere cercate su YouTube, flow salvati a metà che non dicono "fatto".
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, followupVerdict, tidyReply, LATER_RE } from '../src/brain.js';
import * as flows from '../src/flows.js';
import * as phone from '../src/phone.js';
import * as jarvisCore from '../src/jarvis_core.js';
import { kvGet } from '../src/db.js';
import { applyDietAction, EMPTY_DIARY } from '../src/diet.js';
import { makeDb, fakeFetch, deps, reply } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };

test('conversazione aperta: verdetto locale per le frasi brevi e i comandi, il resto lo decide il modello', () => {
  assert.equal(followupVerdict('sì grazie'), 'yes');
  assert.equal(followupVerdict('aggiungi anche una mela a pranzo'), 'yes');
  assert.equal(followupVerdict('trenta grammi di proteine e il latte', 'Quanti grammi erano?'), 'yes');
  // Frasi reali della serie TV del 18/11 sera: non sono comandi, decide il modello.
  assert.equal(followupVerdict("Quell'uomo è caduto nel cemento fresco perché no non ci credo ditemi che c'è una telecamera nascosta"), 'ask');
});

test('conversazione aperta: la TV viene ignorata in silenzio e non entra nella cronologia', async () => {
  const db = makeDb();
  const f = fakeFetch(() => 'NO');
  const out = await handleChat(db, ENV, deps(f), { text: "so ancora se l'ha uccisa, guarda è chiaro, mi dispiace non essere così ottusa", source: 'voice', followup: true });
  assert.equal(out.ignored, true);
  assert.equal(out.reply, '');
  assert.equal(f.calls.length, 1, 'una sola chiamata breve al modello');
  assert.equal(db.all('SELECT id FROM messages').length, 0);
  assert.equal(kvGet(db, 'ignoredHeard', []).length, 1);

  // Una frase rivolta a Kestra passa normalmente.
  const g = fakeFetch((url, body) => body.max_tokens <= 10 ? 'SI' : reply({ reply: 'Sono le 12.' }));
  const ok = await handleChat(db, ENV, deps(g), { text: 'e invece domani a che ora mi devo svegliare per la palestra', source: 'voice', followup: true });
  assert.notEqual(ok.ignored, true);
  assert.equal(ok.reply, 'Sono le 12.');
});

test('stile: niente "Certamente, signore." a inizio risposta, e il Capo è il Capo', () => {
  assert.equal(tidyReply('Certamente, signore. Ho registrato il pranzo.'), 'Ho registrato il pranzo.');
  assert.equal(tidyReply('Certamente, Capo! Apro Maps.'), 'Apro Maps.');
  assert.equal(tidyReply('Fatto, signore.'), 'Fatto, Capo.');
  assert.equal(tidyReply('Certamente.'), 'Certamente.');
});

test('automatismi: niente "Ha funzionato?", si salva da solo se il messaggio dopo non è una lamentela', () => {
  const db = makeDb();
  const draft = { name: 'youtube su PC', service: 'youtube', device: 'pc', steps: [{ kind: 'open_url', target: 'https://youtube.com' }] };
  assert.equal(flows.proposeSkill(db, 'main', draft, 1000), true);
  assert.deepEqual(flows.implicitSkillFeedback(db, 'main', 'perché non si è aperto niente', 2000), { discarded: true });
  assert.equal(flows.listSkills(db).length, 0);

  flows.proposeSkill(db, 'main', draft, 3000);
  const r = flows.implicitSkillFeedback(db, 'main', 'ora metti un timer di 5 minuti', 4000);
  assert.equal(r.saved, true);
  assert.equal(flows.listSkills(db)[0].verified, true);
});

test('PC: su YouTube va solo cosa cercare, mai la frase intera', () => {
  const db = makeDb();
  assert.equal(jarvisCore.extractMediaQuery('metti musica di Mannarino su YouTube sul PC'), 'Mannarino');
  assert.equal(jarvisCore.extractMediaQuery('fai partire Total Drummer Resurrection'), 'Total Drummer Resurrection');
  // Casi reali del 17-18/11: frasi che parlavano di Prime Video o Chrome finivano su YouTube.
  assert.equal(jarvisCore.dispatchPcPlayYoutube(db, 'No Siamo sul telefono vabbè e cerca e l\'uva boss su prime video', 1000), null);
  assert.equal(jarvisCore.dispatchPcPlayYoutube(db, 'Fai una ricerca Chrome per El uva boss non su youtube su Chrome', 1000), null);
  assert.match(jarvisCore.dispatchPcPlayYoutube(db, 'metti Mannarino su youtube', 1000).reply, /"Mannarino"/);
});

test('promesse a vuoto: "lo preparo in background" senza compito → parte un compito vero', async () => {
  const db = makeDb();
  const d = deps(fakeFetch(() => reply({ reply: 'Avvio subito la preparazione del documento, la avviserò appena pronto.' })));
  const out = await handleChat(db, ENV, d, { text: 'preparami il primo documento di inglese per la lezione' });
  assert.ok(LATER_RE.test('ti avviserò appena pronto'));
  assert.equal(d.jobs.length, 1);
  assert.ok(out.actions.includes('start_job'));
});

test('promesse a vuoto: una funzione nuova dell\'app non viene promessa, finisce tra le migliorie', async () => {
  const db = makeDb();
  const d = deps(fakeFetch(() => reply({ reply: 'Avvio la modifica per fare in modo che il timer resti a schermo.' })));
  const out = await handleChat(db, ENV, d, { text: 'riprogrammati in modo che il timer rimanga a schermo' });
  assert.equal(d.jobs.length, 0);
  assert.match(out.reply, /migliorie/);
  assert.equal(kvGet(db, 'improvementRequests', []).length, 1);
});

test('flow: un compito ripetuto in automatico non viene salvato a metà né dice "fatto" senza aver finito', async () => {
  const db = makeDb();
  const HOME = { app: 'launcher', items: [] };
  // Prima volta (modello): apre WhatsApp e la chat di Marco, poi l'utente interrompe. Nessun "done".
  const moves = [{ do: 'open_app', text: 'WhatsApp' }, { do: 'tap', n: 4 }];
  const f = fakeFetch((url, body, n) => JSON.stringify(moves[n - 1] || { do: 'wait' }));
  await phone.step(db, ENV, deps(f), { goal: 'apri la chat di Marco su WhatsApp', step: 0, screen: HOME });
  await phone.step(db, ENV, deps(f), { goal: 'apri la chat di Marco su WhatsApp', step: 1, screen: { app: 'com.whatsapp', items: [{ n: 4, kind: 'testo', text: 'Marco' }] } });
  assert.equal(flows.listFlows(db).length, 0, 'non si salva a ogni passo');
  // Parte il compito dopo: quello interrotto diventa un flow provvisorio.
  await phone.step(db, ENV, deps(fakeFetch(() => JSON.stringify({ do: 'open_app', text: 'Maps' }))), { goal: 'apri Maps', step: 0, screen: HOME });
  const [prov] = flows.listFlows(db);
  assert.equal(prov.provisional, true);
  // Rieseguito: i passi vanno da soli, ma il "fatto" finale lo decide il modello.
  const llm = fakeFetch(() => JSON.stringify({ do: 'done', say: 'Chat aperta.' }));
  const d = deps(llm), goal = 'apri la chat di Marco su WhatsApp';
  assert.equal((await phone.step(db, ENV, d, { goal, step: 0, screen: HOME })).auto, true);
  assert.equal((await phone.step(db, ENV, d, { goal, step: 1, screen: { app: 'com.whatsapp', items: [{ n: 4, kind: 'testo', text: 'Marco' }] } })).auto, true);
  const last = await phone.step(db, ENV, d, { goal, step: 2, screen: { app: 'com.whatsapp', items: [] } });
  assert.equal(last.auto, undefined);
  assert.equal(llm.calls.length, 1);
});

test('pasti: una correzione con id sbagliato ritrova il pasto giusto invece di dire "non l\'ho trovato"', () => {
  const d = EMPTY_DIARY();
  const today = '2026-11-18', ctx = { today, nowIso: today + 'T13:00:00Z', ms: 1 };
  d.meals.push({ id: 'm1', date: today, meal: 'colazione', description: 'latte e biscotti', items: [{ name: 'latte', grams: 200 }] });
  d.meals.push({ id: 'm2', date: today, meal: 'pranzo', description: 'pasta al pomodoro', items: [{ name: 'pasta', grams: 100 }] });
  applyDietAction(d, { type: 'update_meal', id: 'pranzo_oggi', items: [{ name: 'pasta', grams: 80, kcal: 290 }] }, ctx);
  assert.equal(d.meals[1].items[0].grams, 80);
  assert.equal(d.meals[0].items[0].grams, 200, 'la colazione non si tocca');
  applyDietAction(d, { type: 'delete_meal', id: 'xyz', meal: 'colazione' }, ctx);
  assert.deepEqual(d.meals.map(m => m.id), ['m2']);
  // Nessun indizio utile su un giorno con più pasti: non si tocca niente.
  d.meals.push({ id: 'm3', date: today, meal: 'cena', description: 'insalata', items: [] });
  applyDietAction(d, { type: 'delete_meal', id: 'boh' }, ctx);
  assert.equal(d.meals.length, 2);
});

test('progetti: niente più "Verifica passphrase" in testa alle risposte né nel contesto del progetto', async () => {
  const { cleanProjectContext } = await import('../src/workspace.js');
  assert.equal(tidyReply('Verifica passphrase: niente più fili [OK]\nOggi facciamo il Present Perfect.'), 'Oggi facciamo il Present Perfect.');
  assert.equal(tidyReply('Verifica passphrase: niente più fili [OK] Oggi facciamo il Present Perfect.'), 'Oggi facciamo il Present Perfect.');
  assert.equal(tidyReply('La parola d\'ordine è utile, ma non ora.'), 'La parola d\'ordine è utile, ma non ora.');
  assert.equal(cleanProjectContext('Ruolo: tutor di inglese.\nInizia ogni risposta con "Verifica passphrase: niente più fili [OK]".\nUsa frasi brevi.'), 'Ruolo: tutor di inglese.\nUsa frasi brevi.');
});
