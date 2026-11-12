// Il "cervello": mette insieme contesto, router dei modelli, memoria e azioni.

import * as router from './router.js';
import { CORE_PROMPT, buildMessages, parseReply } from './context.js';
import { loadDiary, saveDiary, applyDietAction, dietBrief, dietContext, DIET_ACTIONS, DIET_KEYWORDS, DIET_RULES } from './diet.js';
import * as memory from './memory.js';
import * as agenda from './agenda.js';
import { today as todayOf, nowIso as nowIsoOf, nowHuman } from './clock.js';
import { logEvent } from './db.js';

const STICKY_TURNS = 3;
const SUMMARIZE_AFTER = 24;   // messaggi non ancora riassunti oltre i quali si comprime
const KEEP_VERBATIM = 10;     // messaggi recenti che restano sempre per intero
const AGENDA_KEYWORDS = /(ricord|promemoria|appuntament|agenda|scadenz|sveglia|domani|dopodomani|stasera|settimana prossima|luned|marted|mercoled|gioved|venerd|sabato|domenica|alle \d|tra \d+ (minut|or))/i;

function session(db, id) {
  let row = db.get('SELECT * FROM sessions WHERE id = ?', id);
  if (!row) {
    db.run('INSERT INTO sessions (id) VALUES (?)', id);
    row = db.get('SELECT * FROM sessions WHERE id = ?', id);
  }
  let modules = {};
  try { modules = JSON.parse(row.modules) || {}; } catch { /* vuoto */ }
  return { ...row, modules };
}

export function addMessage(db, sessionId, role, text, at, meta = null) {
  db.run('INSERT INTO messages (session, role, text, at, meta) VALUES (?, ?, ?, ?, ?)', sessionId, role, text, at, meta ? JSON.stringify(meta) : null);
}

