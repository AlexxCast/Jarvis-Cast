// Account collegati di Alessio: Google (Gmail, Calendar anche condiviso con la famiglia, Drive) e
// Microsoft (Outlook personale e delle università di Udine e Klagenfurt, agenda, OneDrive), più un
// calendario .ics in sola lettura come ripiego quando un'università non permette il collegamento.
//
// Regole fisse:
// - i token di accesso (refresh token) sono cifrati nel database con il segreto ACCOUNTS_KEY;
// - leggere è libero, scrivere (inviare una mail, mettere un evento) chiede SEMPRE conferma;
// - al modello arrivano solo mittente, oggetto, data e un'anteprima: il testo intero solo se lo chiede;
// - i codici di verifica (OTP) vengono mascherati prima di arrivare al modello;
// - nessuna scrittura nel database a ogni richiesta: i token di accesso brevi restano in memoria.

import { kvGet, kvSet, logEvent } from './db.js';
import { localToMs, localParts } from './clock.js';

const TIMEOUT_MS = 12_000;
const PENDING_TTL_MS = 10 * 60_000;
const STATE_TTL_MS = 15 * 60_000;

export const PROVIDERS = {
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive.readonly'],
    idEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    name: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite', 'Files.Read'],
    idEnv: 'MS_CLIENT_ID', secretEnv: 'MS_CLIENT_SECRET',
  },
};

