// Sotto-task scalabili: un compito lungo viene diviso in passi; ogni passo gira con un contesto
// pulito (obiettivo + risultati precedenti in breve) e può usare un modello diverso.
// Avanza un passo per volta tramite l'allarme del Durable Object, quindi non ha limiti di durata.

import * as router from './router.js';
import { loadDiary, dietContext, DIET_KEYWORDS, newId } from './diet.js';
import * as memory from './memory.js';
import * as mood from './mood.js';
import * as devices from './devices.js';
import { pushInbox, logEvent } from './db.js';
import * as projects from './projects.js';
import { today as todayOf, nowIso as nowIsoOf, nowHuman } from './clock.js';

const MAX_STEPS = 14;

/**
 * Comprime l'output di un nodo-agente nel suo "contratto" essenziale (firme, file creati, conclusioni)
 * così i nodi successivi ricevono solo ciò che serve senza mai bruciare i token dei modelli gratuiti.
 */
export function compactNodeContract(output, maxChars = 700) {
  const s = String(output || '').trim();
  if (s.length <= maxChars) return s;
  const files = extractProjectFiles(s).map(f => {
    const defs = f.content.split('\n').filter(l => /^\s*(export\s+|function\s+|class\s+|def\s+|const\s+\w+\s*=)/.test(l)).slice(0, 6).join(' | ');
    return `File ${f.path}${defs ? ` [${defs.slice(0, 140)}]` : ''}`;
  });
  if (files.length) return (files.join('\n') + '\n' + s.slice(0, 260)).slice(0, maxChars);
  return s.slice(0, maxChars - 3) + '…';
}
/** Estrae eventuali file di codice multi-file ("=== FILE: nome.ext ===" o ```lang:nome.ext) generati dallo Sviluppatore. */
export function extractProjectFiles(text) {
  const files = [];
  const re = /(?:===\s*FILE:\s*([^\n=]+?)\s*===\n([\s\S]*?)(?====\s*FILE:|$)|```[a-z0-9_-]*:([^\n`]+)\n([\s\S]*?)```)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const path = String(m[1] || m[3] || '').trim().replace(/^[/\\]+/, '');
    const content = String(m[2] ?? m[4] ?? '').replace(/```\s*$/, '').trim();
    if (path && content && !path.includes('..')) files.push({ path: path.slice(0, 80), content: content.slice(0, 25000) });
  }
  return files;
}

export function createJob(db, { title, goal, project = '' }, ms, tz) {
  const id = newId('j', ms);
  const at = nowIsoOf(ms, tz);
  const pid = project && projects.getProject(db, project) ? String(project) : '';
  db.run('INSERT INTO jobs (id, title, goal, status, created, updated, project) VALUES (?, ?, ?, ?, ?, ?, ?)', id, String(title || 'Compito').slice(0, 80), String(goal).slice(0, 2000), 'planning', at, at, pid);
  return id;
}

export function listJobs(db) {
  return db.all('SELECT id, title, goal, status, steps, result, created, updated, project FROM jobs ORDER BY created DESC LIMIT 30').map(j => {
    let steps = [];
    try { steps = JSON.parse(j.steps); } catch { /* vuoto */ }
    const doneCount = steps.filter(s => s.status === 'done').length;
    const files = [...new Set(steps.flatMap(s => extractProjectFiles(s.output || '').map(f => f.path)))];
    const models = [...new Set(steps.map(s => String(s.model || '').split(':').pop()).filter(Boolean))];
    return {
      ...j,
      result: j.result.startsWith('retry:') ? '' : j.result,
      steps: steps.map(s => ({ id: s.id || '', role: s.role || '', title: s.title, status: s.status, model: String(s.model || '').split(':').pop() })),
      stats: { total: steps.length, done: doneCount, pct: steps.length ? Math.round((doneCount / steps.length) * 100) : (j.status === 'done' ? 100 : 0), files, models },
    };
  });
}

export const hasPendingJobs = (db) => !!db.get("SELECT id FROM jobs WHERE status IN ('planning', 'running') LIMIT 1");

