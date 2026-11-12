// Router dei modelli: sceglie il modello giusto per ogni richiesta e cambia provider
// PRIMA che i limiti gratuiti finiscano, senza perdere la sessione (che vive nel nostro database).

import { PROVIDERS, DEFAULT_MODELS, modelKey, sanitizeModels } from './models.js';
import { kvGet, logEvent } from './db.js';
import { nowIso } from './clock.js';

/** Sopra questa quota di un limite il modello viene messo in fondo alla lista (cambio anticipato). */
export const SWITCH_AT = 0.8;
const MINUTE = 60_000;

export const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.5);
export function messagesTokens(messages) {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += estimateTokens(m.content) + 4;
    else for (const part of m.content) n += part.type === 'text' ? estimateTokens(part.text) : 800;
  }
  return n;
}

export function loadModels(db) {
  const custom = sanitizeModels(kvGet(db, 'models', null));
  return custom.length ? custom : DEFAULT_MODELS;
}

const minuteBucket = (ms) => 'm:' + new Date(ms).toISOString().slice(0, 16);
const dayBucket = (ms) => 'd:' + new Date(ms).toISOString().slice(0, 10);

function usageOf(db, key, ms) {
  const row = (b) => db.get('SELECT requests, tokens FROM usage WHERE model_key = ? AND bucket = ?', key, b) || { requests: 0, tokens: 0 };
  return { minute: row(minuteBucket(ms)), day: row(dayBucket(ms)) };
}

function addUsage(db, key, ms, tokens) {
  for (const b of [minuteBucket(ms), dayBucket(ms)]) {
    db.run('INSERT INTO usage (model_key, bucket, requests, tokens) VALUES (?, ?, 1, ?) ON CONFLICT(model_key, bucket) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens', key, b, tokens);
  }
  // Pulizia: i contatori al minuto servono solo per pochi minuti, quelli al giorno per qualche settimana.
  db.run("DELETE FROM usage WHERE (bucket LIKE 'm:%' AND bucket < ?) OR (bucket LIKE 'd:%' AND bucket < ?)", minuteBucket(ms - 10 * MINUTE), dayBucket(ms - 40 * 86400_000));
}

/** Quota consumata (0..1+) rispetto al limite più vicino all'esaurimento. */
export function loadFraction(m, usage, extraTokens = 0) {
  const parts = [];
  if (m.rpm) parts.push((usage.minute.requests + 1) / m.rpm);
  if (m.rpd) parts.push((usage.day.requests + 1) / m.rpd);
  if (m.tpm) parts.push((usage.minute.tokens + extraTokens) / m.tpm);
  if (m.tpd) parts.push((usage.day.tokens + extraTokens) / m.tpd);
  return parts.length ? Math.max(...parts) : 0;
}

function stateOf(db, key) {
  return db.get('SELECT * FROM model_state WHERE model_key = ?', key) || { model_key: key, blocked_until: 0, fails: 0, last_error: '', low_until: 0 };
}
function saveState(db, s, ms) {
  db.run(`INSERT INTO model_state (model_key, blocked_until, fails, last_error, low_until, updated) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_key) DO UPDATE SET blocked_until = excluded.blocked_until, fails = excluded.fails, last_error = excluded.last_error, low_until = excluded.low_until, updated = excluded.updated`,
    s.model_key, s.blocked_until, s.fails, String(s.last_error || '').slice(0, 300), s.low_until, ms);
}

/**
 * Ordina i candidati per una richiesta.
 * Ritorna [{ model, key, status: 'ok' | 'near' , load }] dal migliore al peggiore; esclude i bloccati.
 */
export function rank(db, env, { tier, needsVision = false, promptTokens = 0, preferKey = '', ms }) {
  const out = [];
  for (const m of loadModels(db)) {
    const p = PROVIDERS[m.provider];
    if (!p || !env[p.env]) continue;
    if (needsVision ? !m.tiers.includes('vision') : !m.tiers.includes(tier)) continue;
    if (promptTokens > m.ctx * 0.9) continue; // il contesto non entra in questo modello
    const key = modelKey(m);
    const st = stateOf(db, key);
    if (st.blocked_until > ms) continue;
    const load = loadFraction(m, usageOf(db, key, ms), promptTokens);
    if (load > 1) continue; // limite locale già raggiunto: aspetta il prossimo minuto/giorno
    const near = load >= SWITCH_AT || st.low_until > ms;
    out.push({ model: m, key, status: near ? 'near' : 'ok', load });
  }
  const score = (c) => (c.status === 'near' ? 1000 : 0) + (c.model.free ? 0 : 500) + (c.key === preferKey ? -1.5 : 0) + c.model.prio / 10;
  // Tra i modelli sani preferisce quello già in uso nella sessione (coerenza), poi la priorità.
  return out.sort((a, b) => score(a) - score(b));
}

function toAnthropic(model, messages, maxTokens) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map(part => part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(part.image_url.url).replace(/^data:image\/\w+;base64,/, '') } }),
  }));
  return { model, max_tokens: maxTokens, system, messages: rest };
}

