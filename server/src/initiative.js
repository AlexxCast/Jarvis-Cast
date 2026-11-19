// Motore di iniziativa: Kestra si accorge da sola delle cose e avvisa, senza aspettare una domanda.
// Gira nel battito del Durable Object (ogni 15 minuti) e quando arriva una notifica dal telefono.
// Non usa modelli (zero crediti). Ogni avviso ha una chiave: non si ripete prima del suo intervallo,
// c'è un tetto giornaliero e di notte gli avvisi aspettano il mattino (tranne gli urgenti).

import { kvGet, kvSet, pushInbox } from './db.js';
import { loadDiary } from './diet.js';
import { nowIso as nowIsoOf, today as todayOf } from './clock.js';
import * as continuity from './continuity.js';

const DAY = 86_400_000;
export const DEFAULTS = { level: 'normale', quietFrom: 23, quietTo: 7, notifications: true };
const CAP = { off: 0, bassa: 3, normale: 8 };

export function settings(db) {
  return { ...DEFAULTS, ...(kvGet(db, 'initiativeSettings', {}) || {}) };
}
export function saveSettings(db, patch) {
  const cur = settings(db);
  const next = {
    level: ['off', 'bassa', 'normale'].includes(patch.level) ? patch.level : cur.level,
    quietFrom: Number.isInteger(patch.quietFrom) && patch.quietFrom >= 0 && patch.quietFrom < 24 ? patch.quietFrom : cur.quietFrom,
    quietTo: Number.isInteger(patch.quietTo) && patch.quietTo >= 0 && patch.quietTo < 24 ? patch.quietTo : cur.quietTo,
    notifications: typeof patch.notifications === 'boolean' ? patch.notifications : cur.notifications,
  };
  kvSet(db, 'initiativeSettings', next);
  return next;
}

const hourIn = (ms, tz) => Number(new Intl.DateTimeFormat('it-IT', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date(ms))) % 24;
export function isQuiet(db, ms, tz) {
  const { quietFrom: a, quietTo: b } = settings(db);
  const h = hourIn(ms, tz);
  return a === b ? false : a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * Propone un avviso. Ritorna 'sent', 'queued' (ore di silenzio), oppure il motivo per cui non parte.
 * urgent: passa anche di notte e oltre il tetto giornaliero (notifiche davvero urgenti).
 */
export function propose(db, { key, text, cooldownMs = DAY, urgent = false }, ms, tz) {
  const st = settings(db);
  if (st.level === 'off' && !urgent) return 'off';
  const log = kvGet(db, 'initiativeLog', {});
  if (log[key] && ms - log[key] < cooldownMs) return 'cooldown';
  const day = todayOf(ms, tz);
  const count = kvGet(db, 'initiativeCount', { day: '', n: 0 });
  const n = count.day === day ? count.n : 0;
  if (!urgent && n >= CAP[st.level]) return 'cap';
  log[key] = ms;
  // Il registro tiene solo le chiavi delle ultime due settimane.
  for (const k of Object.keys(log)) if (ms - log[k] > 14 * DAY) delete log[k];
  kvSet(db, 'initiativeLog', log);
  kvSet(db, 'initiativeCount', { day, n: n + 1 });
  const history = kvGet(db, 'initiativeHistory', []);
  if (isQuiet(db, ms, tz) && !urgent) {
    kvSet(db, 'initiativeQueue', [...kvGet(db, 'initiativeQueue', []).slice(-19), { key, text }]);
    kvSet(db, 'initiativeHistory', [...history.slice(-29), { at: nowIsoOf(ms, tz), key, text, queued: true }]);
    return 'queued';
  }
  pushInbox(db, nowIsoOf(ms, tz), 'initiative', text);
  kvSet(db, 'initiativeHistory', [...history.slice(-29), { at: nowIsoOf(ms, tz), key, text }]);
  return 'sent';
}

// ---------------------------------------------------------------- controlli

/** Lo stesso errore tecnico ripetuto: Kestra lo dice invece di fallire in silenzio. */
function checkErrors(db, ms, tz) {
  const since = nowIsoOf(ms - 2 * 3600_000, tz);
  const rows = db.all("SELECT text FROM events WHERE kind = 'error' AND at >= ? ORDER BY id DESC LIMIT 60", since);
  const groups = new Map();
  for (const r of rows) {
    const sig = String(r.text).replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 60);
    groups.set(sig, (groups.get(sig) || 0) + 1);
  }
  const out = [];
  for (const [sig, n] of groups) {
    if (n < 3) continue;
    out.push(propose(db, { key: 'err:' + sig, text: `Capo, una cosa non va: "${sig.replace(/#/g, '…')}" è fallito ${n} volte nelle ultime due ore. L'ho annotato tra i problemi da sistemare.`, cooldownMs: 12 * 3600_000 }, ms, tz));
  }
  return out;
}