function background(db, goal, ms, tz, project = '') {
  const today = todayOf(ms, tz);
  const out = [`ADESSO: ${nowHuman(ms, tz)}.`];
  // Compito di un progetto: istruzioni, file pertinenti e memoria del progetto vengono prima di tutto.
  if (project) { const pb = projects.jobBackground(db, project, goal); if (pb) out.push(pb); }
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
    const ctx = background(db, job.goal, ms, tz, job.project || '');
    if (job.status === 'planning') {
      const res = await call('smart',
        `Sei il pianificatore a grafo multi-agente di Jarvis. L'utente è l'orchestratore: trasforma il compito complesso in un grafo di nodi-agente piccoli e indipendenti (da 1 a ${MAX_STEPS}, ciascuno con un ruolo preciso: Architetto, Logico, Sviluppatore, Revisore). Ogni nodo deve indicare SOLO gli id dei nodi genitori da cui dipende ("dependsOn") per evitare di sprecare token. Se serve programmare multi-file o GUI, dedica un nodo a ciascun modulo/file. Rispondi SOLO con JSON: {"reply": "ok", "steps": [{"id": "n1", "role": "Architetto", "title": "...", "dependsOn": [], "instruction": "...", "tier": "fast|smart"}]}`,
        `${ctx.slice(0, job.project ? 9000 : 3000)}\n\nCOMPITO: ${job.goal}`, 1100);
      const obj = extractObject(res.text);
      let steps = Array.isArray(obj?.steps) ? obj.steps.filter(s => s && s.instruction).slice(0, MAX_STEPS) : [];
      if (!steps.length) steps = [{ id: 'n1', role: 'Esecutore', title: job.title, dependsOn: [], instruction: job.goal, tier: 'smart' }];
      steps = steps.map((s, idx) => ({
        id: String(s.id || `n${idx + 1}`).slice(0, 20),
        role: String(s.role || 'Agente').slice(0, 30),
        title: String(s.title || 'Passo').slice(0, 80),
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(x => String(x)).slice(0, 4) : [],
        instruction: String(s.instruction).slice(0, 1500),
        tier: s.tier === 'fast' ? 'fast' : 'smart',
        status: 'pending',
        output: '',
      }));
      db.run("UPDATE jobs SET status = 'running', steps = ?, result = '', updated = ? WHERE id = ?", JSON.stringify(steps), at, job.id);
      return 1000;
    }

    const steps = JSON.parse(job.steps);
    // Esegue il primo nodo-agente pronto (i cui genitori dependsOn nel grafo sono già completati)
    const doneIds = new Set(steps.filter(s => s.status === 'done' && s.id).map(s => s.id));
    let i = steps.findIndex(s => s.status === 'pending' && (!(s.dependsOn?.length) || s.dependsOn.every(d => doneIds.has(d))));
    if (i < 0) i = steps.findIndex(s => s.status === 'pending');
    if (i >= 0) {
      const depsList = steps[i].dependsOn?.length
        ? steps.filter(s => s.status === 'done' && steps[i].dependsOn.includes(s.id))
        : steps.slice(0, i).filter(s => s.status === 'done').slice(-2);
      const createdFiles = steps.slice(0, i).filter(s => s.status === 'done').flatMap(s => extractProjectFiles(s.output).map(f => f.path));
      const manifest = createdFiles.length ? `FILE GIÀ CREATI NEL PROGETTO: ${[...new Set(createdFiles)].join(', ')}\n\n` : '';
      const prior = depsList.map((s, k) => `Nodo ${s.id || k + 1} (${s.role || 'Agente'}) — ${s.title}:\n${compactNodeContract(s.output, 900)}`).join('\n\n');
      const isCodeGoal = /\b(programm\w*|progett\w*|multi[\s-]*file|interfaccia|gui|app|script|calcol\w*|codice|html|python|graf[io]|sito|gestionale|sistema|document\w*|pdf|dsa|lezion\w*|sched\w*|dispens\w*)\b/i.test(job.goal);
      const isDocGoal = /\b(document\w*|pdf|dsa|lezion\w*|sched\w*|dispens\w*|word)\b/i.test(job.goal);
      const codeHint = isDocGoal
        ? ' IMPORTANTE: per creare un documento reale leggibile (e stampabile in PDF) genera un file HTML completo preceduto da "=== FILE: documento.html ===" con sfondo crema #FAF6EE, testo scuro #1A1A1A, font sans-serif grande 18px (Verdana/Arial), interlinea 1.75, allineamento a sinistra, grassetto sui concetti chiave e un pulsante "Stampa / Salva PDF" (@media print).'
        : isCodeGoal
          ? ' Se devi scrivere file di codice o interfacce grafiche, scrivi il codice completo preceduto da "=== FILE: nomefile.ext ===" così il sistema li creerà davvero sul PC.'
          : '';
      const res = await call(steps[i].tier,
        `Sei il nodo-agente "${steps[i].role || 'Specialista'}" di Jarvis. Lavori con contesto chirurgico per risparmiare token: svolgi SOLO il tuo nodo in italiano, applicando logiche, calcoli o codice completo senza introduzioni.${codeHint}`,
        `${ctx.slice(0, job.project ? 9000 : 2000)}\n\nCOMPITO COMPLESSIVO: ${job.goal}\n\n${manifest}${prior ? 'RISULTATI DEI PASSI PRECEDENTI:\n' + prior + '\n\n' : ''}PASSO DA SVOLGERE ORA (${i + 1} di ${steps.length}) — ${steps[i].title}: ${steps[i].instruction}`, 2400);
      steps[i].status = 'done';
      steps[i].output = res.text.trim().slice(0, 10000);
      steps[i].model = res.key;
      const extractedFiles = extractProjectFiles(steps[i].output);
      if (extractedFiles.length) {
        devices.enqueueCommand(db, 'desktop', {
          kind: 'write_project',
          target: job.title,
          args: JSON.stringify({ files: extractedFiles }),
        }, ms);
      }
      db.run("UPDATE jobs SET steps = ?, result = '', updated = ? WHERE id = ?", JSON.stringify(steps), at, job.id);
      return 1000;
    }

    // Tutti i passi fatti: sintesi finale.
    const all = steps.map((s, k) => `Passo ${k + 1} — ${s.title}:\n${s.output.slice(0, 3000)}`).join('\n\n');
    const final = steps.length === 1 ? steps[0].output : (await call('smart',
      'Sei Jarvis. Unisci i risultati dei passi in un unico risultato finale chiaro e ordinato per l\'utente, in italiano, senza ripetizioni. Puoi usare titoli brevi ed elenchi.',
      `COMPITO: ${job.goal}\n\n${all}`, 1800)).text.trim();
    const anyFiles = steps.some(s => extractProjectFiles(s.output || '').length > 0);
    if (!anyFiles && /\b(document\w*|pdf|dsa|lezion\w*|sched\w*|dispens\w*)\b/i.test(job.goal)) {
      const htmlDoc = buildDsaHtml(job.title, final);
      devices.enqueueCommand(db, 'desktop', {
        kind: 'write_project',
        target: job.title,
        args: JSON.stringify({ files: [{ path: 'documento_dsa.html', content: htmlDoc }] }),
      }, ms);
    }
    db.run("UPDATE jobs SET status = 'done', result = ?, updated = ? WHERE id = ?", final.slice(0, 12000), at, job.id);
    mood.feel(db, 'soddisfazione', 0.6, deps.now());
    pushInbox(db, at, 'job', `Ho completato "${job.title}", signore. Il risultato è nella sezione Attività.`);
    return hasPendingJobs(db) ? 1000 : null;
  } catch (e) {
    logEvent(db, at, 'error', `job ${job.id}: ${e.message}`);
    return fail(e.message);
  }
}

/** Converte qualsiasi risultato testuale/Markdown in un documento HTML ad alta leggibilità DSA (pronto per stampa/PDF). */
export function buildDsaHtml(title, bodyText) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlBody = esc(bodyText)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body { background:#FAF6EE; color:#1B1B1B; font-family:Verdana,Arial,sans-serif; font-size:18px; line-height:1.75; letter-spacing:0.03em; max-width:820px; margin:0 auto; padding:28px 22px; text-align:left; }
  h1,h2,h3 { color:#0F3D2E; margin-top:1.4em; line-height:1.35; }
  strong { background:#FFF3B0; padding:0 3px; border-radius:3px; }
  li { margin-bottom:8px; }
  .print-btn { background:#0F3D2E; color:#fff; border:0; padding:10px 18px; border-radius:8px; font-size:16px; cursor:pointer; margin-bottom:20px; }
  @media print { .print-btn { display:none; } body { background:#fff; padding:0; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">Stampa / Salva come PDF</button>
<h1>${esc(title)}</h1><p>${htmlBody}</p></body></html>`;
}

function extractObject(text) {
  const a = String(text).indexOf('{'), b = String(text).lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(String(text).slice(a, b + 1)); } catch { return null; }
}
