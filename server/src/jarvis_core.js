// JARVIS CORE: motore cognitivo proprietario e Amministratore Autonomo interno a Jarvis.
// Agisce in prima persona (prima e sopra i modelli LLM esterni) con:
// 1. Auto-interrogazione autonoma a zero crediti (selfInterrogate): controlla salute modelli, RAM/CPU dispositivi,
//    pulizia grafo e compiti in sospeso, prendendo iniziativa in caso di necessità senza sprecare token LLM;
// 2. Diagnostica completa con grafica in sovraimpressione (visual overlay);
// 3. Controllo autonomo di Antigravity / VS Code su progetti del PC con cattura e invio dello schermo PC in sovraimpressione;
// 4. Esecuzione procedurale istantanea e orchestrazione multi-dispositivo (PC Ghideon + Smartphone).

import { kvGet, kvSet, pushInbox } from './db.js';
import * as flows from './flows.js';
import * as devices from './devices.js';
import * as memory from './memory.js';
import * as router from './router.js';
import * as agents from './agents.js';
import { nowIso as nowIsoOf } from './clock.js';

const BASE_PC_RE = /\b(pc|computer|desktop|portatile|windows|gh?ideon|antigravit\w*|chrome|profilo\s+chrome|account\s+chrome)\b/i;
const DIAGNOSTIC_RE = /\b(diagnostic\w*|stato\s+del\s+(?:pc|computer|sistema|gh?ideon|jarvis)|dispositiv[io]\s+conness\w*|come\s+sta\s+il\s+(?:pc|sistema)|quanta\s+ram|cpu\s+del\s+pc|controllo\s+sistema|report\s+sistema)\b/i;
const PC_SCREEN_RE = /\b(mostra(?:mi)?\s+lo\s+schermo|fa(?:mmi|i)\s+vedere\s+lo\s+schermo|screenshot\s+(?:del\s+)?(?:pc|computer|gh?ideon)|schermo\s+del\s+(?:pc|computer|gh?ideon)|cosa\s+c'[eè]\s+sullo\s+schermo)\b/i;
const LIVE_CALL_RE = /\b(video\s*chiamat\w*|video\s*call|modalit[aà]\s+live|live\s+vision|in\s+diretta|dal\s+vivo|ti\s+devo\s+far\s+vedere|devo\s+farti\s+vedere|guarda\s+con\s+la\s+(?:tele)?camera)\b/i;
const ANTIGRAVITY_RE = /\b(?:antigravit\w*|anti\s+gravit\w*)\b/i;
const TIMED_ACTION_RE = /^\W*(?:ehi\s+|ciao\s+|ok\s+)?(?:jarvis\s+)?tra\s+(\d{1,3})\s*(second\w*|minut\w*|or[ae])\s+(.{2,240})$/i;
const TIMER_RE = /^\W*(?:ehi\s+|ciao\s+|ok\s+)?(?:jarvis\s+)?(?:metti|imposta|avvia|fai\s+partire|crea)\s+(?:un\s+)?(timer|conto\s+alla\s+rovescia|cronometro)\s*(?:di|da)?\s*(?:(\d{1,3})\s*(second\w*|minut\w*|or[ae]))?(?:\s+(?:per|di|chiamato)\s+(.{2,100}))?\W*$/i;
const PASSPHRASE_RE = /^\W*(?:la\s+parola\s+d'ordine\s+[eè]\s+|parola\s+d'ordine\s+)?niente\s+pi[uù]\s+fili\W*$/i;
const SELF_PROMPT_ECHO_RE = /^\W*(?:parola\s+d'ordine(?:\s+non\s+corretta.*)?|certamente\s+signore.*|subito\s+signore.*|ricevuto\s+signore.*|ottimo\s+lavoro\s+signore.*|ho\s+avviato\s+la\s+riproduzione.*|signore\s+ho\s+riscontrato.*)\W*$/i;

const WEB_SERVICES = {
  youtube: 'https://www.youtube.com',
  prime: 'https://www.primevideo.com',
  'prime video': 'https://www.primevideo.com',
  gmail: 'https://mail.google.com',
  instagram: 'https://www.instagram.com',
  whatsapp: 'https://web.whatsapp.com',
  netflix: 'https://www.netflix.com',
  twitch: 'https://www.twitch.com',
  github: 'https://github.com',
  chatgpt: 'https://chatgpt.com',
  maps: 'https://maps.google.com',
  google: 'https://www.google.com',
  amazon: 'https://www.amazon.it',
  wikipedia: 'https://it.wikipedia.org',
  spotify: 'https://open.spotify.com',
  drive: 'https://drive.google.com',
  docs: 'https://docs.google.com',
  gemini: 'https://gemini.google.com',
  facebook: 'https://www.facebook.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
};

const LIVE_CARDS_KEY = 'liveCards';
const LIVE_KINDS = new Set(['countdown', 'stopwatch', 'progress', 'counter', 'metric', 'checklist']);
const FOCUS_TTL_MS = 15 * 60_000;

/** Legge il puntatore gerarchico di contesto attivo per la sessione (es. dispositivo(pc(chrome · apri))). */
export function getFocus(db, sessionId = 'main', nowMs = Date.now()) {
  const f = kvGet(db, `focus:${sessionId}`, null);
  if (!f || (nowMs - Number(f.updatedAt || 0)) > FOCUS_TTL_MS) return null;
  return f;
}

/** Aggiorna la "sotto-cartella" di contesto attivo senza appesantire la memoria o la cronologia. */
export function setFocus(db, sessionId = 'main', patch = {}, nowMs = Date.now()) {
  const prev = getFocus(db, sessionId, nowMs) || {};
  const next = {
    domain: patch.domain || prev.domain || 'generale',
    device: patch.device !== undefined ? patch.device : (prev.device || null),
    target: patch.target !== undefined ? String(patch.target || '').slice(0, 60) : (prev.target || ''),
    action: patch.action !== undefined ? String(patch.action || '').slice(0, 30) : (prev.action || ''),
    profile: patch.profile !== undefined ? String(patch.profile || '').slice(0, 40) : (prev.profile || ''),
    updatedAt: nowMs,
  };
  const inner = [next.target, next.profile ? `profilo: ${next.profile}` : '', next.action].filter(Boolean).join(' · ');
  next.path = next.device
    ? `${next.domain}(${next.device}(${inner || 'attivo'}))`
    : `${next.domain}(${inner || 'attivo'})`;
  kvSet(db, `focus:${sessionId}`, next);
  return next;
}

/** Una sola riga compatta per il prompt LLM: mantiene la coerenza sul ramo/dispositivo/oggetto attivo a costo zero. */
export function focusPromptLine(db, sessionId = 'main', nowMs = Date.now()) {
  const f = getFocus(db, sessionId, nowMs);
  if (!f) return '';
  return `CONTESTO ATTIVO (grafo): ${f.path} — se l'utente continua sullo stesso argomento/dispositivo senza specificarlo, resta in questo percorso; se chiede di cambiare dispositivo (es. telefono/pc), sposta lì l'azione sullo stesso oggetto.`;
}

// ------------------------------------------------------------------ Fix Latenti (registro automatico problemi ricorrenti)

const FIX_LATENTI_KEY = 'fixLatenti';
const ISSUE_HINT_RE = /\b(non\s+funzion\w*|non\s+parte|non\s+apre|non\s+va\b|non\s+sta\s+funzionando|non\s+riesc\w*|errore\s*\d*|ancora\s+niente|non\s+l'ha\s+(?:aperto|fatto)|non\s+hai\s+(?:aperto|fatto|selezionato)|vedo\s+solo\s+che|trovata\s+una\s+soluzione|non\s+va\s+bene|bloccato|si\s+blocca|non\s+risponde|perch[eé]\s+non)\b/i;

export function listFixLatenti(db) {
  return kvGet(db, FIX_LATENTI_KEY, []);
}

/**
 * Rileva automaticamente quando qualcosa non funziona o l'utente insiste sullo stesso problema,
 * e aggiorna il documento "fix latenti" raggruppando gli scambi sotto un titolo chiaro.
 */
export function maybeLogLatentIssue(db, sessionId = 'main', userText = '', nowMs = Date.now(), tz = 'Europe/Rome') {
  const clean = String(userText || '').trim();
  if (!clean) return false;
  const focus = getFocus(db, sessionId, nowMs);
  const recent = db.all('SELECT role, text, at, meta FROM messages WHERE session = ? ORDER BY id DESC LIMIT 8', sessionId).reverse();
  const recentUsers = recent.filter(m => m.role === 'user').slice(-4);
  const target = (focus?.target || '').trim();
  const repeatedTarget = target.length >= 3 && recentUsers.filter(m => m.text.toLowerCase().includes(target.toLowerCase())).length >= 3;

  if (!ISSUE_HINT_RE.test(clean) && !repeatedTarget) return false;

  const atIso = nowIsoOf(nowMs, tz);
  const topicKey = `${focus?.domain || 'generale'}:${(target || clean.slice(0, 32)).toLowerCase()}`;
  const title = target
    ? `Problema su: ${target}${focus?.device ? ` (${focus.device.toUpperCase()})` : ''}`
    : `Problema: ${clean.slice(0, 60)}`;

  const list = listFixLatenti(db);
  const idx = list.findIndex(x => x.topicKey === topicKey && (nowMs - Number(x.updatedMs || 0)) < 45 * 60_000);
  const existing = idx >= 0 ? list[idx] : {
    id: `fix-${nowMs}`,
    topicKey,
    title,
    createdAt: atIso,
    messages: [],
    errors: [],
  };

  const seen = new Set((existing.messages || []).map(m => `${m.role}|${m.at}|${m.text.slice(0, 80)}`));
  const merged = [...(existing.messages || [])];
  for (const m of recent) {
    let model = '';
    try { model = JSON.parse(m.meta || '{}').model || ''; } catch {}
    const sig = `${m.role}|${m.at}|${String(m.text || '').slice(0, 80)}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      merged.push({ at: m.at, role: m.role, model, text: String(m.text || '').slice(0, 500) });
    }
  }

  const recentErrs = db.all("SELECT at, text FROM events WHERE kind = 'error' ORDER BY id DESC LIMIT 3")
    .map(e => `[${e.at}] ${String(e.text || '').slice(0, 180)}`);
  const entry = {
    ...existing,
    title,
    updatedAt: atIso,
    updatedMs: nowMs,
    messages: merged.slice(-24),
    errors: [...new Set([...(existing.errors || []), ...recentErrs])].slice(-6),
  };

  const next = idx >= 0 ? [entry, ...list.filter((_, i) => i !== idx)] : [entry, ...list];
  kvSet(db, FIX_LATENTI_KEY, next.slice(0, 40));
  return true;
}

/** Genera il documento Markdown completo "fix latenti" pronto per analisi e correzioni. */
export function renderFixLatentiMarkdown(db) {
  const list = listFixLatenti(db);
  if (!list.length) return '# Fix Latenti\n\nNessun problema aperto registrato.\n';
  const blocks = list.map(item => {
    const lines = [
      `## ${item.title}`,
      `- **Aggiornato:** ${item.updatedAt} (creato: ${item.createdAt})`,
      ...(item.errors?.length ? ['- **Errori tecnici rilevati:**', ...item.errors.map(e => `  - ${e}`)] : []),
      '',
      '### Scambi messaggi',
      ...(item.messages || []).map(m => `- **${m.at} [${m.role}${m.model ? ` · ${m.model}` : ''}]:** ${m.text.replace(/\n+/g, ' ')}`),
    ];
    return lines.join('\n');
  });
  return `# Fix Latenti — Registro Automatico Problemi\n\n${blocks.join('\n\n---\n\n')}\n`;
}

/** Gestisce le schede vive modulari (create dinamicamente da Jarvis Core o dall'IA). */
export function applyLiveCard(db, a = {}, nowMs = Date.now()) {
  const op = String(a.op || 'set').toLowerCase();
  const list = kvGet(db, LIVE_CARDS_KEY, []).filter(c => !c.expiresAt || Number(c.expiresAt) > nowMs);
  const id = String(a.id || '').trim().slice(0, 60) || `card-${nowMs}`;

  if (op === 'remove' || op === 'delete') {
    kvSet(db, LIVE_CARDS_KEY, list.filter(c => c.id !== id));
    return true;
  }
  if (op === 'bump') {
    const idx = list.findIndex(c => c.id === id);
    if (idx < 0) return false;
    list[idx].value = (Number(list[idx].value) || 0) + (Number(a.delta) || 1);
    list[idx].updatedAt = nowMs;
    kvSet(db, LIVE_CARDS_KEY, list);
    return true;
  }
  if (op === 'toggle') {
    const idx = list.findIndex(c => c.id === id);
    const itemIdx = Number(a.index);
    if (idx < 0 || !Array.isArray(list[idx].items) || !list[idx].items[itemIdx]) return false;
    list[idx].items[itemIdx].done = !list[idx].items[itemIdx].done;
    list[idx].updatedAt = nowMs;
    kvSet(db, LIVE_CARDS_KEY, list);
    return true;
  }

  const kind = LIVE_KINDS.has(String(a.kind || '').toLowerCase()) ? String(a.kind).toLowerCase() : 'metric';
  const title = String(a.title || a.label || 'Attività').trim().slice(0, 70);
  const sec = Number(a.seconds);
  const card = {
    id,
    kind,
    title,
    subtitle: String(a.subtitle || a.text || '').trim().slice(0, 120),
    badge: String(a.badge || '').trim().slice(0, 24),
    unit: String(a.unit || '').trim().slice(0, 16),
    value: a.value != null ? Number(a.value) : 0,
    max: a.max != null ? Number(a.max) : null,
    targetMs: kind === 'countdown' ? (Number(a.targetMs) || (sec > 0 ? nowMs + sec * 1000 : nowMs + 60_000)) : null,
    startMs: kind === 'stopwatch' ? (Number(a.startMs) || nowMs) : null,
    items: Array.isArray(a.items) ? a.items.slice(0, 12).map(it => ({ label: String(it?.label || it || '').slice(0, 80), done: !!it?.done })).filter(it => it.label) : [],
    expiresAt: a.expiresAt ? Number(a.expiresAt) : (kind === 'countdown' && sec > 0 ? nowMs + sec * 1000 + 30_000 : null),
    updatedAt: nowMs,
  };
  kvSet(db, LIVE_CARDS_KEY, [card, ...list.filter(c => c.id !== id)].slice(0, 16));
  return true;
}

/**
 * Restituisce TUTTE le attività attive e modulari in questo istante:
 * schede dinamiche create dall'IA/utente, timer in scadenza, dispositivi online e progetti in corso.
 */
export function listLiveCards(db, nowMs = Date.now()) {
  const saved = kvGet(db, LIVE_CARDS_KEY, []).filter(c => !c.expiresAt || Number(c.expiresAt) > nowMs);
  const out = [...saved];
  const ids = new Set(out.map(c => c.id));

  for (const t of kvGet(db, 'timedActions', [])) {
    if (Number(t.dueMs) <= nowMs) continue;
    const id = String(t.id);
    if (!ids.has(id)) {
      ids.add(id);
      out.push({
        id, kind: 'countdown', title: t.command || 'Attività programmata',
        subtitle: 'Esecuzione automatica allo scadere', badge: 'Timer',
        targetMs: Number(t.dueMs), updatedAt: Number(t.createdAt || nowMs),
      });
    }
  }
  for (const d of devices.listDevices(db, nowMs)) {
    if (!d.online) continue;
    const id = `dev-${d.id}`;
    if (!ids.has(id)) {
      ids.add(id);
      out.push({
        id, kind: 'progress', title: `${d.name} (${d.platform || d.kind})`,
        subtitle: d.metrics?.activeWindow ? `Finestra: ${d.metrics.activeWindow}` : 'Online in background',
        badge: 'Online', value: Number(d.metrics?.ram || 0), max: 100, unit: '% RAM',
        system: true,
      });
    }
  }
  return out;
}

/**
 * Esegue le attività temporizzate scadute ("tra X minuti apri...", "tra X minuti fai partire...").
 * Ritorna la scadenza (ms) della prossima attività temporizzata in coda, oppure null.
 */
export function fireDueTimedActions(db, env = {}, nowMs = Date.now(), tz = 'Europe/Rome') {
  const list = kvGet(db, 'timedActions', []);
  if (!list.length) return null;
  const atIso = nowIsoOf(nowMs, tz);
  const remaining = [];
  for (const item of list) {
    if (Number(item.dueMs) <= nowMs) {
      applyLiveCard(db, { op: 'remove', id: item.id }, nowMs);
      const cmd = String(item.command || '').trim();
      if (item.kind === 'timer') {
        pushInbox(db, atIso, 'timed', `Signore, il timer "${cmd}" è scaduto!`);
      } else if (isPcTarget(db, cmd) || ANTIGRAVITY_RE.test(cmd)) {
        handleCoreIntent(db, cmd, nowMs, env);
        pushInbox(db, atIso, 'timed', `Signore, come programmato ho eseguito sul PC: "${cmd}".`);
      } else {
        pushInbox(db, atIso, 'timed', `[PHONE_TASK:${cmd}] Signore, avvio l'attività programmata: "${cmd}".`);
      }
    } else {
      remaining.push(item);
    }
  }
  if (remaining.length !== list.length) kvSet(db, 'timedActions', remaining);
  return remaining.length ? Math.min(...remaining.map(x => Number(x.dueMs))) : null;
}

/**
 * Meccanismo di Auto-Interrogazione e Iniziativa Autonoma (Timer interno ~1.5 min, Zero Crediti LLM).
 * Gira in background su timer e heartbeat: esegue attività temporizzate scadute, controlla compiti/messaggi
 * in sospeso, ripara i modelli bloccati da errori transitori, isola i modelli ritirati (404/410),
 * sorveglia le risorse del PC/Telefono e mantiene ordinato il grafo.
 */
export function selfInterrogate(db, env = {}, nowMs = Date.now(), tz = 'Europe/Rome') {
  const nextTimed = fireDueTimedActions(db, env, nowMs, tz);
  const lastRun = Number(kvGet(db, 'lastSelfInterrogateMs', 0));
  if (nowMs - lastRun < 45_000) return { ran: false, nextTimed };
  kvSet(db, 'lastSelfInterrogateMs', nowMs);

  const actionsTaken = [];
  const atIso = nowIsoOf(nowMs, tz);

  // 0. Controllo attività sul telefono rimaste in sospeso (phonePending):
  const pendingPhone = kvGet(db, 'phonePending', null);
  if (pendingPhone && pendingPhone.goal && nowMs - Number(pendingPhone.at || 0) > 90_000 && nowMs - Number(pendingPhone.at || 0) < 10 * 60_000) {
    const alerted = kvGet(db, 'phonePendingAlerted', 0);
    if (Number(alerted) !== Number(pendingPhone.at)) {
      kvSet(db, 'phonePendingAlerted', pendingPhone.at);
      pushInbox(db, atIso, 'admin', `Signore, ho ancora in sospeso l'attività "${pendingPhone.goal}". Vuole che proceda?`);
      actionsTaken.push(`notificato compito in sospeso: ${pendingPhone.goal}`);
    }
  }

  // 1. Auto-guarigione dei modelli e salvaguardia crediti:
  // - Sblocca i modelli principali (es. Gemini) se erano in pausa per un picco 503/timeout ormai passato (> 90s);
  // - Isola per 24h i modelli con errore 410 (Gone / End-of-Life) o 404 (non più gratuiti) così non rallentano Jarvis.
  try {
    const states = db.all('SELECT * FROM model_state');
    for (const st of states) {
      const err = String(st.last_error || '');
      if (/^(404|410)\b/.test(err) && st.blocked_until < nowMs + 12 * 3600_000) {
        db.run('UPDATE model_state SET blocked_until = ? WHERE model_key = ?', nowMs + 24 * 3600_000, st.model_key);
        actionsTaken.push(`isolato modello obsoleto ${st.model_key}`);
      } else if (/^(0|500|502|503|504)\b/.test(err) && st.blocked_until > nowMs && nowMs - Number(st.updated || 0) > 90_000) {
        db.run('UPDATE model_state SET blocked_until = 0, fails = 0 WHERE model_key = ?', st.model_key);
        actionsTaken.push(`riattivato modello ${st.model_key}`);
      }
    }
  } catch { /* tabella non pronta */ }

  // 2. Sorveglianza autonoma dispositivi (es. RAM/CPU critica sul PC Ghideon):
  const devs = devices.listDevices(db, nowMs);
  for (const d of devs) {
    if (!d.online) continue;
    const ram = Number(d.metrics?.ram || 0);
    if (ram >= 90) {
      const lastAlert = Number(kvGet(db, `ramAlert:${d.id}`, 0));
      if (nowMs - lastAlert > 60 * 60_000) {
        kvSet(db, `ramAlert:${d.id}`, nowMs);
        pushInbox(db, atIso, 'admin', `Signore, ho rilevato che su ${d.name} la RAM è al ${ram}%. Se vuole posso chiudere le applicazioni superflue.`);
        actionsTaken.push(`avviso RAM critica su ${d.name} (${ram}%)`);
      }
    }
  }

  // 3. Igiene periodica del grafo e delle automazioni (ogni 10 minuti, zero crediti):
  const lastTidy = Number(kvGet(db, 'lastAutoTidyMs', 0));
  if (nowMs - lastTidy > 10 * 60_000) {
    kvSet(db, 'lastAutoTidyMs', nowMs);
    const merged = memory.tidyTopics(db);
    const pruned = agents.FlowAgent.prune(db);
    if (merged > 0 || pruned > 0) actionsTaken.push(`grafo ottimizzato (${merged} uniti, ${pruned} flow potati)`);
  }

  return { ran: true, actionsTaken, nextTimed };
}

/** Costruisce il rapporto diagnostico completo con grafica in sovraimpressione (visual). */
export function buildDiagnosticReport(db, env = {}, nowMs = Date.now()) {
  selfInterrogate(db, env, nowMs);
  const devs = devices.listDevices(db, nowMs);
  const pc = devs.find(d => d.kind === 'desktop');
  const mStatus = router.status(db, env, nowMs).filter(m => m.configured);
  const healthyModels = mStatus.filter(m => m.blockedForSec === 0 && !/^(404|410)\b/.test(m.lastError || ''));
  const blockedModels = mStatus.filter(m => m.blockedForSec > 0 || /^(404|410)\b/.test(m.lastError || ''));
  const learnedFlows = flows.listFlows(db).length + flows.listAutoGoals(db).length;
  const modulesCount = memory.listModules(db).length;

  const items = [];
  if (pc) {
    items.push({ label: `${pc.name} (${pc.online ? 'Online' : 'Offline'})`, value: Number(pc.metrics?.ram || 0) });
  } else {
    items.push({ label: 'PC Desktop (Offline)', value: 0 });
  }
  items.push({ label: `Modelli IA attivi (${healthyModels.length}/${mStatus.length})`, value: Math.round((healthyModels.length / Math.max(1, mStatus.length)) * 100) });
  const primaryLoad = healthyModels[0]?.load ?? 0;
  items.push({ label: `Crediti disponibili (${healthyModels[0]?.provider || 'IA'})`, value: Math.max(0, 100 - primaryLoad) });
  items.push({ label: `Automazioni (${learnedFlows}) e Dipartimenti (${modulesCount})`, value: Math.min(100, learnedFlows * 10 + modulesCount * 5) });

  const visual = {
    kind: 'bars',
    title: 'Diagnostica Sistema • Jarvis Core',
    unit: '%',
    seconds: 20,
    items,
    text: pc?.online
      ? `Finestra attiva su ${pc.name}: "${pc.metrics?.activeWindow || 'Desktop'}" · Modelli in pausa/EOL: ${blockedModels.length}`
      : `Modelli operativi: ${healthyModels.map(m => m.model).slice(0, 3).join(', ')}`,
  };

  const pcPart = pc
    ? `${pc.name} è ${pc.online ? `online con RAM al ${Math.round(Number(pc.metrics?.ram || 0))}%` : 'offline'}`
    : 'il PC Desktop non è connesso';
  const reply = `Diagnostica completata, signore: ${pcPart}; ${healthyModels.length} modelli IA sono operativi con pieno risparmio crediti (${blockedModels.length} obsoleti isolati in automatico) e ${learnedFlows} automazioni sono pronte.`;

  return {
    reply,
    visual,
    device: [{ type: 'visual', data: visual }],
    actions: ['core_diagnostic', 'show'],
    touched: ['automazioni', 'tecnologia'],
    touchedLeaves: [],
  };
}

/** Verifica se il testo si riferisce al PC Desktop (qualsiasi preposizione: "sul pc", "da pc", "al pc", "gideon", "ghideon", "antigravity"). */
export function isPcTarget(db, text) {
  const s = String(text || '');
  if (BASE_PC_RE.test(s)) return true;
  const low = s.toLowerCase();
  for (const d of devices.listDevices(db)) {
    if (d.kind === 'desktop' && d.name) {
      const cleanName = d.name.toLowerCase().replace(/^pc\s+/i, '').trim();
      if (cleanName.length >= 3 && low.includes(cleanName)) return true;
    }
  }
  return false;
}

function stripPcWords(db, text) {
  let out = String(text || '')
    .replace(/\b(?:su|sul|sullo|in|nel|da|dal|al|il|lo|col|con\s+il)?\s*(?:pc|computer|desktop|portatile|windows|gh?ideon)(?:\s+(?:gh?ideon|pc|computer|desktop))?\b/gi, ' ');
  for (const d of devices.listDevices(db)) {
    if (d.kind === 'desktop' && d.name) {
      const cleanName = d.name.replace(/^PC\s+/i, '').trim();
      if (cleanName.length >= 3) {
        const esc = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`\\b(?:su|sul|in|nel|da|dal|al|il)?\\s*(?:pc\\s+)?${esc}\\b`, 'gi'), ' ');
      }
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Invia l'apertura di un'app o servizio web al PC Desktop. */
export function dispatchPcOpen(db, rawTarget, nowMs = Date.now()) {
  const clean = String(rawTarget || '').replace(/[.!?]+$/, '').trim();
  if (!clean) return null;
  const low = clean.toLowerCase();
  const webUrl = WEB_SERVICES[low];
  const reg = flows.registerAutoGoal(db, `PC: apri ${clean}`, nowMs);
  if (webUrl) {
    devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: webUrl }, nowMs);
  } else {
    devices.enqueueCommand(db, 'desktop', { kind: 'open_app', target: clean }, nowMs);
  }
  memory.touchTopics(db, [{ area: 'tecnologia', topic: clean, parent: 'PC Desktop' }], new Date(nowMs).toISOString());
  return {
    reply: `Apro ${clean} sul PC, signore.`,
    device: [], actions: ['pc_action'],
    touched: ['automazioni', 'tecnologia'],
    touchedLeaves: reg ? ['f:' + reg.id] : [],
  };
}