/** Tutti i modelli in pausa: meglio saperlo prima di chiedere qualcosa. */
function checkModels(db, ms, tz) {
  const rows = db.all('SELECT model_key, blocked_until FROM model_state');
  if (rows.length < 3) return [];
  const blocked = rows.filter(r => r.blocked_until > ms);
  if (blocked.length < rows.length) return [];
  const until = Math.min(...blocked.map(r => r.blocked_until));
  const at = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(until));
  return [propose(db, { key: 'models', text: `Capo, i modelli gratuiti sono tutti in pausa per i limiti di oggi. Tornano verso le ${at}: fino ad allora rispondo solo ai comandi semplici.`, cooldownMs: 6 * 3600_000 }, ms, tz)];
}

/** Un compito lungo non riuscito: si offre di riprovarlo. */
function checkJobs(db, ms, tz) {
  const since = nowIsoOf(ms - DAY, tz);
  return db.all("SELECT id, title FROM jobs WHERE status = 'failed' AND updated >= ?", since)
    .map(j => propose(db, { key: 'job:' + j.id, text: `Il compito "${j.title}" non è andato a buon fine. Se vuoi lo riprovo: dimmi "riprova il compito".`, cooldownMs: 30 * DAY }, ms, tz));
}

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
/** Date scritte nei ricordi ("esame il 25 novembre", "consegna 3/12"): ritorna yyyy-mm-dd o null. */
export function dateIn(text, today) {
  const t = String(text).toLowerCase();
  const y0 = Number(today.slice(0, 4));
  let d = null, m = null, y = null;
  const a = /\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/.exec(t);
  const b = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t);
  if (a) { d = Number(a[1]); m = MONTHS.indexOf(a[2]) + 1; y = a[3] ? Number(a[3]) : null; }
  else if (b) { d = Number(b[1]); m = Number(b[2]); y = b[3] ? Number(b[3].length === 2 ? '20' + b[3] : b[3]) : null; }
  if (!d || !m || m > 12 || d > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let iso = `${y || y0}-${pad(m)}-${pad(d)}`;
  if (!y && iso < today) iso = `${y0 + 1}-${pad(m)}-${pad(d)}`; // "il 3 gennaio" detto a dicembre
  return iso;
}

