// JARVIS CORE: motore cognitivo proprietario e Amministratore Autonomo interno a Jarvis.
// Agisce in prima persona (prima e sopra i modelli LLM esterni) con:
// 1. Auto-interrogazione autonoma a zero crediti (selfInterrogate): controlla salute modelli, RAM/CPU dispositivi,
//    pulizia grafo e compiti in sospeso, prendendo iniziativa in caso di necessità senza sprecare token LLM;
// 2. Diagnostica completa con grafica in sovraimpressione (visual overlay);
// 3. Controllo autonomo di Antigravity / VS Code su progetti del PC con cattura e invio dello schermo PC in sovraimpressione;
// 4. Esecuzione procedurale istantanea e orchestrazione multi-dispositivo (PC Ghideon + Smartphone).

import { cleanSpoken, unitLabel } from './parlato.js';
import { kvGet, kvSet, pushInbox } from './db.js';
import * as flows from './flows.js';
import * as devices from './devices.js';
import * as eyes from './pc_eyes.js';
import * as memory from './memory.js';
import * as router from './router.js';
import * as agents from './agents.js';
import * as selfHeal from './self_heal.js';
import * as initiative from './initiative.js';
import { nowIso as nowIsoOf } from './clock.js';

const BASE_PC_RE = /\b(pc|computer|desktop|portatile|windows|gh?ideon|antigravit\w*|chrome|profilo\s+chrome|account\s+chrome)\b/i;
const DIAGNOSTIC_RE = /\b(diagnostic\w*|stato\s+del\s+(?:pc|computer|sistema|gh?ideon|jarvis)|dispositiv[io]\s+conness\w*|come\s+sta\s+il\s+(?:pc|sistema)|quanta\s+ram|cpu\s+del\s+pc|controllo\s+sistema|report\s+sistema)\b/i;
const PC_SCREEN_RE = /\b(mostra(?:mi)?\s+lo\s+schermo|fa(?:mmi|i)\s+vedere\s+lo\s+schermo|screenshot\s+(?:del\s+)?(?:pc|computer|gh?ideon)|schermo\s+del\s+(?:pc|computer|gh?ideon)|cosa\s+c'[eè]\s+sullo\s+schermo)\b/i;
const SELF_HEAL_RE = /\b(auto[\s-]*(?:diagnos\w*|corregg\w*|ripar\w*|heal\w*)|sistema\s+i\s+problemi|impara\s+dagli\s+errori|analizza\s+(?:i\s+)?fix\s+latenti|stato\s+apprendimento)\b/i;
const LIVE_CALL_RE = /\b(video\s*chiamat\w*|video\s*call|modalit[aà]\s+live|live\s+vision|in\s+diretta|dal\s+vivo|ti\s+devo\s+far\s+vedere|devo\s+farti\s+vedere|guarda\s+con\s+la\s+(?:tele)?camera)\b/i;
const ANTIGRAVITY_RE = /\b(?:antigravit\w*|anti\s+gravit\w*)\b/i;
const TIMED_ACTION_RE = /^\W*(?:ehi\s+|ciao\s+|ok\s+)?(?:(?:kestra|chestra|questra|jarvis)\s+)?tra\s+(\d{1,3})\s*(second\w*|minut\w*|or[ae])\s+(.{2,240})$/i;
// "metti un timer di 10 minuti per la pasta", "mettimi un timer 5 minuti", "fai partire il cronometro".
// I numeri a parole ("dieci minuti") arrivano già in cifre da cleanSpoken: prima "dieci minuti" diventava l'etichetta
// di un timer da 1 minuto.
const TIMER_RE = /^\W*(?:ehi\s+|ciao\s+|ok\s+)?(?:(?:kestra|chestra|questra|jarvis)\s+)?(?:metti(?:mi)?|mi\s+metti|imposta(?:mi)?|avvia|fai\s+partire|crea|setta|parti\s+con)\s+(?:un\s+|il\s+|lo\s+)?(timer|conto\s+alla\s+rovescia|cronometro)\s*(?:di|da)?\s*(?:(\d{1,3})\s*(second\w*|minut\w*|or[ae]))?(?:\s+(?:per|di|chiamato)\s+(?!\d)(.{2,100}))?\W*$/i;
// Inizio di un comando al PC (dopo il nome del PC tolto): "apri…", "ok chiudi…", "scorri giù", "più giù", "pausa".
const PC_CMD_START = /^(?:(?:ok|no|sì|ora|adesso|poi|invece|dai|e|ma|per\s+favore|puoi|potresti|mi|ti\s+prego)\s+)*(?:apri\w*|avvi\w*|lanci\w*|chiud\w*|termin\w*|ferm\w*|cerc\w*|trov\w*|vai|scrivi|digita|incolla|blocca|sospendi|metti\w*|riavvia|spegni|alza|abbassa|muto|smuta|togli|pausa|play|riprendi|stop|prossim\w*|precedente|successiv\w*|salta|nuova|ricarica|aggiorna|torna|indietro|schermo|fullscreen|scorri|scendi|sali|gi[uù]|su|pi[uù]|ancora|cambia|mostra\w*|minimizza|riduci|clicca|invio|conferma|seleziona|usa|tab|esegui|fai|fammi|riproduci|ascolta|volume|fallo|falla|alt)(?![\p{L}])/iu;
const CONFIRMED_GOAL_RE = /\b(?:ha\s+confermato|confermato\s+dall'utente)\b/i;
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
const NAV_TTL_MS = 10 * 60_000;

export function getNavMode(db, sessionId = 'main', nowMs = Date.now()) {
  const n = kvGet(db, `navMode:${sessionId}`, null);
  if (!n || !n.active || (nowMs - Number(n.updatedAt || 0)) > NAV_TTL_MS) return null;
  return n;
}

export function setNavMode(db, sessionId = 'main', active = false, device = 'pc', nowMs = Date.now()) {
  if (!active) {
    kvSet(db, `navMode:${sessionId}`, null);
    return null;
  }
  const next = { active: true, device, updatedAt: nowMs };
  kvSet(db, `navMode:${sessionId}`, next);
  return next;
}

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
      pushInbox(db, atIso, 'admin', `Capo, ho ancora in sospeso l'attività "${pendingPhone.goal}". Vuole che proceda?`);
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
        pushInbox(db, atIso, 'admin', `Capo, ho rilevato che su ${d.name} la RAM è al ${ram}%. Se vuoi posso chiudere le applicazioni superflue.`);
        actionsTaken.push(`avviso RAM critica su ${d.name} (${ram}%)`);
      }
    }
  }

  // 3. Auto-diagnostica, pulizia doppioni e apprendimento alias in background (zero token LLM)
  try {
    const heal = selfHeal.runDeterministicHeal(db, nowMs, tz);
    if (heal.actions?.length) actionsTaken.push(...heal.actions);
  } catch { /* non bloccare selfInterrogate */ }

  // 3a. Motore di iniziativa: errori ripetuti, modelli esauriti, compiti falliti, scadenze, obiettivi (zero crediti).
  try {
    const sent = initiative.tick(db, nowMs, tz);
    if (sent?.length) actionsTaken.push(`iniziativa: ${sent.length} avvisi`);
  } catch { /* non bloccare */ }

  // 3b. Consolidamento della memoria una volta al giorno: i ricordi doppi dello stesso modulo diventano uno.
  const day = atIso.slice(0, 10);
  if (kvGet(db, 'lastConsolidation', '') !== day) {
    kvSet(db, 'lastConsolidation', day);
    try {
      const merged = memory.consolidate(db);
      const log = kvGet(db, 'consolidationLog', []);
      kvSet(db, 'consolidationLog', [...log.slice(-13), { day, merged }]);
      if (merged) actionsTaken.push(`memoria consolidata: ${merged} ricordi doppi uniti`);
    } catch { /* non bloccare */ }
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
  const reply = `Diagnostica completata, Capo: ${pcPart}; ${healthyModels.length} modelli IA sono operativi con pieno risparmio crediti (${blockedModels.length} obsoleti isolati in automatico) e ${learnedFlows} automazioni sono pronte.`;

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
// Nomi che il riconoscimento storpia: "giotube", "iutub", "spotifai", "netflics", "crome".
const PC_NAMES = ['youtube', 'prime video', 'gmail', 'instagram', 'whatsapp', 'netflix', 'twitch', 'github', 'chatgpt', 'google', 'amazon', 'wikipedia', 'spotify', 'gemini', 'facebook', 'linkedin', 'reddit', 'chrome', 'discord', 'telegram', 'vscode', 'antigravity', 'steam', 'edge'];
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Il nome vero di un'app/sito capito male, oppure il testo com'era. */
export function canonicalPcName(raw) {
  const t = String(raw || '').toLowerCase().replace(/^(?:tipo|cioè|quell[oa]|il|la|lo|l')\s+/i, '').trim();
  if (!t || PC_NAMES.includes(t) || t.includes(' ')) return t;
  // Suoni italiani di parole inglesi: gi/ju → y, ai finale → y, ks → x.
  const sound = t.replace(/^gi|^iu|^ju/, 'you').replace(/ai$/, 'y').replace(/ics$|ks$/, 'x').replace(/^cr/, 'chr');
  let best = null, bestD = 9;
  for (const n of PC_NAMES) {
    const dist = Math.min(editDistance(t, n), editDistance(sound, n));
    if (dist < bestD) { best = n; bestD = dist; }
  }
  const allowed = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
  return best && bestD <= allowed ? best : t;
}

export function dispatchPcOpen(db, rawTarget, nowMs = Date.now()) {
  const said = String(rawTarget || '').replace(/[.!?]+$/, '').trim();
  const fixed = canonicalPcName(said);
  const clean = fixed && fixed !== said.toLowerCase() ? fixed : said.replace(/^(?:tipo|cioè)\s+/i, '');
  if (!clean) return null;
  const low = clean.toLowerCase();
  // "helluva boss su prime video": un titolo dentro un servizio → pagina di ricerca del servizio, non un'app inesistente.
  const inSvc = /^(.{2,80}?)\s+(?:su|sul|in|da)\s+(prime(?:\s+video)?|youtube|netflix)$/i.exec(clean);
  if (inSvc) {
    const q = encodeURIComponent(inSvc[1].trim());
    const svc = inSvc[2].toLowerCase();
    const url = svc.startsWith('prime') ? `https://www.primevideo.com/search/ref=atv_nb_sbox?phrase=${q}`
      : svc === 'youtube' ? `https://www.youtube.com/results?search_query=${q}` : `https://www.netflix.com/search?q=${q}`;
    devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: url }, nowMs);
    return {
      reply: `Cerco ${inSvc[1].trim()} su ${inSvc[2]} sul PC: da lì scegli tu l'episodio, io non posso cliccare dentro la pagina.`,
      device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [],
    };
  }
  const webUrl = WEB_SERVICES[low];
  const reg = flows.registerAutoGoal(db, `PC: apri ${clean}`, nowMs);
  if (webUrl) {
    devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: webUrl }, nowMs);
  } else {
    devices.enqueueCommand(db, 'desktop', { kind: 'open_app', target: clean }, nowMs);
  }
  memory.touchTopics(db, [{ area: 'tecnologia', topic: clean, parent: 'PC Desktop' }], new Date(nowMs).toISOString());
  return {
    reply: `Apro ${clean} sul PC, Capo.`,
    device: [], actions: ['pc_action'],
    touched: ['automazioni', 'tecnologia'],
    touchedLeaves: reg ? ['f:' + reg.id] : [],
  };
}