/** Invia al PC l'ordine di cercare e far partire direttamente un video o una canzone su YouTube. */
export function dispatchPcPlayYoutube(db, rawQuery, nowMs = Date.now()) {
  let q = String(rawQuery || '')
    .replace(/\b(?:apri\s+youtube\s+e\s+|vai\s+su\s+youtube\s+e\s+|su\s+youtube|da\s+youtube|in\s+youtube)\b/gi, ' ')
    .replace(/^(?:fai\s+partire|fammi\s+partire|metti(?:mi)?|riproduci|avvia|cerca|ascolta)\s+/i, ' ')
    .replace(/^(?:un\s+video\s+di|un\s+video\s+su|una\s+canzone\s+di|musica\s+di)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!q || /^(?:un\s+video|qualcosa|un\s+film|una\s+musica|musica|video|film(?:\s+su)?)$/i.test(q)) {
    q = /film/i.test(q) ? 'film completo ita' : 'musica rilassante mix';
  }
  const reg = flows.registerAutoGoal(db, `PC YouTube: ${q}`, nowMs);
  devices.enqueueCommand(db, 'desktop', { kind: 'play_youtube', target: q }, nowMs);
  memory.touchTopics(db, [{ area: 'intrattenimento', topic: q, parent: 'YouTube' }], new Date(nowMs).toISOString());
  return {
    reply: `Faccio partire "${q}" su YouTube sul PC, signore.`,
    device: [], actions: ['pc_action'],
    touched: ['automazioni', 'intrattenimento'],
    touchedLeaves: reg ? ['f:' + reg.id] : [],
  };
}