/** Applica le azioni restituite dal modello. Ritorna { photoRequest, jobs, applied }. */
export function applyActions(db, actions, ctx) {
  const out = { photoRequest: null, jobs: [], applied: [], device: [] };
  let diary = null;
  for (const a of actions.slice(0, 20)) {
    try {
      if (DIET_ACTIONS.has(a.type)) {
        diary = diary || loadDiary(db);
        const photo = applyDietAction(diary, a, ctx);
        if (photo) out.photoRequest = photo;
      } else if (a.type === 'remember') memory.remember(db, a, ctx.nowIso);
      else if (a.type === 'forget') memory.forget(db, a.id);
      else if (a.type === 'add_reminder') agenda.addReminder(db, a, ctx.ms, ctx.tz);
      else if (a.type === 'done_reminder') agenda.doneReminder(db, a.id);
      else if (a.type === 'start_job') { if (String(a.goal || '').trim()) out.jobs.push({ title: String(a.title || 'Compito').slice(0, 80), goal: String(a.goal).slice(0, 2000) }); }
      else if (a.type === 'open_app') {
        // Eseguita dal telefono, non dal server: la inoltriamo così com'è.
        const name = String(a.name || '').trim().slice(0, 60);
        if (!name) continue;
        out.device.push({ type: 'open_app', name });
      } else if (a.type === 'open_url') {
        const url = String(a.url || '').trim().slice(0, 500);
        if (!/^https:\/\//i.test(url)) continue;
        out.device.push({ type: 'open_url', url });
      } else continue;
      out.applied.push(a.type);
    } catch (e) {
      logEvent(db, ctx.nowIso, 'error', `azione ${a.type}: ${e.message}`);
    }
  }
  if (diary) {
    if (ctx.hadPhoto && !out.photoRequest) diary.pendingPhotoRequest = '';
    saveDiary(db, diary);
  }
  return out;
}

/**
 * Gestisce un messaggio dell'utente.
 * deps: { now, fetchFn, tz, defer(promise), startJob({title, goal}) }
 */
export async function handleChat(db, env, deps, { text, image = null, sessionId = 'main', source = 'app' }) {
  const ms = deps.now();
  const tz = deps.tz;
  const today = todayOf(ms, tz);
  const nowIso = nowIsoOf(ms, tz);
  const userText = String(text || '').trim().slice(0, 4000) || (image ? 'Guarda questa foto.' : '');
  if (!userText) return { reply: 'Non ho sentito nulla, signore.', expectReply: true, card: '', photoRequest: null };

  const sess = session(db, sessionId);
  const diary = loadDiary(db);

  // Moduli attivi: richiamati dal testo oppure ancora "caldi" dai turni precedenti.
  const sticky = Object.entries(sess.modules).filter(([, ttl]) => ttl > 0).map(([k]) => k);
  const lastAssistant = db.get("SELECT text FROM messages WHERE session = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", sessionId)?.text || '';
  const probe = userText + ' ' + lastAssistant.slice(0, 300);
  const dietOn = !!image || DIET_KEYWORDS.test(probe) || sticky.includes('dieta') || !!diary.activeRecipeSession || !!diary.pendingPhotoRequest;
  const agendaOn = AGENDA_KEYWORDS.test(probe) || sticky.includes('agenda');
  const recalled = memory.recall(db, probe, { sticky });

  const history = db.all('SELECT role, text FROM messages WHERE session = ? AND id > ? ORDER BY id DESC LIMIT 14', sessionId, sess.summarized_upto).reverse();
  const mods = memory.listModules(db);
  const parts = {
    core: CORE_PROMPT(diary.profile.name, nowHuman(ms, tz)),
    brief: dietBrief(diary, today),
    rules: dietOn ? DIET_RULES : '',
    blocks: dietOn ? dietContext(diary, today) : [],
    memories: recalled.entries.map(m => `- [${m.id}] (${m.module}) ${m.text}`),
    moduleIndex: mods.length ? 'MODULI DI MEMORIA ESISTENTI: ' + mods.map(m => `${m.name}${m.description ? ` (${m.description})` : ''} [${m.entries}]`).join('; ') : '',
    agenda: agendaOn ? agenda.agendaContext(db, tz) : '',
    summary: sess.summary,
    history,
    userText: `[${nowHuman(ms, tz)}${source === 'voice' ? ', a voce' : ''}] ${userText}`,
    image,
  };

  addMessage(db, sessionId, 'user', userText, nowIso, image ? { image: true } : null);

  let result;
  const tier = router.classifyTier(userText, !!image);
  try {
    const res = await router.chat(db, env, {
      tier, needsVision: !!image, preferKey: sess.model, maxTokens: 1400,
      build: (model) => buildMessages(model, parts), fetchFn: deps.fetchFn, now: deps.now, tz,
    });
    const parsed = parseReply(res.text);
    const done = applyActions(db, parsed.actions, { today, nowIso, ms, tz, hadPhoto: !!image });
    for (const j of done.jobs) deps.startJob?.(j);
    result = { reply: parsed.reply, expectReply: parsed.expectReply, card: parsed.card, photoRequest: done.photoRequest, model: res.key, switched: res.switched, actions: done.applied, device: done.device };
    sess.model = res.key;
  } catch (e) {
    logEvent(db, nowIso, 'error', `chat: ${e.message} ${(e.tried || []).join(' | ')}`);
    result = { reply: e.tried ? e.message : 'Si è verificato un problema interno, signore. Riprovi tra poco.', expectReply: false, card: '', photoRequest: null, model: '', switched: false, actions: [], device: [], error: true };
  }

  addMessage(db, sessionId, 'assistant', result.reply, nowIso, { model: result.model, card: result.card || undefined });
  memory.markUsed(db, recalled.entries.map(m => m.id), nowIso);

  // Aggiorna i moduli "caldi" della sessione.
  const next = {};
  for (const [k, ttl] of Object.entries(sess.modules)) if (ttl > 1) next[k] = ttl - 1;
  if (dietOn && (DIET_KEYWORDS.test(userText) || image || result.actions.some(a => DIET_ACTIONS.has(a)))) next.dieta = STICKY_TURNS;
  if (agendaOn && AGENDA_KEYWORDS.test(userText)) next.agenda = STICKY_TURNS;
  for (const m of recalled.active) next[m] = STICKY_TURNS;
  db.run('UPDATE sessions SET model = ?, modules = ?, updated = ? WHERE id = ?', sess.model, JSON.stringify(next), nowIso, sessionId);

  const pending = summarizeIfNeeded(db, env, deps, sessionId);
  if (deps.defer) deps.defer(pending); else await pending;
  return result;
}

/** Comprime i messaggi più vecchi in un riassunto, così la sessione non cresce all'infinito. */
export async function summarizeIfNeeded(db, env, deps, sessionId) {
  try {
    const sess = session(db, sessionId);
    const rows = db.all('SELECT id, role, text FROM messages WHERE session = ? AND id > ? ORDER BY id', sessionId, sess.summarized_upto);
    if (rows.length <= SUMMARIZE_AFTER) return false;
    const old = rows.slice(0, rows.length - KEEP_VERBATIM);
    const transcript = old.map(m => `${m.role === 'user' ? 'Utente' : 'Jarvis'}: ${m.text}`).join('\n').slice(0, 24000);
    const res = await router.chat(db, env, {
      tier: 'fast', maxTokens: 500, fetchFn: deps.fetchFn, now: deps.now, tz: deps.tz,
      build: () => [
        { role: 'system', content: 'Riassumi conversazioni in italiano, in modo fedele e compatto (massimo 180 parole). Conserva decisioni, richieste rimaste aperte, preferenze e fatti utili; ometti i convenevoli. Rispondi solo con il riassunto.' },
        { role: 'user', content: `RIASSUNTO PRECEDENTE:\n${sess.summary || '(nessuno)'}\n\nNUOVI MESSAGGI:\n${transcript}\n\nScrivi il riassunto aggiornato.` },
      ],
    });
    db.run('UPDATE sessions SET summary = ?, summarized_upto = ? WHERE id = ?', res.text.trim().slice(0, 2400), old[old.length - 1].id, sessionId);
    return true;
  } catch {
    return false; // riproverà al prossimo messaggio
  }
}

/** "Jarvis" detto in mezzo a una frase: l'utente si rivolge all'assistente o ne sta solo parlando? */
export async function isAddressed(db, env, deps, text) {
  const res = await router.chat(db, env, {
    tier: 'fast', maxTokens: 5, fetchFn: deps.fetchFn, now: deps.now, tz: deps.tz,
    build: () => [
      { role: 'system', content: 'Un utente ha un assistente vocale di nome Jarvis. Ricevi la trascrizione di una frase sentita dal microfono. Decidi se l\'utente si sta rivolgendo all\'assistente per chiedergli qualcosa (SI) oppure sta parlando con altre persone o di altro, per esempio dei film Marvel, di Iron Man o dell\'assistente in terza persona (NO). Rispondi solo SI oppure NO.' },
      { role: 'user', content: String(text || '').slice(0, 400) },
    ],
  });
  return /^\s*s[iìí]/i.test(res.text);
}