/**
 * Dalla frase detta estrae solo cosa cercare ("metti Mannarino su YouTube sul PC" → "Mannarino").
 * Prima veniva usata la frase intera, e su YouTube partivano ricerche come "No siamo sul telefono vabbè...".
 */
export function extractMediaQuery(raw) {
  let q = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = /^.*\b(?:fai\s+partire|fammi\s+partire|metti(?:mi)?|riproduci|avvia|cerca(?:mi)?|ascolta|guarda)\s+(.+)$/i.exec(q);
  if (m) q = m[1];
  return q
    .replace(/\b(?:apri\s+youtube\s+e|vai\s+su\s+youtube\s+e)\b/gi, ' ')
    .replace(/\b(?:su|sul|sullo|da|dal|in|nel|con)\s+(?:youtube|pc|computer|desktop|gh?ideon)\b/gi, ' ')
    .replace(/\b(?:per\s+favore|subito|adesso|di\s+nuovo|grazie|dai)\b/gi, ' ')
    .replace(/^(?:un\s+video\s+(?:di|su)|una\s+canzone\s+(?:di|del|della|dei)|la\s+canzone(?:\s+(?:di|del|della|dei))?|il\s+video(?:\s+(?:di|del|della))?|il\s+brano(?:\s+(?:di|del))?|musica\s+di|un\s+po'\s+di)\s+/i, '')
    .replace(/^\s*youtube\s*$/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Invia al PC l'ordine di cercare e far partire direttamente un video o una canzone su YouTube.
 * Ritorna null se la frase non è una richiesta YouTube pulita (altro servizio citato, frase troppo lunga):
 * in quel caso decide il modello, invece di mandare su YouTube l'intera frase.
 */
export function dispatchPcPlayYoutube(db, rawQuery, nowMs = Date.now()) {
  let q = extractMediaQuery(rawQuery);
  if (/\b(prime|netflix|chrome|google|telefono|cellulare|whatsapp|instagram|joytify|spotify|account|profilo|pagina|scheda)\b/i.test(q) || q.split(' ').length > 8) return null;
  if (!q || /^(?:un\s+video|qualcosa|un\s+film|una\s+musica|musica|video|film(?:\s+su)?)$/i.test(q)) {
    q = /film/i.test(q) ? 'film completo ita' : 'musica rilassante mix';
  }
  const reg = flows.registerAutoGoal(db, `PC YouTube: ${q}`, nowMs);
  devices.enqueueCommand(db, 'desktop', { kind: 'play_youtube', target: q }, nowMs);
  memory.touchTopics(db, [{ area: 'intrattenimento', topic: q, parent: 'YouTube' }], new Date(nowMs).toISOString());
  return {
    reply: `Faccio partire "${q}" su YouTube sul PC, Capo.`,
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
    reply: `Avvio subito Antigravity sul progetto ${project} sul PC e ti mostro lo schermo in sovraimpressione, Capo.`,
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
    reply: 'Catturo e ti mostro subito lo schermo del PC in sovraimpressione, Capo.',
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
/** Avvia un timer vero: scheda dal vivo e azione programmata che suona alla fine. */
function startTimer(db, rawAmount, rawUnit, label, nowMs) {
  const amount = Math.max(1, Math.min(999, Number(rawAmount) || 1));
  const unit = unitLabel(amount, rawUnit);
  const delayMs = unit.startsWith('second') ? amount * 1000 : unit.startsWith('or') ? amount * 3600_000 : amount * 60_000;
  const dueMs = nowMs + delayMs;
  const list = kvGet(db, 'timedActions', []);
  const entry = { id: `ta-${nowMs}`, kind: 'timer', dueMs, command: label, createdAt: nowMs };
  kvSet(db, 'timedActions', [...list.slice(-20), entry]);
  applyLiveCard(db, { op: 'set', id: entry.id, kind: 'countdown', title: label, subtitle: `Durata: ${amount} ${unit}`, badge: 'Timer', targetMs: dueMs, expiresAt: dueMs + 30_000 }, nowMs);
  return {
    reply: `Timer da ${amount} ${unit}${label && label !== 'Timer' ? ` per ${label}` : ''} avviato, Capo. Lo vedi scorrere sullo schermo.`,
    device: [], actions: ['live_card', 'timed_action'], touched: ['agenda'], touchedLeaves: [], scheduleAt: dueMs,
  };
}

export function handleCoreIntent(db, userText, nowMs = Date.now(), env = {}, sessionId = 'main', tz = 'Europe/Rome') {
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
        reply: `Parola d'ordine confermata, Capo. Eseguo subito.`,
        device: [{ type: 'phone_task', goal }],
        actions: ['phone_task'],
        touched: ['automazioni'],
        touchedLeaves: reg ? ['f:' + reg.id] : [],
      };
    }
    return {
      reply: 'Parola d\'ordine confermata, Capo.',
      device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
    };
  }

  // Il parlato vero: niente nome all'inizio, niente "ehm", numeri in cifre ("dieci minuti" → "10 minuti").
  const clean = cleanSpoken(raw.replace(/\bniente\s+pi[uù]\s+fili\b/gi, ''));
  if (!clean) return null;

  // 0b. Chiusura esplicita della navigazione continua ("a posto così", "basta così", "stop navigazione")
  if (/^(?:ok\s+)?(?:siamo\s+)?(?:a\s+posto\s+cos[iì]|apposto\s+cos[iì]|basta\s+cos[iì]|perfetto\s+cos[iì]|stop\s+navigazione|esci\s+dalla\s+navigazione|va\s+bene\s+cos[iì])\W*$/i.test(clean)) {
    setNavMode(db, sessionId, false);
    return {
      reply: 'Perfetto, Capo. Resto in attesa.',
      expectReply: false,
      device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
    };
  }

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
        reply: `Perfetto, uso l'account "${accReply.account}"${p.service && p.service !== 'chrome' ? ` e apro ${p.service}` : ' su Chrome'}, Capo.`,
        device: [], actions: ['pc_action'], touched: ['automazioni', 'tecnologia'], touchedLeaves: [],
      };
    }
  }

  // 1b. Timer o Cronometro esplicito ("metti un timer di 5 minuti", "avvia un cronometro")
  // Compito sul telefono fermo su "Invio il messaggio. Procedo?": il "sì" lo riprende subito, senza modello,
  // con la conferma scritta nell'obiettivo (phone.guardMove la riconosce). "no" lo annulla.
  const phoneWait = kvGet(db, 'phonePending', null);
  if (phoneWait?.goal && nowMs - Number(phoneWait.at || 0) < 15 * 60_000 && /\bProcedo\?\s*$/.test(String(phoneWait.say || ''))) {
    if (/^(?:s[iì]|si|ok|vai|procedi|conferm\w*|certo|invia(?:lo|la)?|manda(?:lo|la)?|chiama(?:lo|la)?|fallo|pure)(?:\W+(?:s[iì]|vai|procedi|invia(?:lo|la)?|manda(?:lo|la)?|chiama(?:lo|la)?|pure|grazie|certo))*\W*$/i.test(clean)) {
      kvSet(db, 'phonePending', null);
      const goal = CONFIRMED_GOAL_RE.test(phoneWait.goal) ? phoneWait.goal : `${phoneWait.goal} (l'utente ha confermato: procedi)`;
      return { reply: 'Procedo.', device: [{ type: 'phone_task', goal }], actions: ['phone_task'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/^(?:no|annulla|lascia\s+stare|non\s+(?:inviare|mandare|chiamare|farlo)|aspetta|stop|fermati)\b/i.test(clean)) {
      kvSet(db, 'phonePending', null);
      return { reply: 'Ok, mi fermo.', device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }
  }
  // Conferma di una telefonata a un numero di emergenza (entro 60 secondi dalla domanda).
  const callConfirm = kvGet(db, 'callConfirm', null);
  if (callConfirm && nowMs - callConfirm.at < 60_000) {
    kvSet(db, 'callConfirm', null);
    if (/^(?:s[iì]|si|conferm\w*|vai|procedi|certo|chiama(?:lo)?)(?:\W+(?:s[iì]|chiama(?:lo)?|subito|pure|vai))*\W*$/i.test(clean)) {
      return { reply: `Chiamo il ${String(callConfirm.name).replace(/^il\s+/i, '')}.`, device: [{ type: 'call', name: callConfirm.name }], actions: ['call'], touched: [], touchedLeaves: [] };
    }
    if (/^(?:no|annulla|lascia\s+stare|non\s+chiamare|aspetta|stop)\b/i.test(clean)) {
      return { reply: 'Ok, non chiamo.', device: [], actions: [], touched: [], touchedLeaves: [] };
    }
  }
  // Conferma di spegnimento o riavvio del PC (entro 60 secondi dalla domanda).
  const pcConfirm = kvGet(db, 'pcConfirm', null);
  if (pcConfirm && nowMs - pcConfirm.at < 60_000) {
    if (/^(?:s[iì]|si|conferm\w*|vai|procedi|fallo|ok|certo|spegni(?:lo)?|riavvia(?:lo)?)(?:\s+(?:s[iì]|pure|grazie|conferm\w*|vai|spegni(?:lo)?|riavvia(?:lo)?))*\W*$/i.test(clean)) {
      kvSet(db, 'pcConfirm', null);
      const kind = pcConfirm.kind || 'system';
      devices.enqueueCommand(db, 'desktop', { kind, target: pcConfirm.target }, nowMs);
      const said = kind === 'shell' ? 'Eseguo il comando sul PC, Capo.' : kind === 'close_app' ? 'Chiudo tutti i programmi sul PC, Capo.'
        : pcConfirm.target === 'restart' ? 'Riavvio il PC tra 10 secondi, Capo.' : 'Spengo il PC tra 10 secondi, Capo.';
      return { reply: said, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    kvSet(db, 'pcConfirm', null);
    if (/^(?:no|annulla|lascia\s+stare|non\s+farlo|aspetta|stop)\b/i.test(clean)) {
      return { reply: pcConfirm.kind === 'shell' || pcConfirm.kind === 'close_app' ? 'Ok, non faccio niente sul PC.' : 'Ok, il PC resta acceso.', device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }
  }
  // Risposta a "Di quanto lo metto?": "10 minuti", "di 5", "mezz'ora" (entro 2 minuti dalla domanda).
  const timerAsk = kvGet(db, 'timerAsk', null);
  if (timerAsk && nowMs - timerAsk.at < 120_000) {
    const ans = /^(?:di\s+|da\s+|per\s+)?(\d{1,3})\s*(second\w*|minut\w*|or[ae])?\W*$/i.exec(clean);
    if (ans) {
      kvSet(db, 'timerAsk', null);
      return startTimer(db, Number(ans[1]), ans[2] || 'minuti', timerAsk.label || 'Timer', nowMs);
    }
  }
  const timerMatch = TIMER_RE.exec(clean);
  if (timerMatch) {
    const isStopwatch = /cronometro/i.test(timerMatch[1]);
    const label = (timerMatch[4] || (isStopwatch ? 'Cronometro' : 'Timer')).trim();
    if (isStopwatch) {
      applyLiveCard(db, { op: 'set', id: `sw-${nowMs}`, kind: 'stopwatch', title: label, subtitle: 'In esecuzione', badge: 'Live', startMs: nowMs }, nowMs);
      return {
        reply: `Ho avviato il cronometro "${label}", Capo. Puoi vedere il tempo scorrere in diretta nella schermata principale.`,
        device: [], actions: ['live_card'], touched: ['agenda'], touchedLeaves: [],
      };
    }
    if (!timerMatch[2]) {
      // Timer senza durata ("metti un timer"): chiedere, non inventare 1 minuto.
      kvSet(db, 'timerAsk', { at: nowMs, label });
      return { reply: 'Di quanto lo metto, Capo?', expectReply: true, device: [], actions: [], touched: ['agenda'], touchedLeaves: [] };
    }
    return startTimer(db, Number(timerMatch[2]), timerMatch[3] || 'minuti', label, nowMs);
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
      reply: `Ricevuto, Capo: tra ${amount} ${unitLabel(amount, unit)} eseguirò in automatico "${innerCmd}".`,
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

  // 2b. Auto-Diagnostica, Auto-Correzione e Apprendimento interno (SelfHeal)
  if (SELF_HEAL_RE.test(clean)) {
    const heal = selfHeal.runDeterministicHeal(db, nowMs, tz);
    const items = [
      { label: `Alias appresi (${heal.learnedTotal})`, value: Math.min(100, heal.learnedTotal * 15) },
      { label: `Automatismi puliti (${heal.skillsTotal})`, value: Math.min(100, heal.skillsTotal * 20) },
      { label: `Problemi aperti in fixLatenti (${heal.openIssues})`, value: Math.min(100, heal.openIssues * 25) },
    ];
    const visual = {
      kind: 'bars',
      title: 'Modulo Interno Self-Heal • Jarvis',
      unit: '',
      seconds: 18,
      items,
      text: heal.actions.length ? heal.actions.join(' · ') : 'Sistema pulito: nessun doppione o coda stantia rilevata.',
    };
    const msg = heal.actions.length
      ? `Auto-riparazione completata, Capo: ${heal.actions.join('; ')}. Ho in memoria ${heal.learnedTotal} correzioni apprese.`
      : `Auto-diagnosi completata, Capo: flussi e code sono già puliti (${heal.learnedTotal} alias appresi, ${heal.openIssues} voci in fix latenti).`;
    return { reply: msg, visual, device: [{ type: 'visual', data: visual }], actions: ['self_heal', 'show'], touched: ['automazioni'], touchedLeaves: [] };
  }

  // 2c. Risoluzione immediata tramite alias appresi da errori/correzioni passate
  const learnedHit = selfHeal.resolveLearnedAlias(db, clean);
  if (learnedHit && learnedHit.device === 'pc') {
    devices.enqueueCommand(db, 'desktop', { kind: learnedHit.kind, target: learnedHit.target }, nowMs);
    setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: learnedHit.target, action: learnedHit.kind }, nowMs);
    return {
      reply: `Eseguo (${learnedHit.kind}: ${learnedHit.target}) sul PC tramite regola appresa, Capo.`,
      device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [],
    };
  }

  // 3. Richiesta di vedere lo schermo del PC in sovraimpressione
  // "cosa c'è sullo schermo" con il PC che sa guardare: risponde l'elenco a voce (occhi), non la sola foto.
  if (PC_SCREEN_RE.test(clean) && !(eyes.pcHasEyes(db, nowMs) && /\bcosa\b/i.test(clean))) {
    return dispatchPcScreenView(db, nowMs);
  }

  // 3b. Modalità Video Call / Live Vision ("attiva videochiamata", "ti devo far vedere una cosa dal vivo")
  if (LIVE_CALL_RE.test(clean) && !isPcTarget(db, clean)) {
    return {
      reply: 'Attivo subito la videochiamata live, Capo. Inquadra pure cosa vuoi mostrarmi.',
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

  // 4a. Occhi sul PC: "che video ci sono", "il terzo", "guarda quel video lì", "vai giù"… "fermo".
  if (!PHONE_REF_RE.test(clean)) {
    const onPc = isPcTarget(db, clean) || (focus?.domain === 'dispositivo' && focus?.device === 'pc') || getNavMode(db, sessionId, nowMs)?.device === 'pc';
    const seen = eyes.handleEyes(db, stripPcWords(db, clean), nowMs, { onPc, sessionId });
    if (seen) {
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return seen;
    }
  }

  // 4b. Cambio contesto esplicito verso il Telefono ("ora fai la stessa cosa sul telefono", "aprilo sul telefono")
  if (PHONE_REF_RE.test(clean) && !isPcTarget(db, clean)) {
    const sameRef = /\b(?:stessa\s+cosa|lo\s+stesso|aprilo|fallo|eseguilo|mettilo|anche\s+l[iì]|anche\s+sul)\b/i.test(clean)
      || /^(?:(?:ma|no|ok|invece|e)\s+)*(?:sul|nel|al)\s+(?:mio\s+)?(?:telefono|cellulare|smartphone)\W*$/i.test(clean); // "ma no sul telefono"
    if (sameRef && focus?.target) {
      const target = focus.target;
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'telefono', target, action: focus.action || 'apri' }, nowMs);
      const webUrl = WEB_SERVICES[target.toLowerCase()];
      const devAct = webUrl ? { type: 'open_url', url: webUrl } : { type: 'open_app', name: target };
      return {
        reply: `Passo al telefono e apro ${target} qui, Capo.`,
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
          reply: `Quale account vuoi usare per ${matchedSkill.service}? Salvati: ${listTxt}.`,
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
        reply: `Eseguo l'automatismo "${matchedSkill.name}"${noteAcc}:${noteStop}, Capo.`,
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
  // Navigazione dal vivo: dopo un comando al PC, "più giù", "torna su", "ancora", "clicca su…", "metti la canzone…"
  // restano sul PC. "scrivi a Marco…" / "manda…" sono messaggi a una persona, non testo da digitare sul PC.
  const NAV_MORE_RE = /^(?:(?:ok|e|ora|adesso|poi|dai)\s+)*(?:(?:scorri|vai|scendi)\s+)?(?:ancora(?:\s+(?:gi[uù]|su))?|pi[uù]\s+(?:gi[uù]|su|in\s+basso|in\s+alto)|(?:torna\s+)?(?:su|gi[uù])|clicca\b.*|metti(?:mi)?\s+(?:la\s+canzone|il\s+video|la\s+musica|il\s+film|un\s+video|una\s+canzone)\b.*|riproduci\b.*|fai\s+partire\b.*)\W*$/i;
  const messageToPerson = /^(?:(?:ok|e|ora|adesso|poi|dai)\s+)*(?:scrivi|manda|invia)\s+(?:un\s+messaggio\s+)?a\s+\p{L}/iu.test(clean) || /\b(whatsapp|telegram|sms|messaggio)\b/i.test(clean);
  const onPcNow = focus?.domain === 'dispositivo' && focus?.device === 'pc';
  const inheritPc = !isPcTarget(db, clean) && !PHONE_REF_RE.test(clean) && !messageToPerson && ((onPcNow && (PC_CONTINUATION_RE.test(clean) || NAV_MORE_RE.test(clean))) || (getNavMode(db, sessionId, nowMs) && NAV_MORE_RE.test(clean)) || PC_EXPLICIT_APP_RE.test(clean));

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
          return { reply: `Chiudo ${tgt} sul PC, Capo.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
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
            ? `Non ho trovato esattamente "${profName}": intendevi l'account "${accCheck.suggestion}"? Me lo confermi?`
            : `Ho sentito il nuovo account "${profName}". Confermi che vuoi salvarlo e usarlo su Chrome?`;
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
          reply: `Apro Chrome sul PC con l'account "${accCheck.exact}"${shouldPersist ? ' e lo salvo tra i tuoi account predefiniti' : ''}, Capo.`,
          device: [], actions: ['pc_action'], touched: ['automazioni', 'tecnologia'], touchedLeaves: [],
        };
      }
    }

    // "più giù", "ancora", "torna su": la stessa pagina continua a scorrere.
    const moreScroll = /^(?:(?:ok|e|ora|adesso|poi|dai)\s+)*(?:(?:scorri|vai|scendi)\s+)?(ancora(?:\s+(?:gi[uù]|su))?|pi[uù]\s+(?:gi[uù]|su|in\s+basso|in\s+alto)|(?:torna\s+)?(?:su|gi[uù]))\W*$/i.exec(withoutPc);
    if (moreScroll) {
      const up = /\bsu\b|alto/i.test(moreScroll[1]) || (/^ancora$/i.test(moreScroll[1]) && kvGet(db, `lastScroll:${sessionId}`, 'down') === 'up');
      devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: up ? 'up' : 'down' }, nowMs);
      eyes.markScrolled(db, nowMs);
      kvSet(db, `lastScroll:${sessionId}`, up ? 'up' : 'down');
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return { reply: up ? 'Su.' : 'Giù.', expectReply: true, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    // Una frase che racconta ("il pc si blocca sempre", "il computer va in sleep da solo") non è un comando:
    // prima bloccava o sospendeva il PC davvero. Da qui in giù serve un verbo di comando all'inizio.
    if (!PC_CMD_START.test(withoutPc)) return null;

    // Controlli completi di sistema, media e browser sul PC
    if (/\b(blocca|lock)\b/i.test(clean)) {
      const cmd = devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'lock', say: 'Blocco lo schermo del PC.' }, nowMs);
      return { reply: 'Blocco subito lo schermo del PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: ['f:' + cmd.id] };
    }
    if (/\b(sospendi|metti\s+in\s+standby|sleep)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'sleep' }, nowMs);
      return { reply: 'Metto il PC in sospensione, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    // Spegnere o riavviare fa perdere il lavoro aperto: prima si chiede (una TV o una frase a metà bastavano a farlo).
    if (/\b(riavvia|reboot)\b/i.test(withoutPc)) {
      kvSet(db, 'pcConfirm', { at: nowMs, target: 'restart', session: sessionId });
      return { reply: 'Riavvio il PC? Il lavoro non salvato si perde. Dimmi "sì" per confermare.', expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(spegni\s+il|spegni|shutdown)\b/i.test(withoutPc) && !/\b(monitor|schermo|app|programma)\b/i.test(withoutPc)) {
      kvSet(db, 'pcConfirm', { at: nowMs, target: 'shutdown', session: sessionId });
      return { reply: 'Spengo il PC? Il lavoro non salvato si perde. Dimmi "sì" per confermare.', expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(muto|togli\s+l'audio|togli\s+audio|riattiva\s+audio|smuta)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'mute' }, nowMs);
      return { reply: 'Attivo/disattivo il muto sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(prossim[ao]\s+(?:video|brano|canzone|traccia)|avanti\s+canzone|salta\s+canzone)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'next_track' }, nowMs);
      return { reply: 'Passo alla traccia successiva sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(precedente\s+(?:video|brano|canzone|traccia)|torna\s+alla\s+canzone\s+prima)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'prev_track' }, nowMs);
      return { reply: 'Torno alla traccia precedente sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(pausa|play|ferma\s+la\s+musica|riprendi\s+la\s+musica)\b/i.test(clean) && !/\b(video|film|youtube|canzone|chrome|prime|spotify|netflix|vscode|edge|google|whatsapp|discord|app|programma)\b/i.test(clean)) {
      const cmd = devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'play_pause', say: 'Play/Pausa sul PC.' }, nowMs);
      return { reply: 'Invio il comando multimediale al PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: ['f:' + cmd.id] };
    }
    if (/^(?:play|apri)\s+(google\s+chrome|chrome|prime\s+video|prime|youtube|spotify|netflix|vscode|google)\b/i.test(withoutPc)) {
      const mPlayApp = /^(?:play|apri)\s+(google\s+chrome|chrome|prime\s+video|prime|youtube|spotify|netflix|vscode|google)\b/i.exec(withoutPc);
      const tgt = /chrome/i.test(mPlayApp[1]) ? 'chrome' : mPlayApp[1];
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target: tgt, action: 'apri' }, nowMs);
      return dispatchPcOpen(db, tgt, nowMs);
    }
    if (/\b(alza\s+il\s+volume|volume\s+su)\b/i.test(clean)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'vol_up' }, nowMs);
      return { reply: 'Alzo il volume sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(abbassa\s+il\s+volume|volume\s+gi[uù])\b/i.test(clean)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'vol_down' }, nowMs);
      return { reply: 'Abbasso il volume sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Scorciatoie browser e finestre sul PC
    if (/\b(nuova\s+scheda|apri\s+una\s+scheda)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'ctrl+t' }, nowMs);
      return { reply: 'Apro una nuova scheda sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(chiudi\s+(?:la\s+)?(?:scheda|pagina)|chiudi\s+tab)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'ctrl+w' }, nowMs);
      return { reply: 'Chiudo la scheda corrente sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(ricarica|aggiorna\s+(?:la\s+)?pagina)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'f5' }, nowMs);
      return { reply: 'Aggiorno la pagina sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(torna\s+indietro|pagina\s+indietro)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'alt+left' }, nowMs);
      return { reply: 'Torno alla pagina precedente sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(schermo\s+intero|fullscreen)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'f11' }, nowMs);
      return { reply: 'Attivo/disattivo lo schermo intero sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(scorri(?:\s+la\s+pagina|\s+gi[uù]|\s+verso\s+il\s+basso)?|scendi)\b/i.test(withoutPc) && !/\bsu\b|\balto\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: 'down' }, nowMs);
      eyes.markScrolled(db, nowMs);
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return { reply: 'Scorro la pagina verso il basso sul PC, Capo.', expectReply: true, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(scorri\s+(?:in\s+)?su|scorri\s+verso\s+l'alto|sali)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: 'up' }, nowMs);
      eyes.markScrolled(db, nowMs);
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return { reply: 'Scorro la pagina verso l\'alto sul PC, Capo.', expectReply: true, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(cambia\s+finestra|alt\s+tab)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'alt+tab' }, nowMs);
      return { reply: 'Cambio finestra attiva sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(mostra\s+(?:il\s+)?desktop|minimizza\s+tutto|riduci\s+tutto)\b/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'win+d' }, nowMs);
      return { reply: 'Mostro il desktop sul PC, Capo.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/^(?:clicca|invio|conferma|apri\s+questo|seleziona\s+questo)\s*$/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'enter' }, nowMs);
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return { reply: 'Confermo sul PC, Capo.', expectReply: true, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/^(?:prossimo\s+elemento|avanti\s+tab|tab)\s*$/i.test(withoutPc)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'hotkey', target: 'tab' }, nowMs);
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return { reply: 'Passo al prossimo elemento, Capo.', expectReply: true, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    // "clicca sul primo video": il PC sa cercare un testo nella pagina, non contare i risultati. Meglio dirlo.
    if (/^(?:clicca|apri|seleziona|metti)\s+(?:su\s*)?(?:il|l[ao]|sul|sull[ao']?)?\s*(?:prim[oa]|second[oa]|terz[oa]|quart[oa]|ultim[oa])\s+(?:video|risultato|link|voce|canzone)\b/i.test(withoutPc)) {
      return { reply: 'Non riesco ancora a contare i risultati sulla pagina: dimmi una parola del titolo e lo cerco io.', expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }
    const findPageMatch = /^(?:cerca\s+nella\s+pagina|clicca(?:\s+su(?:l|lla|llo|i|gli|lle|ll')?)?|apri\s+(?:il\s+link|la\s+voce|il\s+risultato)|vai\s+sul\s+titolo|seleziona(?:\s+su)?|su\s+questa\s+pagina\s+(?:cerca|clicca|apri))\s+(.+)$/i.exec(withoutPc);
    if (findPageMatch) {
      const q = findPageMatch[1].replace(/[.!?]+$/, '').trim();
      devices.enqueueCommand(db, 'desktop', { kind: 'find_on_page', target: q, args: 'open' }, nowMs);
      setNavMode(db, sessionId, true, 'pc', nowMs);
      return { reply: `Cerco e seleziono "${q}" nella pagina corrente, Capo.`, expectReply: true, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
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
      if (norm === 'all') {
        kvSet(db, 'pcConfirm', { at: nowMs, kind: 'close_app', target: 'all', session: sessionId });
        return { reply: 'Chiudo tutti i programmi sul PC? Il lavoro non salvato si perde. Dimmi "sì" per confermare.', expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
      }
      devices.enqueueCommand(db, 'desktop', { kind: 'close_app', target: norm }, nowMs);
      setFocus(db, sessionId, { domain: 'dispositivo', device: 'pc', target, action: 'chiudi' }, nowMs);
      return { reply: `Chiudo ${target} sul PC, Capo.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Scrittura / incolla testo sul PC ("scrivi ciao a tutti sul pc")
    const typeMatch = /^(?:per\s+favore\s+)?(?:scrivi|digita|incolla)\s+(.+)$/i.exec(withoutPc);
    if (typeMatch) {
      const txt = typeMatch[1].trim();
      devices.enqueueCommand(db, 'desktop', { kind: 'type_text', target: txt }, nowMs);
      return { reply: `Scrivo sul PC: "${txt.slice(0, 60)}", Capo.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Ricerca file o cartelle locali sul PC ("cerca file preventivo sul pc")
    const fileMatch = /^(?:per\s+favore\s+)?(?:cerca|trova)\s+(?:il\s+|un\s+|la\s+)?(?:file|documento|cartella)\s+(.+)$/i.exec(withoutPc);
    if (fileMatch) {
      const q = fileMatch[1].replace(/[.!?]+$/, '').trim();
      devices.enqueueCommand(db, 'desktop', { kind: 'search_files', target: q }, nowMs);
      return { reply: `Cerco "${q}" tra i file del PC, Capo.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Esecuzione comando shell esplicito sul PC ("esegui comando dir sul pc")
    // Un comando di sistema detto a voce (o sentito dalla TV) può cancellare file: si ripete e si aspetta il "sì".
    const shellMatch = /^(?:esegui\s+(?:il\s+)?comando|lancia\s+(?:il\s+)?comando|terminale)\s+(.+)$/i.exec(clean.replace(/\s+(?:sul|nel|al)\s+(?:pc|computer)\b.*$/i, ''));
    if (shellMatch) {
      const cmdText = shellMatch[1].trim();
      kvSet(db, 'pcConfirm', { at: nowMs, kind: 'shell', target: cmdText, session: sessionId });
      return { reply: `Eseguo sul PC il comando "${cmdText.slice(0, 80)}"? Dimmi "sì" per confermare.`, expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Far partire un video, un film o una canzone su YouTube sul PC (solo se NON chiede esplicitamente "non su youtube", "prime video" o ricerca "su chrome/google/online")
    const blockYt = /\b(non\s+(?:su|da)\s+youtube|prime\s+video|su\s+chrome|su\s+google|online|su\s+questa\s+pagina)\b/i.test(withoutPc);
    const cleanedForYt = withoutPc.replace(/\bprime\s+video\b/gi, '');
    if (!blockYt && /\b(fai\s+partire|fammi\s+partire|metti(?:mi)?|riproduci|cerca|ascolta|avvia)\b/i.test(cleanedForYt) && /\b(youtube|video|film|musica|canzon\w*|brano)\b/i.test(cleanedForYt)) {
      const r = dispatchPcPlayYoutube(db, withoutPc, nowMs);
      if (r) {
        setNavMode(db, sessionId, false);
        r.expectReply = false;
        return r;
      }
      return null; // frase non pulita: decide il modello
    }

    // Apertura URL o ricerca sito/web sul PC ("cerca il sito amazon", "cerca meteo roma su google", "vai su wikipedia")
    const urlMatch = /\b((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)\b/i.exec(withoutPc);
    if (urlMatch && /\b(apri|aprire|vai\s+su|visita|cerca|cercare)\b/i.test(withoutPc)) {
      const url = /^https?:\/\//i.test(urlMatch[1]) ? urlMatch[1] : 'https://' + urlMatch[1];
      devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: url }, nowMs);
      return { reply: `Apro ${urlMatch[1]} sul PC, Capo.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
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
          reply: `Quale account vuoi usare per ${targetName}? Salvati: ${listTxt}.`,
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
        // Niente più "Ha funzionato?": l'automatismo si salva da solo se il messaggio successivo non è una lamentela.
        if (!proposed) setNavMode(db, sessionId, true, 'pc', nowMs);
        res.expectReply = true;
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
      return { reply: `Cerco "${q}" sul PC, Capo.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
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