// ---------- parole che fanno capire di cosa parla l'utente ----------
export const MAIL_WORDS = /\b(e-?mail|mail|posta|inbox|gmail|outlook|messaggi? di posta|casella)\b/i;
export const CAL_WORDS = /\b(agenda google|calendari\w*|google calendar|appuntament\w*|impegn\w*|evento|eventi|riunion\w*|lezion\w*|esam\w*|cosa (ho|c'è) (oggi|domani|stasera|questa settimana|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica))\b/i;
export const DOC_WORDS = /\b(google drive|drive|onedrive|google docs?|miei documenti|nei (miei )?documenti|tra i (miei )?documenti)\b/i;
export const ACCOUNT_WORDS = new RegExp(`${MAIL_WORDS.source}|${CAL_WORDS.source}|\\b(account|onedrive|google drive)\\b`, 'i');
const YES_RE = /^\W*(?:s[iì]|ok|okay|va bene|conferm\w*|invia(?:la|lo)?|mandala|mettilo|procedi|fallo|certo|esatto|vai)(?=[\s,.!]|$)[^?]*$/i;
const NO_RE = /^\W*(?:no|annulla|lascia (?:stare|perdere)|non (?:inviarla|mandarla|metterlo|farlo)|aspetta|fermati|stop)\b/i;

// ---------- archivio ----------
export function listAccounts(db) {
  return db.all('SELECT id, provider, email, label, added, status, last_error FROM accounts ORDER BY added');
}
export const hasAccounts = (db) => !!db.get('SELECT 1 AS x FROM accounts LIMIT 1');

/** Nome leggibile dell'account dal dominio dell'indirizzo. */
export function defaultLabel(email, provider) {
  const e = String(email || '').toLowerCase();
  const [local, domain = ''] = e.split('@');
  if (/(^|\.)uniud\.it$/.test(domain)) return 'Università di Udine';
  if (/(^|\.)aau\.at$/.test(domain)) return 'Università di Klagenfurt';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return `Gmail ${local}`;
  if (/^(outlook|hotmail|live|msn)\./.test(domain)) return `Outlook ${local}`;
  if (provider === 'ics') return 'Calendario';
  return e || PROVIDERS[provider]?.name || provider;
}

/** Trova l'account a cui si riferisce una parola ("udine", "klagenfurt", "gmail", l'indirizzo...). */
export function resolveAccount(db, hint, { provider = '', capability = '' } = {}) {
  let list = db.all('SELECT * FROM accounts WHERE status != ? ORDER BY added', 'reconnect');
  if (provider) list = list.filter(a => a.provider === provider);
  if (capability === 'mail' || capability === 'docs') list = list.filter(a => a.provider !== 'ics');
  if (!list.length) return null;
  const h = String(hint || '').toLowerCase().trim();
  if (!h) return list.find(a => a.provider === 'google') || list[0];
  const words = h.split(/[\s,@.]+/).filter(w => w.length > 2);
  const alias = (a) => `${a.email} ${a.label} ${a.provider} ${/uniud/.test(a.email) ? 'udine uniud università' : ''} ${/aau\.at/.test(a.email) ? 'klagenfurt aau università' : ''} ${a.provider === 'microsoft' ? 'outlook' : ''} ${a.provider === 'google' ? 'gmail google' : ''}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const a of list) {
    if (a.email.toLowerCase() === h) return a;
    const s = words.filter(w => alias(a).includes(w)).length;
    if (s > bestScore) { best = a; bestScore = s; }
  }
  return best;
}

// ---------- cifratura dei refresh token ----------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function aesKey(env) {
  if (!env.ACCOUNTS_KEY || String(env.ACCOUNTS_KEY).length < 16) throw new Error('Manca il segreto ACCOUNTS_KEY (almeno 16 caratteri) su Cloudflare.');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(env.ACCOUNTS_KEY)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function unseal(env, packed) {
  const [iv, ct] = String(packed).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- collegamento (OAuth) ----------
export function redirectUri(origin, provider) { return `${origin}/oauth/${provider}/callback`; }

/** Indirizzo da aprire nel browser per collegare un account. */
export function startConnect(db, env, { provider, origin, ms, hint = '' }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Servizio sconosciuto.');
  if (!env[p.idEnv] || !env[p.secretEnv]) throw new Error(`Mancano i segreti ${p.idEnv} e ${p.secretEnv} su Cloudflare.`);
  if (!env.ACCOUNTS_KEY) throw new Error('Manca il segreto ACCOUNTS_KEY su Cloudflare.');
  const state = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, '');
  const states = (kvGet(db, 'oauthStates', []) || []).filter(s => ms - s.at < STATE_TTL_MS);
  kvSet(db, 'oauthStates', [...states, { state, provider, at: ms }].slice(-6));
  const q = new URLSearchParams({ client_id: env[p.idEnv], redirect_uri: redirectUri(origin, provider), response_type: 'code', scope: p.scopes.join(' '), state });
  if (provider === 'google') { q.set('access_type', 'offline'); q.set('prompt', 'consent select_account'); q.set('include_granted_scopes', 'true'); }
  else { q.set('response_mode', 'query'); q.set('prompt', 'select_account'); }
  if (hint) q.set('login_hint', hint);
  return `${p.authUrl}?${q}`;
}

async function fetchJson(fetchFn, url, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: e.name === 'AbortError' ? 'tempo scaduto' : String(e.message || e) };
  } finally { clearTimeout(t); }
}

async function tokenRequest(env, fetchFn, provider, params) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({ client_id: env[p.idEnv], client_secret: env[p.secretEnv], ...params });
  if (provider === 'microsoft') body.set('scope', p.scopes.join(' '));
  return fetchJson(fetchFn, p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
}

const accessCache = new Map(); // id account → { token, exp }
export function _resetCache() { accessCache.clear(); }

/** Ritorno dal login: scambia il codice, legge l'indirizzo e salva l'account (cifrato). */
export async function finishConnect(db, env, fetchFn, { provider, code, state, origin, ms }) {
  const states = kvGet(db, 'oauthStates', []) || [];
  const st = states.find(s => s.state === state && s.provider === provider && ms - s.at < STATE_TTL_MS);
  if (!st) throw new Error('Il collegamento è scaduto o non è partito da Kestra. Riprova da Impostazioni › Account.');
  kvSet(db, 'oauthStates', states.filter(s => s.state !== state));
  const r = await tokenRequest(env, fetchFn, provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin, provider) });
  if (!r.ok || !r.json?.access_token) throw new Error(`Il servizio ha rifiutato il collegamento: ${r.json?.error_description || r.json?.error || r.status}`);
  if (!r.json.refresh_token) throw new Error('Il servizio non ha dato un accesso permanente (refresh token). Rimuovi Kestra dagli accessi del tuo account e ricollegalo.');
  const who = provider === 'google'
    ? await fetchJson(fetchFn, 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${r.json.access_token}` } })
    : await fetchJson(fetchFn, 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', { headers: { authorization: `Bearer ${r.json.access_token}` } });
  const email = String(who.json?.email || who.json?.mail || who.json?.userPrincipalName || '').toLowerCase();
  if (!email) throw new Error('Non riesco a leggere l\'indirizzo dell\'account.');
  const id = `${provider}:${email}`;
  const sealed = await seal(env, r.json.refresh_token);
  const prev = db.get('SELECT label FROM accounts WHERE id = ?', id);
  db.run(`INSERT INTO accounts (id, provider, email, label, secret, added, status, last_error) VALUES (?, ?, ?, ?, ?, ?, 'ok', '')
    ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, status = 'ok', last_error = ''`,
    id, provider, email, prev?.label || defaultLabel(email, provider), sealed, new Date(ms).toISOString());
  accessCache.set(id, { token: r.json.access_token, exp: ms + (Number(r.json.expires_in) || 3000) * 1000 - 60_000 });
  return { id, email, label: prev?.label || defaultLabel(email, provider) };
}

