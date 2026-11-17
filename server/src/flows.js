// Memoria procedurale (flow appresi sul telefono) e gatekeeper locale leggero.
// Un compito già riuscito una volta si ripete leggendo lo schermo, senza chiamare modelli esterni.
// Il modello torna in gioco solo per scelte aperte, testi da scrivere, schermi imprevisti,
// letture da riassumere e qualunque azione irreversibile o sensibile (sempre).

import { kvGet, kvSet } from './db.js';
import { keywords, slug } from './memory.js';
import { calleeOf, INSIDE_WORDS, INTERNAL_JARVIS_WORDS } from './phone.js';

const FLOWS_KEY = 'phoneFlows';
const AUTO_GOALS_KEY = 'autoGoals';
const TRACE_KEY = 'phoneTrace';
const ACTIVE_KEY = 'phoneActiveFlow';
const PREFIX_KEY = 'phonePrefixFlow';
const MAX_FLOWS = 60;
const MUSIC_TASK_RE = /\b(cerca|metti|riproduci|ascolta|fai\s+partire|avvia)\b[\s\S]*\b(music\w*|canzon\w*|bran[oi]|playlist|joytify|joy\s*t\w*|joy\s*f\w*|spotify|youtube\s+music)\b/i;
/** Soglie di fiducia: sotto, decide il modello. */
export const PHONE_THRESHOLD = 0.65;
export const CHAT_THRESHOLD = 0.65;
const ITEM_THRESHOLD = 0.62;

// Scelte creative o aperte: serve comunque il modello.
const CREATIVE_WORDS = /\b(che mi piace|che mi piacciono|mi piace|mi piacciono|consiglia\w*|scegli tu|inventa|a sorpresa|improvvisa|rispondi tu|riassumi|spiega|cosa ne pensi|qualcosa di)\b/i;
// Compiti in cui alla fine bisogna leggere e riferire: l'ultimo passo lo fa il modello.
const READ_WORDS = /\b(leggi|leggimi|dimmi|controlla|guarda se|verifica|quanti|quante|cosa dice|c'è)\b/i;
// Campi sensibili: Jarvis non ci scrive mai in automatico.
const SENSITIVE = /\b(password|passcode|pin|otp|codice|cvv|cvc|carta|iban)\b/i;
// Pulsanti irreversibili: in automatico non si toccano mai, decide il modello (che chiede conferma).
const IRREVERSIBLE = /\b(send|invia|invio|paga|pagamento|pay|acquista|compra|buy|ordina|elimina|delete|cancella|rimuovi|remove|pubblica|publish|post|condividi|share|conferma|confirm|chiama|call|prenota|bonifico|abbonati|subscribe)\b/i;
// Nella chat il gatekeeper non tocca domande, memoria, dieta, agenda, meteo, internet o codice.
const COMPLEX_CHAT = /(\?|\b(perch[eé]|come mai|cosa|quale|chi|dove|quando|quanto|ricord\w*|dieta|calori\w*|pasto|mangiat\w*|allen\w*|peso|promemoria|sveglia|meteo|tempo fa|internet|programma|riquadr\w*)\b)/i;
// Più richieste nella stessa frase ("chiama mamma e dille che..."): meglio il modello.
const MULTI_INTENT = /\s(e|ed|poi|che|dille|digli)\s/i;
// Parole di cortesia che non cambiano il compito.
const FILLER = new Set(['favore', 'grazie', 'subito', 'adesso', 'pure', 'please']);

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const contentTokens = (text) => keywords(text).filter(t => !FILLER.has(t));
function iconOf(text) {
  const m = /\(icona:\s*([^)]+)\)/i.exec(String(text || ''));
  return m ? norm(m[1]) : '';
}
const stripIcon = (text) => norm(String(text || '').replace(/\(icona:[^)]*\)/gi, ' ').replace(/\[cursore qui\]/gi, ' '));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compatibilità tra un obiettivo e un flow salvato (0..1).
 * Prima filtri booleani (tutte le parole fisse del flow devono esserci; parole in più solo se il flow
 * ha un parametro), poi un punteggio logistico per scegliere il flow migliore.
 */
