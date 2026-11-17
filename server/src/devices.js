// Gestore multi-dispositivo di Jarvis (Smartphone Android, PC Desktop Windows/Mac/Linux, Web).
// Ogni dispositivo si registra col server, invia telemetria (CPU, RAM, batteria, app attive)
// e ritira i comandi in coda destinati a lui (aprire programmi, URL, controlli media/sistema, notifiche vocali).

import { kvGet, kvSet } from './db.js';
import * as flows from './flows.js';

const DEVICES_KEY = 'devicesRegistry';
const QUEUE_KEY = 'devicesQueue';
const HISTORY_KEY = 'devicesHistory';
const ONLINE_TTL_MS = 45_000;

export function listDevices(db, nowMs = Date.now()) {
  const raw = kvGet(db, DEVICES_KEY, []);
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

  const list = kvGet(db, DEVICES_KEY, []);
  const existing = list.find(d => d.id === id || (d.kind === kind && kind === 'desktop'));
  const record = {
    id: existing?.id || id,
    kind,
    name,
    platform,
    metrics: { ...(existing?.metrics || {}), ...metrics },
    apps: apps || existing?.apps || [],
    lastSeen: nowMs,
  };
  const updated = [record, ...list.filter(d => d.id !== record.id)].slice(0, 12);
  kvSet(db, DEVICES_KEY, updated);

  // Consegna e svuota i comandi in coda per questo dispositivo (solo se poll !== false, così la GUI non li ruba al demone).
  const shouldPoll = payload.poll !== false;
  const queue = kvGet(db, QUEUE_KEY, []);
  const mine = shouldPoll ? queue.filter(c => c.targetDevice === record.id || c.targetDevice === kind) : [];
  if (mine.length) {
    const rest = queue.filter(c => !(c.targetDevice === record.id || c.targetDevice === kind));
    kvSet(db, QUEUE_KEY, rest);
  }

  return { device: { ...record, online: true }, commands: mine };
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