/** Calendario .ics pubblicato (ripiego quando l'università blocca il collegamento). */
export async function addIcs(db, env, { url, label, ms }) {
  if (!/^https:\/\//i.test(String(url || '').replace(/^webcal:/i, 'https:'))) throw new Error('Serve un indirizzo https (o webcal) del calendario.');
  const clean = String(url).replace(/^webcal:/i, 'https:');
  const host = new URL(clean).hostname;
  const id = `ics:${host}:${(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean)).then(b => b64(b))).replace(/[+/=]/g, '').slice(0, 10)}`;
  db.run(`INSERT INTO accounts (id, provider, email, label, secret, added, status, last_error) VALUES (?, 'ics', ?, ?, ?, ?, 'ok', '')
    ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, label = excluded.label, status = 'ok'`,
    id, host, String(label || '').trim() || defaultLabel(host, 'ics'), await seal(env, clean), new Date(ms).toISOString());
  return { id, label };
}

export function removeAccount(db, id) { db.run('DELETE FROM accounts WHERE id = ?', id); accessCache.delete(id); }
export function renameAccount(db, id, label) { db.run('UPDATE accounts SET label = ? WHERE id = ?', String(label || '').slice(0, 60), id); }

async function accessToken(db, env, fetchFn, acc, ms) {
  const c = accessCache.get(acc.id);
  if (c && c.exp > ms) return c.token;
  const refresh = await unseal(env, acc.secret);
  const r = await tokenRequest(env, fetchFn, acc.provider, { grant_type: 'refresh_token', refresh_token: refresh });
  if (!r.ok || !r.json?.access_token) {
    const err = r.json?.error || `errore ${r.status}`;
    if (err === 'invalid_grant' || r.status === 400 || r.status === 401) {
      db.run("UPDATE accounts SET status = 'reconnect', last_error = ? WHERE id = ?", String(r.json?.error_description || err).slice(0, 200), acc.id);
      throw new AccountError(`L'account ${acc.label} va ricollegato (Impostazioni › Account).`);
    }
    throw new AccountError(`${acc.label} non risponde ora (${err}).`);
  }
  // Microsoft cambia il refresh token a ogni rinnovo: si salva quello nuovo (una scrittura ogni ~ora al massimo).
  if (r.json.refresh_token && r.json.refresh_token !== refresh) db.run('UPDATE accounts SET secret = ? WHERE id = ?', await seal(env, r.json.refresh_token), acc.id);
  accessCache.set(acc.id, { token: r.json.access_token, exp: ms + (Number(r.json.expires_in) || 3000) * 1000 - 60_000 });
  return r.json.access_token;
}

export class AccountError extends Error {}

async function api(db, env, fetchFn, acc, ms, url, init = {}) {
  const token = await accessToken(db, env, fetchFn, acc, ms);
  const r = await fetchJson(fetchFn, url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (r.status === 401) accessCache.delete(acc.id);
  if (r.status === 403 && /insufficient|scope|permission|Authorization_RequestDenied|consent/i.test(r.text)) {
    throw new AccountError(`${acc.label}: manca il permesso per questa operazione. Ricollega l'account; se è dell'università, l'amministratore potrebbe bloccarlo.`);
  }
  if (!r.ok) throw new AccountError(`${acc.label}: il servizio ha risposto ${r.status}${r.json?.error?.message ? ` (${String(r.json.error.message).slice(0, 120)})` : ''}.`);
  return r.json ?? {};
}

// ---------- pulizia del testo che arriva al modello ----------
/** Maschera codici di verifica e numeri lunghi (carte, IBAN) prima che arrivino al modello. */
export function scrub(text) {
  return String(text || '')
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g, '[IBAN nascosto]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[numero nascosto]')
    .replace(/((?:codice|code|otp|pin|password|passcode|verifica|verification|sicurezza|security)[^\n]{0,40}?)\b\d{4,8}\b/gi, '$1[codice nascosto]');
}
export function htmlToText(html) {
  return String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const b64urlDecode = (s) => { try { const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } catch { return ''; } };
const b64urlEncode = (s) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fmtWhen = (ms, tz) => { const p = localParts(ms, tz); return `${p.weekday} ${p.date} ${p.time}`; };

// ---------- posta ----------
async function gmailList(db, env, fetchFn, acc, ms, tz, { query = '', unread = false, limit = 6 }) {
  const q = [query, unread ? 'is:unread' : '', 'in:inbox'].filter(Boolean).join(' ');
  const list = await api(db, env, fetchFn, acc, ms, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`);
  const out = [];
  for (const m of (list.messages || []).slice(0, limit)) {
    const d = await api(db, env, fetchFn, acc, ms, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const h = Object.fromEntries((d.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    out.push({ id: `${acc.id}|${m.id}`, account: acc.label, from: h.from || '', subject: h.subject || '(senza oggetto)', when: fmtWhen(Number(d.internalDate) || ms, tz), unread: (d.labelIds || []).includes('UNREAD'), preview: htmlToText(d.snippet || '').slice(0, 180) });
  }
  return out;
}
async function graphList(db, env, fetchFn, acc, ms, tz, { query = '', unread = false, limit = 6 }) {
  const sel = '$select=id,subject,from,receivedDateTime,bodyPreview,isRead';
  const url = query
    ? `https://graph.microsoft.com/v1.0/me/messages?$top=${limit}&${sel}&$search=${encodeURIComponent(`"${query.replace(/"/g, '')}"`)}`
    : `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${limit}&${sel}&$orderby=receivedDateTime desc${unread ? '&$filter=isRead eq false' : ''}`;
  const j = await api(db, env, fetchFn, acc, ms, url);
  return (j.value || []).map(m => ({ id: `${acc.id}|${m.id}`, account: acc.label, from: m.from?.emailAddress ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address || ''}>` : '', subject: m.subject || '(senza oggetto)', when: fmtWhen(Date.parse(m.receivedDateTime) || ms, tz), unread: m.isRead === false, preview: String(m.bodyPreview || '').slice(0, 180) }));
}

export async function mailSearch(db, env, fetchFn, { account = '', query = '', unread = false, ms, tz = 'Europe/Rome' }) {
  const targets = account ? [resolveAccount(db, account, { capability: 'mail' })].filter(Boolean) : db.all("SELECT * FROM accounts WHERE provider != 'ics' AND status != 'reconnect' ORDER BY added");
  const items = [], errors = [];
  await Promise.all(targets.map(async (acc) => {
    try { items.push(...(acc.provider === 'google' ? await gmailList(db, env, fetchFn, acc, ms, tz, { query, unread }) : await graphList(db, env, fetchFn, acc, ms, tz, { query, unread }))); }
    catch (e) { errors.push(e.message); }
  }));
  return { items, errors };
}

function gmailBody(payload) {
  const walk = (p) => {
    if (!p) return { plain: '', html: '' };
    if (p.mimeType === 'text/plain' && p.body?.data) return { plain: b64urlDecode(p.body.data), html: '' };
    if (p.mimeType === 'text/html' && p.body?.data) return { plain: '', html: b64urlDecode(p.body.data) };
    let plain = '', html = '';
    for (const c of p.parts || []) { const r = walk(c); plain = plain || r.plain; html = html || r.html; }
    return { plain, html };
  };
  const r = walk(payload);
  return r.plain || htmlToText(r.html);
}

export async function mailRead(db, env, fetchFn, { id, ms, tz = 'Europe/Rome' }) {
  const [accId, msgId] = String(id || '').split('|');
  const acc = db.get('SELECT * FROM accounts WHERE id = ?', accId);
  if (!acc || !msgId) throw new AccountError('Non trovo quella mail: cercala di nuovo.');
  if (acc.provider === 'google') {
    const d = await api(db, env, fetchFn, acc, ms, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`);
    const h = Object.fromEntries((d.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    return { id, account: acc.label, from: h.from || '', to: h.to || '', subject: h.subject || '', when: fmtWhen(Number(d.internalDate) || ms, tz), text: gmailBody(d.payload).slice(0, 4000) };
  }
  const m = await api(db, env, fetchFn, acc, ms, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}?$select=subject,from,toRecipients,receivedDateTime,body`, { headers: { prefer: 'outlook.body-content-type="text"' } });
  return { id, account: acc.label, from: m.from?.emailAddress?.address || '', to: (m.toRecipients || []).map(r => r.emailAddress?.address).join(', '), subject: m.subject || '', when: fmtWhen(Date.parse(m.receivedDateTime) || ms, tz), text: htmlToText(m.body?.content || '').slice(0, 4000) };
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`; }

async function mailSend(db, env, fetchFn, a, ms) {
  const acc = resolveAccount(db, a.account, { capability: 'mail' });
  if (!acc) throw new AccountError('Non c\'è un account di posta collegato.');
  const to = String(a.to || '').split(/[,;\s]+/).filter(Boolean);
  if (!to.length || !to.every(x => EMAIL_RE.test(x))) throw new AccountError('Manca un indirizzo valido del destinatario.');
  const subject = String(a.subject || '').slice(0, 200), body = String(a.body || '').slice(0, 20000);
  if (acc.provider === 'google') {
    const raw = [`To: ${to.join(', ')}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n');
    const r = await api(db, env, fetchFn, acc, ms, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: b64urlEncode(raw) }) });
    if (!r.id) throw new AccountError('Gmail non ha confermato l\'invio.');
    return `Mail inviata da ${acc.email} a ${to.join(', ')}.`;
  }
  await api(db, env, fetchFn, acc, ms, 'https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: body }, toRecipients: to.map(address => ({ emailAddress: { address } })) }, saveToSentItems: true }) });
  return `Mail inviata da ${acc.email} a ${to.join(', ')}.`;
}

// ---------- agenda ----------
function icsUnfold(text) { return String(text).replace(/\r?\n[ \t]/g, ''); }
function icsTime(value, params, tz) {
  const v = String(value || '');
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, , z] = m;
  if (!h) return { ms: localToMs(`${Y}-${Mo}-${D}T00:00`, tz), allDay: true };
  if (z) return { ms: Date.UTC(+Y, +Mo - 1, +D, +h, +mi), allDay: false };
  const zone = /TZID=([^;:]+)/.exec(params || '')?.[1] || tz;
  let ms; try { ms = localToMs(`${Y}-${Mo}-${D}T${h}:${mi}`, zone); } catch { ms = localToMs(`${Y}-${Mo}-${D}T${h}:${mi}`, tz); }
  return { ms, allDay: false };
}
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** Eventi di un file .ics tra from e to (ripetizioni giornaliere e settimanali comprese). */
export function parseIcs(text, fromMs, toMs, tz = 'Europe/Rome') {
  const out = [];
  for (const block of icsUnfold(text).split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const prop = (name) => { const m = new RegExp(`^${name}((?:;[^:\\n]*)?):(.*)$`, 'm').exec(body); return m ? { params: m[1], value: m[2].trim() } : null; };
    const s = prop('DTSTART'); if (!s) continue;
    const start = icsTime(s.value, s.params, tz); if (!start) continue;
    const e = prop('DTEND'); const end = e ? icsTime(e.value, e.params, tz) : null;
    const dur = end ? end.ms - start.ms : (start.allDay ? 86_400_000 : 3_600_000);
    const title = (prop('SUMMARY')?.value || '(senza titolo)').replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\;/g, ';');
    const where = (prop('LOCATION')?.value || '').replace(/\\,/g, ',').replace(/\\n/g, ' ');
    const rule = prop('RRULE')?.value || '';
    const exdates = new Set([...body.matchAll(/^EXDATE[^:\n]*:(.*)$/gm)].flatMap(m => m[1].split(',')).map(v => icsTime(v.trim(), '', tz)?.ms).filter(Boolean));
    const push = (ms) => { if (ms + dur > fromMs && ms < toMs && !exdates.has(ms)) out.push({ title, where, start: ms, end: ms + dur, allDay: start.allDay }); };
    if (!rule) { push(start.ms); continue; }
    const r = Object.fromEntries(rule.split(';').map(x => x.split('=')));
    const interval = Math.max(1, Number(r.INTERVAL) || 1);
    const until = r.UNTIL ? icsTime(r.UNTIL, '', tz)?.ms ?? Infinity : Infinity;
    const count = Number(r.COUNT) || Infinity;
    if (r.FREQ !== 'DAILY' && r.FREQ !== 'WEEKLY') { push(start.ms); continue; }
    const byDay = r.FREQ === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',').map(d => DAY_CODES.indexOf(d.slice(-2))).filter(d => d >= 0) : null;
    let n = 0;
    for (let day = 0; day < 800 && n < count; day++) {
      const ms = start.ms + day * 86_400_000;
      if (ms > until || ms >= toMs) break;
      const weekday = new Date(ms + 12 * 3_600_000).getUTCDay();
      const weeksFrom = Math.floor(day / 7);
      let hit;
      if (r.FREQ === 'DAILY') hit = day % interval === 0;
      else hit = weeksFrom % interval === 0 && (byDay ? byDay.includes(weekday) : day % 7 === 0);
      if (!hit) continue;
      n++;
      push(ms);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

async function googleEvents(db, env, fetchFn, acc, ms, fromMs, toMs, calHint) {
  const cals = await api(db, env, fetchFn, acc, ms, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader');
  let list = (cals.items || []).filter(c => !c.hidden && c.selected !== false);
  if (calHint) { const h = calHint.toLowerCase(); const f = list.filter(c => String(c.summaryOverride || c.summary).toLowerCase().includes(h)); if (f.length) list = f; }
  const out = [];
  await Promise.all(list.slice(0, 8).map(async (c) => {
    const j = await api(db, env, fetchFn, acc, ms, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${new Date(fromMs).toISOString()}&timeMax=${new Date(toMs).toISOString()}`);
    for (const e of j.items || []) {
      const allDay = !!e.start?.date;
      const start = allDay ? localToMs(`${e.start.date}T00:00`) : Date.parse(e.start?.dateTime);
      const end = allDay ? localToMs(`${e.end?.date || e.start.date}T00:00`) : Date.parse(e.end?.dateTime || e.start?.dateTime);
      out.push({ title: e.summary || '(senza titolo)', where: e.location || '', start, end, allDay, calendar: c.summaryOverride || c.summary, account: acc.label, by: e.creator?.self ? '' : (e.creator?.displayName || e.creator?.email || '') });
    }
  }));
  return out;
}
async function graphEvents(db, env, fetchFn, acc, ms, fromMs, toMs, tz) {
  const j = await api(db, env, fetchFn, acc, ms, `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${new Date(fromMs).toISOString()}&endDateTime=${new Date(toMs).toISOString()}&$top=40&$select=subject,start,end,location,isAllDay&$orderby=start/dateTime`, { headers: { prefer: 'outlook.timezone="UTC"' } });
  return (j.value || []).map(e => ({ title: e.subject || '(senza titolo)', where: e.location?.displayName || '', start: Date.parse(`${e.start?.dateTime}Z`), end: Date.parse(`${e.end?.dateTime}Z`), allDay: !!e.isAllDay, calendar: 'Outlook', account: acc.label }));
}

export async function calendarList(db, env, fetchFn, { from = '', days = 7, calendar = '', account = '', ms, tz = 'Europe/Rome' }) {
  const startDay = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : localParts(ms, tz).date;
  const fromMs = Math.max(localToMs(`${startDay}T00:00`, tz), from ? 0 : ms - 3_600_000);
  const toMs = localToMs(`${startDay}T00:00`, tz) + Math.min(31, Math.max(1, Number(days) || 7)) * 86_400_000;
  const targets = account ? [resolveAccount(db, account)].filter(Boolean) : db.all("SELECT * FROM accounts WHERE status != 'reconnect' ORDER BY added");
  const items = [], errors = [];
  await Promise.all(targets.map(async (acc) => {
    try {
      if (acc.provider === 'google') items.push(...await googleEvents(db, env, fetchFn, acc, ms, fromMs, toMs, calendar));
      else if (acc.provider === 'microsoft') items.push(...await graphEvents(db, env, fetchFn, acc, ms, fromMs, toMs, tz));
      else {
        const url = await unseal(env, acc.secret);
        const r = await fetchJson(fetchFn, url);
        if (!r.ok) throw new AccountError(`${acc.label}: calendario non raggiungibile (${r.status}).`);
        items.push(...parseIcs(r.text, fromMs, toMs, tz).map(e => ({ ...e, calendar: acc.label, account: acc.label })));
      }
    } catch (e) { errors.push(e.message); }
  }));
  items.sort((a, b) => a.start - b.start);
  return { items: items.slice(0, 40), errors, from: startDay };
}

async function eventAdd(db, env, fetchFn, a, ms, tz) {
  const startLocal = String(a.start || '');
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(startLocal)) throw new AccountError('Manca la data dell\'evento (yyyy-MM-ddTHH:mm).');
  const allDay = !!a.all_day || startLocal.length === 10;
  const endLocal = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(a.end || '')) ? String(a.end) : '';
  const acc = resolveAccount(db, a.account || a.calendar || '', {}) || resolveAccount(db, '');
  if (!acc || acc.provider === 'ics') throw new AccountError('Non c\'è un\'agenda collegata in cui scrivere.');
  const title = String(a.title || '').slice(0, 200) || 'Evento';
  if (acc.provider === 'google') {
    let calId = 'primary', calName = 'principale';
    if (a.calendar) {
      const cals = await api(db, env, fetchFn, acc, ms, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer');
      const h = String(a.calendar).toLowerCase();
      const c = (cals.items || []).find(x => String(x.summaryOverride || x.summary).toLowerCase().includes(h));
      if (c) { calId = c.id; calName = c.summaryOverride || c.summary; }
      else if (!/princip|mio|personale/.test(h)) throw new AccountError(`Non trovo un calendario "${a.calendar}" in cui posso scrivere.`);
    }
    const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const body = allDay
      ? { summary: title, location: a.location || undefined, start: { date: startLocal.slice(0, 10) }, end: { date: endLocal ? endLocal.slice(0, 10) : nextDay(startLocal.slice(0, 10)) } }
      : { summary: title, location: a.location || undefined, start: { dateTime: `${startLocal}:00`, timeZone: tz }, end: { dateTime: `${endLocal || plusHour(startLocal, tz)}:00`, timeZone: tz } };
    const r = await api(db, env, fetchFn, acc, ms, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.id) throw new AccountError('Google Calendar non ha confermato l\'evento.');
    return `Evento "${title}" messo nel calendario ${calName}.`;
  }
  const endM = endLocal || plusHour(startLocal, tz);
  const r = await api(db, env, fetchFn, acc, ms, 'https://graph.microsoft.com/v1.0/me/events', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: title, isAllDay: allDay, start: { dateTime: allDay ? `${startLocal.slice(0, 10)}T00:00:00` : `${startLocal}:00`, timeZone: tz }, end: { dateTime: allDay ? `${(endLocal || startLocal).slice(0, 10)}T23:59:00` : `${endM}:00`, timeZone: tz }, location: a.location ? { displayName: a.location } : undefined }) });
  if (!r.id) throw new AccountError('Outlook non ha confermato l\'evento.');
  return `Evento "${title}" messo nell'agenda ${acc.label}.`;
}
/** Un'ora dopo, in ora locale (fine predefinita di un evento). */
function plusHour(local, tz) { const p = localParts(localToMs(local, tz) + 3_600_000, tz); return `${p.date}T${p.time}`; }