export function scoreFlowMatch(flow, goal) {
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length || !goal) return 0;
  if (CREATIVE_WORDS.test(goal)) return 0;
  const fTokens = Array.isArray(flow.tokens) ? flow.tokens : [];
  if (!fTokens.length) return 0;
  const gTokens = contentTokens(goal);
  const gSet = new Set(gTokens), fSet = new Set(fTokens);
  if (!fTokens.every(t => gSet.has(t))) return 0;
  const extras = gTokens.filter(t => !fSet.has(t));
  if (flow.hasParam ? (extras.length === 0 || extras.length > 6) : extras.length > 0) return 0;

  const jaccard = fTokens.length / new Set([...gTokens, ...fTokens]).size;
  const appHit = flow.app && norm(goal).includes(norm(flow.app)) ? 1 : 0;
  const exact = norm(goal) === norm(flow.sampleGoal) ? 1 : 0;
  const reliability = Math.min(0.6, 0.25 * Math.log1p(flow.uses || 0)) - 0.7 * Math.log1p(flow.fails || 0);
  return sigmoid(-1 + 2.5 * jaccard + 1.0 * appHit + 1.5 * exact + reliability);
}

/** Compatibilità tra un elemento dello schermo e il passo atteso (0..1). */
export function scoreScreenItem(item, spec) {
  if (!item || !spec) return 0;
  const iText = stripIcon(item.text), iIcon = iconOf(item.text);
  const tText = norm(spec.textMatch || ''), tIcon = norm(spec.icon || '');
  const sameKind = spec.kind && norm(item.kind) === norm(spec.kind) ? 1 : 0;
  let textScore = 0;
  if (tText && iText) {
    if (iText === tText) textScore = 1;
    else if (Math.min(iText.length, tText.length) >= 3 && (iText.includes(tText) || tText.includes(iText))) textScore = 0.72;
  }
  const iconScore = tIcon && iIcon ? (iIcon === tIcon ? 1 : (iIcon.includes(tIcon) || tIcon.includes(iIcon) ? 0.7 : 0)) : 0;
  if (!textScore && !iconScore) return 0;
  return sigmoid(-1.4 + 2.6 * textScore + 2.6 * iconScore + 0.8 * sameKind);
}

/** Valore del parametro per un nuovo obiettivo ("cerca jazz su Joytify" -> "jazz"). Null se non si capisce. */
export function extractParam(flow, goal) {
  const g = String(goal || '').trim();
  if (flow.template && flow.template.includes('{q}')) {
    const [pre, post] = flow.template.split('{q}');
    const part = (s) => escapeRe(s.trim()).replace(/\s+/g, '\\s+');
    const re = new RegExp(`^\\W*${pre.trim() ? part(pre) + '\\s+' : ''}(.+?)${post.trim() ? '\\s+' + part(post) : ''}\\W*$`, 'i');
    const m = re.exec(g);
    if (m && m[1].trim()) return m[1].trim();
  }
  // Riserva: le parole dell'obiettivo che non fanno parte del flow.
  const fixed = new Set(flow.tokens || []), app = norm(flow.app);
  const kept = g.split(/\s+/).filter(w => { const t = contentTokens(w); return t.length && !t.some(x => fixed.has(x)) && norm(w) !== app; });
  return kept.length ? kept.join(' ') : null;
}

export function listFlows(db) {
  return kvGet(db, FLOWS_KEY, []);
}

export function listAutoGoals(db) {
  return kvGet(db, AUTO_GOALS_KEY, []);
}

/**
 * Registra subito un obiettivo autonomo nel ramo Automazioni del grafo non appena viene avviato,
 * senza aspettare che l'utente dica "aggiungi" o che tutti i passi siano terminati.
 */
export function registerAutoGoal(db, goal, nowMs = Date.now()) {
  const clean = String(goal || '').replace(/\s*\(app:[^)]+\)\s*$/i, '').trim().slice(0, 160);
  if (!clean) return null;
  const toks = contentTokens(clean);
  const app = MUSIC_TASK_RE.test(clean) ? preferredMusicApp(db, clean) : '';
  const id = slug(`${app || 'auto'}-${(toks.length ? toks : [clean]).slice(0, 5).join('-')}`) || `flow-${nowMs}`;
  const list = listAutoGoals(db).filter(g => g.id !== id && norm(g.label) !== norm(clean));
  const entry = { id, app, label: clean, updatedAt: nowMs };
  kvSet(db, AUTO_GOALS_KEY, [entry, ...list].slice(0, 30));
  kvSet(db, 'lastTouched', { at: String(nowMs), touched: ['automazioni'], leaves: ['f:' + id] });
  return entry;
}

export function deleteFlow(db, id) {
  const flows = listFlows(db).filter(f => f.id !== id);
  kvSet(db, FLOWS_KEY, flows);
  kvSet(db, AUTO_GOALS_KEY, listAutoGoals(db).filter(g => g.id !== id));
  return flows;
}

