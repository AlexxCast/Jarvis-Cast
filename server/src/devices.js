// Gestore multi-dispositivo di Jarvis (Smartphone Android, PC Desktop Windows/Mac/Linux, Web).
// Ogni dispositivo si registra col server, invia telemetria (CPU, RAM, batteria, app attive)
// e ritira i comandi in coda destinati a lui (aprire programmi, URL, controlli media/sistema, notifiche vocali).

import { kvGet, kvSet } from './db.js';
import * as flows from './flows.js';

const DEVICES_KEY = 'devicesRegistry';
const QUEUE_KEY = 'devicesQueue';
const HISTORY_KEY = 'devicesHistory';
const ONLINE_TTL_MS = 45_000; // il PC fermo chiede ogni 8 secondi, la finestra ogni 30: restano entrambi "online"

// Il PC manda un battito ogni 2 secondi (anche due programmi insieme): scriverlo ogni volta nel database
// consumava da solo quasi 90.000 scritture al giorno, oltre il limite gratuito di Cloudflare (100.000).
// L'ultimo stato vive in memoria e si salva solo quando cambia qualcosa di importante o ogni 5 minuti.
const PERSIST_MS = 5 * 60_000;
const live = new WeakMap(); // db → Map(id → record più recente)
const liveOf = (db) => { let m = live.get(db); if (!m) { m = new Map(); live.set(db, m); } return m; };

// Ritmo delle domande del PC ("hai comandi per me?"): ogni 2 secondi quando il Capo sta usando Kestra,
// ogni 8 quando è tutto fermo. Anche le richieste hanno un limite gratuito (100.000 al giorno).
const ACTIVE_MS = 10 * 60_000;
const FAST_POLL_MS = 2000, IDLE_POLL_MS = 8000, GUI_POLL_MS = 30_000;
const activeUntil = new WeakMap();
export function markActive(db, nowMs = Date.now()) { activeUntil.set(db, nowMs + ACTIVE_MS); }
export function pollDelay(db, nowMs, { poll = true, delivered = 0 } = {}) {
  if (!poll) return GUI_POLL_MS;
  return delivered || nowMs < (activeUntil.get(db) || 0) ? FAST_POLL_MS : IDLE_POLL_MS;
}

function storedDevices(db) {
  const raw = kvGet(db, DEVICES_KEY, []);
  const mem = liveOf(db);
  return raw.map(d => (mem.has(d.id) && Number(mem.get(d.id).lastSeen) > Number(d.lastSeen || 0) ? mem.get(d.id) : d));
}

export function listDevices(db, nowMs = Date.now()) {
  const raw = storedDevices(db);
  return raw.map(d => ({
    ...d,
    online: nowMs - Number(d.lastSeen || 0) <= ONLINE_TTL_MS,
  }));
}

/**
 * Registra o aggiorna lo stato di un dispositivo (heartbeat) e restituisce i comandi in coda per lui.
 */
export function heartbeat(db, payload = {}, nowMs = Date.now()) {
  const id = String(payload.id || payload.kind || 'desktop-main').trim().slice(0, 60);
  const kind = ['desktop', 'android', 'web'].includes(payload.kind) ? payload.kind : 'desktop';
  const name = String(payload.name || (kind === 'desktop' ? 'PC Desktop' : kind === 'android' ? 'Smartphone Android' : 'Web')).trim().slice(0, 80);
  const platform = String(payload.platform || 'Windows').trim().slice(0, 60);
  const metrics = payload.metrics && typeof payload.metrics === 'object' ? {
    cpu: Number(payload.metrics.cpu) || 0,
    ram: Number(payload.metrics.ram) || 0,
    battery: payload.metrics.battery != null ? Number(payload.metrics.battery) : null,
    activeWindow: String(payload.metrics.activeWindow || '').slice(0, 120),
  } : {};
  const apps = Array.isArray(payload.apps) ? payload.apps.map(a => String(a || '').trim().slice(0, 50)).filter(Boolean).slice(0, 120) : undefined;
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.map(p => String(p || '').trim().slice(0, 60)).filter(Boolean).slice(0, 20) : undefined;

  const saved = kvGet(db, DEVICES_KEY, []);
  const list = storedDevices(db);
  const existing = list.find(d => d.id === id || (d.kind === kind && kind === 'desktop'));
  const record = {
    id: existing?.id || id,
    kind,
    name,
    platform,
    metrics: { ...(existing?.metrics || {}), ...metrics },
    apps: apps || existing?.apps || [],
    profiles: profiles || existing?.profiles || [],
    lastSeen: nowMs,
  };
  liveOf(db).set(record.id, record);
  const before = saved.find(d => d.id === record.id);
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  const important = !before || before.name !== record.name || before.platform !== record.platform || before.kind !== record.kind
    || !same(before.apps, record.apps) || !same(before.profiles, record.profiles);
  if (important || nowMs - Number(before.lastSeen || 0) >= PERSIST_MS) {
    kvSet(db, DEVICES_KEY, [record, ...list.filter(d => d.id !== record.id)].slice(0, 12));
  }

  // Consegna e svuota i comandi in coda per questo dispositivo (solo se poll !== false, così la GUI non li ruba al demone).
  const shouldPoll = payload.poll !== false;
  const queue = kvGet(db, QUEUE_KEY, []);
  const mine = shouldPoll ? queue.filter(c => c.targetDevice === record.id || c.targetDevice === kind) : [];
  if (mine.length) {
    const rest = queue.filter(c => !(c.targetDevice === record.id || c.targetDevice === kind));
    kvSet(db, QUEUE_KEY, rest);
  }

  if (mine.length) markActive(db, nowMs);
  return { device: { ...record, online: true }, commands: mine, nextPollMs: pollDelay(db, nowMs, { poll: shouldPoll, delivered: mine.length }) };
}

