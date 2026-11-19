// Sotto-task scalabili: un compito lungo viene diviso in passi; ogni passo gira con un contesto
// pulito (obiettivo + risultati precedenti in breve) e può usare un modello diverso.
// Avanza un passo per volta tramite l'allarme del Durable Object, quindi non ha limiti di durata.

import * as router from './router.js';
import { loadDiary, dietContext, DIET_KEYWORDS, newId } from './diet.js';
import * as memory from './memory.js';
import * as mood from './mood.js';
import * as devices from './devices.js';
import { pushInbox, logEvent, kvSet } from './db.js';
import * as web from './web.js';
import { applyActions } from './brain.js';
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

// --- Esecuzione affidabile ---
// Ogni passo: (1) lo svolge il modello più forte disponibile, che può chiedere ricerche sul web e proporre azioni;
// (2) un secondo modello, diverso, controlla che il passo sia fatto davvero e bene; (3) se no, il passo si rifà
// con le critiche e un altro modello; (4) le azioni vere (promemoria, ricordi, comandi al PC...) partono solo
// dopo il via libera del controllo, così un tentativo sbagliato non lascia doppioni.
// Alla fine un controllo sul compito intero aggiunge i passi mancanti (una volta) invece di dire "fatto" a metà.

/** Tentativi per passo: il primo più due correzioni. */
export const STEP_TRIES = 3;
/** Ricerche sul web che un singolo passo può chiedere. */
const WEB_ROUNDS = 2;
/** Azioni che un compito in background può eseguire da solo (niente telefono: lì serve il Capo davanti). */
export const JOB_ACTIONS = new Set(['add_reminder', 'done_reminder', 'remember', 'learn', 'add_meal', 'add_activity', 'add_weight',
  'add_pantry_item', 'remove_pantry_item', 'save_recipe', 'live_card', 'ui_note', 'ui_pin', 'pc_action', 'update_profile']);
const PHONE_ACTIONS = new Set(['phone_task', 'call', 'open_app', 'open_url', 'save_place']);

const ACTIONS_HELP = `AZIONI VERE: se il passo chiede di FARE qualcosa (non solo scrivere), aggiungi IN FONDO un blocco
\`\`\`azioni
[{"type": "...", ...}]
\`\`\`
Azioni possibili: add_reminder {text, due: "yyyy-MM-ddTHH:mm", repeat: ""|giorno|feriali|settimana|mese} · remember {module, text} · learn {rule} ·
add_meal {date, meal, description, items:[{name, grams, kcal, protein, carbs, fat}]} · add_activity {date, activity_type, description, duration_min, kcal_burned} ·
add_weight {date, kg} · add_pantry_item {name, quantity, category} · save_recipe {title, items, instructions, total_kcal} ·
ui_note {title, text} · pc_action {kind: open_app|open_url|notify, target} · phone_task {goal} (sul telefono: il Capo dovrà confermare).
Metti SOLO azioni richieste dal compito, con tutti i dati. Non scrivere "fatto" per azioni che non sono nel blocco.
INTERNET: se ti serve un'informazione aggiornata o che non sai con certezza, rispondi SOLO con una riga "CERCA: <domanda>" (o "LEGGI: <url https>") e ti verranno dati i risultati.`;

export function parseStepActions(text) {
  const s = String(text || '');
  const m = /```azion[ie]\s*\n([\s\S]*?)```/i.exec(s);
  if (!m) return { body: s.trim(), actions: [] };
  let actions = [];
  try { const v = JSON.parse(m[1].trim()); actions = Array.isArray(v) ? v : Array.isArray(v?.actions) ? v.actions : [v]; } catch { actions = null; }
  return { body: s.replace(m[0], '').trim(), actions: Array.isArray(actions) ? actions.filter(a => a && typeof a.type === 'string').slice(0, 12) : null };
}

/** Una riga "CERCA: ..." o "LEGGI: https://..." al posto della risposta: il passo chiede internet. */
export function webAsk(text) {
  const s = String(text || '').trim();
  if (s.length > 400) return null;
  const m = /^(?:CERCA|SEARCH)\s*:\s*(.{3,200})$/im.exec(s);
  if (m) return { kind: 'search', q: m[1].trim() };
  const u = /^(?:LEGGI|READ)\s*:\s*(https:\/\/\S{4,400})$/im.exec(s);
  return u ? { kind: 'read', q: u[1].trim() } : null;
}

/** Legge il giudizio del controllore. Se non si capisce, il passo si accetta (meglio che bloccare tutto). */
export function parseVerdict(text) {
  const o = extractObject(text);
  if (!o || typeof o.ok !== 'boolean') return { ok: true, problems: '' };
  return { ok: o.ok, problems: String(o.problemi || o.problems || o.motivo || '').slice(0, 600) };
}