/** Avvia un task su Antigravity sul progetto richiesto sul PC e mostra lo schermo del PC in sovraimpressione! */
export function dispatchAntigravityTask(db, userText, nowMs = Date.now()) {
  const s = String(userText || '').replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').trim();
  const projMatch = /\b(?:sul\s+progetto|progetto|cartella|repo)\s+([a-z0-9_.-]+)/i.exec(s);
  const project = projMatch ? projMatch[1] : 'Jarvis-Cast';
  let taskPrompt = s
    .replace(/^.*?\b(?:antigravit\w*|anti\s+gravit\w*)\b\s*/i, '')
    .replace(/\b(?:sul\s+progetto|progetto)\s+[a-z0-9_.-]+\b/i, '')
    .replace(/^(?:per|di|che|su|:|-)\s+/i, '')
    .trim();
  if (!taskPrompt) taskPrompt = s;

  const reg = flows.registerAutoGoal(db, `Antigravity: ${project}`, nowMs);
  devices.enqueueCommand(db, 'desktop', { kind: 'antigravity_task', target: project, args: taskPrompt }, nowMs);
  memory.touchTopics(db, [{ area: 'programmazione', topic: project, parent: 'Antigravity' }], new Date(nowMs).toISOString());

  const visual = {
    kind: 'image',
    title: `Antigravity • Progetto ${project} (Schermo PC)`,
    url: `/api/devices/screen?t=${nowMs}`,
    seconds: 25,
    text: `Task avviato: "${taskPrompt.slice(0, 100)}"`,
  };
  return {
    reply: `Avvio subito Antigravity sul progetto ${project} sul PC e le mostro lo schermo in sovraimpressione, signore.`,
    visual,
    device: [{ type: 'visual', data: visual }],
    actions: ['pc_action', 'show'],
    touched: ['automazioni', 'programmazione'],
    touchedLeaves: reg ? ['f:' + reg.id] : [],
  };
}