// ---------- documenti ----------
export async function docsSearch(db, env, fetchFn, { query = '', account = '', ms }) {
  const q = String(query || '').replace(/'/g, ' ').trim();
  const targets = account ? [resolveAccount(db, account, { capability: 'docs' })].filter(Boolean) : db.all("SELECT * FROM accounts WHERE provider != 'ics' AND status != 'reconnect' ORDER BY added");
  const items = [], errors = [];
  await Promise.all(targets.map(async (acc) => {
    try {
      if (acc.provider === 'google') {
        const filter = `trashed=false${q ? ` and (name contains '${q}' or fullText contains '${q}')` : ''}`;
        const j = await api(db, env, fetchFn, acc, ms, `https://www.googleapis.com/drive/v3/files?pageSize=6&orderBy=${q ? '' : 'modifiedTime desc'}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(filter)}`.replace('orderBy=&', ''));
        for (const f of j.files || []) items.push({ id: `${acc.id}|${f.id}`, account: acc.label, name: f.name, type: f.mimeType.replace('application/vnd.google-apps.', 'google '), modified: String(f.modifiedTime || '').slice(0, 10), url: f.webViewLink || '' });
      } else {
        const j = await api(db, env, fetchFn, acc, ms, q ? `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(q)}')?$top=6&$select=id,name,webUrl,lastModifiedDateTime,file` : 'https://graph.microsoft.com/v1.0/me/drive/recent?$top=6');
        for (const f of j.value || []) items.push({ id: `${acc.id}|${f.id}`, account: acc.label, name: f.name, type: f.file?.mimeType || 'cartella', modified: String(f.lastModifiedDateTime || '').slice(0, 10), url: f.webUrl || '' });
      }
    } catch (e) { errors.push(e.message); }
  }));
  return { items: items.slice(0, 10), errors };
}

export async function docRead(db, env, fetchFn, { id, ms }) {
  const [accId, fileId] = String(id || '').split('|');
  const acc = db.get('SELECT * FROM accounts WHERE id = ?', accId);
  if (!acc || !fileId) throw new AccountError('Non trovo quel documento: cercalo di nuovo.');
  const token = await accessToken(db, env, fetchFn, acc, ms);
  const get = (url) => fetchJson(fetchFn, url, { headers: { authorization: `Bearer ${token}` } });
  if (acc.provider === 'google') {
    const meta = await api(db, env, fetchFn, acc, ms, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,webViewLink`);
    const exp = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[meta.mimeType];
    const r = exp ? await get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exp)}`)
      : /^text\/|json|csv|markdown/.test(meta.mimeType) ? await get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`) : null;
    return { name: meta.name, url: meta.webViewLink, text: r?.ok ? scrub(r.text).slice(0, 12000) : '', note: r ? '' : 'Questo tipo di file non si legge come testo: c\'è il link per aprirlo.' };
  }
  const meta = await api(db, env, fetchFn, acc, ms, `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}?$select=name,webUrl,file`);
  const textual = /^text\/|json|csv|markdown/.test(meta.file?.mimeType || '') || /\.(txt|md|csv|json)$/i.test(meta.name || '');
  const r = textual ? await get(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}/content`) : null;
  return { name: meta.name, url: meta.webUrl, text: r?.ok ? scrub(r.text).slice(0, 12000) : '', note: r ? '' : 'I file Word/PDF di OneDrive per ora si aprono dal link.' };
}