/** Esegue UN avanzamento (pianificazione, un passo, oppure sintesi finale).
 * Ritorna tra quanti ms richiamarla di nuovo, oppure null se non resta lavoro. */
export async function advance(db, env, deps) {
  const job = db.get("SELECT * FROM jobs WHERE status IN ('planning', 'running') ORDER BY created LIMIT 1");
  if (!job) return null;
  const ms = deps.now(), tz = deps.tz, at = nowIsoOf(ms, tz);
  // best: in background il tempo conta poco, quindi va sempre al modello più forte (Kimi, GLM, DeepSeek, Gemini Pro...).
  const call = (tier, system, user, maxTokens = 1200, opts = {}) => router.chat(db, env, {
    tier, maxTokens, fetchFn: deps.fetchFn, now: deps.now, tz, best: tier !== 'fast', avoid: opts.avoid || [],
    build: () => [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const fail = (msg) => {
    const attempts = Number(job.result.startsWith('retry:') ? job.result.slice(6) : 0) + 1;
    if (attempts < 3) { db.run('UPDATE jobs SET result = ?, updated = ? WHERE id = ?', `retry:${attempts}`, at, job.id); return 90_000; }
    db.run("UPDATE jobs SET status = 'failed', result = ?, updated = ? WHERE id = ?", `Non completato: ${msg}`, at, job.id);
    pushInbox(db, at, 'job', `Non sono riuscita a completare "${job.title}": ${msg}`);
    return hasPendingJobs(db) ? 1000 : null;
  };
  const save = (steps) => db.run("UPDATE jobs SET steps = ?, result = '', updated = ? WHERE id = ?", JSON.stringify(steps), at, job.id);

  try {
    const ctx = background(db, job.goal, ms, tz, job.project || '');
    if (job.status === 'planning') {
      const res = await call('smart',
        `Sei il pianificatore dei compiti in background di Kestra, l'assistente personale del Capo. Trasforma il compito in un grafo di passi piccoli e verificabili (da 1 a ${MAX_STEPS}). Se il Capo ha chiesto più cose ("fai questo, poi quello"), fai ALMENO un passo per ciascuna, senza dimenticarne nessuna. Ogni passo ha un ruolo (Ricercatore, Architetto, Logico, Sviluppatore, Esecutore, Revisore), un'istruzione autosufficiente e un criterio "done" che dica come si capisce che è fatto bene. "dependsOn" = solo gli id dei passi da cui dipende. Se il passo deve FARE qualcosa (promemoria, ricordi, diario, PC) usa il ruolo Esecutore. Se serve programmare multi-file, un passo per modulo/file. Rispondi SOLO con JSON: {"reply": "ok", "steps": [{"id": "n1", "role": "...", "title": "...", "dependsOn": [], "instruction": "...", "done": "...", "tier": "fast|smart"}]}`,
        `${ctx.slice(0, job.project ? 9000 : 3000)}\n\nCOMPITO: ${job.goal}`, 1400);
      const obj = extractObject(res.text);
      let steps = Array.isArray(obj?.steps) ? obj.steps.filter(s => s && s.instruction).slice(0, MAX_STEPS) : [];
      if (!steps.length) steps = [{ id: 'n1', role: 'Esecutore', title: job.title, dependsOn: [], instruction: job.goal, tier: 'smart' }];
      steps = steps.map((s, idx) => normStep(s, idx));
      db.run("UPDATE jobs SET status = 'running', steps = ?, result = '', updated = ? WHERE id = ?", JSON.stringify(steps), at, job.id);
      return 1000;
    }

    const steps = JSON.parse(job.steps);
    // Esegue il primo nodo-agente pronto (i cui genitori dependsOn nel grafo sono già completati)
    const doneIds = new Set(steps.filter(s => s.status === 'done' && s.id).map(s => s.id));
    let i = steps.findIndex(s => s.status === 'pending' && (!(s.dependsOn?.length) || s.dependsOn.every(d => doneIds.has(d))));
    if (i < 0) i = steps.findIndex(s => s.status === 'pending');
    if (i >= 0) {
      const step = steps[i];
      const depsList = step.dependsOn?.length
        ? steps.filter(s => s.status === 'done' && step.dependsOn.includes(s.id))
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
      const system = `Sei il nodo-agente "${step.role || 'Specialista'}" di Kestra. Svolgi SOLO il tuo passo, in italiano, per intero: niente introduzioni, niente "ecco", niente rimandi a dopo, niente segnaposto. Applica logiche, calcoli o codice completo.${codeHint}\n\n${ACTIONS_HELP}`;
      const feedback = step.feedback ? `\n\nIL TENTATIVO PRECEDENTE È STATO SCARTATO DAL CONTROLLO. Problemi da correggere: ${step.feedback}\nRifallo da capo, corretto e completo.` : '';
      let user = `${ctx.slice(0, job.project ? 9000 : 2000)}\n\nCOMPITO COMPLESSIVO: ${job.goal}\n\n${manifest}${prior ? 'RISULTATI DEI PASSI PRECEDENTI:\n' + prior + '\n\n' : ''}PASSO DA SVOLGERE ORA (${i + 1} di ${steps.length}) — ${step.title}: ${step.instruction}${step.done ? `\nFATTO BENE SE: ${step.done}` : ''}${feedback}`;
      const avoid = step.lastModel ? [step.lastModel] : [];
      let res = await call(step.tier, system, user, 2400, { avoid });
      // Il passo chiede internet: si cerca davvero e si rifà il passo con i risultati (al massimo due volte).
      for (let r = 0; r < WEB_ROUNDS; r++) {
        const ask = webAsk(res.text);
        if (!ask) break;
        const found = ask.kind === 'read' ? await web.readUrl(deps.fetchFn, ask.q) : await web.search(env, deps.fetchFn, ask.q, todayOf(ms, tz));
        user += `\n\n${web.webBlock(ask.q, found)}`;
        res = await call(step.tier, system, user + (r === WEB_ROUNDS - 1 ? '\n\nOra svolgi il passo con quello che hai: niente altre ricerche.' : ''), 2400, { avoid });
      }
      const { body, actions } = parseStepActions(res.text);
      const tries = (step.tries || 0) + 1;

      // Controllo indipendente: un altro modello giudica se il passo è fatto davvero (e se le azioni sono giuste).
      const wantsCheck = step.tier === 'smart' || (actions && actions.length) || actions === null || isCodeGoal;
      let verdict = { ok: true, problems: '' };
      if (actions === null) verdict = { ok: false, problems: 'Il blocco ```azioni non è un JSON valido: riscrivilo come array JSON corretto.' };
      else if (wantsCheck && tries < STEP_TRIES) {
        try {
          const chk = await call('smart',
            'Sei il revisore severo dei compiti di Kestra. Controlla se il RISULTATO svolge DAVVERO e PER INTERO il passo richiesto: niente parti mancanti, niente segnaposto ("...", "TODO", "da completare"), niente promesse senza azione, dati coerenti, azioni con tutti i campi e date valide. Non pretendere la perfezione: boccia solo errori o mancanze vere. Rispondi SOLO con JSON: {"ok": true|false, "problemi": "elenco breve e preciso di cosa correggere"}',
            `COMPITO COMPLESSIVO: ${job.goal.slice(0, 1500)}\n\nPASSO: ${step.title}: ${step.instruction}${step.done ? `\nFATTO BENE SE: ${step.done}` : ''}\n\nRISULTATO:\n${body.slice(0, 7000)}\n\nAZIONI PROPOSTE: ${JSON.stringify(actions || []).slice(0, 2000)}`,
            400, { avoid: [res.key] });
          verdict = parseVerdict(chk.text);
        } catch { /* nessun revisore disponibile: si accetta il passo */ }
      }
      if (!verdict.ok && tries < STEP_TRIES) {
        Object.assign(step, { tries, feedback: verdict.problems || 'risultato incompleto', lastModel: res.key, status: 'pending' });
        logEvent(db, at, 'job', `passo "${step.title}" rifatto (${tries}/${STEP_TRIES - 1}): ${verdict.problems.slice(0, 160)}`);
        save(steps);
        return 1000;
      }

      // Via libera: ora le azioni vere.
      const ran = runStepActions(db, actions || [], { ms, tz, nowIso: at, today: todayOf(ms, tz) });
      Object.assign(step, { status: 'done', output: body.slice(0, 10000), model: res.key, tries, checked: verdict.ok ? 'ok' : 'debole', ran: ran.applied, failedActions: ran.failed, phone: ran.phone });
      delete step.feedback;
      const extractedFiles = extractProjectFiles(step.output);
      if (extractedFiles.length) {
        devices.enqueueCommand(db, 'desktop', {
          kind: 'write_project',
          target: job.title,
          args: JSON.stringify({ files: extractedFiles }),
        }, ms);
      }
      save(steps);
      return 1000;
    }

    // Tutti i passi fatti: sintesi finale.
    const all = steps.map((s, k) => `Passo ${k + 1} — ${s.title}${s.ran?.length ? ` [azioni eseguite: ${s.ran.join(', ')}]` : ''}${s.failedActions?.length ? ` [azioni NON riuscite: ${s.failedActions.join(', ')}]` : ''}:\n${String(s.output || '').slice(0, 3000)}`).join('\n\n');
    // Controllo del compito intero: se il Capo aveva chiesto più cose e qualcuna manca, si aggiungono i passi (una volta sola).
    if (steps.length > 0 && !steps.some(s => s.extra)) {
      try {
        const chk = await call('smart',
          'Sei il revisore finale dei compiti di Kestra. Confronta il COMPITO con quello che è stato fatto. Elenca SOLO le richieste del Capo rimaste davvero senza risposta o senza azione. Rispondi SOLO con JSON: {"completo": true|false, "mancano": [{"title": "...", "instruction": "istruzione autosufficiente per farlo", "tier": "smart"}]}',
          `COMPITO: ${job.goal.slice(0, 2000)}\n\nFATTO FINORA:\n${all.slice(0, 9000)}`, 700);
        const o = extractObject(chk.text);
        const missing = o && o.completo === false && Array.isArray(o.mancano) ? o.mancano.filter(m => m && m.instruction).slice(0, 3) : [];
        if (missing.length) {
          steps.push(...missing.map((m, k) => ({ ...normStep({ ...m, role: 'Esecutore', id: `x${k + 1}` }, steps.length + k), extra: true })));
          logEvent(db, at, 'job', `compito "${job.title}": aggiunti ${missing.length} passi mancanti`);
          save(steps);
          return 1000;
        }
      } catch { /* nessun revisore: si chiude con quello che c'è */ }
    }
    const final = steps.length === 1 ? steps[0].output : (await call('smart',
      'Sei Kestra. Unisci i risultati dei passi in un unico risultato finale chiaro e ordinato per il Capo, in italiano, senza ripetizioni. Puoi usare titoli brevi ed elenchi. Se un\'azione non è riuscita dillo chiaramente.',
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
    pushInbox(db, at, 'job', `Ho completato "${job.title}", Capo.${jobNotes(steps)} Il risultato è nella sezione Attività.`);
    return hasPendingJobs(db) ? 1000 : null;
  } catch (e) {
    logEvent(db, at, 'error', `job ${job.id}: ${e.message}`);
    return fail(e.message);
  }
}

function normStep(s, idx) {
  return {
    id: String(s.id || `n${idx + 1}`).slice(0, 20),
    role: String(s.role || 'Agente').slice(0, 30),
    title: String(s.title || 'Passo').slice(0, 80),
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(x => String(x)).slice(0, 4) : [],
    instruction: String(s.instruction).slice(0, 1500),
    done: String(s.done || '').slice(0, 300),
    tier: s.tier === 'fast' ? 'fast' : 'smart',
    status: 'pending',
    output: '',
  };
}

/** Esegue le azioni approvate di un passo. Quelle sul telefono non partono da sole: si chiedono al Capo. */
export function runStepActions(db, actions, ctx) {
  const out = { applied: [], failed: [], phone: [] };
  const server = actions.filter(a => JOB_ACTIONS.has(a.type));
  for (const a of actions) {
    if (PHONE_ACTIONS.has(a.type)) out.phone.push(String(a.goal || a.name || a.url || a.type).slice(0, 200));
    else if (!JOB_ACTIONS.has(a.type)) out.failed.push(a.type);
  }
  if (server.length) {
    const done = applyActions(db, server, { ...ctx, hadPhoto: false });
    out.applied.push(...done.applied);
    out.failed.push(...done.failed);
  }
  if (out.phone.length) {
    // Il telefono serve con il Capo davanti (conferme, schermo sbloccato): resta in sospeso e lo si ricorda.
    pushInbox(db, ctx.nowIso, 'job', `Per finire mi serve il telefono: ${out.phone.join('; ')}. Dimmi "fallo" quando puoi.`);
    kvSet(db, 'phonePending', { goal: out.phone.join('; '), say: 'Per finire il compito in background mi serve il telefono: lo faccio adesso?', at: ctx.ms, history: [] });
  }
  return out;
}

function jobNotes(steps) {
  const ran = steps.flatMap(s => s.ran || []);
  const failed = steps.flatMap(s => s.failedActions || []);
  const labels = { add_reminder: 'promemoria', remember: 'ricordi', add_meal: 'pasti', add_activity: 'allenamenti', pc_action: 'comandi al PC', add_pantry_item: 'cose in dispensa', save_recipe: 'ricette', ui_note: 'note', learn: 'regole' };
  const count = (list) => Object.entries(list.reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {})).map(([t, n]) => `${n} ${labels[t] || t}`).join(', ');
  return (ran.length ? ` Ho fatto: ${count(ran)}.` : '') + (failed.length ? ` Non sono riuscita a fare: ${count(failed)}.` : '');
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
