// Il "cervello": mette insieme contesto, router dei modelli, memoria e azioni.

import * as phone from './phone.js';
import * as flows from './flows.js';
import * as agents from './agents.js';
import * as devices from './devices.js';
import * as jarvisCore from './jarvis_core.js';
import * as workspace from './workspace.js';
import * as projects from './projects.js';
import * as initiative from './initiative.js';
import * as lessons from './lessons.js';
import * as semantic from './semantic.js';
import * as continuity from './continuity.js';
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
import * as cooking from './cooking.js';
import * as mood from './mood.js';
import { today as todayOf, nowIso as nowIsoOf, nowHuman } from './clock.js';
import { logEvent, kvSet, kvGet } from './db.js';

const STICKY_TURNS = 5;
// Richieste di cambiare cosa mostra l'app: solo allora il modello riceve le istruzioni per personalizzarla.
// Richieste di cambiare come lavora Kestra (codice del server) o di annullare una modifica già online.
const CODE_WORDS = /(codice|server|comportament|ragion|impara a|migliora(?:ti)?\b|te stess|cambia(?:re)? come|annulla (?:l'ultima |la )?modific|torna come prima|hai rotto|test)/i;
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
    if (!/^(https:\/\/|\/api\/devices\/screen)/i.test(String(a.url || ''))) return null;
    v.url = String(a.url).slice(0, 500);
  }
  return v;
}

/** Frasi con cui il modello dichiara di aver salvato o cambiato qualcosa. */
const ACTION_ASK = /\b(aggiungi|segna|segnami|registra|ricordami|ricorda|salva|crea|creami|apri|aprimi|prepara|preparami|organizza|cancella|elimina|togli|sposta|imposta|programma|clicca|seleziona|collegati|configura)\b/i;