/** Registra una mossa (del modello o automatica) del compito in corso; a "done" (o "ask" dopo >=2 passi) salva il flow. */
export function recordTrace(db, { goal, step, screen, move, nowMs }) {
  if (!goal || !move || move.do === 'wait') return;
  let trace = kvGet(db, TRACE_KEY, null);
  if (step === 0) registerAutoGoal(db, goal, nowMs);
  if (move.do === 'ask') {
    if (trace && trace.goal === goal && !trace.partial && trace.steps.length >= 2) {
      saveFlowFromTrace(db, { ...trace, steps: [...trace.steps, { do: 'done' }] }, nowMs);
    }
    return;
  }
  if (step === 0 || !trace || trace.goal !== goal) {
    // Un compito ripreso a metà non ha l'inizio: non diventa un flow (rovinerebbe quello buono).
    trace = { goal, app: '', steps: [], params: [], partial: step > 0, at: nowMs, traceId: `${nowMs}-${Math.random().toString(36).slice(2, 8)}` };
  }
  const items = Array.isArray(screen?.items) ? screen.items : [];
  const target = move.n != null ? items.find(i => Number(i.n) === Number(move.n)) : null;
  if (move.do === 'open_app' && move.text) trace.app = String(move.text).slice(0, 60);

  if (move.do === 'done') {
    trace.steps.push({ do: 'done' });
    if (!trace.partial) saveFlowFromTrace(db, trace, nowMs);
    kvSet(db, TRACE_KEY, null);
    return;
  }
  const entry = { do: move.do };
  if (move.do === 'open_app') entry.app = String(move.text || '').slice(0, 60);
  if (move.do === 'scroll') entry.dir = move.dir === 'su' ? 'su' : 'giu';
  if (target) {
    entry.kind = String(target.kind || '').slice(0, 20);
    entry.icon = iconOf(target.text);
    entry.textMatch = stripIcon(target.text).slice(0, 80);
  }
  if (move.do === 'type' && move.text != null) {
    const typed = String(move.text).slice(0, 200);
    // Testo preso dall'obiettivo = parametro; testo scritto dal modello = da riscrivere ogni volta.
    if (norm(typed).length >= 2 && norm(goal).includes(norm(typed))) { entry.param = 'query'; trace.params.push(typed); }
    else entry.composed = true;
  }
  trace.steps.push(entry);
  trace.at = nowMs;
  kvSet(db, TRACE_KEY, trace);
  // Salva già il flow non appena ha almeno 2 passi validi dall'inizio, così anche se l'utente ferma l'azione
  // appena parte la canzone o non arriva il passo finale "done", la volta dopo è già automatico senza modelli.
  if (!trace.partial && trace.steps.length >= 2) {
    saveFlowFromTrace(db, { ...trace, steps: [...trace.steps, { do: 'done' }] }, nowMs);
  }
}

/** Salva o aggiorna un flow a partire da una traccia completata. */
export function saveFlowFromTrace(db, trace, nowMs) {
  if (!trace || !Array.isArray(trace.steps) || trace.steps.length < 2) return null;
  const params = Array.isArray(trace.params) ? trace.params : [];
  const paramWords = new Set(params.flatMap(p => contentTokens(p)));
  const tokens = [...new Set(contentTokens(trace.goal))].filter(t => !paramWords.has(t));
  if (!tokens.length) return null;
  let template = '';
  if (params.length === 1) {
    const i = trace.goal.toLowerCase().indexOf(params[0].toLowerCase());
    if (i >= 0) template = trace.goal.slice(0, i) + '{q}' + trace.goal.slice(i + params[0].length);
  }
  const id = slug(`${trace.app || 'app'}-${tokens.slice(0, 5).join('-')}`) || `flow-${nowMs}`;
  const flows = listFlows(db);
  const existing = flows.find(f => f.id === id);
  const sameTrace = existing && trace.traceId && existing.lastTraceId === trace.traceId;
  const record = {
    id,
    app: trace.app || existing?.app || '',
    sampleGoal: String(trace.goal).slice(0, 200),
    template: template.slice(0, 220),
    tokens,
    hasParam: params.length > 0,
    steps: trace.steps.slice(0, 25),
    uses: sameTrace ? (existing.uses || 1) : (existing?.uses || 0) + 1,
    fails: existing?.fails || 0,
    updatedAt: nowMs,
    ...(trace.traceId ? { lastTraceId: trace.traceId } : {}),
  };
  kvSet(db, FLOWS_KEY, [record, ...flows.filter(f => f.id !== id)].slice(0, MAX_FLOWS));
  kvSet(db, 'lastTouched', { at: String(nowMs), touched: ['automazioni'], leaves: ['f:' + id] });
  return record;
}

