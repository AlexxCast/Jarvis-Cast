// Il "cervello": mette insieme contesto, router dei modelli, memoria e azioni.

import * as phone from './phone.js';
import { WEATHER_WORDS, weatherContext } from './weather.js';
import * as web from './web.js';
import * as router from './router.js';
import { CORE_PROMPT, buildMessages, parseReply } from './context.js';
import { loadDiary, saveDiary, applyDietAction, dietBrief, dietContext, DIET_ACTIONS, DIET_KEYWORDS, DIET_RULES } from './diet.js';
import * as memory from './memory.js';
import * as places from './places.js';
import * as agenda from './agenda.js';
import * as ui from './ui.js';
import * as coder from './coder.js';
import * as mood from './mood.js';
import { today as todayOf, nowIso as nowIsoOf, nowHuman } from './clock.js';
import { logEvent, kvSet, kvGet } from './db.js';

const STICKY_TURNS = 3;
// Richieste di cambiare cosa mostra l'app: solo allora il modello riceve le istruzioni per personalizzarla.
const UI_WORDS = /(mostra|vedere|vedo|visualizz|schermat|riquadr|togli|nascond|in vista|personalizz|interfaccia|nell'app|sull'app|home|pagina|funzion|modific|riprogramm|riscriv|programm|pulsant|bottone|anteprima|approv|unisci|scarta)/i;
// Richieste di usare il telefono: solo allora il modello riceve l'elenco delle app installate.
const DEVICE_WORDS = /(apri|app\b|applicazion|mand|invi|scriv|messagg|chiam|cerca|metti|music|canzon|playlist|ascolt|video|foto|leggi|whatsapp|telegram|instagram|telefono|impostazion|sveglia|naviga|mappa|portami|accendi|spegni|volume)/i;
const SPORT_WORDS = /(allen|corsa|corr[eoi]|palestra|sport|cammin|bici|nuot|esercizi|pesi|passi)/i;
const SUMMARIZE_AFTER = 24;   // messaggi non ancora riassunti oltre i quali si comprime
const KEEP_VERBATIM = 10;     // messaggi recenti che restano sempre per intero
const AGENDA_KEYWORDS = /(ricord|ogni (sera|mattina|giorno|settimana|mese|luned|marted|mercoled|gioved|venerd|sabato|domenica)|tutti i giorni|promemoria|quando (arriv|esc|torn|sono a|entro)|arrivo a|esco da|torno a casa|luogh|posizione|salva (questo|il) (posto|luogo)|appuntament|agenda|scadenz|sveglia|domani|dopodomani|stasera|settimana prossima|luned|marted|mercoled|gioved|venerd|sabato|domenica|alle \d|tra \d+ (minut|or))/i;

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