async function callProvider(fetchFn, env, m, messages, maxTokens) {
  const p = PROVIDERS[m.provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const anth = p.kind === 'anthropic';
    const res = await fetchFn(p.url, {
      method: 'POST',
      signal: controller.signal,
      headers: anth
        ? { 'content-type': 'application/json', 'x-api-key': env[p.env], 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', authorization: `Bearer ${env[p.env]}` },
      body: JSON.stringify(anth ? toAnthropic(m.model, messages, maxTokens) : { model: m.model, messages, max_tokens: maxTokens, temperature: 0.4 }),
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* corpo non JSON */ }
    if (!res.ok) return { ok: false, status: res.status, error: (data?.error?.message || data?.message || raw || '').toString().slice(0, 300), headers: res.headers };
    const text = anth
      ? (data?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
      : (typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '');
    const tokens = anth ? (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0) : (data?.usage?.total_tokens || 0);
    if (!text.trim()) return { ok: false, status: 502, error: 'risposta vuota', headers: res.headers };
    return { ok: true, text, tokens, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e), headers: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Legge le intestazioni "x-ratelimit-*": se resta meno del 20% il modello passa in fondo per un minuto. */
function nearLimitFromHeaders(headers) {
  if (!headers) return false;
  for (const kind of ['requests', 'tokens']) {
    const rem = Number(headers.get(`x-ratelimit-remaining-${kind}`));
    const lim = Number(headers.get(`x-ratelimit-limit-${kind}`));
    if (Number.isFinite(rem) && Number.isFinite(lim) && lim > 0 && rem / lim < 1 - SWITCH_AT) return true;
  }
  return false;
}

function blockFor(status, error, fails, headers) {
  const retryAfter = Number(headers?.get?.('retry-after'));
  if (status === 429) return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 6 * 3600_000) : Math.min(MINUTE * 2 ** fails, 6 * 3600_000);
  if (status === 401 || status === 403) return 6 * 3600_000;                 // chiave non valida
  if (status === 402) return 12 * 3600_000;                                  // crediti esauriti
  if (status === 404 || (status === 400 && /model/i.test(error))) return 24 * 3600_000; // modello ritirato
  if (status === 400 || status === 413) return 0;                            // richiesta non adatta a questo modello: prova il prossimo, senza bloccarlo
  return 30_000;                                                             // 5xx, timeout, rete
}

/**
 * Esegue una richiesta provando i modelli in ordine.
 * build(model) → messages: il contesto viene ricostruito per la finestra di ogni modello provato.
 */
export async function chat(db, env, { tier = 'fast', needsVision = false, preferKey = '', build, maxTokens = 1200, fetchFn = fetch, now = Date.now, tz }) {
  const tried = [];
  const attempted = new Set();
  for (let round = 0; round < 8; round++) {
    const ms = now();
    const candidates = rank(db, env, { tier, needsVision, preferKey, ms }).filter(c => !attempted.has(c.key));
    if (!candidates.length) break;
    const c = candidates[0];
    attempted.add(c.key);
    const messages = build(c.model);
    const promptTokens = messagesTokens(messages);
    if (promptTokens > c.model.ctx * 0.9) { tried.push(`${c.key}: contesto troppo grande`); continue; }
    if (loadFraction(c.model, usageOf(db, c.key, ms), promptTokens) > 1) { tried.push(`${c.key}: limite token`); continue; }

    const res = await callProvider(fetchFn, env, c.model, messages, maxTokens);
    const st = stateOf(db, c.key);
    if (res.ok) {
      addUsage(db, c.key, ms, res.tokens || promptTokens + estimateTokens(res.text));
      st.fails = 0; st.last_error = '';
      st.low_until = nearLimitFromHeaders(res.headers) ? ms + MINUTE : 0;
      saveState(db, st, ms);
      const switched = !!preferKey && preferKey !== c.key;
      if (switched) logEvent(db, nowIso(ms, tz), 'switch', `${preferKey} → ${c.key}${tried.length ? ' (' + tried.join('; ') + ')' : ' (cambio anticipato: limite vicino o modello in pausa)'}`);
      return { text: res.text, key: c.key, model: c.model, switched, tried };
    }
    addUsage(db, c.key, ms, 0);
    st.fails = (st.fails || 0) + 1;
    st.last_error = `${res.status} ${res.error}`;
    st.blocked_until = ms + blockFor(res.status, res.error, st.fails - 1, res.headers);
    saveState(db, st, ms);
    tried.push(`${c.key}: ${res.status || 'rete'} ${res.error}`.slice(0, 160));
  }
  const configured = Object.values(PROVIDERS).some(p => env[p.env]);
  const err = new Error(configured
    ? 'Tutti i modelli sono momentaneamente esauriti o non raggiungibili. Riprova tra poco.'
    : 'Nessuna chiave API configurata sul server: aggiungi almeno GEMINI_API_KEY.');
  err.tried = tried;
  throw err;
}

/** Stato dei modelli per la pagina Impostazioni. */
export function status(db, env, ms) {
  return loadModels(db).map(m => {
    const key = modelKey(m);
    const st = stateOf(db, key);
    const u = usageOf(db, key, ms);
    return {
      key, provider: m.provider, model: m.model, tiers: m.tiers, free: m.free, prio: m.prio, ctx: m.ctx,
      configured: !!env[PROVIDERS[m.provider].env], envName: PROVIDERS[m.provider].env,
      load: Math.round(loadFraction(m, u) * 100), requestsToday: u.day.requests, tokensToday: u.day.tokens,
      limits: { rpm: m.rpm, rpd: m.rpd, tpm: m.tpm, tpd: m.tpd },
      blockedForSec: st.blocked_until > ms ? Math.round((st.blocked_until - ms) / 1000) : 0, lastError: st.last_error,
    };
  });
}

/** Sceglie il livello in base alla richiesta, senza spendere una chiamata a un modello. */
export function classifyTier(text, hasImage = false) {
  if (hasImage) return 'vision';
  const t = String(text || '').toLowerCase();
  const complex = /\b(pianific|organizz|programm|analizz|confront|spiega(mi)? (perch|come)|perch[eé]|strategi|piano (settimanale|mensile|alimentare|di allenamento)|riassum|valuta|progett|ottimizz|calcola(mi)? .*(deficit|perdita)|passo (dopo|per) passo|pro e contro|scrivi(mi)? (un|una|il|la))/.test(t);
  return complex || t.length > 320 ? 'smart' : 'fast';
}