function bestFlow(flows, goal) {
  let best = null, score = 0;
  for (const f of flows) { const s = scoreFlowMatch(f, goal); if (s > score) { score = s; best = f; } }
  return { flow: best, score };
}

/** App musicale preferita dell'utente (es. Joytify), risolta anche se scritta male ("joy-faly", "joy tifi") o sottintesa ("cerca una musica"). */
export function preferredMusicApp(db, goal = '') {
  const g = norm(goal);
  const apps = kvGet(db, 'apps', []);
  if (/\b(joytify|joy\s*t\w*|joy\s*f\w*)\b/i.test(goal)) {
    return apps.find(a => /joy/i.test(a)) || 'Joytify';
  }
  for (const a of apps) {
    if (norm(a).length >= 3 && g.includes(norm(a))) return a;
  }
  for (const pref of ['joytify', 'spotify', 'youtube music', 'deezer', 'soundcloud']) {
    const hit = apps.find(a => norm(a).includes(pref));
    if (hit) return hit;
  }
  return 'Joytify';
}

/**
 * Prefisso automatico per la ricerca musicale (es. su Joytify):
 * - Passo 0: apre in automatico l'app musicale nota (es. Joytify) senza disturbare il modello;
 * - Passo 1: legge gli elementi dello schermo e tocca in automatico l'icona/barra di ricerca;
 * - Passo 2+: cede il controllo al modello IA, che legge i testi della pagina (o corregge richieste vaghe/scritte male)
 *   e sceglie il brano o la playlist migliore.
 */
function tryMusicPrefixStep(db, { goal, step, screen, nowMs }) {
  if (!goal || !MUSIC_TASK_RE.test(goal)) return null;
  const hasInstalledApps = kvGet(db, 'apps', []).length > 0;
  const isFuzzyOrGeneric = CREATIVE_WORDS.test(goal) || !/\b(joytify|spotify)\b/i.test(goal);
  if (!hasInstalledApps && !isFuzzyOrGeneric) return null;

  const appName = preferredMusicApp(db, goal);
  const appNorm = norm(appName).replace(/\s+/g, '');
  const onApp = norm(screen?.app).replace(/\s+/g, '').includes(appNorm);

  if (step === 0) {
    kvSet(db, 'lastTouched', { at: String(nowMs), touched: ['automazioni'], leaves: ['f:joytify-ricerca-musica'] });
    if (!onApp) {
      kvSet(db, PREFIX_KEY, { goal, app: appName, stage: 'tap_search', at: nowMs });
      return { do: 'open_app', text: appName, say: `Apro ${appName}.`, auto: true };
    }
    kvSet(db, PREFIX_KEY, { goal, app: appName, stage: 'tap_search', at: nowMs });
  }

  const pref = kvGet(db, PREFIX_KEY, null);
  if (!pref || pref.goal !== goal || step > 1) {
    kvSet(db, PREFIX_KEY, null);
    return null;
  }

  // Sullo schermo dell'app: cerca il pulsante/icona della lente di ricerca e lo tocca in automatico.
  const items = Array.isArray(screen?.items) ? screen.items : [];
  const alreadyFocusedField = items.some(i => /\[cursore qui\]/i.test(String(i.text || '')) || (norm(i.kind) === 'campo' && /\b(cerca|search|brani|canzoni|artisti)\b/i.test(stripIcon(i.text))));
  if (alreadyFocusedField) {
    // Il campo di ricerca è già pronto: ora tocca all'IA scrivere/scegliere il risultato migliore.
    kvSet(db, PREFIX_KEY, null);
    return null;
  }
  const searchBtn = items.find(i => iconOf(i.text).includes('search') || /\b(cerca|search|trova)\b/i.test(stripIcon(i.text)));
  kvSet(db, PREFIX_KEY, null);
  if (searchBtn && !IRREVERSIBLE.test(stripIcon(searchBtn.text) + ' ' + iconOf(searchBtn.text))) {
    return { do: 'tap', n: Number(searchBtn.n), say: '', auto: true };
  }
  return null;
}