export const CLAIM_WORDS = /\b(ho|l'ho|li ho|le ho|te l'ho|gliel'ho)\s+(appena\s+|già\s+|subito\s+|anche\s+)?(registrat|aggiunt|aggiornat|salvat|segnat|impostat|annotat|memorizzat|eliminat|cancellat|inserit|creat|modificat|spostat|tolt|rimoss|chius|apert)|\b(chiudo|apro|avvio|cerco|eseguo|seleziono)\s+(?:subito|ora|adesso|immediatamente)\b|\b(apro|avvio|clicco|forzo|lancio|configuro|premo|faccio partire)\b|\bci penso io\b[^!?]{0,40}\b(apr|cerc|avvi|lanci|mett|clicc|prepar|configur)|\b(promemoria|piano|diario|pasto|peso|allenamento|dispensa|ricetta)\s+(è stat[oa]\s+)?(impostat|aggiornat|registrat|salvat|creat|aggiunt)[oa]\b|^\W*(fatto|registrato|aggiornato|salvato|segnato|annotato)\b/i;
const FAIL_LABELS = { show: 'mostrare la grafica', web_search: 'cercare su internet', read_url: 'leggere la pagina', add_meal: 'registrare il pasto (mancano gli alimenti)', update_meal: 'modificare il pasto (non l\'ho trovato)', delete_meal: 'eliminare il pasto (non l\'ho trovato)', add_weight: 'registrare il peso', add_activity: 'registrare l\'allenamento', add_reminder: 'creare il promemoria (data non valida)', remember: 'salvare il ricordo', call: 'avviare la chiamata (manca il nome)', update_profile: 'aggiornare il profilo', delete_activity: 'eliminare l\'attività (non l\'ho trovata)' };
const failLabel = (t) => FAIL_LABELS[t] || `completare l'operazione "${t}"`;
const REPAIR_PROMPT = (failed) => `CONTROLLO AUTOMATICO: nella tua risposta ${failed.length ? `queste azioni non erano valide e NON sono state eseguite: ${failed.join(', ')}` : 'dichiari di aver fatto qualcosa ma il campo "actions" è vuoto o incompleto'}. Finora NON è stato salvato nulla. Rimanda SOLO il JSON completo, con in "actions" tutte le azioni corrette e complete (per un pasto: items con name, grams, kcal, protein, carbs, fat; per update/delete: l'id esatto preso dal contesto). Se davvero non c'è nulla da salvare, lascia "actions" vuoto e scrivi una reply che NON dica di aver salvato o fatto qualcosa.`;

/** Il modello rimanda a dopo ("in background", "ti avviso appena pronto", "sto elaborando"). */
export const LATER_RE = /\b(in\s+background|ti\s+avviser[oò]|la\s+avviser[oò]|vi\s+avviser[oò]|appena\s+(?:sar[aà]\s+|è\s+)?pront[oa]|sto\s+(?:elaborando|preparando|completando|lavorando|analizzando)|avvio\s+(?:subito\s+)?(?:la|il|l')\s*(?:preparazione|creazione|elaborazione|raccolta|modifica|lavoro|analisi)|(?:le|ti|vi)\s+riporter[oò]|un\s+istante\s+e)\b/i;
const LATER_SENTENCE_RE = /[^.!?]*\b(in\s+background|ti\s+avviser[oò]|la\s+avviser[oò]|appena\s+(?:sar[aà]\s+)?pront[oa]|avvio\s+(?:subito\s+)?(?:la|il|l')\s*modifica)\b[^.!?]*[.!?]?/gi;
/** Richieste di cambiare l'app stessa (nuove funzioni, interfaccia): senza Jarvis programmatore non si possono promettere. */
const FEATURE_RE = /\b(riprogramm\w*|implement\w*|modific\w*\s+(?:al\s+)?codice|codice\s+dell'app|nuova\s+funzion\w*|aggiung\w*\s+(?:una\s+)?funzion\w*|convertitore|interfaccia|pannello|pulsante)\b/i;
const NOW_PROMPT = 'CONTROLLO AUTOMATICO: hai l\'immagine o il file davanti adesso. Non rimandare e non dire che lo farai in background: fai subito l\'analisi richiesta e metti in "actions" le azioni che servono (es. add_pantry_item per ogni prodotto). Rimanda SOLO il JSON completo.';

/** Annota una miglioria chiesta dall'utente che Kestra non sa ancora fare (lista visibile in Mente). */
export function noteImprovement(db, text, nowIso) {
  const list = kvGet(db, 'improvementRequests', []);
  const t = String(text || '').trim().slice(0, 300);
  if (!t || list.some(x => x.text === t)) return;
  kvSet(db, 'improvementRequests', [...list.slice(-49), { at: nowIso, text: t }]);
}

/** Toglie i tic verbali ("Certamente, signore." a inizio di ogni risposta) e usa "Capo" come vuole la personalità. */
const PROJECT_EXIT_RE = /^\W*(?:(?:ok|kestra|chestra)\s+)?(?:esci\s+dal\s+(?:progetto|workspace)|chiudi\s+(?:il\s+)?(?:progetto|workspace)|torna\s+(?:a\s+(?:kestra|jarvis)\s+)?(?:normale|standard))\W*$/i;
const PROJECT_NEWCHAT_RE = /^\W*(?:(?:apri|inizia|fai|crea)\s+(?:una\s+)?)?nuova\s+chat\b(?:\s+(?:nel|del)\s+progetto)?\W*$/i;
export const PROJECT_OPEN_RE = /^\W*(?:(?:ok|ehi|kestra|chestra)\s+)?(apri|entra\s+nel|vai\s+(?:nel|al)|riprendi|torna\s+(?:nel|al)|crea|fai|nuovo|apri\s+un\s+nuovo)\s+(?:il\s+|un\s+)?(?:nuovo\s+)?progetto\s+(?:chiamato\s+|di\s+nome\s+|sul(?:l[ao'])?\s+|di\s+|per\s+)?["“]?(.{2,60}?)["”]?\W*$/i;

/** Cosa è entrato nel contesto dell'ultima risposta (vista Mente): sezioni, token, ricordi, file del progetto. */
export function saveContextReport(db, report) {
  kvSet(db, 'contextReport', report);
  const hist = kvGet(db, 'contextReports', []);
  kvSet(db, 'contextReports', [...hist.slice(-9), { at: report.at, session: report.session, model: report.model, used: report.used, budget: report.budget, sections: (report.sections || []).length }]);
}

export function tidyReply(text) {
  let s = String(text || '').trim()
    // Intestazioni copiate da vecchi prompt di progetto ("Verifica passphrase: niente più fili [OK]").
    .replace(/^\W*(?:verifica\s+)?passphrase\b[^\n]*?(?:\[ok\]|\n|$)/i, '')
    .trim();
  const stripped = s.replace(/^(?:certamente|certo|sicuro)[,!.]?\s*(?:signore|capo)?\s*[,!.]\s+(?=\S)/i, '');
  if (stripped.length >= 3) s = stripped;
  s = s.replace(/\bsignore\b/g, 'Capo').replace(/\bSignore\b/g, 'Capo');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** App installate sul telefono (le manda l'app Android), così un nome storpiato diventa l'app vera. */
export function appsPrompt(db) {
  const apps = kvGet(db, 'apps', []);
  if (!apps.length) return '';
  return 'APP INSTALLATE SUL TELEFONO (usa sempre questi nomi esatti; un nome detto uguale o quasi a una di queste app è quella app; se l\'utente storpia un nome o il riconoscimento vocale lo sbaglia, scegli l\'app installata più simile per suono o per contesto, es. per la musica l\'app di musica che c\'è in questo elenco): ' + apps.join(', ').slice(0, 3500);
}

/** Applica le azioni restituite dal modello. Ritorna { photoRequest, jobs, applied, rememberedIds }. */
export function applyActions(db, actions, ctx) {
  const out = { photoRequest: null, jobs: [], applied: [], device: [], code: [], failed: [], rememberedIds: [] };
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
      } else if (a.type === 'remember') {
        const memId = ctx.project && projects.isProjectMemory(ctx.project, a.module)
          ? projects.remember(db, ctx.project.id, a.text, ctx.nowIso)
          : memory.remember(db, a, ctx.nowIso);
        if (!memId) { out.failed.push(a.type); continue; }
        out.rememberedIds.push(memId);
      }
      else if (a.type === 'forget') memory.forget(db, a.id);
      else if (a.type === 'learn') { if (!lessons.learn(db, a.rule || a.text, ctx.nowIso)) { out.failed.push(a.type); continue; } }
      else if (a.type === 'clean_graph') agents.GraphAgent.cleanBranch(db, a.branch || 'all', a.max_nodes);
      else if (a.type === 'add_reminder') { if (!agenda.addReminder(db, a, ctx.ms, ctx.tz)) { out.failed.push(a.type); continue; } }
      else if (a.type === 'done_reminder') agenda.doneReminder(db, a.id);
      else if (coder.CODE_ACTIONS.has(a.type)) out.code.push({ type: a.type, id: String(a.id || ''), request: String(a.request || '').trim().slice(0, 2000) });
      else if (ui.UI_ACTIONS.has(a.type)) { if (!ui.applyUiAction(db, a, ctx.nowIso)) { out.failed.push(a.type); continue; } out.ui = true; }
      else if (a.type === 'start_job') { if (String(a.goal || '').trim()) out.jobs.push({ title: String(a.title || 'Compito').slice(0, 80), goal: String(a.goal).slice(0, 2000) }); }
      else if (cooking.COOKING_ACTIONS.has(a.type)) { if (!cooking.apply(db, a, ctx.ms)) { out.failed.push(a.type); continue; } }
      else if (a.type === 'live_card') { if (!jarvisCore.applyLiveCard(db, a, ctx.ms)) { out.failed.push(a.type); continue; } }
      else if (a.type === 'pc_action') {
        const target = String(a.target || a.name || a.url || '').trim();
        if (!target) { out.failed.push(a.type); continue; }
        devices.enqueueCommand(db, a.device || 'desktop', { kind: a.kind || 'open_app', target, args: a.args || '' }, ctx.ms);
      }
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
        // Ignora phone_task generati per errore quando la richiesta riguarda funzioni interne di Jarvis (grafo, dieta, memoria).
        const goal = String(a.goal || '').trim().slice(0, 1000);
        if (!goal || (phone.INTERNAL_JARVIS_WORDS.test(goal) && !phone.isPhoneTarget(db, goal))) continue;
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
export async function handleChat(db, env, deps, { text, image = null, files = [], sessionId = 'main', source = 'app', followup = false }) {
  const ms = deps.now();
  const tz = deps.tz;
  const today = todayOf(ms, tz);
  const nowIso = nowIsoOf(ms, tz);
  const fileList = Array.isArray(files) ? files.filter(f => f && f.name && typeof f.content === 'string') : [];
  const rawText = String(text || '').trim().slice(0, 4000);
  const userText = rawText || (image ? 'Guarda questa foto.' : (fileList.length ? `Analizza ${fileList.length === 1 ? 'questo file' : 'questi file'}: ${fileList.map(f => f.name).join(', ')}` : ''));
  if (!userText) return { reply: 'Non ho sentito nulla, Capo.', expectReply: true, card: '', photoRequest: null };

  // Conversazione aperta: frase sentita senza "Kestra". Se è la TV, la radio o qualcuno che parla con altri, silenzio.
  if (followup && !image && !fileList.length) {
    const addressed = await isFollowupAddressed(db, env, deps, userText, sessionId);
    if (!addressed) {
      const heard = kvGet(db, 'ignoredHeard', []);
      kvSet(db, 'ignoredHeard', [...heard.slice(-19), { at: nowIso, text: userText.slice(0, 200) }]);
      return { reply: '', ignored: true, expectReply: false, card: '', photoRequest: null, actions: [], device: [], touched: [], touchedLeaves: [] };
    }
  }

  // Automatismo proposto al comando precedente: si salva da solo se l'utente non si lamenta (niente "Ha funzionato?").
  flows.implicitSkillFeedback(db, sessionId, userText, ms);

  // Progetti (come i progetti di Claude): entrata, uscita, nuova chat, creazione a voce o da file.
  projects.migrateWorkspaces(db, nowIso, ms);
  let proj = sessionId === 'main' ? projects.getActive(db) : null;
  if (!proj && sessionId !== 'main') {
    const c = projects.chatBySession(db, sessionId);
    if (c) proj = { project: projects.getProject(db, c.project), chat: c };
  }
  const local = (reply, extra = {}) => {
    if (reply) { addMessage(db, proj?.chat.session || 'main', 'user', userText, nowIso, null); addMessage(db, proj?.chat.session || 'main', 'assistant', reply, nowIso, { model: 'jarvis-core' }); }
    return { reply, expectReply: false, card: '', visual: null, photoRequest: null, model: 'jarvis-core', switched: false, actions: [], device: [], layoutChanged: true, touched: ['progetti'], touchedLeaves: [], ...extra };
  };
  if (proj && PROJECT_EXIT_RE.test(userText)) {
    projects.exitProject(db);
    return local(`Sono uscita dal progetto "${proj.project.name}", Capo.`, { actions: ['project_exit'] });
  }
  if (proj && PROJECT_NEWCHAT_RE.test(userText)) {
    proj = projects.enterProject(db, proj.project.id, { newChat: true }, nowIso, ms);
    return local(`Nuova chat nel progetto "${proj.project.name}". Dimmi pure.`, { expectReply: true, actions: ['project_chat'] });
  }
  const openAsk = PROJECT_OPEN_RE.exec(userText);
  if (openAsk && !fileList.length) {
    const found = projects.findByName(db, openAsk[2]);
    if (found) {
      proj = projects.enterProject(db, found.id, {}, nowIso, ms);
      return local(`Siamo nel progetto "${found.name}".`, { expectReply: true, actions: ['project_enter'] });
    }
    if (/^(?:crea|nuovo|fai|apri\s+un\s+nuovo)/i.test(openAsk[1])) {
      const pid = projects.createProject(db, { name: openAsk[2].replace(/[.!?]+$/, '') }, nowIso, ms);
      proj = projects.enterProject(db, pid, {}, nowIso, ms);
      return local(`Ho creato il progetto "${proj.project.name}" e ci sono dentro. Dimmi le istruzioni, oppure carica i file dalla scheda Progetti.`, { expectReply: true, actions: ['project_create'] });
    }
    const names = db.all('SELECT name FROM projects ORDER BY updated DESC LIMIT 6').map(r => r.name);
    if (names.length) return local(`Non trovo quel progetto. Ho: ${names.join(', ')}.`, { expectReply: true });
  }
  if (/\b(?:attiva\s+(?:modalit[aà]\s+)?(?:progetto|workspace)|adattati\s+a\s+quest[oa]|usa(?:lo)?\s+come\s+(?:progetto|workspace|contesto\s+progetto)|apri\s+(?:un\s+)?workspace)\b/i.test(userText)) {
    const pdfB64 = fileList.find(f => f.encoding === 'base64' && /\.pdf$/i.test(f.name))?.content || null;
    const textJoined = fileList.filter(f => f.encoding !== 'base64').map(f => `=== ${f.name} ===\n${f.content}`).join('\n\n');
    const ws = await workspace.enterWorkspace(db, env, deps.fetchFn, {
      contextText: [userText, textJoined].filter(Boolean).join('\n\n'),
      pdfBase64: pdfB64,
      nowMs: ms,
      tz,
    });
    return local(`Ho creato il progetto "${ws.title}" con le sue istruzioni e il materiale tra i file. Per uscire di' "esci dal progetto".`, { actions: ['project_create'] });
  }
  if (/^\W*(?:(?:kestra|chestra)\W+)?riprova\s+(?:il\s+|l['’]\s*ultimo\s+)?compito\W*$/i.test(userText)) {
    const j = db.get("SELECT id, title FROM jobs WHERE status = 'failed' ORDER BY updated DESC LIMIT 1");
    if (!j) return local('Non ci sono compiti falliti da riprovare.');
    db.run("UPDATE jobs SET status = 'planning', steps = '[]', result = '', updated = ? WHERE id = ?", nowIso, j.id);
    deps.schedule?.(ms + 500);
    return local(`Riprovo "${j.title}". Ti avviso a lavoro finito.`, { actions: ['job_retry'], touched: ['compiti'] });
  }
  if (proj) sessionId = proj.chat.session;

  // Se l'utente chiede di ridurre, sistemare o pulire il grafo (es. "il grafo della dieta è troppo grande, riducilo"),
  // l'agente locale GraphAgent lo compatta subito, così l'operazione avviene davvero anche se il modello non emette clean_graph.
  const cleanCmd = agents.GraphAgent.detectCleanCommand(userText);
  if (cleanCmd) agents.GraphAgent.cleanBranch(db, cleanCmd.branch, cleanCmd.maxNodes);

  // 0. Auto-interrogazione autonoma a zero crediti (salvaguardia modelli, sorveglianza dispositivi, pulizia grafo).
  jarvisCore.selfInterrogate(db, env, ms, tz);

  // 1. JARVIS CORE (IA proprietaria interna): gestisce direttamente controllo multi-dispositivo (PC/Telefono), Antigravity, timer e diagnostica.
  // In cucina con le mani occupate: "avanti", "indietro", "ripeti" scorrono i passaggi senza chiamare un modello.
  const cookStep = (!image && !fileList.length) ? cooking.voiceStep(db, userText, ms) : null;
  const coreHit = cookStep
    ? { reply: cookStep, expectReply: true, actions: ['recipe_step'], device: [], touched: ['cucina'], touchedLeaves: [] }
    : (!image && !fileList.length) ? jarvisCore.handleCoreIntent(db, userText, ms, env, sessionId, tz) : null;
  if (coreHit) {
    if (coreHit.scheduleAt) deps.schedule?.(coreHit.scheduleAt);
    if (coreHit.reply) {
      addMessage(db, sessionId, 'user', userText, nowIso, null);
      addMessage(db, sessionId, 'assistant', coreHit.reply, nowIso, { model: 'jarvis-core', visual: coreHit.visual || undefined });
      jarvisCore.maybeLogLatentIssue(db, sessionId, userText, ms, tz);
    }
    if (coreHit.touched?.length) {
      kvSet(db, 'lastTouched', { at: nowIso + '#' + ms, touched: coreHit.touched, leaves: coreHit.touchedLeaves });
      memory.noteUse(db, coreHit.touched, ms);
    }
    if (coreHit.reply) continuity.record(db, { ms, tz, sessionId, userText, reply: coreHit.reply, applied: coreHit.actions || [], device: coreHit.device || [], touched: coreHit.touched || [], expectReply: !!coreHit.expectReply });
    return {
      reply: coreHit.reply, expectReply: !!coreHit.expectReply, card: '', visual: coreHit.visual || null, photoRequest: null,
      model: 'jarvis-core', switched: false, actions: coreHit.actions, device: coreHit.device,
      tier: 'local', layoutChanged: false, touched: coreHit.touched, touchedLeaves: coreHit.touchedLeaves,
    };
  }

  // 2. Gatekeeper procedurale locale: attività già fatte sul telefono vanno in automatico, zero modelli esterni.
  const localHit = flows.gatekeepChat(db, userText, { hasImage: !!image || fileList.length > 0, hasPendingPhone: !!phone.pendingContext(db, ms) });
  if (localHit) {
    addMessage(db, sessionId, 'user', userText, nowIso, image ? { image: true } : null);
    addMessage(db, sessionId, 'assistant', localHit.reply, nowIso, { model: 'local-gatekeeper' });
    jarvisCore.maybeLogLatentIssue(db, sessionId, userText, ms, tz);
    if (localHit.device.some(d => d.type === 'phone_task')) kvSet(db, 'phonePending', null);
    const { touched, touchedLeaves } = agents.onLocalHit(db, userText, localHit, nowIso, ms);
    continuity.record(db, { ms, tz, sessionId, userText, reply: localHit.reply, applied: localHit.actions || [], device: localHit.device || [], touched: touched || [] });
    return {
      reply: localHit.reply, expectReply: false, card: '', visual: null, photoRequest: null,
      model: 'local-gatekeeper', switched: false, actions: localHit.actions, device: localHit.device,
      tier: 'local', layoutChanged: false, touched, touchedLeaves,
    };
  }

  const sess = session(db, sessionId);
  const diary = loadDiary(db);

  // Moduli attivi: richiamati dal testo oppure ancora "caldi" dai turni precedenti.
  const sticky = Object.entries(sess.modules).filter(([, ttl]) => ttl > 0).map(([k]) => k);
  const recentMsgs = db.all('SELECT text FROM messages WHERE session = ? ORDER BY id DESC LIMIT 4', sessionId).map(r => r.text.slice(0, 250)).join(' ');
  const probe = userText + ' ' + recentMsgs;
  const dietOn = !!image || DIET_KEYWORDS.test(probe) || sticky.includes('dieta') || !!diary.activeRecipeSession || !!diary.pendingPhotoRequest;
  const agendaOn = AGENDA_KEYWORDS.test(probe) || sticky.includes('agenda');
  // Impronta di significato del messaggio (Gemini, ~0,1 s, tetto 1,5 s): se manca si usa solo la ricerca per parole.
  const qvec = await semantic.embedQuery(env, deps.fetchFn, userText).catch(() => null);
  const recalled = memory.recall(db, probe, { sticky, qvec });

  const history = db.all('SELECT role, text FROM messages WHERE session = ? AND id > ? ORDER BY id DESC LIMIT 14', sessionId, sess.summarized_upto).reverse();
  const mods = memory.listModules(db);
  const textFiles = fileList.filter(f => f.encoding !== 'base64');
  let pdfBase64 = fileList.find(f => f.encoding === 'base64' && /\.pdf$/i.test(f.name))?.content || null;
  let pdfExtractedText = '';
  if (pdfBase64) {
    const extracted = await router.readPdfWithGemini(env, deps.fetchFn, pdfBase64, `Estrai fedelmente tutto il testo contenuto in questo PDF (${userText}).`);
    if (extracted) {
      pdfExtractedText = extracted.slice(0, 32000);
      pdfBase64 = null; // testo estratto: ora può leggerlo qualsiasi modello!
    }
  }
  const projCtx = proj ? projects.projectContext(db, proj, probe) : null;
  const activeFocus = jarvisCore.getFocus(db, sessionId, ms);
  const navActive = jarvisCore.getNavMode(db, sessionId, ms);
  const focusLine = jarvisCore.focusPromptLine(db, sessionId, ms);
  const parts = {
    core: CORE_PROMPT(diary.profile.name, nowHuman(ms, tz)) + '\n\n' + mood.MOOD_PROMPT(mood.current(db, ms)) + (projCtx ? '\n\n' + projCtx.header : ''),
    brief: projCtx && !dietOn ? '' : dietBrief(diary, today),
    rules: [focusLine, cooking.contextLine(db), dietOn ? DIET_RULES : '', UI_WORDS.test(userText) ? ui.uiPrompt(ui.loadLayout(db)) : '', (UI_WORDS.test(userText) || CODE_WORDS.test(userText)) ? coder.codePrompt(env, db) : '', DEVICE_WORDS.test(userText) ? appsPrompt(db) : '', lessons.contextBlock(db, probe), initiative.NOTIF_WORDS.test(userText) ? initiative.notificationsContext(db) : '', (/\b(pc|computer|desktop|windows|dispositiv\w*)\b/i.test(userText) || activeFocus?.device === 'pc' || navActive) ? devices.devicesPrompt(db, ms) : '', phone.pendingContext(db, ms)].filter(Boolean).join('\n\n'),
    blocks: [...(dietOn ? dietContext(diary, today) : []), ...(projCtx ? projCtx.blocks : [])],
    memories: recalled.entries.slice(0, projCtx ? 8 : 24).map(m => `- [${m.id}] (${m.module}) ${m.text}`),
    moduleIndex: [mods.length ? 'MODULI DI MEMORIA ESISTENTI: ' + mods.map(m => `${m.name}${m.description ? ` (${m.description})` : ''} [${m.entries}]`).join('; ') : '',
      memory.topicsIndex(db, mods.map(m => m.name).slice(0, 30))].filter(Boolean).join('\n').slice(0, 2500),
    agenda: agendaOn ? agenda.agendaContext(db, tz) : '',
    weather: WEATHER_WORDS.test(userText) ? await weatherContext(db, deps.fetchFn, userText) : '',
    // Domande su fatti recenti: la ricerca parte subito, senza aspettare che il modello la chieda.
    web: web.WEB_WORDS.test(userText) && !WEATHER_WORDS.test(userText) ? web.webBlock(userText, await web.search(env, deps.fetchFn, userText, today)) : '',
    summary: sess.summary,
    continuity: continuity.block(db, { ms, tz, sessionId, userText }),
    history,
    userText: `[${nowHuman(ms, tz)}${source === 'voice' ? ', a voce' : ''}] ${userText}` +
      (textFiles.length ? '\n\nFILE ALLEGATI DALL\'UTENTE:\n' + textFiles.map(f => `=== FILE: ${f.name} ===\n${f.content.slice(0, 24000)}`).join('\n\n') : '') +
      (pdfExtractedText ? `\n\nCONTENUTO ESTRATTO DAL PDF:\n${pdfExtractedText}` : ''),
    image,
    pdfBase64,
    report: {},
  };

  const storedUserText = fileList.length ? `[📎 ${fileList.map(f => f.name).join(', ')}] ${userText}` : userText;
  addMessage(db, sessionId, 'user', storedUserText, nowIso, image ? { image: true } : null);
  if (proj) projects.touchChat(db, sessionId, userText, nowIso);

  let result;
  let remembered = [];
  let topicHits = { modules: [], leaves: [] };
  const tier = router.classifyTier(userText, !!image || !!pdfBase64);
  // Richiesta che chiede di FARE qualcosa (PC, telefono, diario, agenda, sessioni): niente modelli lite,
  // che rispondono "ci penso io" senza mettere l'azione nel JSON.
  const needsActions = ACTION_ASK.test(userText) || phone.DOING_WORDS.test(userText) || jarvisCore.isPcTarget(db, userText);
  try {
    let res = await router.chat(db, env, {
      tier, needsVision: !!image || !!pdfBase64, preferKey: sess.model, needsActions, maxTokens: 2000,
      build: (model) => buildMessages(model, parts), fetchFn: deps.fetchFn, now: deps.now, tz,
    });
    let parsed = parseReply(res.text);
    saveContextReport(db, { at: nowIso, session: sessionId, tier, project: projCtx?.report || null, recalled: recalled.entries.length, ...parts.report });
    // Il modello chiede di cercare su internet o leggere una pagina: lo facciamo e gli ridiamo la parola.
    // Oppure chiede un cassetto di memoria che non è entrato nel contesto: glielo diamo e rispondiamo di nuovo.
    const webAsk = parsed.actions.filter(a => a.type === 'web_search' || a.type === 'read_url').slice(0, 2);
    const memAsk = parsed.actions.filter(a => a.type === 'recall').slice(0, 3);
    if (webAsk.length || memAsk.length) {
      const found = [];
      for (const a of webAsk) {
        const q = a.type === 'read_url' ? String(a.url || '') : String(a.query || userText);
        found.push(web.webBlock(q, a.type === 'read_url' ? await web.readUrl(deps.fetchFn, q) : await web.search(env, deps.fetchFn, q, today)));
      }
      parts.web = [parts.web, ...found].filter(Boolean).join('\n\n');
      if (memAsk.length) {
        const have = new Set(parts.memories);
        const extra = memAsk.flatMap(a => memory.recallFor(db, { module: a.module, query: a.query || '' }, 15))
          .map(m => `- [${m.id}] (${m.module}) ${m.text}`).filter(l => !have.has(l));
        parts.memories = [...extra, ...parts.memories];
        if (!extra.length) parts.rules = [parts.rules, 'MEMORIA: il cassetto richiesto è vuoto o non esiste; rispondi con quello che sai senza inventare.'].filter(Boolean).join('\n\n');
      }
      try {
        res = await router.chat(db, env, {
          tier, needsVision: !!image, preferKey: res.key, maxTokens: 2000,
          build: (model) => buildMessages(model, parts), fetchFn: deps.fetchFn, now: deps.now, tz,
        });
        parsed = parseReply(res.text);
      } catch { parsed = { ...parsed, reply: 'Ho cercato, ma non riesco a elaborare i risultati in questo momento, signore.', actions: [] }; }
      parsed.actions = parsed.actions.filter(a => a.type !== 'web_search' && a.type !== 'read_url' && a.type !== 'recall');
    }
    if (!parsed.actions.some(a => a && a.type === 'remember')) {
      const explicitMem = agents.MemoryAgent.extractExplicit(userText);
      if (explicitMem) parsed.actions.push({ type: 'remember', module: explicitMem.module, text: explicitMem.text });
    }
    let done = applyActions(db, parsed.actions, { today, nowIso, ms, tz, hadPhoto: !!image, project: proj?.project || null });
    // Correzione del Capo senza una regola dal modello: si impara comunque dallo scambio.
    if (lessons.CORRECTION_RE.test(userText) && !parsed.actions.some(a => a?.type === 'learn')) {
      const lastA = [...history].reverse().find(h => h.role === 'assistant');
      const lastU = [...history].reverse().find(h => h.role === 'user');
      // "No" in risposta a una domanda di Kestra è una risposta, non una correzione.
      const answeredNo = lastA && /\?\s*$/.test(lastA.text) && /^\W*no\b/i.test(userText);
      if (lastA && !answeredNo && userText.split(/\s+/).length >= 4) lessons.learnFromCorrection(db, { previousUser: lastU?.text, previousReply: lastA.text, correction: userText }, nowIso);
    }
    if (cleanCmd && !done.applied.includes('clean_graph')) done.applied.push('clean_graph');
    // Promesse di lavoro "più tardi" ("lo preparo in background, ti avviso") senza nulla che parta davvero.
    if (LATER_RE.test(parsed.reply) && !done.jobs.length && !done.code.length && !done.device.length) {
      if (image || fileList.length) {
        // Ha già foto o file davanti: deve rispondere adesso, non rimandare.
        try {
          const again = await router.chat(db, env, {
            tier, needsVision: !!image || !!pdfBase64, maxTokens: 2000, fetchFn: deps.fetchFn, now: deps.now, tz,
            build: (model) => [...buildMessages(model, parts), { role: 'assistant', content: res.text.slice(0, 3000) }, { role: 'user', content: NOW_PROMPT }],
          });
          const fixed = parseReply(again.text);
          if (fixed.parsed && !LATER_RE.test(fixed.reply)) {
            const redo = applyActions(db, fixed.actions, { today, nowIso, ms, tz, hadPhoto: !!image, project: proj?.project || null });
            parsed = { ...fixed, topics: fixed.topics?.length ? fixed.topics : parsed.topics };
            done = redo;
          }
        } catch { /* resta la risposta, ma onesta qui sotto */ }
        if (LATER_RE.test(parsed.reply)) parsed = { ...parsed, reply: 'Non sono riuscita a finire l\'analisi adesso, Capo. Riprova a mandarmelo tra un attimo.' };
      } else if (FEATURE_RE.test(userText + ' ' + parsed.reply)) {
        // Una funzione nuova dell'app: niente promessa, la segna tra le migliorie richieste (visibili in Mente).
        noteImprovement(db, userText, nowIso);
        done.applied.push('note_improvement');
        parsed = { ...parsed, reply: `${parsed.reply.replace(LATER_SENTENCE_RE, '').trim()} Per ora non posso farlo da sola: l'ho segnato tra le migliorie richieste.`.trim() };
      } else {
        // Lavoro lungo: parte un compito vero in background, così l'avviso a fine lavoro arriva davvero.
        const recent = history.slice(-4).map(h => `${h.role === 'user' ? 'Utente' : 'Kestra'}: ${h.text}`).join('\n');
        done.jobs.push({ title: userText.slice(0, 60), goal: `${userText}\n\nContesto recente:\n${recent}`.slice(0, 2000) });
        done.applied.push('start_job');
      }
    }
    // Dice di averlo fatto ma nessuna azione è andata a buon fine: una seconda richiesta per avere le azioni vere.
    const nothing = (d, t = []) => !d.applied.length && !d.device.length && !d.jobs.length && !d.code.length && !(t && t.length);
    // Le richieste da eseguire sul telefono (chiamate, app) hanno la loro rete di sicurezza più sotto.
    const deviceAsk = !!phone.calleeOf(userText) || (phone.DOING_WORDS.test(userText) && phone.isPhoneTarget(db, userText));
    if (nothing(done, parsed.topics) && (done.failed.length || parsed.truncated || (CLAIM_WORDS.test(parsed.reply) && !deviceAsk))) {
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
      if (redo && (!nothing(redo, fixed.topics) || !CLAIM_WORDS.test(fixed.reply))) {
        parsed = { ...fixed, topics: fixed.topics?.length ? fixed.topics : parsed.topics };
        done = redo;
      }
      else {
        parsed = { ...parsed, reply: 'Mi scusi signore, non sono riuscito a salvarlo davvero. Me lo può ripetere con i dettagli?', expectReply: true, card: '', actions: [] };
        mood.feel(db, 'confusione', 0.3, ms);
      }
    } else if (done.failed.length) {
      // Alcune azioni sono riuscite e altre no: lo dice chiaramente invece di far finta.
      parsed = { ...parsed, reply: `${parsed.reply} Attenzione però: non sono riuscito a ${[...new Set(done.failed)].map(failLabel).join(' e a ')}.` };
      logEvent(db, nowIso, 'error', `azioni non riuscite: ${done.failed.join(', ')}`);
    }
    remembered = parsed.actions.filter(a => a && a.type === 'remember').map(a => memory.slug(a.module) || 'generale');
    const fallbackTopics = (!cleanCmd && (!parsed.topics || !parsed.topics.length) && !remembered.length && !recalled.active.length && !dietOn && !agendaOn)
      ? agents.GraphAgent.inferFallbackTopics(db, userText)
      : [];
    const mergedTopics = cleanCmd ? [] : [...(parsed.topics || []), ...fallbackTopics].slice(0, 4);
    topicHits = cleanCmd ? { modules: cleanCmd.branch !== 'all' ? [cleanCmd.branch] : [], leaves: [] } : memory.touchTopics(db, mergedTopics, nowIso);
    // Aggiorna la sotto-cartella di contesto attivo per mantenere coerenza tra turni senza appesantire il prompt.
    const pcAct = parsed.actions.find(a => a?.type === 'pc_action');
    const devAct = done.device?.[0];
    if (pcAct) {
      const tgt = String(pcAct.target || pcAct.name || pcAct.url || '').trim();
      jarvisCore.setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: tgt, action: String(pcAct.kind || 'azione') }, ms);
      const svc = tgt.replace(/^https?:\/\/(?:www\.)?/i, '').split(/[./\s]/)[0].toLowerCase();
      if (svc.length >= 3 && !flows.findMatchingSkill(db, userText, 'pc')) {
        const proposed = flows.proposeSkill(db, sessionId, {
          name: `${svc} su PC`,
          userText,
          service: svc,
          device: 'pc',
          defaults: { account: activeFocus?.profile || 'alexx cast' },
          steps: [{ kind: String(pcAct.kind || 'open_app'), target: tgt, args: pcAct.args || '', optional: false }, { kind: 'dynamic_media', param: 'media', optional: true }],
        }, ms);
        void proposed; // si conferma da solo al messaggio successivo (flows.implicitSkillFeedback)
      }
    } else if (devAct) {
      const tgt = String(devAct.name || devAct.url || devAct.goal || '').slice(0, 50);
      jarvisCore.setFocus(db, sessionId, { domain: 'dispositivo', device: 'telefono', target: tgt, action: devAct.type }, ms);
      const svc = tgt.replace(/^https?:\/\/(?:www\.)?/i, '').split(/[./\s]/)[0].toLowerCase();
      if (svc.length >= 3 && (devAct.type === 'open_app' || devAct.type === 'open_url') && !flows.findMatchingSkill(db, userText, 'telefono')) {
        const proposed = flows.proposeSkill(db, sessionId, {
          name: `${svc} su Telefono`,
          userText,
          service: svc,
          device: 'telefono',
          steps: [{ kind: devAct.type, target: devAct.url || devAct.name, optional: false }],
        }, ms);
        void proposed;
      }
    } else if (done.jobs?.length) {
      jarvisCore.setFocus(db, sessionId, { domain: 'progetti', device: null, target: done.jobs[0].title, action: 'progetto' }, ms);
    } else if (parsed.actions.some(a => DIET_ACTIONS.has(a?.type))) {
      jarvisCore.setFocus(db, sessionId, { domain: 'dieta', device: null, target: parsed.actions[0]?.meal || 'diario', action: parsed.actions[0]?.type || 'dieta' }, ms);
    } else if (parsed.actions.some(a => a?.type === 'add_reminder')) {
      jarvisCore.setFocus(db, sessionId, { domain: 'agenda', device: null, target: 'promemoria', action: 'agenda' }, ms);
    } else if (mergedTopics[0]?.topic) {
      jarvisCore.setFocus(db, sessionId, { domain: memory.slug(mergedTopics[0].area || 'generale') || 'generale', device: null, target: mergedTopics[0].topic, action: 'chat' }, ms);
    }
    if (parsed.mood) mood.feel(db, parsed.mood.emozione, parsed.mood.intensita, ms);
    // Ha promesso di farlo ma non ha messo l'azione: la aggiungiamo noi, così non resta una promessa a vuoto.
    const goal = userText.replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').slice(0, 1000);
    const callee = phone.calleeOf(userText);
    if (!done.device.length && callee && phone.PROMISE_WORDS.test(parsed.reply)) {
      // "Chiamo Marcolino" senza l'azione: la telefonata parte lo stesso.
      done.device.push({ type: 'call', name: callee });
      done.applied.push('call');
    } else if (!done.device.length && phone.DOING_WORDS.test(userText) && phone.isPhoneTarget(db, userText) && phone.PROMISE_WORDS.test(parsed.reply)) {
      done.device.push({ type: 'phone_task', goal });
      done.applied.push('phone_task');
    } else if (done.device.length && done.device.every(d => d.type === 'open_app') && phone.INSIDE_WORDS.test(userText)) {
      // Ha solo aperto l'app ma l'utente voleva fare qualcosa dentro (mandare, cercare, mettere...).
      done.device = [{ type: 'phone_task', goal: `${goal} (app: ${done.device[0].name})` }];
      done.applied.push('phone_task');
    }
    // Rete di sicurezza per il PC: se l'utente o il modello parla di fare qualcosa sul PC/Ghideon/Gideon,
    // svuota sempre le azioni sul telefono (così non parte MAI sul telefono per errore) e invia il comando al PC.
    if (jarvisCore.isPcTarget(db, userText) || jarvisCore.isPcTarget(db, parsed.reply)) {
      done.device = [];
      if (!done.applied.includes('pc_action')) {
        const primeTitleM = /\b(?:apri|apro|cerca|cerco|metti|metto)\s+(.{2,60}?)\s+(?:su|in)\s+prime(?:\s+video)?\b/i.exec(userText + ' ' + parsed.reply);
        if (primeTitleM && primeTitleM[1]) {
          devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: `https://www.primevideo.com/search/ref=atv_nb_sbox?phrase=${encodeURIComponent(primeTitleM[1].trim())}` }, ms);
          done.applied.push('pc_action');
        } else if (/\b(scorro|scorri)\b/i.test(userText + ' ' + parsed.reply)) {
          const up = /\b(su|alto)\b/i.test(userText + ' ' + parsed.reply);
          devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: up ? 'up' : 'down' }, ms);
          done.applied.push('pc_action');
        } else if (/\b(chiudi|chiudo)\s+(?:subito\s+)?(?:google\s+chrome|chrome|edge|spotify|vscode|youtube|prime(?:\s+video)?)\b/i.test(userText + ' ' + parsed.reply)) {
          const mCls = /\b(?:chiudi|chiudo)\s+(?:subito\s+)?(google\s+chrome|chrome|edge|spotify|vscode|youtube|prime(?:\s+video)?)\b/i.exec(userText + ' ' + parsed.reply);
          const clsTarget = /chrome/i.test(mCls[1]) ? 'chrome' : mCls[1];
          devices.enqueueCommand(db, 'desktop', { kind: 'close_app', target: clsTarget }, ms);
          done.applied.push('pc_action');
        } else if (/\b(video|film|youtube|musica|canzon\w*)\b/i.test(userText) && /\b(fai\s+partire|fammi\s+partire|metti|riproduci|avvia|cerca)\b/i.test(userText)) {
          if (jarvisCore.dispatchPcPlayYoutube(db, userText, ms)) done.applied.push('pc_action');
        } else {
          const mApp = /\b(?:apri|apro|avvia|avvio|eseguo\s+l'apertura\s+di)\s+(?:l'app\s+|il\s+programma\s+)?([a-z0-9]+)/i.exec(userText + ' ' + parsed.reply);
          if (mApp) {
            jarvisCore.dispatchPcOpen(db, mApp[1], ms);
            done.applied.push('pc_action');
          }
        }
      }
    }
    // Notizie o diagnostiche chieste a voce/chat: se il modello non ha già creato una grafica "show",
    // costruisce in automatico la scheda in sovraimpressione (visual overlay) con i punti principali.
    if (!done.visual && /\b(notizi\w*|news|novit[aà]|ultim'ora|giornale|cronaca|attualit[aà]|diagnostic\w*)\b/i.test(userText) && parsed.reply) {
      const bullets = parsed.reply
        .split(/(?:\.\s+|\n+|;\s+)/)
        .map(s => s.replace(/^(?:certamente|subito|ecco|signore)[,\s]*/gi, '').trim())
        .filter(s => s.length >= 12)
        .slice(0, 5)
        .map(s => ({ label: s.slice(0, 40), value: '' }));
      if (bullets.length) {
        done.visual = { kind: 'list', title: 'Notizie in Sovraimpressione', seconds: 18, items: bullets, text: parsed.reply.slice(0, 260) };
        done.device.push({ type: 'visual', data: done.visual });
        done.applied.push('show');
      }
    }
    const autoLeaves = [];
    if (done.device.some(d => d.type === 'phone_task')) {
      kvSet(db, 'phonePending', null);
      agents.FlowAgent.prune(db);
      for (const d of done.device) {
        if (d.type === 'phone_task' && d.goal) {
          kvSet(db, 'lastPhoneGoal', d.goal);
          const reg = flows.registerAutoGoal(db, d.goal, ms);
          if (reg) autoLeaves.push('f:' + reg.id);
        }
      }
    }
    if (!done.jobs.length) {
      const autoProj = jarvisCore.detectComplexProject(userText);
      if (autoProj) { done.jobs.push(autoProj); done.applied.push('start_job'); }
    }
    for (const j of done.jobs) deps.startJob?.(proj ? { ...j, project: proj.project.id } : j);
    for (const c of done.code) {
      try {
        if (!coder.enabled(env)) { done.applied.push('code_disabled'); continue; }
        if (c.type === 'code_change' && c.request) { const id = coder.propose(db, c.request, deps.now(), tz); const w = coder.work(db, env, deps, id); if (deps.defer) deps.defer(w); else await w; }
        else if (c.type === 'code_approve') await coder.approve(db, env, deps, c.id);
        else if (c.type === 'code_discard') await coder.discard(db, env, deps, c.id);
        else if (c.type === 'code_revert') await coder.revert(db, env, deps, c.id);
        done.applied.push(c.type);
      } catch (e) { logEvent(db, nowIso, 'error', `${c.type}: ${e.message}`); }
    }
    const keepListening = !!(navActive || done.applied.includes('pc_action') || done.device.some(d => d.type === 'phone_task' || d.type === 'open_app')) && !parsed.actions.some(a => a?.kind === 'play_youtube');
    if (done.applied.includes('pc_action') && !parsed.actions.some(a => a?.kind === 'play_youtube')) jarvisCore.setNavMode(db, sessionId, true, 'pc', ms);
    result = { reply: tidyReply(parsed.reply), expectReply: parsed.expectReply || keepListening, card: parsed.card, visual: done.visual || null, photoRequest: done.photoRequest, model: res.key, switched: res.switched, actions: done.applied, device: done.device, tier, layoutChanged: !!done.ui, rememberedIds: done.rememberedIds, autoLeaves };
    sess.model = res.key;
  } catch (e) {
    logEvent(db, nowIso, 'error', `chat: ${e.message} ${(e.tried || []).join(' | ')}`);
    mood.feel(db, 'frustrazione', 0.3, ms);
    result = { reply: e.tried ? e.message : 'Si è verificato un problema interno, signore. Riprovi tra poco.', expectReply: false, card: '', photoRequest: null, model: '', switched: false, actions: [], device: [], error: true };
  }

  addMessage(db, sessionId, 'assistant', result.reply, nowIso, { model: result.model, card: result.card || undefined, visual: result.visual || undefined });
  jarvisCore.maybeLogLatentIssue(db, sessionId, userText, ms, tz);
  // Cosa ha "acceso" questo scambio: la sfera illumina questi rami e foglie.
  const touched = new Set(recalled.active);
  if (dietOn) touched.add(SPORT_WORDS.test(userText) ? 'sport' : 'dieta');
  if (agendaOn) touched.add('agenda');
  for (const r of remembered) touched.add(r);
  for (const m of topicHits.modules) touched.add(m);
  if ((result.actions || []).includes('start_job')) touched.add('compiti');
  if ((result.device || []).some(d => d.type === 'phone_task')) touched.add('automazioni');
  result.touched = [...touched];
  result.touchedLeaves = [...new Set([...topicHits.leaves, ...(result.rememberedIds || []).map(id => 'm:' + id), ...(result.autoLeaves || []), ...recalled.entries.map(m => 'm:' + m.id)])];
  kvSet(db, 'lastTouched', { at: nowIso + '#' + ms, touched: result.touched, leaves: result.touchedLeaves });
  if (!result.error) continuity.record(db, { ms, tz, sessionId, chatTitle: proj ? `${proj.project.name}${proj.chat?.title ? ' › ' + proj.chat.title : ''}` : '', userText, reply: result.reply, applied: result.actions || [], device: result.device || [], touched: result.touched, expectReply: result.expectReply });
  memory.markUsed(db, recalled.entries.map(m => m.id), nowIso);
  memory.noteUse(db, result.touched, ms);

  // Aggiorna i moduli "caldi" della sessione.
  const next = {};
  for (const [k, ttl] of Object.entries(sess.modules)) if (ttl > 1) next[k] = ttl - 1;
  if (dietOn && (DIET_KEYWORDS.test(userText) || image || result.actions.some(a => DIET_ACTIONS.has(a)))) next.dieta = STICKY_TURNS;
  if (agendaOn && AGENDA_KEYWORDS.test(userText)) next.agenda = STICKY_TURNS;
  for (const m of recalled.active) next[m] = STICKY_TURNS;
  db.run('UPDATE sessions SET model = ?, modules = ?, updated = ? WHERE id = ?', sess.model, JSON.stringify(next), nowIso, sessionId);

  // Impronte dei ricordi nuovi, in background: non rallenta la risposta.
  deps.defer?.(semantic.backfill(db, env, deps.fetchFn, 10).catch(() => 0));
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

/**
 * Frase sentita a conversazione aperta (senza dire "Kestra"): verdetto locale veloce.
 * 'yes' = chiaramente rivolta all'assistente, 'ask' = decide il modello (TV, altre persone, frasi fuori contesto).
 */
export function followupVerdict(text, lastAssistant = '') {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9àèéìòóù' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'no';
  const words = t.split(' ');
  if (words.length <= 3) return 'yes';
  if (/\?\s*$/.test(String(lastAssistant || '').trim()) && words.length <= 8) return 'yes';
  if (words.length <= 12 && /^(?:e\s+|poi\s+|ora\s+|adesso\s+|allora\s+|no\s+|s[iì]\s+)?(?:apri|aprimi|metti|mettimi|aggiungi|segna|registra|togli|cancella|chiama|cerca|cercami|ricordami|ricorda|dimmi|mostrami|mostra|fai|fammi|leggi|leggimi|scrivi|manda|invia|imposta|spegni|accendi|quanto|quanti|quante|qual|quale|cosa|come|perch[eé]|dove|quando|puoi|sai|mi\s+(?:dici|serve|servono)|ho\s+(?:mangiato|bevuto|fatto))\b/.test(t)) return 'yes';
  return 'ask';
}

/** Conversazione aperta: l'utente sta ancora parlando con Kestra o il microfono ha sentito altro (TV, altre persone)? */
export async function isFollowupAddressed(db, env, deps, text, sessionId = 'main') {
  const last = db.all('SELECT role, text FROM messages WHERE session = ? ORDER BY id DESC LIMIT 4', sessionId).reverse();
  const lastAssistant = [...last].reverse().find(m => m.role === 'assistant')?.text || '';
  const v = followupVerdict(text, lastAssistant);
  if (v !== 'ask') return v === 'yes';
  try {
    const res = await router.chat(db, env, {
      tier: 'fast', maxTokens: 5, fetchFn: deps.fetchFn, now: deps.now, tz: deps.tz,
      build: () => [
        { role: 'system', content: 'Kestra è un assistente vocale. Dopo una sua risposta il microfono resta aperto qualche secondo e trascrive ciò che sente, senza che l\'utente ripeta il nome. Ricevi gli ultimi scambi e la nuova frase trascritta. Rispondi SI se la frase è rivolta a Kestra (continua il discorso, risponde a una sua domanda, è una richiesta o un comando). Rispondi NO se sembra audio di TV, radio, video o serie, una persona che parla con altri, una frase che non c\'entra nulla con il discorso, o la voce di Kestra stessa. Rispondi solo SI oppure NO.' },
        { role: 'user', content: `ULTIMI SCAMBI:\n${last.map(m => `${m.role === 'user' ? 'Utente' : 'Kestra'}: ${String(m.text).slice(0, 200)}`).join('\n')}\n\nNUOVA FRASE: ${String(text).slice(0, 400)}` },
      ],
    });
    return !/^\W*no\b/i.test(res.text);
  } catch {
    return true; // nel dubbio non si perde una richiesta vera
  }
}