/** Richiede uno screenshot live dello schermo del PC e lo mostra in sovraimpressione. */
export function dispatchPcScreenView(db, nowMs = Date.now()) {
  devices.enqueueCommand(db, 'desktop', { kind: 'capture_screen', target: 'screen' }, nowMs);
  const visual = {
    kind: 'image',
    title: 'Schermo PC (Live)',
    url: `/api/devices/screen?t=${nowMs}`,
    seconds: 25,
  };
  return {
    reply: 'Catturo e le mostro subito lo schermo del PC in sovraimpressione, signore.',
    visual,
    device: [{ type: 'visual', data: visual }],
    actions: ['pc_action', 'show'],
    touched: ['automazioni'],
    touchedLeaves: [],
  };
}

/**
 * Riconosce comandi diretti al PC Desktop, Antigravity, diagnostica, cattura schermo o parola d'ordine
 * e li esegue localmente tramite il nucleo proprietario Jarvis Core (zero chiamate a modelli esterni).
 */
export function handleCoreIntent(db, userText, nowMs = Date.now(), env = {}, sessionId = 'main') {
  const raw = String(userText || '').trim();
  if (!raw) return null;

  // 0. Eco della voce di Jarvis stessa catturata dal microfono: ignorala senza fare nulla.
  if (SELF_PROMPT_ECHO_RE.test(raw)) {
    return {
      reply: '',
      device: [], actions: [], touched: [], touchedLeaves: [],
    };
  }

  // 1. L'utente ha pronunciato "niente più fili": autorizza ed esegue subito l'ultima azione richiesta!
  if (PASSPHRASE_RE.test(raw)) {
    const lastPhoneGoal = kvGet(db, 'lastPhoneGoal', null);
    const recentUser = db.all("SELECT text FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 6")
      .map(r => String(r.text || '').trim())
      .find(t => !PASSPHRASE_RE.test(t) && !SELF_PROMPT_ECHO_RE.test(t));
    const goal = lastPhoneGoal || recentUser || '';
    if (goal) {
      const reg = flows.registerAutoGoal(db, goal, nowMs);
      return {
        reply: `Parola d'ordine confermata, signore. Eseguo subito.`,
        device: [{ type: 'phone_task', goal }],
        actions: ['phone_task'],
        touched: ['automazioni'],
        touchedLeaves: reg ? ['f:' + reg.id] : [],
      };
    }
    return {
      reply: 'Parola d\'ordine confermata, signore.',
      device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
    };
  }

  const clean = raw.replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').replace(/\bniente\s+pi[uù]\s+fili\b/gi, '').trim();
  if (!clean) return null;

  // 1a. Conferma salvataggio automatismo a step appena eseguito ("sì, ha funzionato" / "no")
  const skillConfirm = flows.confirmPendingSkill(db, sessionId, clean, nowMs);
  if (skillConfirm) {
    if (!skillConfirm.saved) maybeLogLatentIssue(db, sessionId, raw, nowMs, tz);
    return {
      reply: skillConfirm.reply,
      device: [],
      actions: skillConfirm.saved ? ['save_skill'] : [],
      touched: ['automazioni'],
      touchedLeaves: skillConfirm.skill ? ['f:' + skillConfirm.skill.id] : [],
    };
  }

  // 1a-bis. Risposta a scelta o conferma account ("alexx cast", "1", "il secondo", "sì confermo")
  const accReply = flows.resolvePendingAccount(db, sessionId, clean, nowMs);
  if (accReply) {
    if (accReply.askConfirm || accReply.cancelled) {
      return { reply: accReply.reply, expectReply: !!accReply.askConfirm, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (accReply.confirmed && accReply.account) {
      const p = accReply.pending || {};
      const shouldPersist = !!p.persist;
      devices.enqueueCommand(db, 'desktop', { kind: 'open_chrome_profile', target: accReply.account, args: shouldPersist ? 'persist' : '' }, nowMs);
      if (p.openUrl) devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: p.openUrl }, nowMs);
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: p.service || 'chrome', profile: accReply.account, action: 'apri' }, nowMs);
      return {
        reply: `Perfetto, uso l'account "${accReply.account}"${p.service && p.service !== 'chrome' ? ` e apro ${p.service}` : ' su Chrome'}, signore.`,
        device: [], actions: ['pc_action'], touched: ['automazioni', 'tecnologia'], touchedLeaves: [],
      };
    }
  }

  // 1b. Timer o Cronometro esplicito ("metti un timer di 5 minuti", "avvia un cronometro")
  const timerMatch = TIMER_RE.exec(clean);
  if (timerMatch) {
    const isStopwatch = /cronometro/i.test(timerMatch[1]);
    const label = (timerMatch[4] || (isStopwatch ? 'Cronometro' : 'Timer')).trim();
    if (isStopwatch) {
      applyLiveCard(db, { op: 'set', id: `sw-${nowMs}`, kind: 'stopwatch', title: label, subtitle: 'In esecuzione', badge: 'Live', startMs: nowMs }, nowMs);
      return {
        reply: `Ho avviato il cronometro "${label}", signore. Può vedere il tempo scorrere in diretta nella schermata principale.`,
        device: [], actions: ['live_card'], touched: ['agenda'], touchedLeaves: [],
      };
    }
    const amount = Math.max(1, Number(timerMatch[2]) || 1);
    const unit = (timerMatch[3] || 'minuti').toLowerCase();
    const delayMs = unit.startsWith('second') ? amount * 1000 : unit.startsWith('or') ? amount * 3600_000 : amount * 60_000;
    const dueMs = nowMs + delayMs;
    const list = kvGet(db, 'timedActions', []);
    const entry = { id: `ta-${nowMs}`, kind: 'timer', dueMs, command: label, createdAt: nowMs };
    kvSet(db, 'timedActions', [...list.slice(-20), entry]);
    applyLiveCard(db, { op: 'set', id: entry.id, kind: 'countdown', title: label, subtitle: `Durata: ${amount} ${unit}`, badge: 'Timer', targetMs: dueMs, expiresAt: dueMs + 30_000 }, nowMs);
    return {
      reply: `Timer da ${amount} ${unit} avviato, signore. Lo vede scorrere in diretta sullo schermo.`,
      device: [], actions: ['live_card', 'timed_action'], touched: ['agenda'], touchedLeaves: [], scheduleAt: dueMs,
    };
  }

  // 1c. Attività temporizzate ("tra 2 minuti apri YouTube sul PC", "tra 5 minuti metti musica rilassante"):
  const timedMatch = TIMED_ACTION_RE.exec(clean);
  if (timedMatch && !/\b(ricordami|promemoria|sveglia)\b/i.test(timedMatch[3])) {
    const amount = Math.max(1, Number(timedMatch[1]) || 1);
    const unit = timedMatch[2].toLowerCase();
    const delayMs = unit.startsWith('second') ? amount * 1000 : unit.startsWith('or') ? amount * 3600_000 : amount * 60_000;
    const innerCmd = timedMatch[3].trim();
    const dueMs = nowMs + delayMs;
    const list = kvGet(db, 'timedActions', []);
    const entry = { id: `ta-${nowMs}`, dueMs, command: innerCmd, createdAt: nowMs };
    kvSet(db, 'timedActions', [...list.slice(-20), entry]);
    applyLiveCard(db, { op: 'set', id: entry.id, kind: 'countdown', title: innerCmd, subtitle: 'Azione programmata', badge: 'Timer', targetMs: dueMs, expiresAt: dueMs + 30_000 }, nowMs);
    const reg = flows.registerAutoGoal(db, `Timer: ${innerCmd}`, nowMs);
    return {
      reply: `Ricevuto, signore: tra ${amount} ${timedMatch[2]} eseguirò in automatico "${innerCmd}".`,
      device: [], actions: ['timed_action', 'live_card'],
      touched: ['automazioni', 'agenda'],
      touchedLeaves: reg ? ['f:' + reg.id] : [],
      scheduleAt: dueMs,
    };
  }

  // 2. Diagnostica completa del sistema / stato PC / stato modelli (con grafica in sovraimpressione!)
  if (DIAGNOSTIC_RE.test(clean)) {
    return buildDiagnosticReport(db, env, nowMs);
  }

  // 3. Richiesta di vedere lo schermo del PC in sovraimpressione
  if (PC_SCREEN_RE.test(clean)) {
    return dispatchPcScreenView(db, nowMs);
  }

  // 3b. Modalità Video Call / Live Vision ("attiva videochiamata", "ti devo far vedere una cosa dal vivo")
  if (LIVE_CALL_RE.test(clean) && !isPcTarget(db, clean)) {
    return {
      reply: 'Attivo subito la videochiamata live, signore. Mi inquadri pure cosa vuole mostrarmi.',
      device: [{ type: 'start_live_call' }],
      actions: ['live_call'],
      touched: ['automazioni'],
      touchedLeaves: [],
    };
  }

  // 4. Task autonomo su Antigravity ("fai partire un task a Antigravity sul progetto X")
  if (ANTIGRAVITY_RE.test(clean)) {
    setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: 'antigravity', action: 'task' }, nowMs);
    return dispatchAntigravityTask(db, clean, nowMs);
  }

  const focus = getFocus(db, sessionId, nowMs);
  const PHONE_REF_RE = /\b(?:sul|al|nel|dal|su|da)\s+(?:mio\s+)?(?:telefono|cellulare|smartphone|android)\b/i;

  // 4b. Cambio contesto esplicito verso il Telefono ("ora fai la stessa cosa sul telefono", "aprilo sul telefono")
  if (PHONE_REF_RE.test(clean) && !isPcTarget(db, clean)) {
    const sameRef = /\b(?:stessa\s+cosa|lo\s+stesso|aprilo|fallo|eseguilo|mettilo|anche\s+l[iì]|anche\s+sul)\b/i.test(clean);
    if (sameRef && focus?.target) {
      const target = focus.target;
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'telefono', target, action: focus.action || 'apri' }, nowMs);
      const webUrl = WEB_SERVICES[target.toLowerCase()];
      const devAct = webUrl ? { type: 'open_url', url: webUrl } : { type: 'open_app', name: target };
      return {
        reply: `Passo al telefono e apro ${target} qui, signore.`,
        device: [devAct],
        actions: [devAct.type],
        touched: ['automazioni'],
        touchedLeaves: [],
      };
    }
    const openPhone = /^(?:per\s+favore\s+)?(?:ora\s+)?(?:apri|aprire|avvia)\s+(?:il\s+|la\s+|l')?(?:app\s+|sito\s+)?(.+?)\s+(?:sul|al|su|nel)\s+(?:telefono|cellulare|smartphone|android)/i.exec(clean);
    if (openPhone) {
      const target = openPhone[1].replace(/[.!?]+$/, '').trim();
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'telefono', target, action: 'apri' }, nowMs);
    }
  }

  // 4c. Esecuzione intelligente di un automatismo modulare a step già verificato (autocontrollo parametri, zero conferme ripetute)
  const matchedSkill = flows.findMatchingSkill(db, clean, focus?.device);
  if (matchedSkill) {
    const plan = flows.planSkillExecution(matchedSkill, clean);
    if (plan.steps.length && !plan.needsModelForFinalStep) {
      const accounts = flows.listAccounts(db);
      const usesAccount = (matchedSkill.steps || []).some(st => /\{account\}/i.test(String(st.target || '')));
      if (usesAccount && !plan.overrides.account && accounts.length >= 2 && matchedSkill.device === 'pc') {
        const urlStep = (matchedSkill.steps || []).find(st => st.kind === 'open_url');
        flows.setPendingAccountPrompt(db, sessionId, {
          mode: 'choose',
          service: matchedSkill.service,
          openUrl: urlStep ? urlStep.target : '',
          accounts,
        }, nowMs);
        const listTxt = accounts.slice(0, 5).map((a, i) => `${i + 1}) ${a}`).join(', ');
        return {
          reply: `Quale account vuole utilizzare per ${matchedSkill.service}? Salvati: ${listTxt}.`,
          expectReply: true,
          device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
        };
      }
      const devList = [];
      for (const st of plan.steps) {
        if (matchedSkill.device === 'pc') {
          devices.enqueueCommand(db, 'desktop', { kind: st.kind, target: st.target, args: st.args || '' }, nowMs);
        } else if (st.kind === 'open_url') {
          devList.push({ type: 'open_url', url: st.target });
        } else if (st.kind === 'open_app') {
          devList.push({ type: 'open_app', name: st.target });
        }
      }
      setFocus(db, sessionId, {
        domain: 'dispositivo',
        device: matchedSkill.device,
        target: matchedSkill.service,
        profile: plan.overrides.account || matchedSkill.defaults?.account || '',
        action: plan.media ? 'media' : 'apri',
      }, nowMs);
      const noteAcc = plan.accountChanged ? ` (profilo aggiornato a ${plan.overrides.account})` : '';
      const noteStop = !plan.media ? ' Mi fermo sulla schermata principale' : ` e avvio "${plan.media}"`;
      return {
        reply: `Eseguo l'automatismo "${matchedSkill.name}"${noteAcc}:${noteStop}, signore.`,
        device: devList,
        actions: matchedSkill.device === 'pc' ? ['pc_action'] : devList.map(d => d.type),
        touched: ['automazioni'],
        touchedLeaves: ['f:' + matchedSkill.id],
      };
    }
  }

  // 5. Comandi verso il PC Desktop (espliciti oppure ereditati dal contesto attivo "dispositivo(pc(...))")
  const PC_CONTINUATION_RE = /^(?:per\s+favore\s+)?(?:(?:ok|no|s[iì]|ora|adesso|poi|invece|dai)\s+){0,3}(?:apri|aprire|aprilo|aprila|avvia|avviare|lancia|chiudi|chiudere|chiudilo|chiudila|termina|cerca|cercare|trova|vai\s+su|scrivi|digita|nuova\s+scheda|chiudi\s+(?:la\s+)?(?:scheda|pagina)|ricarica|aggiorna|schermo\s+intero|scorri|cambia\s+finestra|mostra\s+desktop|minimizza|alza\s+il\s+volume|abbassa\s+il\s+volume|muto|pausa|play|prossim[ao]|precedente|blocca|fallo|falla|seleziona\s+(?:il\s+)?(?:profilo|account)|usa\s+(?:il\s+|l')?(?:profilo|account))\b/i;
  const PC_EXPLICIT_APP_RE = /^(?:per\s+favore\s+)?(?:(?:ok|no|s[iì]|ora|adesso|poi|invece|dai)\s+){0,3}(?:chiudi|chiudere|termina|apri|aprire|avvia)\s+(?:google\s+chrome|chrome|prime\s+video|prime|vscode|vs\s+code|esplora\s+file|blocco\s+note|task\s+manager)\b/i;
  const inheritPc = !isPcTarget(db, clean) && !PHONE_REF_RE.test(clean) && ((focus?.domain === 'dispositivo' && focus?.device === 'pc' && PC_CONTINUATION_RE.test(clean)) || PC_EXPLICIT_APP_RE.test(clean));

  if (isPcTarget(db, clean) || inheritPc) {
    const withoutPc = stripPcWords(db, clean);

    // Anafora contestuale ("aprilo", "sì aprila", "chiudilo", "fallo") usando focus.target o l'ultimo servizio citato nella chat
    if (/^(?:s[iì]\s+|ok\s+|ora\s+|adesso\s+)?(?:aprilo|aprila|fallo|falla|eseguilo|eseguila|chiudilo|chiudila)\s*$/i.test(withoutPc)) {
      const recentSvc = db.all("SELECT text FROM messages ORDER BY id DESC LIMIT 4")
        .map(r => String(r.text || ''))
        .map(t => /\b(prime\s+video|prime|youtube|netflix|twitch|spotify|whatsapp|gmail|instagram|chrome|vscode)\b/i.exec(t)?.[1])
        .find(Boolean);
      const tgt = recentSvc || focus?.target;
      if (tgt) {
        if (/chiud/i.test(withoutPc)) {
          devices.enqueueCommand(db, 'desktop', { kind: 'close_app', target: tgt }, nowMs);
          setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: tgt, action: 'chiudi' }, nowMs);
          return { reply: `Chiudo ${tgt} sul PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
        }
        setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: tgt, action: 'apri' }, nowMs);
        return dispatchPcOpen(db, tgt, nowMs);
      }
    }

    // Correzione rapida ("ma no sul pc", "aprilo sul pc", "fallo sul pc"): recupera l'azione dal messaggio precedente!
    if (/^(?:ma\s+)?(?:no\s+)?(?:aprilo|fallo|eseguilo|mettilo|cercalo)?\s*$/i.test(withoutPc)) {
      const prev = db.all("SELECT text FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 4")
        .map(r => stripPcWords(db, r.text))
        .find(t => /\b(apri|avvia|cerca|metti|fai\s+partire|fammi\s+partire|youtube|chrome|spotify|code)\b/i.test(t));
      if (prev) {
        if (/\b(video|film|musica|canzone|youtube)\b/i.test(prev) && /\b(metti|fai\s+partire|fammi\s+partire|riproduci|cerca)\b/i.test(prev)) {
          return dispatchPcPlayYoutube(db, prev, nowMs);
        }
        const mOpen = /\b(?:apri|avvia|lancia)\s+(?:l'app\s+|il\s+programma\s+)?([a-z0-9\s._-]+)/i.exec(prev);
        if (mOpen) return dispatchPcOpen(db, mOpen[1], nowMs);
      }
    }

    // Selezione o impostazione profilo Chrome ("seleziona persona 1 alessio cast su chrome", "quando apri chrome usa persona 1", "apri chrome con ale")
    const chromeProfMatch = /\bchrome\b/i.test(withoutPc) && /(?:seleziona|usa|imposta|scegli|con|su)\s+(?:il\s+|l')?(?:profilo|account)?\s*(?:di\s+)?(.{2,60})$/i.exec(
      withoutPc.replace(/\b(?:apri|aprire|avvia|su|con|chrome|google\s+chrome|quando\s+sei|e\s+devi|devi|l'account|il\s+profilo|account|profilo|per\s+favore|no)\b/gi, ' ').replace(/\s+/g, ' ').trim()
    ) || (/\bchrome\b/i.test(withoutPc) && /\b(?:persona\s*\d+|alessio(?:\s+cast(?:ronovo)?)?|alexx(?:\s+cast)?|ale)\b/i.exec(withoutPc));
    if (chromeProfMatch && /\b(profilo|account|persona\s*\d+|seleziona|usa\s+(?:il|l')|con\s+(?:il|l'))\b/i.test(withoutPc)) {
      const profName = String(chromeProfMatch[1] || chromeProfMatch[0] || '')
        .replace(/\b(?:su|in|da|con|il|la|lo|l'|account|profilo|chrome)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (profName.length >= 2) {
        const shouldPersist = /\b(quando|sempre|imposta|usa\s+sempre|di\s+default|cambia|dovrebbe\s+essere|invece)\b/i.test(clean);
        const accCheck = flows.matchAccount(db, profName);
        if (!accCheck.exact) {
          flows.setPendingAccountPrompt(db, sessionId, {
            mode: 'confirm',
            candidate: profName,
            suggestion: accCheck.suggestion || profName,
            service: 'chrome',
            persist: shouldPersist,
          }, nowMs);
          const msg = accCheck.suggestion
            ? `Non ho trovato esattamente "${profName}": intendeva l'account "${accCheck.suggestion}"? Me lo conferma?`
            : `Ho sentito il nuovo account "${profName}". Conferma che vuole salvarlo e usarlo su Chrome?`;
          return { reply: msg, expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
        }
        flows.saveAccount(db, accCheck.exact);
        devices.enqueueCommand(db, 'desktop', { kind: 'open_chrome_profile', target: accCheck.exact, args: shouldPersist ? 'persist' : '' }, nowMs);
        if (shouldPersist) {
          const skills = flows.listSkills(db).map(sk => sk.device === 'pc' ? { ...sk, defaults: { ...(sk.defaults || {}), account: accCheck.exact }, updatedAt: nowMs } : sk);
          kvSet(db, 'modularSkills', skills);
        }
        setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: 'chrome', profile: accCheck.exact, action: 'profilo' }, nowMs);
        return {
          reply: `Apro Chrome sul PC con l'account "${accCheck.exact}"${shouldPersist ? ' e lo salvo tra i suoi account predefiniti' : ''}, signore.`,
          device: [], actions: ['pc_action'], touched: ['automazioni', 'tecnologia'], touchedLeaves: [],
        };
      }
    }

    // Controlli completi di sistema, media e browser sul PC
    if (/\b(blocca|lock)\b/i.test(clean)) {
      const cmd = devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'lock', say: 'Blocco lo schermo del PC.' }, nowMs);
      return { reply: 'Blocco subito lo schermo del PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: ['f:' + cmd.id] };
    }
    if (/\b(sospendi|metti\s+in\s+standby|sleep)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'sleep' }, nowMs);
      return { reply: 'Metto il PC in sospensione, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(riavvia|reboot)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'restart' }, nowMs);
      return { reply: 'Riavvio il PC tra 10 secondi, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(spegni\s+il|spegni|shutdown)\b/i.test(withoutPc) && !/\b(monitor|schermo|app|programma)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'shutdown' }, nowMs);
      return { reply: 'Spengo il PC tra 10 secondi, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(muto|togli\s+l'audio|togli\s+audio|riattiva\s+audio|smuta)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'mute' }, nowMs);
      return { reply: 'Attivo/disattivo il muto sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(prossim[ao]\s+(?:video|brano|canzone|traccia)|avanti\s+canzone|salta\s+canzone)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'next_track' }, nowMs);
      return { reply: 'Passo alla traccia successiva sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(precedente\s+(?:video|brano|canzone|traccia)|torna\s+alla\s+canzone\s+prima)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'prev_track' }, nowMs);
      return { reply: 'Torno alla traccia precedente sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(pausa|play|ferma\s+la\s+musica|riprendi\s+la\s+musica)\b/i.test(clean) && !/\b(video|film|youtube|canzone|chrome|prime|spotify|netflix|vscode|edge|google|whatsapp|discord|app|programma)\b/i.test(clean)) {
      const cmd = devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'play_pause', say: 'Play/Pausa sul PC.' }, nowMs);
      return { reply: 'Invio il comando multimediale al PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: ['f:' + cmd.id] };
    }
    if (/^(?:play|apri)\s+(google\s+chrome|chrome|prime\s+video|prime|youtube|spotify|netflix|vscode|google)\b/i.test(withoutPc)) {
      const mPlayApp = /^(?:play|apri)\s+(google\s+chrome|chrome|prime\s+video|prime|youtube|spotify|netflix|vscode|google)\b/i.exec(withoutPc);
      const tgt = /chrome/i.test(mPlayApp[1]) ? 'chrome' : mPlayApp[1];
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: tgt, action: 'apri' }, nowMs);
      return dispatchPcOpen(db, tgt, nowMs);
    }
    if (/\b(alza\s+il\s+volume|volume\s+su)\b/i.test(clean)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'vol_up' }, nowMs);
      return { reply: 'Alzo il volume sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(abbassa\s+il\s+volume|volume\s+gi[uù])\b/i.test(clean)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'vol_down' }, nowMs);
      return { reply: 'Abbasso il volume sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Scorciatoie browser e finestre sul PC
    if (/\b(nuova\s+scheda|apri\s+una\s+scheda)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'ctrl+t' }, nowMs);
      return { reply: 'Apro una nuova scheda sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(chiudi\s+(?:la\s+)?(?:scheda|pagina)|chiudi\s+tab)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'ctrl+w' }, nowMs);
      return { reply: 'Chiudo la scheda corrente sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(ricarica|aggiorna\s+(?:la\s+)?pagina)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'f5' }, nowMs);
      return { reply: 'Aggiorno la pagina sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(torna\s+indietro|pagina\s+indietro)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'alt+left' }, nowMs);
      return { reply: 'Torno alla pagina precedente sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(schermo\s+intero|fullscreen)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'f11' }, nowMs);
      return { reply: 'Attivo/disattivo lo schermo intero sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(scorri\s+gi[uù]|scendi)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'pagedown' }, nowMs);
      return { reply: 'Scorro verso il basso sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(scorri\s+su|sali)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'pageup' }, nowMs);
      return { reply: 'Scorro verso l\'alto sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(cambia\s+finestra|alt\s+tab)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'alt+tab' }, nowMs);
      return { reply: 'Cambio finestra attiva sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(mostra\s+(?:il\s+)?desktop|minimizza\s+tutto|riduci\s+tutto)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'win+d' }, nowMs);
      return { reply: 'Mostro il desktop sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Chiusura programmi / app / siti / finestre sul PC ("chiudi chrome sul pc", "no no chiudi chrome", "chiudi tutto")
    const cleanCloseSrc = withoutPc.replace(/^(?:(?:ok|no|s[iì]|ora|adesso|poi|dai)\s+){1,3}/i, '').trim();
    const closeMatch = /^(?:per\s+favore\s+)?(?:mi\s+)?(?:chiudi|chiudere|termina|terminare|ferma|fermare|uccidi)\s+(?:il\s+|la\s+|l'|lo\s+)?(?:programma\s+|app\s+|sito\s+|finestra\s+(?:di\s+)?)?(.+)$/i.exec(cleanCloseSrc);
    if (closeMatch) {
      let target = closeMatch[1].replace(/\b(?:ho\s+chiuso|come\s+richiesto|subito|ora|adesso|di\s+nuovo|per\s+favore)\b.*$/i, '').replace(/[.!?]+$/, '').trim() || closeMatch[1].replace(/[.!?]+$/, '').trim();
      const knownClose = /\b(google\s+chrome|chrome|microsoft\s+edge|edge|vs\s*code|vscode|spotify|discord|telegram|blocco\s+note|notepad|vlc|youtube|prime\s+video|prime|netflix)\b/i.exec(target);
      if (knownClose) target = /chrome/i.test(knownClose[1]) ? 'chrome' : knownClose[1];
      const norm = /^(?:questa\s+finestra|finestra|la\s+finestra)$/i.test(target) ? 'window'
        : /^(?:tutto|tutte\s+le\s+app|tutti\s+i\s+programmi)$/i.test(target) ? 'all'
        : target;
      devices.enqueueCommand(db, 'desktop', { kind: 'close_app', target: norm }, nowMs);
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target, action: 'chiudi' }, nowMs);
      return { reply: `Chiudo ${target} sul PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Scrittura / incolla testo sul PC ("scrivi ciao a tutti sul pc")
    const typeMatch = /^(?:per\s+favore\s+)?(?:scrivi|digita|incolla)\s+(.+)$/i.exec(withoutPc);
    if (typeMatch) {
      const txt = typeMatch[1].trim();
      devices.enqueueCommand(db, 'desktop', { kind: 'type_text', target: txt }, nowMs);
      return { reply: `Scrivo sul PC: "${txt.slice(0, 60)}", signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Ricerca file o cartelle locali sul PC ("cerca file preventivo sul pc")
    const fileMatch = /^(?:per\s+favore\s+)?(?:cerca|trova)\s+(?:il\s+|un\s+|la\s+)?(?:file|documento|cartella)\s+(.+)$/i.exec(withoutPc);
    if (fileMatch) {
      const q = fileMatch[1].replace(/[.!?]+$/, '').trim();
      devices.enqueueCommand(db, 'desktop', { kind: 'search_files', target: q }, nowMs);
      return { reply: `Cerco "${q}" tra i file del PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Esecuzione comando shell esplicito sul PC ("esegui comando dir sul pc")
    const shellMatch = /^(?:esegui\s+comando|lancia\s+comando|terminale)\s+(.+)$/i.exec(withoutPc);
    if (shellMatch) {
      devices.enqueueCommand(db, 'desktop', { kind: 'shell', target: shellMatch[1].trim() }, nowMs);
      return { reply: `Eseguo il comando sul PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Far partire un video, un film o una canzone su YouTube sul PC (anche "apri youtube e fai partire un video sul pc")
    if (/\b(fai\s+partire|fammi\s+partire|metti(?:mi)?|riproduci|cerca|ascolta|avvia)\b/i.test(withoutPc) && /\b(youtube|video|film|musica|canzon\w*|brano)\b/i.test(withoutPc)) {
      return dispatchPcPlayYoutube(db, withoutPc, nowMs);
    }

    // Apertura URL o ricerca sito/web sul PC ("cerca il sito amazon", "cerca meteo roma su google", "vai su wikipedia")
    const urlMatch = /\b((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)\b/i.exec(withoutPc);
    if (urlMatch && /\b(apri|aprire|vai\s+su|visita|cerca|cercare)\b/i.test(withoutPc)) {
      const url = /^https?:\/\//i.test(urlMatch[1]) ? urlMatch[1] : 'https://' + urlMatch[1];
      devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: url }, nowMs);
      return { reply: `Apro ${urlMatch[1]} sul PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Apertura programma/app/sito sul PC ("apri YouTube su Ghideon", "aprire YouTube sul computer", "avvia VS Code sul computer")
    const openMatch = /^(?:per\s+favore\s+)?(?:mi\s+)?(?:apri|aprire|avvia|avviare|lancia|lanciare|esegui|eseguire|vai\s+su)\s+(?:il\s+|la\s+|l'|lo\s+)?(?:programma\s+|app\s+|sito\s+(?:di\s+|della\s+)?)?(.+)$/i.exec(withoutPc);
    if (openMatch) {
      const targetName = openMatch[1].replace(/[.!?]+$/, '').trim();
      const lowT = targetName.toLowerCase();
      const webUrl = WEB_SERVICES[lowT];
      const accounts = flows.listAccounts(db);
      if ((lowT === 'chrome' || webUrl) && accounts.length >= 2) {
        flows.setPendingAccountPrompt(db, sessionId, {
          mode: 'choose',
          service: lowT,
          openUrl: webUrl || '',
          accounts,
        }, nowMs);
        const listTxt = accounts.slice(0, 5).map((a, i) => `${i + 1}) ${a}`).join(', ');
        return {
          reply: `Quale account vuole utilizzare per ${targetName}? Salvati: ${listTxt}.`,
          expectReply: true,
          device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
        };
      }
      const res = dispatchPcOpen(db, targetName, nowMs);
      if (res) {
        setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: targetName, action: 'apri' }, nowMs);
        const lowT = targetName.toLowerCase();
        const webUrl = WEB_SERVICES[lowT];
        const steps = webUrl
          ? [{ kind: 'open_chrome_profile', target: '{account}', optional: false }, { kind: 'open_url', target: webUrl, optional: false }, { kind: 'dynamic_media', param: 'media', optional: true }]
          : [{ kind: 'open_app', target: targetName, optional: false }];
        const proposed = flows.proposeSkill(db, sessionId, {
          name: `${targetName} su PC`,
          service: lowT,
          device: 'pc',
          defaults: { account: focus?.profile || 'alexx cast' },
          steps,
        }, nowMs);
        if (proposed) res.reply += ' Ha funzionato? Se sì, me lo conferma così salvo ogni step negli automatismi?';
        return res;
      }
    }

    // Qualsiasi altra ricerca web o sito sul PC ("cerca <query> su google", "cerca il sito <nome>", "cerca <query>")
    const searchMatch = /^(?:per\s+favore\s+)?(?:cerca|cercare|trova|trovare|metti|riproduci|ascolta|fai\s+partire|fammi\s+partire)\s+(.+)$/i.exec(withoutPc);
    if (searchMatch) {
      const q = searchMatch[1].replace(/[.!?]+$/, '').trim();
      const siteOnly = /^(?:il\s+sito\s+(?:di\s+|della\s+)?|il\s+portale\s+)?([a-z0-9_-]+)$/i.exec(q);
      if (siteOnly && WEB_SERVICES[siteOnly[1].toLowerCase()]) {
        setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: siteOnly[1], action: 'apri' }, nowMs);
        return dispatchPcOpen(db, siteOnly[1], nowMs);
      }
      if (/^(?:metti|riproduci|ascolta|fai\s+partire|fammi\s+partire)\b/i.test(withoutPc)) {
        setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: 'youtube', action: 'riproduci' }, nowMs);
        return dispatchPcPlayYoutube(db, q, nowMs);
      }
      devices.enqueueCommand(db, 'desktop', { kind: 'search_web', target: q }, nowMs);
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: q, action: 'cerca' }, nowMs);
      return { reply: `Cerco "${q}" sul PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
  }

  return null;
}

/**
 * Rileva se una richiesta descrive un problema complesso o prolungato nel tempo
 * che merita di essere strutturato in un progetto multi-step in background (se il modello non lo ha già avviato).
 */
export function detectComplexProject(userText) {
  const s = String(userText || '').trim();
  if (s.length < 22) return null;
  const m = /\b(?:avvia\s+un\s+progetto|crea\s+un\s+progetto|progetta\s+(?:un|una|il|la)|sviluppa\s+(?:un|una|in\s+multi[\s-]*file)|costruisci\s+(?:un|una)|programma\s+(?:un\s+progetto|un'app|un'interfaccia|una\s+gui|un\s+gestionale|un\s+sito)|gestisci\s+nel\s+tempo|pianifica\s+in\s+pi[uù]\s+fasi|studia\s+a\s+fondo|prepara\s+un\s+piano\s+completo\s+(?:per|di|su))\s+(.{8,400})/i.exec(s);
  if (!m) return null;
  const goal = m[1].trim();
  return { title: goal.slice(0, 60), goal: s.slice(0, 2000) };
}