const VISUAL_KINDS = new Set(['bars', 'line', 'pie', 'list', 'text', 'svg', 'image']);
/** Convalida una grafica chiesta dal modello: solo dati, niente HTML. Ritorna null se non è usabile. */
export function cleanVisual(a) {
  const kind = String(a.kind || '').toLowerCase();
  if (!VISUAL_KINDS.has(kind)) return null;
  const v = { kind, title: String(a.title || '').trim().slice(0, 80), seconds: Math.round(Math.min(60, Math.max(4, Number(a.seconds) || 12))) };
  if (a.unit) v.unit = String(a.unit).slice(0, 12);
  if (a.text) v.text = String(a.text).trim().slice(0, 400);
  if (['bars', 'line', 'pie', 'list'].includes(kind)) {
    v.items = (Array.isArray(a.items) ? a.items : []).slice(0, 14).map(i => ({
      label: String(i?.label ?? '').trim().slice(0, 40),
      value: kind === 'list' ? (Number.isFinite(Number(i?.value)) && i?.value !== '' && i?.value != null ? Number(i.value) : '') : Number(i?.value),
    })).filter(i => i.label && (kind === 'list' || Number.isFinite(i.value)));
    if (!v.items.length) return null;
  }
  if (kind === 'text' && !v.text) return null;
  if (kind === 'svg') {
    const svg = String(a.svg || '').trim();
    if (!/^<svg[\s>]/i.test(svg) || svg.length > 20000) return null;
    v.svg = svg;
  }
  if (kind === 'image') {
    if (!/^https:\/\//i.test(String(a.url || ''))) return null;
    v.url = String(a.url).slice(0, 500);
  }
  return v;
}

/** Frasi con cui il modello dichiara di aver salvato o cambiato qualcosa. */
export const CLAIM_WORDS = /\b(ho|l'ho|li ho|le ho|te l'ho|gliel'ho)\s+(appena\s+|già\s+|subito\s+|anche\s+)?(registrat|aggiunt|aggiornat|salvat|segnat|impostat|annotat|memorizzat|eliminat|cancellat|inserit|creat|modificat|spostat|tolt|rimoss)|\b(promemoria|piano|diario|pasto|peso|allenamento|dispensa|ricetta)\s+(è stat[oa]\s+)?(impostat|aggiornat|registrat|salvat|creat|aggiunt)[oa]\b|^\W*(fatto|registrato|aggiornato|salvato|segnato|annotato)\b/i;
const FAIL_LABELS = { show: 'mostrare la grafica', web_search: 'cercare su internet', read_url: 'leggere la pagina', add_meal: 'registrare il pasto (mancano gli alimenti)', update_meal: 'modificare il pasto (non l\'ho trovato)', delete_meal: 'eliminare il pasto (non l\'ho trovato)', add_weight: 'registrare il peso', add_activity: 'registrare l\'allenamento', add_reminder: 'creare il promemoria (data non valida)', remember: 'salvare il ricordo', call: 'avviare la chiamata (manca il nome)', update_profile: 'aggiornare il profilo', delete_activity: 'eliminare l\'attività (non l\'ho trovata)' };
const failLabel = (t) => FAIL_LABELS[t] || `completare l'operazione "${t}"`;
const REPAIR_PROMPT = (failed) => `CONTROLLO AUTOMATICO: nella tua risposta ${failed.length ? `queste azioni non erano valide e NON sono state eseguite: ${failed.join(', ')}` : 'dichiari di aver fatto qualcosa ma il campo "actions" è vuoto o incompleto'}. Finora NON è stato salvato nulla. Rimanda SOLO il JSON completo, con in "actions" tutte le azioni corrette e complete (per un pasto: items con name, grams, kcal, protein, carbs, fat; per update/delete: l'id esatto preso dal contesto). Se davvero non c'è nulla da salvare, lascia "actions" vuoto e scrivi una reply che NON dica di aver salvato o fatto qualcosa.`;

/** App installate sul telefono (le manda l'app Android), così un nome storpiato diventa l'app vera. */
export function appsPrompt(db) {
  const apps = kvGet(db, 'apps', []);
  if (!apps.length) return '';
  return 'APP INSTALLATE SUL TELEFONO (usa sempre questi nomi esatti; un nome detto uguale o quasi a una di queste app è quella app; se l\'utente storpia un nome o il riconoscimento vocale lo sbaglia, scegli l\'app installata più simile per suono o per contesto, es. per la musica l\'app di musica che c\'è in questo elenco): ' + apps.join(', ').slice(0, 3500);
}

/** Applica le azioni restituite dal modello. Ritorna { photoRequest, jobs, applied }. */
export function applyActions(db, actions, ctx) {
  const out = { photoRequest: null, jobs: [], applied: [], device: [], code: [], failed: [] };
  let diary = null;
  // phone_task apre l'app da solo: un open_app in più la riaprirebbe a metà lavoro.
  if (actions.some(a => a?.type === 'phone_task')) actions = actions.filter(a => a?.type !== 'open_app');
  for (const a of actions.slice(0, 20)) {
    try {
      if (DIET_ACTIONS.has(a.type)) {
        diary = diary || loadDiary(db);
        const before = JSON.stringify(diary);
        const photo = applyDietAction(diary, a, ctx);
        if (photo) out.photoRequest = photo;
        // Un'azione che non cambia nulla (pasto senza alimenti, id inesistente) non è "fatta".
        if (!photo && a.type !== 'clear_recipe_session' && JSON.stringify(diary) === before) { out.failed.push(a.type); continue; }
      } else if (a.type === 'remember') { if (!memory.remember(db, a, ctx.nowIso)) { out.failed.push(a.type); continue; } }
      else if (a.type === 'forget') memory.forget(db, a.id);
      else if (a.type === 'add_reminder') { if (!agenda.addReminder(db, a, ctx.ms, ctx.tz)) { out.failed.push(a.type); continue; } }
      else if (a.type === 'done_reminder') agenda.doneReminder(db, a.id);
      else if (coder.CODE_ACTIONS.has(a.type)) out.code.push({ type: a.type, id: String(a.id || ''), request: String(a.request || '').trim().slice(0, 2000) });
      else if (ui.UI_ACTIONS.has(a.type)) { if (!ui.applyUiAction(db, a, ctx.nowIso)) { out.failed.push(a.type); continue; } out.ui = true; }
      else if (a.type === 'start_job') { if (String(a.goal || '').trim()) out.jobs.push({ title: String(a.title || 'Compito').slice(0, 80), goal: String(a.goal).slice(0, 2000) }); }
      else if (a.type === 'open_app') {
        // Eseguita dal telefono, non dal server: la inoltriamo così com'è.
        const name = String(a.name || '').trim().slice(0, 60);
        if (!name) continue;
        out.device.push({ type: 'open_app', name });
      } else if (a.type === 'show') {
        // Una grafica da mostrare: nell'app sotto la risposta e, col telefono in uso, sopra le altre app.
        const v = cleanVisual(a);
        if (!v) { out.failed.push(a.type); continue; }
        out.visual = v;
        out.device.push({ type: 'visual', data: v });
      } else if (a.type === 'call') {
        // La telefonata la fa il telefono, cercando il nome in rubrica.
        const name = String(a.name || a.number || '').trim().slice(0, 60);
        if (!name) { out.failed.push(a.type); continue; }
        out.device.push({ type: 'call', name });
      } else if (a.type === 'phone_task') {
        // Il telefono esegue l'obiettivo da solo, chiedendo al server una mossa alla volta.
        const goal = String(a.goal || '').trim().slice(0, 1000);
        if (!goal) continue;
        out.device.push({ type: 'phone_task', goal });
      } else if (a.type === 'save_place') {
        // Le coordinate le conosce solo il telefono: salva lui la posizione attuale con questo nome.
        const name = String(a.name || '').trim().slice(0, 40);
        if (!name) continue;
        out.device.push({ type: 'save_place', name });
      } else if (a.type === 'forget_place') places.deletePlace(db, a.name);
      else if (a.type === 'open_url') {
        const url = String(a.url || '').trim().slice(0, 500);
        if (!/^https:\/\//i.test(url)) continue;
        out.device.push({ type: 'open_url', url });
      } else { out.failed.push(String(a.type)); continue; }
      out.applied.push(a.type);
    } catch (e) {
      out.failed.push(String(a.type));
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
    core: CORE_PROMPT(diary.profile.name, nowHuman(ms, tz)) + '\n\n' + mood.MOOD_PROMPT(mood.current(db, ms)),
    brief: dietBrief(diary, today),
    rules: [dietOn ? DIET_RULES : '', UI_WORDS.test(userText) ? ui.uiPrompt(ui.loadLayout(db)) : '', UI_WORDS.test(userText) ? coder.codePrompt(env, db) : '', DEVICE_WORDS.test(userText) ? appsPrompt(db) : '', phone.pendingContext(db, ms)].filter(Boolean).join('\n\n'),
    blocks: dietOn ? dietContext(diary, today) : [],
    memories: recalled.entries.map(m => `- [${m.id}] (${m.module}) ${m.text}`),
    moduleIndex: [mods.length ? 'MODULI DI MEMORIA ESISTENTI: ' + mods.map(m => `${m.name}${m.description ? ` (${m.description})` : ''} [${m.entries}]`).join('; ') : '',
      memory.topicsIndex(db, mods.map(m => m.name).slice(0, 30))].filter(Boolean).join('\n').slice(0, 2500),
    agenda: agendaOn ? agenda.agendaContext(db, tz) : '',
    weather: WEATHER_WORDS.test(userText) ? await weatherContext(db, deps.fetchFn, userText) : '',
    // Domande su fatti recenti: la ricerca parte subito, senza aspettare che il modello la chieda.
    web: web.WEB_WORDS.test(userText) && !WEATHER_WORDS.test(userText) ? web.webBlock(userText, await web.search(env, deps.fetchFn, userText, today)) : '',
    summary: sess.summary,
    history,
    userText: `[${nowHuman(ms, tz)}${source === 'voice' ? ', a voce' : ''}] ${userText}`,
    image,
  };

  addMessage(db, sessionId, 'user', userText, nowIso, image ? { image: true } : null);

  let result;
  let remembered = [];
  let topicHits = { modules: [], leaves: [] };
  const tier = router.classifyTier(userText, !!image);
  try {
    let res = await router.chat(db, env, {
      tier, needsVision: !!image, preferKey: sess.model, maxTokens: 2000,
      build: (model) => buildMessages(model, parts), fetchFn: deps.fetchFn, now: deps.now, tz,
    });
    let parsed = parseReply(res.text);
    // Il modello chiede di cercare su internet o leggere una pagina: lo facciamo e gli ridiamo la parola.
    const webAsk = parsed.actions.filter(a => a.type === 'web_search' || a.type === 'read_url').slice(0, 2);
    if (webAsk.length) {
      const found = [];
      for (const a of webAsk) {
        const q = a.type === 'read_url' ? String(a.url || '') : String(a.query || userText);
        found.push(web.webBlock(q, a.type === 'read_url' ? await web.readUrl(deps.fetchFn, q) : await web.search(env, deps.fetchFn, q, today)));
      }
      parts.web = [parts.web, ...found].filter(Boolean).join('\n\n');
      try {
        res = await router.chat(db, env, {
          tier, needsVision: !!image, preferKey: res.key, maxTokens: 2000,
          build: (model) => buildMessages(model, parts), fetchFn: deps.fetchFn, now: deps.now, tz,
        });
        parsed = parseReply(res.text);
      } catch { parsed = { ...parsed, reply: 'Ho cercato, ma non riesco a elaborare i risultati in questo momento, signore.', actions: [] }; }
      parsed.actions = parsed.actions.filter(a => a.type !== 'web_search' && a.type !== 'read_url');
    }
    let done = applyActions(db, parsed.actions, { today, nowIso, ms, tz, hadPhoto: !!image });
    // Dice di averlo fatto ma nessuna azione è andata a buon fine: una seconda richiesta per avere le azioni vere.
    const nothing = (d) => !d.applied.length && !d.device.length && !d.jobs.length && !d.code.length;
    // Le richieste da eseguire sul telefono (chiamate, app) hanno la loro rete di sicurezza più sotto.
    const deviceAsk = !!phone.calleeOf(userText) || (phone.DOING_WORDS.test(userText) && DEVICE_WORDS.test(userText));
    if (nothing(done) && (done.failed.length || parsed.truncated || (CLAIM_WORDS.test(parsed.reply) && !deviceAsk))) {
      logEvent(db, nowIso, 'error', `azione dichiarata ma non eseguita (${done.failed.join(', ') || 'nessuna azione'}): ${parsed.reply.slice(0, 120)}`);
      let fixed = null;
      try {
        const again = await router.chat(db, env, {
          tier: 'smart', needsVision: !!image, maxTokens: 2000, fetchFn: deps.fetchFn, now: deps.now, tz,
          build: (model) => [...buildMessages(model, parts), { role: 'assistant', content: res.text.slice(0, 3000) }, { role: 'user', content: REPAIR_PROMPT(done.failed) }],
        });
        fixed = parseReply(again.text);
      } catch { /* resta la risposta onesta qui sotto */ }
      const redo = fixed?.parsed ? applyActions(db, fixed.actions, { today, nowIso, ms, tz, hadPhoto: !!image }) : null;
      if (redo && (!nothing(redo) || !CLAIM_WORDS.test(fixed.reply))) { parsed = fixed; done = redo; }
      else {
        parsed = { ...parsed, reply: 'Mi scusi signore, non sono riuscito a salvarlo davvero. Me lo può ripetere con i dettagli?', expectReply: true, card: '', actions: [] };
        mood.feel(db, 'frustrazione', 0.3, ms);
      }
    } else if (done.failed.length) {
      // Alcune azioni sono riuscite e altre no: lo dice chiaramente invece di far finta.
      parsed = { ...parsed, reply: `${parsed.reply} Attenzione però: non sono riuscito a ${[...new Set(done.failed)].map(failLabel).join(' e a ')}.` };
      logEvent(db, nowIso, 'error', `azioni non riuscite: ${done.failed.join(', ')}`);
    }
    remembered = parsed.actions.filter(a => a && a.type === 'remember').map(a => memory.slug(a.module) || 'generale');
    topicHits = memory.touchTopics(db, parsed.topics, nowIso);
    if (parsed.mood) mood.feel(db, parsed.mood.emozione, parsed.mood.intensita, ms);
    // Ha promesso di farlo ma non ha messo l'azione: la aggiungiamo noi, così non resta una promessa a vuoto.
    const goal = userText.replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').slice(0, 1000);
    const callee = phone.calleeOf(userText);
    if (!done.device.length && callee && phone.PROMISE_WORDS.test(parsed.reply)) {
      // "Chiamo Marcolino" senza l'azione: la telefonata parte lo stesso.
      done.device.push({ type: 'call', name: callee });
      done.applied.push('call');
    } else if (!done.device.length && phone.DOING_WORDS.test(userText) && DEVICE_WORDS.test(userText) && phone.PROMISE_WORDS.test(parsed.reply)) {
      done.device.push({ type: 'phone_task', goal });
      done.applied.push('phone_task');
    } else if (done.device.length && done.device.every(d => d.type === 'open_app') && phone.INSIDE_WORDS.test(userText)) {
      // Ha solo aperto l'app ma l'utente voleva fare qualcosa dentro (mandare, cercare, mettere...).
      done.device = [{ type: 'phone_task', goal: `${goal} (app: ${done.device[0].name})` }];
      done.applied.push('phone_task');
    }
    if (done.device.some(d => d.type === 'phone_task')) kvSet(db, 'phonePending', null);
    for (const j of done.jobs) deps.startJob?.(j);
    for (const c of done.code) {
      try {
        if (!coder.enabled(env)) { done.applied.push('code_disabled'); continue; }
        if (c.type === 'code_change' && c.request) { const id = coder.propose(db, c.request, deps.now(), tz); const w = coder.work(db, env, deps, id); if (deps.defer) deps.defer(w); else await w; }
        else if (c.type === 'code_approve') await coder.approve(db, env, deps, c.id);
        else if (c.type === 'code_discard') await coder.discard(db, env, deps, c.id);
        done.applied.push(c.type);
      } catch (e) { logEvent(db, nowIso, 'error', `${c.type}: ${e.message}`); }
    }
    result = { reply: parsed.reply, expectReply: parsed.expectReply, card: parsed.card, visual: done.visual || null, photoRequest: done.photoRequest, model: res.key, switched: res.switched, actions: done.applied, device: done.device, tier, layoutChanged: !!done.ui };
    sess.model = res.key;
  } catch (e) {
    logEvent(db, nowIso, 'error', `chat: ${e.message} ${(e.tried || []).join(' | ')}`);
    mood.feel(db, 'frustrazione', 0.3, ms);
    result = { reply: e.tried ? e.message : 'Si è verificato un problema interno, signore. Riprovi tra poco.', expectReply: false, card: '', photoRequest: null, model: '', switched: false, actions: [], device: [], error: true };
  }

  addMessage(db, sessionId, 'assistant', result.reply, nowIso, { model: result.model, card: result.card || undefined, visual: result.visual || undefined });
  // Cosa ha "acceso" questo scambio: la sfera illumina questi rami e foglie.
  const touched = new Set(recalled.active);
  if (dietOn) touched.add(SPORT_WORDS.test(userText) ? 'sport' : 'dieta');
  if (agendaOn) touched.add('agenda');
  for (const r of remembered) touched.add(r);
  for (const m of topicHits.modules) touched.add(m);
  if ((result.actions || []).includes('start_job')) touched.add('compiti');
  result.touched = [...touched];
  result.touchedLeaves = [...topicHits.leaves, ...recalled.entries.map(m => 'm:' + m.id)];
  kvSet(db, 'lastTouched', { at: nowIso + '#' + ms, touched: result.touched, leaves: result.touchedLeaves });
  memory.markUsed(db, recalled.entries.map(m => m.id), nowIso);
  memory.noteUse(db, result.touched, ms);

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
