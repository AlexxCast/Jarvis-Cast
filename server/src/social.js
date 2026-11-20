// Monomythos: i post che Centro social non riesce a pubblicare da solo (TikTok finisce nella posta,
// Instagram senza chiavi Meta) li pubblica Kestra sul telefono, poi carica gli screenshot delle statistiche.
// I dati stanno nel ramo hub-dati del repository Monomytos: pubblicazioni.json (post pronti) e
// decisioni.json (cosa ha già fatto il Capo). Il controllo parte alla notifica di Centro social e,
// se la notifica non arriva o arriva prima del post, ogni ora guardando indietro di poche ore.

import { kvGet, kvSet, memGet, memSet, pushInbox, logEvent } from './db.js';
import { nowIso } from './clock.js';

export const REPO = 'AlexxCast/Monomytos';
const RAW = `https://raw.githubusercontent.com/${REPO}/hub-dati/`;
const HOUR = 3600_000;
/** Quanto indietro guardare: "qualche ora, non una giornata" (Alessio, 20/11/2026). */
export const LOOKBACK_MS = 6 * HOUR;
/** Dopo una notifica di Centro social si controlla a ogni battito (15 minuti) per 3 ore, poi torna ogni ora. */
export const WATCH_MS = 3 * HOUR;
const NORMAL_EVERY_MS = 59 * 60_000;
const WATCH_EVERY_MS = 14 * 60_000;
/** Un post offerto e non fatto si ripropone dopo 3 ore (se la notifica è stata chiusa per sbaglio). */
const REOFFER_MS = 3 * HOUR;
export const PLATFORMS = ['tiktok', 'instagram'];
const NAMES = { tiktok: 'TikTok', instagram: 'Instagram' };
/** L'app Android di Centro social (com.alexxcast.centrosocial) o il suo nome. */
export const CENTRO_APP = /centrosocial|centro\s*social/i;

const DEFAULTS = { enabled: true, auto: false, stats: true };

export function settings(db) { return { ...DEFAULTS, ...(kvGet(db, 'socialSettings', {}) || {}) }; }
export function saveSettings(db, patch = {}) {
  const s = settings(db);
  for (const k of Object.keys(DEFAULTS)) if (typeof patch[k] === 'boolean') s[k] = patch[k];
  kvSet(db, 'socialSettings', s);
  return s;
}

/** Su quali social un post va ancora pubblicato a mano (stessa regola della sezione "Da pubblicare a mano" di Centro social). */
export function missing(p) {
  const out = [];
  for (const n of PLATFORMS) {
    const e = p?.piattaforme?.[n];
    if (e && (e.esito !== 'ok' || /posta|bozza|inbox|PROCESSING/i.test(e.stato || ''))) out.push(n);
  }
  return out;
}

export const keyOf = (p) => `${p.id}@${p.data}`;

function state(db) {
  const s = kvGet(db, 'socialState', null) || {};
  return { done: s.done || {}, offered: s.offered || {}, log: s.log || [] };
}

/** I post da pubblicare adesso, TikTok prima di Instagram, i più vecchi prima. */
export function pendingPosts(pubb, decisioni, st, ms) {
  const out = [];
  for (const p of Array.isArray(pubb) ? pubb : []) {
    if (!p || p.prova || !p.video || !p.didascalia_instagram || !p.data) continue;
    const t = Date.parse(p.data);
    if (!Number.isFinite(t) || t < ms - LOOKBACK_MS || t > ms + HOUR) continue;
    if (decisioni && decisioni['ig:' + p.data]) continue; // già segnato in Centro social (fatto a mano o annullato)
    const key = keyOf(p);
    for (const platform of missing(p)) {
      if (st.done[key]?.[platform]) continue;
      out.push({
        key, platform, id: String(p.id), data: p.data, t,
        title: String(p.titolo || '').trim() || String(p.id).replace(/^(tt|ig|yt)_/, '').replace(/_/g, ' '),
        video: String(p.video), caption: String(p.didascalia_instagram),
      });
    }
  }
  return out.sort((a, b) => (a.platform === b.platform ? a.t - b.t : a.platform === 'tiktok' ? -1 : 1));
}