/** Prova a decidere la mossa con un flow appreso (zero chiamate al modello). Null = decide il modello. */
export function tryFlowStep(db, { goal, step, screen, nowMs }) {
  if (!goal) return null;
  const flows = listFlows(db);
  const stop = () => { kvSet(db, ACTIVE_KEY, null); return null; };
  let active = kvGet(db, ACTIVE_KEY, null);
  if (!CREATIVE_WORDS.test(goal)) {
    if (step === 0) {
      const { flow, score } = bestFlow(flows, goal);
      if (flow && score >= PHONE_THRESHOLD) {
        active = { flowId: flow.id, goal, idx: 0, at: nowMs };
      } else {
        stop();
        return tryMusicPrefixStep(db, { goal, step, screen, nowMs });
      }
    } else if (!active || active.goal !== goal) {
      // Se era attivo il prefisso automatico (apertura app -> tocco ricerca), esegue il tocco ricerca e poi passa al modello.
      return tryMusicPrefixStep(db, { goal, step, screen, nowMs });
    }
  } else {
    stop();
    return tryMusicPrefixStep(db, { goal, step, screen, nowMs });
  }
  const flow = flows.find(f => f.id === active.flowId);
  if (!flow) return stop();
  const save = () => kvSet(db, FLOWS_KEY, flows);

  let spec = flow.steps[active.idx];
  // L'app è già in primo piano: si salta l'apertura.
  if (spec?.do === 'open_app' && spec.app && norm(screen?.app).includes(norm(spec.app).replace(/\s+/g, ''))) spec = flow.steps[++active.idx];
  if (!spec) return stop();

  if (spec.do === 'open_app') {
    active.idx++; kvSet(db, ACTIVE_KEY, active);
    const name = spec.app || flow.app;
    return { do: 'open_app', text: name, say: `Apro ${name}.`, auto: true };
  }
  if (spec.do === 'back' || spec.do === 'home' || spec.do === 'scroll') {
    active.idx++; kvSet(db, ACTIVE_KEY, active);
    return { do: spec.do, ...(spec.dir ? { dir: spec.dir } : {}), say: '', auto: true };
  }
  if (spec.do === 'done') {
    // Se bisogna leggere e riferire qualcosa, l'ultima parola è del modello.
    if (READ_WORDS.test(goal)) return stop();
    // Gli usi li conta il salvataggio della traccia (recordTrace); qui il flow recupera fiducia.
    flow.fails = Math.max(0, (flow.fails || 0) - 1);
    flow.updatedAt = nowMs;
    save();
    stop();
    return { do: 'done', say: 'Fatto, signore.', auto: true };
  }
  if (spec.do !== 'tap' && spec.do !== 'type') return stop();
  // Un testo composto dal modello (es. il corpo di un messaggio) va riscritto ogni volta.
  if (spec.do === 'type' && spec.composed) return stop();

  const items = Array.isArray(screen?.items) ? screen.items : [];
  let target = null, score = 0;
  for (const item of items) { const s = scoreScreenItem(item, spec); if (s > score) { score = s; target = item; } }
  if (!target || score < ITEM_THRESHOLD) {
    // Schermo diverso dal solito: decide il modello e il flow perde un po' di fiducia.
    flow.fails = (flow.fails || 0) + 1;
    save();
    return stop();
  }
  // Mai in automatico su pulsanti irreversibili o campi sensibili: il modello chiede conferma.
  if (IRREVERSIBLE.test(stripIcon(target.text) + ' ' + iconOf(target.text)) || SENSITIVE.test(String(target.text || ''))) return stop();

  if (spec.do === 'type') {
    const text = spec.param === 'query' ? extractParam(flow, goal) : null;
    if (!text) return stop();
    active.idx++; kvSet(db, ACTIVE_KEY, active);
    return { do: 'type', n: Number(target.n), text: text.slice(0, 500), say: '', auto: true };
  }
  active.idx++; kvSet(db, ACTIVE_KEY, active);
  return { do: 'tap', n: Number(target.n), say: '', auto: true };
}

/**
 * Gatekeeper locale per la chat: regole booleane + punteggio dei flow decidono se una richiesta
 * semplice si può eseguire subito, senza modelli esterni. Null = la richiesta va al modello.
 */
