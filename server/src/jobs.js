// Sotto-task scalabili: un compito lungo viene diviso in passi; ogni passo gira con un contesto
// pulito (obiettivo + risultati precedenti in breve) e può usare un modello diverso.
// Avanza un passo per volta tramite l'allarme del Durable Object, quindi non ha limiti di durata.

import * as router from './router.js';
import { loadDiary, dietContext, DIET_KEYWORDS, newId } from './diet.js';
import * as memory from './memory.js';
import { pushInbox, logEvent } from './db.js';
import { today as todayOf, nowIso as nowIsoOf, nowHuman } from './clock.js';

const MAX_STEPS = 6;

export function createJob(db, { title, goal }, ms, tz) {
  const id = newId('j', ms);
  const at = nowIsoOf(ms, tz);
  db.run('INSERT INTO jobs (id, title, goal, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)', id, String(title || 'Compito').slice(0, 80), String(goal).slice(0, 2000), 'planning', at, at);
  return id;
}

export function listJobs(db) {
  return db.all('SELECT id, title, goal, status, steps, result, created, updated FROM jobs ORDER BY created DESC LIMIT 30').map(j => {
    let steps = [];
    try { steps = JSON.parse(j.steps); } catch { /* vuoto */ }
    return { ...j, result: j.result.startsWith('retry:') ? '' : j.result, steps: steps.map(s => ({ title: s.title, status: s.status })) };
  });
}

export const hasPendingJobs = (db) => !!db.get("SELECT id FROM jobs WHERE status IN ('planning', 'running') LIMIT 1");

function background(db, goal, ms, tz) {
  const today = todayOf(ms, tz);
  const out = [`ADESSO: ${nowHuman(ms, tz)}.`];
  const rec = memory.recall(db, goal, { limit: 16 });
  if (rec.entries.length) out.push('COSA SAI DELL\'UTENTE\n' + rec.entries.map(m => `- (${m.module}) ${m.text}`).join('\n'));
  if (DIET_KEYWORDS.test(goal)) out.push(dietContext(loadDiary(db), today).filter(b => b.prio <= 2).map(b => b.text).join('\n\n'));
  return out.join('\n\n').slice(0, 14000);
}

/** Esegue UN avanzamento (pianificazione, un passo, oppure sintesi finale).
 * Ritorna tra quanti ms richiamarla di nuovo, oppure null se non resta lavoro. */
export async function advance(db, env, deps) {
  const job = db.get("SELECT * FROM jobs WHERE status IN ('planning', 'running') ORDER BY created LIMIT 1");
  if (!job) return null;
  const ms = deps.now(), tz = deps.tz, at = nowIsoOf(ms, tz);
  const call = (tier, system, user, maxTokens = 1200) => router.chat(db, env, {
    tier, maxTokens, fetchFn: deps.fetchFn, now: deps.now, tz,
    build: () => [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const fail = (msg) => {
    const attempts = Number(job.result.startsWith('retry:') ? job.result.slice(6) : 0) + 1;
    if (attempts < 3) { db.run('UPDATE jobs SET result = ?, updated = ? WHERE id = ?', `retry:${attempts}`, at, job.id); return 90_000; }
    db.run("UPDATE jobs SET status = 'failed', result = ?, updated = ? WHERE id = ?", `Non completato: ${msg}`, at, job.id);
    pushInbox(db, at, 'job', `Non sono riuscito a completare "${job.title}": ${msg}`);
    return hasPendingJobs(db) ? 1000 : null;
  };

  try {
    const ctx = background(db, job.goal, ms, tz);
    if (job.status === 'planning') {
      const res = await call('smart',
        `Sei il pianificatore di Jarvis. Dividi il compito in passi indipendenti e concreti (da 1 a ${MAX_STEPS}); ogni passo deve poter essere svolto da solo conoscendo i risultati dei precedenti. Rispondi SOLO con JSON: {"reply": "ok", "steps": [{"title": "...", "instruction": "...", "tier": "fast|smart"}]}`,
        `${ctx}\n\nCOMPITO: ${job.goal}`, 900);
      const obj = extractObject(res.text);
      let steps = Array.isArray(obj?.steps) ? obj.steps.filter(s => s && s.instruction).slice(0, MAX_STEPS) : [];
      if (!steps.length) steps = [{ title: job.title, instruction: job.goal, tier: 'smart' }];
      steps = steps.map(s => ({ title: String(s.title || 'Passo').slice(0, 80), instruction: String(s.instruction).slice(0, 1500), tier: s.tier === 'fast' ? 'fast' : 'smart', status: 'pending', output: '' }));
      db.run("UPDATE jobs SET status = 'running', steps = ?, result = '', updated = ? WHERE id = ?", JSON.stringify(steps), at, job.id);
      return 1000;
    }

    const steps = JSON.parse(job.steps);
    const i = steps.findIndex(s => s.status === 'pending');
    if (i >= 0) {
      const prior = steps.slice(0, i).map((s, k) => `Passo ${k + 1} — ${s.title}:\n${s.output.slice(0, 1500)}`).join('\n\n');
      const res = await call(steps[i].tier,
        'Sei Jarvis e stai svolgendo un passo di un compito più grande per il tuo utente. Svolgi SOLO questo passo, in italiano, in modo concreto e completo, senza introduzioni.',
        `${ctx}\n\nCOMPITO COMPLESSIVO: ${job.goal}\n\n${prior ? 'RISULTATI DEI PASSI PRECEDENTI:\n' + prior + '\n\n' : ''}PASSO DA SVOLGERE ORA (${i + 1} di ${steps.length}) — ${steps[i].title}: ${steps[i].instruction}`);
      steps[i].status = 'done';
      steps[i].output = res.text.trim().slice(0, 6000);
      steps[i].model = res.key;
      db.run("UPDATE jobs SET steps = ?, result = '', updated = ? WHERE id = ?", JSON.stringify(steps), at, job.id);
      return 1000;
    }

    // Tutti i passi fatti: sintesi finale.
    const all = steps.map((s, k) => `Passo ${k + 1} — ${s.title}:\n${s.output.slice(0, 3000)}`).join('\n\n');
    const final = steps.length === 1 ? steps[0].output : (await call('smart',
      'Sei Jarvis. Unisci i risultati dei passi in un unico risultato finale chiaro e ordinato per l\'utente, in italiano, senza ripetizioni. Puoi usare titoli brevi ed elenchi.',
      `COMPITO: ${job.goal}\n\n${all}`, 1800)).text.trim();
    db.run("UPDATE jobs SET status = 'done', result = ?, updated = ? WHERE id = ?", final.slice(0, 12000), at, job.id);
    pushInbox(db, at, 'job', `Ho completato "${job.title}", signore. Il risultato è nella sezione Attività.`);
    return hasPendingJobs(db) ? 1000 : null;
  } catch (e) {
    logEvent(db, at, 'error', `job ${job.id}: ${e.message}`);
    return fail(e.message);
  }
}

function extractObject(text) {
  const a = String(text).indexOf('{'), b = String(text).lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(String(text).slice(a, b + 1)); } catch { return null; }
}