async function fetchJson(fetchFn, file, ms) {
  const r = await fetchFn(`${RAW}${file}?t=${ms}`, { headers: { accept: 'application/json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} leggendo ${file}`);
  return r.json();
}

/** Legge i dati di Centro social (letture pubbliche, nessuna chiave). */
export async function load(deps, ms) {
  const fetchFn = deps.fetchFn || fetch;
  const [pubb, dec] = await Promise.all([fetchJson(fetchFn, 'pubblicazioni.json', ms), fetchJson(fetchFn, 'decisioni.json', ms).catch(() => ({}))]);
  return { pubb: pubb || [], dec: dec || {} };
}

const marker = (it) => `[SOCIAL_POST:${it.key}|${it.platform}]`;

/**
 * Un giro di controllo. Senza force rispetta il ritmo (ogni ora, ogni 15 minuti dopo una notifica).
 * Scrive nel database solo quando c'è un post nuovo da offrire.
 */
export async function check(db, env, deps, { force = false, reason = 'ora' } = {}) {
  const s = settings(db);
  if (!s.enabled) return { skipped: 'spento' };
  const ms = deps.now();
  const last = Number(memGet(db, 'socialCheckMs', 0));
  const every = ms < Number(memGet(db, 'socialWatchUntil', 0)) ? WATCH_EVERY_MS : NORMAL_EVERY_MS;
  if (!force && ms - last < every) return { skipped: 'presto' };
  memSet(db, 'socialCheckMs', ms);
  let data;
  try { data = await load(deps, ms); } catch (e) {
    logEvent(db, nowIso(ms, deps.tz), 'error', `Monomythos: ${e.message}`);
    return { error: e.message };
  }
  const st = state(db);
  const items = pendingPosts(data.pubb, data.dec, st, ms);
  memSet(db, 'socialItems', items);
  memSet(db, 'socialLastCheck', { ms, reason, found: items.length });
  const fresh = items.filter(it => ms - Number(st.offered[it.key + '|' + it.platform] || 0) > REOFFER_MS);
  if (fresh.length) {
    const at = nowIso(ms, deps.tz);
    for (const it of fresh) {
      st.offered[it.key + '|' + it.platform] = ms;
      const how = s.auto ? 'Lo pubblico adesso.' : 'Tocca "Pubblica" nella notifica quando vuoi.';
      pushInbox(db, at, 'social', `${marker(it)} Nuovo post di Monomythos per ${NAMES[it.platform]}: «${it.title}». ${how}`);
    }
    // Le offerte vecchie non servono più dopo la finestra di ricerca.
    for (const k of Object.keys(st.offered)) if (ms - st.offered[k] > LOOKBACK_MS + HOUR) delete st.offered[k];
    kvSet(db, 'socialState', st);
  }
  return { found: items.length, offered: fresh.length, items };
}

/** Notifiche del telefono: se è arrivata quella di Centro social, si controlla subito e poi spesso per 3 ore. */
export function sawCentroNotification(db, list, ms) {
  const hit = (Array.isArray(list) ? list : []).some(n => CENTRO_APP.test(String(n?.app || '')) || CENTRO_APP.test(String(n?.label || '')));
  if (hit) { memSet(db, 'socialWatchUntil', ms + WATCH_MS); memSet(db, 'socialCheckMs', 0); }
  return hit;
}

/** Il telefono chiede i dettagli di un post offerto. */
export async function item(db, env, deps, key, platform) {
  const find = () => (memGet(db, 'socialItems', []) || []).find(it => it.key === key && it.platform === platform);
  let it = find();
  if (!it) { await check(db, env, deps, { force: true, reason: 'telefono' }); it = find(); }
  if (!it) return null;
  const s = settings(db);
  return { ...it, auto: s.auto, stats: s.stats };
}

const b64 = (text) => { const b = new TextEncoder().encode(text); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (c) => new TextDecoder().decode(Uint8Array.from(atob(String(c).replace(/\n/g, '')), x => x.charCodeAt(0)));

/** Chiave GitHub per scrivere nel ramo hub-dati di Monomytos (la stessa di Centro social va bene). */
export const tokenOf = (env) => env.MONOMYTOS_TOKEN || '';

async function gh(env, deps, path, opt = {}) {
  const token = tokenOf(env);
  if (!token) { const e = new Error('manca il Secret MONOMYTOS_TOKEN nel Worker Cloudflare'); e.status = 0; throw e; }
  const r = await (deps.fetchFn || fetch)(`https://api.github.com/repos/${REPO}${path}`, {
    ...opt,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'kestra', 'content-type': 'application/json', ...(opt.headers || {}) },
  });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch { /* niente */ } const e = new Error(`GitHub ${r.status}${m ? ': ' + m : ''}`); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

/** Segna il post come fatto in decisioni.json, così Centro social lo toglie da "Da pubblicare a mano". */
export async function markInCentro(env, deps, data, note) {
  for (let i = 0; i < 3; i++) {
    let sha, att = {};
    try { const f = await gh(env, deps, '/contents/decisioni.json?ref=hub-dati'); sha = f.sha; att = JSON.parse(unb64(f.content)); } catch (e) { if (e.status !== 404) throw e; }
    att['ig:' + data] = { stato: 'pubblicata_a_mano', da: 'kestra', nota: String(note || '').slice(0, 200), t: new Date(deps.now()).toISOString() };
    try {
      await gh(env, deps, '/contents/decisioni.json', { method: 'PUT', body: JSON.stringify({ message: 'Kestra: post pubblicato dal telefono', content: b64(JSON.stringify(att, null, 1)), branch: 'hub-dati', ...(sha ? { sha } : {}) }) });
      return true;
    } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw new Error('decisioni.json cambiato mentre scrivevo, riprova');
}

function addLog(st, ms, tz, text) {
  st.log.push({ at: nowIso(ms, tz), text: String(text).slice(0, 240) });
  st.log = st.log.slice(-30);
}

/** Esito dal telefono: { key, platform, ok, note }. */
export async function done(db, env, deps, b) {
  const ms = deps.now();
  const key = String(b.key || ''), platform = String(b.platform || '');
  if (!key || !PLATFORMS.includes(platform)) return { error: 'post sconosciuto' };
  const st = state(db);
  const it = (memGet(db, 'socialItems', []) || []).find(x => x.key === key && x.platform === platform);
  const title = it?.title || key.split('@')[0];
  let centro = null;
  if (b.ok) {
    st.done[key] = { ...(st.done[key] || {}), [platform]: nowIso(ms, deps.tz) };
    addLog(st, ms, deps.tz, `Pubblicato su ${NAMES[platform]}: «${title}»`);
    // Quando tutti i social mancanti di questo post sono fatti, lo segno in Centro social.
    const data = key.slice(key.indexOf('@') + 1);
    const stillMissing = (memGet(db, 'socialItems', []) || []).some(x => x.key === key && x.platform !== platform && !st.done[key]?.[x.platform]);
    if (!stillMissing) {
      try { await markInCentro(env, deps, data, `${NAMES[platform]} dal telefono`); centro = 'segnato'; } catch (e) { centro = e.message; logEvent(db, nowIso(ms, deps.tz), 'error', `Monomythos decisioni: ${e.message}`); }
    }
  } else {
    addLog(st, ms, deps.tz, `Non pubblicato su ${NAMES[platform]}: «${title}» (${String(b.note || 'motivo sconosciuto').slice(0, 120)})`);
  }
  // Pulizia: i post fatti più vecchi di 3 giorni non servono.
  for (const k of Object.keys(st.done)) { const t = Date.parse(k.slice(k.indexOf('@') + 1)); if (Number.isFinite(t) && ms - t > 3 * 24 * HOUR) delete st.done[k]; }
  kvSet(db, 'socialState', st);
  return { ok: true, centro };
}

/** Screenshot delle statistiche di Instagram (JPEG in base64) nella cartella che legge l'analisi AI di Centro social. */
export async function uploadStats(db, env, deps, b) {
  const ms = deps.now();
  const images = (Array.isArray(b.images) ? b.images : []).filter(x => typeof x === 'string' && x.length > 100).slice(0, 4);
  if (!images.length) return { error: 'nessuna immagine' };
  const base = new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const names = [];
  for (let i = 0; i < images.length; i++) {
    if (images[i].length > 14_000_000) return { error: 'immagine troppo grande' };
    const name = `instagram_screen/${base}_kestra_${i + 1}.jpg`;
    await gh(env, deps, `/contents/${name}`, { method: 'PUT', body: JSON.stringify({ message: 'Statistiche Instagram da Kestra', content: images[i].replace(/^data:[^,]+,/, ''), branch: 'hub-dati' }) });
    names.push(name);
  }
  const st = state(db);
  addLog(st, ms, deps.tz, `Statistiche Instagram caricate in Centro social (${names.length} screenshot)`);
  kvSet(db, 'socialState', st);
  return { ok: true, files: names };
}

/** Per la scheda in Impostazioni. */
export function status(db, env) {
  const st = state(db);
  return {
    settings: settings(db),
    token: !!tokenOf(env),
    lastCheck: memGet(db, 'socialLastCheck', null),
    pending: (memGet(db, 'socialItems', []) || []).map(({ key, platform, title, data }) => ({ key, platform, title, data })),
    log: st.log.slice().reverse(),
  };
}