// ---------- blocchi di contesto per il modello ----------
const fmtEvent = (e, tz) => {
  const s = localParts(e.start, tz), en = localParts(e.end, tz);
  const when = e.allDay ? `${s.weekday} ${s.date} (tutto il giorno)` : `${s.weekday} ${s.date} ${s.time}-${en.time}`;
  return `- ${when} · ${e.title}${e.where ? ` @ ${e.where}` : ''} [${e.calendar}${e.calendar !== e.account ? `, ${e.account}` : ''}]${e.by ? ` (messo da ${e.by})` : ''}`;
};
export function calendarBlock(res, tz = 'Europe/Rome') {
  return `AGENDE COLLEGATE (Google/Outlook, dal ${res.from}):\n${res.items.length ? res.items.map(e => fmtEvent(e, tz)).join('\n') : '- nessun evento nel periodo'}${res.errors.length ? `\nPROBLEMI: ${res.errors.join(' ')}` : ''}`;
}
export function mailBlock(res) {
  return `POSTA (anteprime; per il testo intero usa mail_read con l'id):\n${res.items.length ? res.items.map(m => `- [${m.id}] ${m.unread ? '● ' : ''}${m.when} · da ${m.from} · "${m.subject}" · ${scrub(m.preview)} (${m.account})`).join('\n') : '- nessuna mail trovata'}${res.errors.length ? `\nPROBLEMI: ${res.errors.join(' ')}` : ''}`;
}
export function mailTextBlock(m) { return `MAIL [${m.id}] (${m.account})\nDa: ${m.from}\nA: ${m.to}\nData: ${m.when}\nOggetto: ${m.subject}\n\n${scrub(m.text)}`; }
export function docsBlock(res) {
  return `DOCUMENTI TROVATI (per leggerne uno usa doc_read con l'id):\n${res.items.length ? res.items.map(d => `- [${d.id}] ${d.name} (${d.type}, modificato ${d.modified}, ${d.account}) ${d.url}`).join('\n') : '- nessun documento trovato'}${res.errors.length ? `\nPROBLEMI: ${res.errors.join(' ')}` : ''}`;
}