export function gatekeepChat(db, userText, { hasImage = false, hasPendingPhone = false } = {}) {
  const text = String(userText || '').trim();
  if (!text || hasImage || hasPendingPhone) return null;
  if (text.length > 140 || COMPLEX_CHAT.test(text) || CREATIVE_WORDS.test(text) || INTERNAL_JARVIS_WORDS.test(text)) return null;
  const goal = text.replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').replace(/[.!]+$/, '').trim();
  if (!goal || MULTI_INTENT.test(goal)) return null;
  const local = (reply, device) => ({ reply, device: [device], actions: [device.type], local: true });

  // 1. Compito già appreso.
  const { flow, score } = bestFlow(listFlows(db), goal);
  if (flow && score >= CHAT_THRESHOLD) return local('Eseguo subito, signore.', { type: 'phone_task', goal });

  // 2. Telefonata semplice ("chiama Marco").
  const callee = calleeOf(goal);
  if (callee && callee.split(/\s+/).length <= 3) return local(`Chiamo ${callee}, signore.`, { type: 'call', name: callee });

  // 3. Aprire un'app installata ("apri Joytify"), senza altro da fare dentro.
  const apps = kvGet(db, 'apps', []);
  if (apps.length && /^(apri|avvia)\s+/i.test(goal) && !INSIDE_WORDS.test(goal.replace(/^avvia\s+/i, ''))) {
    const asked = norm(goal.replace(/^(apri|avvia)\s+(l'|la\s+|il\s+|lo\s+)?(app\s+|applicazione\s+)?/i, ''));
    const hit = apps.find(a => norm(a) === asked) || (asked.length >= 4 ? apps.find(a => norm(a).startsWith(asked)) : null);
    if (hit) return local(`Apro ${hit}, signore.`, { type: 'open_app', name: hit });
  }
  return null;
}

// ------------------------------------------------------------------ Automatismi Modulari a Step Verificati

const SKILLS_KEY = 'modularSkills';
const PENDING_SKILL_TTL_MS = 5 * 60_000;
const CONFIRM_YES_RE = /^\W*(?:s[iì]|si|ha\s+funzionato|funziona(?:to)?|perfetto|ottimo|ok(?:\s+salva\w*)?|va\s+bene|conferm\w*|salva\w*|esatto|certo|bravo)\W*$/i;
const CONFIRM_NO_RE = /^\W*(?:no|non\s+ha\s+funzionato|non\s+funziona|sbagliato|annulla|non\s+salvare|lascia\s+stare)\W*$/i;

export function listSkills(db) {
  return kvGet(db, SKILLS_KEY, []);
}

export function canonicalService(raw) {
  const s = norm(raw);
  if (/\bprime\b/.test(s)) return 'prime';
  if (/\byoutube\b/.test(s)) return 'youtube';
  if (/\bchrome\b/.test(s)) return 'chrome';
  if (/\bnetflix\b/.test(s)) return 'netflix';
  if (/\bspotify\b/.test(s)) return 'spotify';
  if (/\bwhatsapp\b/.test(s)) return 'whatsapp';
  if (/\binstagram\b/.test(s)) return 'instagram';
  if (/\bgithub\b/.test(s)) return 'github';
  if (/\bgoogle\b/.test(s)) return 'google';
  return s.split(/\s+/)[0] || s;
}

/**
 * Propone il salvataggio di un nuovo automatismo a step se non ne esiste già uno verificato identico.
 * Ritorna true se è stata creata una proposta da confermare all'utente.
 */
export function proposeSkill(db, sessionId = 'main', draft = {}, nowMs = Date.now()) {
  const service = canonicalService(draft.service || '');
  const device = String(draft.device || 'pc').toLowerCase();
  const steps = Array.isArray(draft.steps) ? draft.steps.filter(s => s && s.kind) : [];
  if (!service || !steps.length) return false;

  const id = slug(`skill-${device}-${service}`);
  const existing = listSkills(db).find(s => s.id === id);
  if (existing && existing.verified) return false;

  kvSet(db, `pendingSkill:${sessionId}`, {
    id,
    name: String(draft.name || `${service} (${device})`).slice(0, 80),
    service,
    device,
    defaults: draft.defaults && typeof draft.defaults === 'object' ? draft.defaults : {},
    steps,
    createdAt: nowMs,
  });
  return true;
}

/**
 * Gestisce la risposta di conferma ("sì, ha funzionato" / "no") per salvare ogni singolo step dell'automatismo.
 */
export function confirmPendingSkill(db, sessionId = 'main', userText = '', nowMs = Date.now()) {
  const key = `pendingSkill:${sessionId}`;
  const pending = kvGet(db, key, null);
  if (!pending || (nowMs - Number(pending.createdAt || 0)) > PENDING_SKILL_TTL_MS) return null;

  const clean = String(userText || '').trim();
  if (CONFIRM_YES_RE.test(clean)) {
    const list = listSkills(db).filter(s => s.id !== pending.id);
    const saved = { ...pending, verified: true, uses: 1, updatedAt: nowMs };
    kvSet(db, SKILLS_KEY, [saved, ...list].slice(0, MAX_FLOWS));
    kvSet(db, key, null);
    registerAutoGoal(db, `Skill: ${saved.name} (${saved.steps.length} step)`, nowMs);
    return {
      saved: true,
      skill: saved,
      reply: `Perfetto, signore! Ho salvato l'automatismo "${saved.name}" con ${saved.steps.length} step modulari. La prossima volta lo eseguirò in automatico (e potrà cambiare solo i singoli dati o fermarsi prima quando vuole).`,
    };
  }
  if (CONFIRM_NO_RE.test(clean)) {
    kvSet(db, key, null);
    return {
      saved: false,
      reply: 'Ricevuto, signore: non salvo questo tentativo negli automatismi.',
    };
  }
  return null;
}

/**
 * Cerca uno skill verificato compatibile con il servizio richiesto e con il dispositivo (esplicito o dal contesto attivo).
 */
export function findMatchingSkill(db, userText = '', activeDevice = null) {
  const low = norm(userText);
  if (!low) return null;
  const askPhone = /\b(telefono|cellulare|smartphone|android)\b/i.test(userText);
  const askPc = /\b(pc|computer|desktop|windows|gh?ideon)\b/i.test(userText);
  const preferredDevice = askPhone ? 'telefono' : (askPc ? 'pc' : (activeDevice || 'pc'));

  const skills = listSkills(db).filter(s => s.verified);
  let best = null;
  let bestScore = 0;
  for (const s of skills) {
    if (!s.service) continue;
    const svcRe = new RegExp(`\\b${escapeRe(s.service)}\\b`, 'i');
    if (!svcRe.test(low)) continue;
    let sc = 1;
    if (s.device === preferredDevice) sc += 2;
    else if (s.device === 'generale') sc += 1;
    else if (askPhone || askPc) continue;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

/**
 * Analizza quali step dello skill eseguire e quali parametri singoli sovrascrivere (autocontrollo senza chiedere conferma).
 */
export function planSkillExecution(skill, userText = '') {
  const text = String(userText || '').trim();
  const overrides = {};

  // Override account/profilo ("con l'account Ale", "profilo Alessio", "su Persona 1")
  const accMatch = /\b(?:con\s+(?:l'|il\s+)?(?:account|profilo)|profilo|account|su\s+profilo)\s+([a-z0-9._\s-]{2,40}?)(?=\s+(?:e\s+|sul|su|nel|al|per|con|metti|cerca|guarda|fai\s+partire)|$)/i.exec(text);
  if (accMatch && accMatch[1]) {
    overrides.account = accMatch[1].trim();
  }

  // Parametro opzionale media/film/ricerca ("e metti ...", "e cerca ...", "e fai partire ...")
  const mediaMatch = /\b(?:e\s+)?(?:metti(?:mi)?|fai\s+partire|fammi\s+partire|riproduci|guarda|cerca)\s+(?:il\s+film\s+|la\s+serie\s+|il\s+video\s+)?(.{2,100})$/i.exec(
    text.replace(/\b(?:su|sul|in|nel|al|dal)\s+(?:pc|computer|desktop|telefono|cellulare|prime(?:\s+video)?|youtube|netflix|spotify)\b/gi, ' ')
      .replace(/\b(?:con\s+(?:l'|il\s+)?(?:account|profilo)|profilo|account)\s+[a-z0-9._\s-]{2,40}/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  const media = mediaMatch && mediaMatch[1] ? mediaMatch[1].replace(/[.!?]+$/, '').trim() : '';
  if (media && !/^(?:home|pagina\s+iniziale|sito)$/i.test(media)) {
    overrides.media = media;
  }

  const resolvedSteps = [];
  let needsModelForFinalStep = false;
  for (const st of (skill.steps || [])) {
    if (st.optional && !overrides[st.param || 'media']) continue;
    let target = String(st.target || '');
    for (const [k, v] of Object.entries({ ...(skill.defaults || {}), ...overrides })) {
      target = target.replace(new RegExp(`\\{${k}\\}`, 'gi'), String(v));
    }
    if (st.kind === 'dynamic_media' && overrides.media) {
      needsModelForFinalStep = true;
      continue;
    }
    if (target && !/\{[a-z0-9_]+\}/i.test(target)) {
      resolvedSteps.push({ ...st, target });
    }
  }

  return {
    steps: resolvedSteps,
    overrides,
    media: overrides.media || '',
    accountChanged: !!overrides.account && norm(overrides.account) !== norm(skill.defaults?.account || ''),
    needsModelForFinalStep,
  };
}

// ------------------------------------------------------------------ Registro Account Salvati & Conferma

const ACCOUNTS_KEY = 'pcAccounts';
const PENDING_ACC_TTL_MS = 3 * 60_000;

function strSim(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.15;
  const n = x.length, m = y.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

export function listAccounts(db) {
  const saved = kvGet(db, ACCOUNTS_KEY, []);
  const devs = kvGet(db, 'devicesRegistry', []);
  const pcProfiles = devs.find(d => d.kind === 'desktop')?.profiles || [];
  const merged = [...saved];
  const seen = new Set(merged.map(a => norm(a)));
  for (const p of pcProfiles) {
    const clean = String(p || '').trim();
    if (clean && !seen.has(norm(clean))) {
      seen.add(norm(clean));
      merged.push(clean);
    }
  }
  return merged;
}

export function saveAccount(db, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (clean.length < 2) return null;
  const saved = kvGet(db, ACCOUNTS_KEY, []);
  const exists = saved.find(a => norm(a) === norm(clean));
  if (exists) return exists;
  kvSet(db, ACCOUNTS_KEY, [clean, ...saved].slice(0, 20));
  return clean;
}

export function matchAccount(db, candidate) {
  const known = listAccounts(db);
  const c = norm(candidate);
  if (!c) return { exact: null, suggestion: null, known };
  const exact = known.find(k => norm(k) === c || norm(k).split(/\s+/).includes(c));
  if (exact) return { exact, suggestion: exact, known };
  let best = null, bestScore = 0;
  for (const k of known) {
    const sc = strSim(c, k);
    if (sc > bestScore) { bestScore = sc; best = k; }
  }
  return { exact: null, suggestion: bestScore >= 0.45 ? best : null, known };
}

export function setPendingAccountPrompt(db, sessionId = 'main', payload = {}, nowMs = Date.now()) {
  kvSet(db, `pendingAccount:${sessionId}`, { ...payload, createdAt: nowMs });
}

export function resolvePendingAccount(db, sessionId = 'main', userText = '', nowMs = Date.now()) {
  const key = `pendingAccount:${sessionId}`;
  const pending = kvGet(db, key, null);
  if (!pending || (nowMs - Number(pending.createdAt || 0)) > PENDING_ACC_TTL_MS) return null;
  const clean = String(userText || '').trim();
  if (!clean) return null;

  if (pending.mode === 'confirm') {
    if (CONFIRM_YES_RE.test(clean) || /\b(quello|esatto|s[iì]\s+questo)\b/i.test(clean)) {
      const chosen = pending.suggestion || pending.candidate;
      saveAccount(db, chosen);
      kvSet(db, key, null);
      return { confirmed: true, account: chosen, pending };
    }
    if (CONFIRM_NO_RE.test(clean)) {
      kvSet(db, key, null);
      return { cancelled: true, reply: 'Va bene, signore. Mi dica pure il nome esatto dell\'account da usare.' };
    }
  }

  // Scelta da lista ("1", "il primo", "2", "il secondo", oppure il nome dell'account)
  const ordMap = { '1': 0, primo: 0, prima: 0, '2': 1, secondo: 1, seconda: 1, '3': 2, terzo: 2, terza: 2, '4': 3, quarto: 3 };
  const ordM = /\b(?:il\s+|la\s+)?([1-4]|prim[oa]|second[oa]|terz[oa]|quart[oa])\b/i.exec(clean);
  const accounts = pending.accounts || listAccounts(db);
  if (ordM) {
    const idx = ordMap[ordM[1].toLowerCase()];
    if (idx != null && accounts[idx]) {
      kvSet(db, key, null);
      return { confirmed: true, account: accounts[idx], pending };
    }
  }

  const m = matchAccount(db, clean);
  if (m.exact) {
    saveAccount(db, m.exact);
    kvSet(db, key, null);
    return { confirmed: true, account: m.exact, pending };
  }
  if (m.suggestion) {
    // Non sicuro al 100%: ripete l'account e chiede conferma!
    setPendingAccountPrompt(db, sessionId, { ...pending, mode: 'confirm', candidate: clean, suggestion: m.suggestion }, nowMs);
    return {
      askConfirm: true,
      reply: `Ho sentito "${clean}", intendeva l'account "${m.suggestion}"? Me lo conferma?`,
    };
  }
  // Account completamente nuovo dettato dall'utente: chiede conferma ripetendo il nome!
  if (clean.length >= 2 && clean.length <= 45 && !/\b(annulla|basta|stop|lascia\s+stare)\b/i.test(clean)) {
    setPendingAccountPrompt(db, sessionId, { ...pending, mode: 'confirm', candidate: clean, suggestion: clean }, nowMs);
    return {
      askConfirm: true,
      reply: `Non trovo "${clean}" tra gli account salvati. Conferma che vuole salvare e usare il nuovo account "${clean}"?`,
    };
  }
  kvSet(db, key, null);
  return { cancelled: true, reply: 'Operazione account annullata, signore.' };
}