/** Scadenze nei ricordi: avvisa 3 giorni prima e il giorno prima, offrendo di preparare qualcosa. */
function checkDeadlines(db, ms, tz) {
  const today = todayOf(ms, tz);
  const out = [];
  const rows = db.all('SELECT id, text FROM memories ORDER BY id DESC LIMIT 400');
  for (const r of rows) {
    if (!/\b(esame|consegna|scadenz|appuntament|colloqui|riunion|visita|partenz|volo|compleann|discussion|tesi|pagament|bollett|rata)\w*/i.test(r.text)) continue;
    const when = dateIn(r.text, today);
    if (!when) continue;
    const days = Math.round((Date.parse(when + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / DAY);
    if (days !== 3 && days !== 1) continue;
    const what = r.text.length > 110 ? r.text.slice(0, 107) + '…' : r.text;
    out.push(propose(db, { key: `dl:${r.id}:${days}`, text: `Promemoria di iniziativa: ${days === 1 ? 'domani' : 'tra tre giorni'} c'è questo: "${what}". Vuoi che ti prepari un piano o una lista di cose da fare?`, cooldownMs: 30 * DAY }, ms, tz));
  }
  return out;
}

/** Fili aperti: "domani ho l'esame" → il giorno dopo, di giorno, Kestra chiede com'è andata (una volta). */
function checkFollowUps(db, ms, tz) {
  const h = hourIn(ms, tz);
  if (h < 9 || h >= 21) return [];
  const out = [];
  for (const f of continuity.dueFollowUps(db, ms, tz).slice(0, 1)) {
    const r = propose(db, { key: f.key, text: f.text, cooldownMs: 30 * DAY }, ms, tz);
    if (r === 'sent' || r === 'queued' || r === 'cooldown') continuity.closePlan(db, f.plan.text);
    out.push(r);
  }
  return out;
}

/** Obiettivi: se segue la dieta e stasera il diario è vuoto, glielo ricorda una volta. */
function checkGoals(db, ms, tz) {
  const h = hourIn(ms, tz);
  const today = todayOf(ms, tz);
  const d = loadDiary(db);
  const out = [];
  const weekAgo = new Date(Date.parse(today + 'T12:00:00Z') - 7 * DAY).toISOString().slice(0, 10);
  const activeDiet = d.meals.some(m => m.date >= weekAgo && m.date < today);
  if (activeDiet && h >= 21 && !d.meals.some(m => m.date === today)) {
    out.push(propose(db, { key: 'diet:' + today, text: 'Oggi il diario dei pasti è vuoto. Se mi dici cosa hai mangiato lo registro io, così il bilancio della settimana resta giusto.', cooldownMs: 20 * 3600_000 }, ms, tz));
  }
  const lastW = d.weights.map(w => w.date).sort().pop();
  if (d.profile.targetWeightKg && lastW && lastW < new Date(Date.parse(today + 'T12:00:00Z') - 8 * DAY).toISOString().slice(0, 10) && h >= 8 && h < 11) {
    out.push(propose(db, { key: 'weight:' + today.slice(0, 7) + ':' + Math.floor(Number(today.slice(8)) / 7), text: 'Non ti pesi da più di una settimana: se stamattina sali sulla bilancia, dimmi il numero e aggiorno l\'andamento.', cooldownMs: 6 * DAY }, ms, tz));
  }
  return out;
}

/** Fuori dalle ore di silenzio consegna gli avvisi rimasti in attesa, riuniti in uno solo. */
function flushQueue(db, ms, tz) {
  if (isQuiet(db, ms, tz)) return [];
  const q = kvGet(db, 'initiativeQueue', []);
  if (!q.length) return [];
  kvSet(db, 'initiativeQueue', []);
  const text = q.length === 1 ? q[0].text : `Buongiorno Capo, mentre dormivi: ${q.map(x => x.text).join(' — ')}`;
  pushInbox(db, nowIsoOf(ms, tz), 'initiative', text.slice(0, 900));
  return ['flushed'];
}

/** Un giro di controlli (al massimo uno ogni 10 minuti). */
export function tick(db, ms, tz, { force = false } = {}) {
  const last = Number(kvGet(db, 'initiativeTickMs', 0));
  if (!force && ms - last < 10 * 60_000) return null;
  kvSet(db, 'initiativeTickMs', ms);
  const out = [...flushQueue(db, ms, tz)];
  if (settings(db).level === 'off') return out;
  for (const check of [checkErrors, checkModels, checkJobs, checkDeadlines, checkGoals, checkFollowUps]) {
    try { out.push(...check(db, ms, tz)); } catch { /* un controllo rotto non ferma gli altri */ }
  }
  return out.filter(x => x === 'sent' || x === 'queued' || x === 'flushed');
}

// ---------------------------------------------------------------- notifiche del telefono

const IGNORE_APPS = /^(com\.android\.(systemui|providers\.downloads|vending)|android|com\.google\.android\.(gms|apps\.photos)|com\.jarvisfit\.app)$/;
const SECRET = /\b(otp|codice\s+(?:di\s+)?(?:verifica|accesso|sicurezza)|verification\s+code|password|pin\b|one[-\s]?time)/i;
const PROMO = /\b(offerta|sconto|promo|saldi|coupon|newsletter|% di sconto|black friday)\b/i;
const URGENT = /\b(urgente|urgenza|emergenza|subito|chiamami|richiamami|aiuto|ospedale|incidente|sto male)\b/i;
const MESSAGING = /(whatsapp|telegram|messaging|mms|sms|signal|instagram|messenger|teams|slack)/i;
const CALLS = /(dialer|telecom|incallui|phone)/i;

/**
 * Notifiche mandate dall'app Android (NotificationListener). Le conserva per il contesto ("chi mi ha scritto?")
 * e decide se meritano un avviso. I codici di verifica non vengono mai salvati.
 */
export function ingestNotifications(db, list, ms, tz) {
  if (!settings(db).notifications) return { stored: 0, alerts: 0 };
  const keep = kvGet(db, 'phoneNotifications', []);
  let stored = 0, alerts = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 30)) {
    const app = String(raw?.app || '').slice(0, 80);
    const label = String(raw?.label || app).slice(0, 40);
    const title = String(raw?.title || '').slice(0, 80);
    let text = String(raw?.text || '').replace(/\s+/g, ' ').slice(0, 300);
    if (!app || IGNORE_APPS.test(app) || (!title && !text)) continue;
    if (SECRET.test(title + ' ' + text)) text = '(codice o dato riservato: non salvato)';
    if (PROMO.test(title + ' ' + text)) continue;
    const at = nowIsoOf(Number(raw?.at) || ms, tz);
    if (keep.some(k => k.app === app && k.title === title && k.text === text)) continue;
    keep.push({ at, app, label, title, text });
    stored++;
    const isMsg = MESSAGING.test(app);
    const missedCall = CALLS.test(app) && /\b(persa|perse|missed)\b/i.test(title + ' ' + text);
    if (isMsg && URGENT.test(text)) {
      if (propose(db, { key: `notif:${app}:${title}`, text: `${title || 'Qualcuno'} ti ha scritto su ${label} e sembra urgente: "${text.slice(0, 140)}". Vuoi che risponda?`, cooldownMs: 10 * 60_000, urgent: true }, ms, tz) === 'sent') alerts++;
    } else if (missedCall) {
      if (propose(db, { key: `call:${title}`, text: `Hai una chiamata persa: ${title || text}. Vuoi che richiami?`, cooldownMs: 30 * 60_000 }, ms, tz) === 'sent') alerts++;
    }
  }
  // Solo se è arrivato qualcosa di nuovo: ogni scrittura conta nel limite gratuito di Cloudflare.
  if (stored) kvSet(db, 'phoneNotifications', keep.slice(-60));
  return { stored, alerts };
}

export const NOTIF_WORDS = /\b(notific\w*|chi mi ha (?:scritto|chiamato)|messaggi(?:o)? (?:nuov|arrivat)\w*|mi ha(?:nno)? scritto|cosa mi sono perso|novit[aà] sul telefono|chiamate perse)\b/i;

/** Le ultime notifiche come contesto, solo quando l'utente ne chiede. */
export function notificationsContext(db) {
  const list = kvGet(db, 'phoneNotifications', []).slice(-15);
  if (!list.length) return 'NOTIFICHE DEL TELEFONO: nessuna notifica ricevuta di recente (oppure l\'accesso alle notifiche è spento).';
  return 'NOTIFICHE RECENTI DEL TELEFONO (dalla più vecchia):\n' + list.map(n => `- ${n.at.slice(11, 16)} ${n.label}: ${n.title}${n.text ? ' — ' + n.text : ''}`).join('\n');
}