/** Riga per il prompt: quali account ci sono (senza dati). */
export function accountsPrompt(db) {
  const list = listAccounts(db);
  if (!list.length) return 'ACCOUNT COLLEGATI: nessuno. Se il Capo chiede mail, agenda Google/Outlook o documenti, digli che può collegarli in Impostazioni › Account (non fingere di leggerli, non aprire app sul PC al posto suo).';
  return `ACCOUNT COLLEGATI: ${list.map(a => `${a.label} (${a.provider === 'ics' ? 'solo agenda' : a.provider}${a.status === 'reconnect' ? ', DA RICOLLEGARE' : ''})`).join('; ')}.
Per posta, agenda e documenti usa SOLO le azioni mail_search, mail_read, calendar_list, docs_search, doc_read, mail_send, event_add: non aprire app o pagine sul PC/telefono per questo. Riporta solo quello che vedi nei risultati: se un dato non c'è, dillo. Non ripetere a voce codici, password o numeri lunghi.`;
}

export const ACCOUNT_ACTIONS_PROMPT = `- mail_search {account?: "udine"|"klagenfurt"|"gmail"|indirizzo, query?: parole o mittente, unread?: true}: cerca nella posta collegata; ti verranno dati i risultati e risponderai di nuovo.
- mail_read {id}: testo intero di una mail trovata (id tra parentesi quadre nei risultati).
- calendar_list {from?: yyyy-MM-dd, days?: 1..31, calendar?: es. "famiglia", account?}: eventi delle agende Google (anche quella di famiglia) e Outlook.
- docs_search {query, account?} · doc_read {id}: cerca e leggi documenti su Google Drive e OneDrive.
- mail_send {account, to: indirizzo esatto, subject, body}: NON parte subito: Kestra chiede conferma al Capo. Usa solo indirizzi detti dal Capo o presenti nelle mail lette; se manca l'indirizzo chiedilo. Nella reply dì cosa stai per inviare e chiedi "confermi?".
- event_add {title, start: yyyy-MM-ddTHH:mm (o yyyy-MM-dd per tutto il giorno), end?, calendar?: es. "famiglia", account?, location?}: NON parte subito: chiede conferma. Nella reply chiedi "confermi?".`;