const STOPWORDS_APP = new Set(['l', 'la', 'lo', 'le', 'il', 'i', 'gli', 'un', 'una', 'uno', 'per', 'su', 'da', 'in', 'di', 'a', 'e', 'o', 'che', 'con', 'non', 'si', 'no', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'al', 'alla', 'allo', 'nel', 'nella', 'nello', 'sul', 'sulla', 'sullo']);

/** Mette in coda un comando per un dispositivo ('desktop' o 'android') e lo registra nelle Automazioni. */
export function enqueueCommand(db, targetDevice, cmd, nowMs = Date.now()) {
  const target = String(targetDevice || 'desktop').toLowerCase();
  const kind = String(cmd.kind || 'open_app').slice(0, 30);
  const cmdTarget = String(cmd.target || '').trim().slice(0, 300);
  if (kind === 'open_app' && (cmdTarget.length < 2 || STOPWORDS_APP.has(cmdTarget.toLowerCase()))) {
    return null;
  }
  const entry = {
    id: `cmd-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
    targetDevice: target,
    kind,
    target: cmdTarget,
    args: String(cmd.args || '').slice(0, 500),
    say: String(cmd.say || '').slice(0, 240),
    createdAt: nowMs,
  };
  const queue = kvGet(db, QUEUE_KEY, []);
  kvSet(db, QUEUE_KEY, [...queue.slice(-30), entry]);

  const hist = kvGet(db, HISTORY_KEY, []);
  kvSet(db, HISTORY_KEY, [{ ...entry, status: 'queued' }, ...hist].slice(0, 30));

  const label = `${target === 'desktop' ? 'PC' : 'Telefono'}: ${entry.kind === 'open_app' ? 'Apri ' + entry.target : entry.target}`;
  flows.registerAutoGoal(db, label, nowMs);
  return entry;
}

export function listCommandHistory(db) {
  return kvGet(db, HISTORY_KEY, []);
}

/** Contesto sintetico sui dispositivi connessi per il prompt di Jarvis. */
export function devicesPrompt(db, nowMs = Date.now()) {
  const devs = listDevices(db, nowMs);
  if (!devs.length) return '';
  const lines = devs.map(d => {
    const st = d.online ? 'ONLINE' : 'offline';
    const m = d.metrics || {};
    const metr = [m.cpu ? `CPU ${m.cpu}%` : '', m.ram ? `RAM ${m.ram}%` : '', m.battery != null ? `Batt ${m.battery}%` : '', m.activeWindow ? `Finestra: "${m.activeWindow}"` : ''].filter(Boolean).join(', ');
    const apps = (d.apps || []).length ? ` · App PC: ${d.apps.slice(0, 20).join(', ')}` : '';
    return `- ${d.name} (${d.kind}, ${st}${metr ? ' · ' + metr : ''})${apps}`;
  });
  return 'DISPOSITIVI GESTITI DA JARVIS (puoi controllarli con l\'azione pc_action {kind: "open_app"|"open_url"|"close_app"|"search_web"|"play_youtube"|"search_files"|"type_text"|"hotkey"|"system"|"capture_screen"|"notify"|"shell", target: "...", args?: "..."}):\n' + lines.join('\n');
}