// ---------- azioni dal modello ----------
export const READ_TYPES = new Set(['mail_search', 'mail_read', 'calendar_list', 'docs_search', 'doc_read']);
export const WRITE_TYPES = new Set(['mail_send', 'event_add']);

/** Esegue le letture chieste dal modello e ritorna i blocchi da rimettere nel contesto. */
export async function runReads(db, env, fetchFn, actions, { ms, tz }) {
  const blocks = [];
  for (const a of actions.slice(0, 3)) {
    try {
      if (a.type === 'mail_search') blocks.push(mailBlock(await mailSearch(db, env, fetchFn, { account: a.account, query: a.query, unread: !!a.unread, ms, tz })));
      else if (a.type === 'mail_read') blocks.push(mailTextBlock(await mailRead(db, env, fetchFn, { id: a.id, ms, tz })));
      else if (a.type === 'calendar_list') blocks.push(calendarBlock(await calendarList(db, env, fetchFn, { from: a.from, days: a.days, calendar: a.calendar, account: a.account, ms, tz }), tz));
      else if (a.type === 'docs_search') blocks.push(docsBlock(await docsSearch(db, env, fetchFn, { query: a.query, account: a.account, ms })));
      else if (a.type === 'doc_read') { const d = await docRead(db, env, fetchFn, { id: a.id, ms }); blocks.push(`DOCUMENTO "${d.name}" ${d.url}\n${d.text || d.note}`); }
    } catch (e) { blocks.push(`ACCOUNT, ERRORE (${a.type}): ${e.message} Dillo al Capo, senza inventare.`); }
  }
  return blocks;
}

/** Lettura fatta subito, senza aspettare il modello, quando la domanda è chiaramente su posta o agenda. */
export async function prefetch(db, env, fetchFn, text, { ms, tz }) {
  if (!hasAccounts(db)) return '';
  const out = [];
  try {
    if (CAL_WORDS.test(text)) out.push(calendarBlock(await calendarList(db, env, fetchFn, { days: /settiman|prossim/i.test(text) ? 7 : 2, calendar: /famigli/i.test(text) ? 'famiglia' : '', ms, tz }), tz));
    if (MAIL_WORDS.test(text) && !/\b(manda|invia|scrivi)\b/i.test(text)) out.push(mailBlock(await mailSearch(db, env, fetchFn, { unread: /non lett|nuov/i.test(text), account: accountHint(text), ms, tz })));
  } catch (e) { out.push(`ACCOUNT, ERRORE: ${e.message}`); }
  return out.join('\n\n');
}
function accountHint(text) { const m = /\b(udine|klagenfurt|uniud|aau|gmail|outlook)\b/i.exec(text); return m ? m[1] : ''; }

/** Riassunto leggibile di un'azione di scrittura, per chiedere conferma. */
export function describeWrite(db, a, tz = 'Europe/Rome') {
  if (a.type === 'mail_send') {
    const acc = resolveAccount(db, a.account, { capability: 'mail' });
    return `mail da ${acc?.email || '?'} a ${a.to || '?'}, oggetto "${a.subject || ''}": "${String(a.body || '').slice(0, 160)}${String(a.body || '').length > 160 ? '…' : ''}"`;
  }
  const when = String(a.start || '').replace('T', ' alle ');
  return `evento "${a.title}" il ${when}${a.calendar ? ` nel calendario ${a.calendar}` : ''}`;
}

/** Il modello vuole scrivere: si mette in attesa di conferma. Ritorna la frase da aggiungere alla risposta. */
export function queueWrite(db, a, { ms, tz }) {
  if (a.type === 'mail_send' && !String(a.to || '').split(/[,;\s]+/).filter(Boolean).every(x => EMAIL_RE.test(x))) {
    return { ok: false, say: 'Mi manca l\'indirizzo esatto del destinatario: me lo dici?' };
  }
  const summary = describeWrite(db, a, tz);
  kvSet(db, 'accountPending', { action: a, summary, at: ms });
  return { ok: true, summary, say: `Prima di procedere: ${summary}. Confermi?` };
}

export function pendingContext(db, ms) {
  const p = kvGet(db, 'accountPending', null);
  if (!p || ms - Number(p.at || 0) > PENDING_TTL_MS) return '';
  return `IN ATTESA DI CONFERMA DEL CAPO: ${p.summary}. Se ora chiede di cambiare qualcosa, rimetti l'azione (${p.action.type}) corretta e chiedi di nuovo conferma.`;
}

/** Risposta del Capo a una conferma in sospeso: "sì" esegue davvero, "no" annulla. null se non c'entra. */
export async function handleConfirmation(db, env, fetchFn, text, { ms, tz }) {
  const p = kvGet(db, 'accountPending', null);
  if (!p) return null;
  if (ms - Number(p.at || 0) > PENDING_TTL_MS) { kvSet(db, 'accountPending', null); return null; }
  const t = String(text || '').trim();
  if (NO_RE.test(t)) { kvSet(db, 'accountPending', null); return { reply: 'Va bene, non faccio nulla.', ok: true, applied: [] }; }
  if (!YES_RE.test(t) || t.length > 60) return null;
  kvSet(db, 'accountPending', null);
  try {
    const said = p.action.type === 'mail_send' ? await mailSend(db, env, fetchFn, p.action, ms) : await eventAdd(db, env, fetchFn, p.action, ms, tz);
    return { reply: `Fatto: ${said}`, ok: true, applied: [p.action.type] };
  } catch (e) {
    try { logEvent(db, new Date(ms).toISOString(), 'error', `account ${p.action.type}: ${e.message}`); } catch { /* sola lettura */ }
    return { reply: `Non ci sono riuscita: ${e.message}`, ok: false, applied: [] };
  }
}
