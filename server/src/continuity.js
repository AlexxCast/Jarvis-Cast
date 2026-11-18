// Filo di continuità: uno schema piccolo e sempre presente di cosa è successo e cosa resta aperto,
// condiviso tra tutte le chat (app, voce, progetti). Serve perché Kestra sia la stessa ovunque e riprenda
// i discorsi da sola, senza che il Capo debba rispiegare ogni volta.
//   - ultime azioni fatte davvero (con l'ora e la chat)
//   - fili aperti: piani detti dal Capo ("domani ho l'esame"), domande di Kestra in attesa di risposta
//   - argomenti toccati di recente
//   - l'ultimo scambio delle altre conversazioni
// Una sola scrittura per messaggio (una riga di kv).

import { kvGet, kvSet } from './db.js';
import { today as todayOf } from './clock.js';
import { keywords } from './memory.js';

const KEY = 'continuity';
const DAY = 86400_000;
const MAX_ACTIONS = 10, MAX_OPEN = 12, MAX_TOPICS = 8, MAX_OTHERS = 3;

const LABELS = {
  add_meal: 'pasto registrato', update_meal: 'pasto corretto', delete_meal: 'pasto eliminato', add_weight: 'peso registrato',
  add_activity: 'allenamento registrato', add_reminder: 'promemoria creato', remember: 'ricordo salvato', learn: 'regola imparata',
  start_job: 'compito avviato', pc_action: 'comando al PC', call: 'chiamata', show: 'grafica mostrata', web_search: 'ricerca sul web',
  update_profile: 'profilo aggiornato', add_place: 'luogo salvato', note_improvement: 'miglioria annotata',
};

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const WHEN_RE = /\b(stamattina|stasera|stanotte|oggi pomeriggio|oggi|domani|dopodomani|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|(?:il|l')\s*\d{1,2}(?:\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre))?|\d{1,2}[/.]\d{1,2})\b/i;
const PLAN_RE = /\b(ho|avr[oò]|vado|andr[oò]|devo|dovr[oò]|faccio|far[oò]|c'[eè]|inizio|comincio|parto|esco|vedo|incontro|gioco|mi alleno|lavoro|discuto|consegno)\b/i;

const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** Da "domani ho l'esame di statistica" ricava il giorno a cui si riferisce (o null se non è un piano). */
export function planDate(text, today) {
  const t = String(text || '').toLowerCase();
  if (/\?\s*$/.test(t) || /\bricord(ami|amelo|arm)/.test(t)) return null; // domande e promemoria espliciti hanno già la loro strada
  const w = WHEN_RE.exec(t);
  if (!w || !PLAN_RE.test(t)) return null;
  const k = w[1].replace('ì', 'i');
  if (/^(stamattina|stasera|stanotte|oggi)/.test(k)) return today;
  if (k === 'domani') return addDays(today, 1);
  if (k === 'dopodomani') return addDays(today, 2);
  const wd = WEEKDAYS.findIndex(d => d.replace('ì', 'i') === k);
  if (wd >= 0) {
    const cur = new Date(today + 'T12:00:00Z').getUTCDay();
    return addDays(today, ((wd - cur + 7) % 7) || 7);
  }
  const m = /(\d{1,2})(?:\s+([a-zà-ù]+))?|(\d{1,2})[/.](\d{1,2})/.exec(k);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let d, mo;
  if (m[3]) { d = Number(m[3]); mo = Number(m[4]); }
  else { d = Number(m[1]); mo = m[2] ? MONTHS.indexOf(m[2]) + 1 : Number(today.slice(5, 7)); }
  if (!d || d > 31 || !mo || mo > 12) return null;
  let iso = `${today.slice(0, 4)}-${pad(mo)}-${pad(d)}`;
  if (iso < today) iso = m[2] || m[3] ? `${Number(today.slice(0, 4)) + 1}-${pad(mo)}-${pad(d)}` : addDays(iso, 30).slice(0, 8) + pad(d);
  return iso;
}

export function load(db) {
  const s = kvGet(db, KEY, null) || {};
  return { actions: s.actions || [], open: s.open || [], topics: s.topics || [], others: s.others || [] };
}

/** Registra uno scambio: azioni fatte, piani detti, domanda lasciata aperta, argomenti, ultimo scambio della chat. */
export function record(db, { ms, tz, sessionId, chatTitle = '', userText = '', reply = '', applied = [], device = [], touched = [], expectReply = false }) {
  const s = load(db);
  const today = todayOf(ms, tz);
  const labels = [...new Set([
    ...applied.map(a => LABELS[a]).filter(Boolean),
    ...device.filter(d => d.type === 'phone_task' && d.goal).map(d => `sul telefono: ${clip(d.goal, 60)}`),
    ...device.filter(d => d.type === 'open_app' && d.name).map(d => `aperta ${d.name}`),
  ])];
  if (labels.length) s.actions = [...s.actions, { ms, session: sessionId, what: labels.join(', '), asked: clip(userText, 70) }].slice(-MAX_ACTIONS);

  // Le domande di Kestra restano aperte finché il Capo non scrive di nuovo (in qualsiasi chat).
  s.open = s.open.filter(o => o.kind !== 'domanda');
  if (expectReply && /\?\s*$/.test(String(reply).trim())) s.open.push({ kind: 'domanda', text: clip(String(reply).split(/(?<=[.!?])\s+/).pop(), 140), ms, session: sessionId });
  const due = planDate(userText, today);
  if (due) {
    const text = clip(userText, 140);
    if (!s.open.some(o => o.kind === 'piano' && o.text === text)) s.open.push({ kind: 'piano', text, due, ms, said: today });
  }
  // Se dopo la data il Capo ne parla da solo ("l'esame è andato bene"), il filo è ripreso: niente domanda.
  const said = new Set(keywords(userText).map(w => w.slice(0, 5)));
  for (const o of s.open) {
    if (o.kind === 'piano' && o.due <= today && o.text !== clip(userText, 140) && keywords(o.text).some(w => w.length >= 4 && said.has(w.slice(0, 5)))) o.closed = true;
  }
  // I piani passati da più di 7 giorni (o già ripresi) escono dallo schema.
  s.open = s.open.filter(o => o.kind !== 'piano' || (addDays(o.due, 7) >= today && !o.closed)).slice(-MAX_OPEN);

  for (const t of touched) { s.topics = s.topics.filter(x => x.name !== t); s.topics.push({ name: t, ms }); }
  s.topics = s.topics.slice(-MAX_TOPICS);

  if (userText) {
    s.others = [{ session: sessionId, title: chatTitle, ms, user: clip(userText, 90), reply: clip(reply, 110) }, ...s.others.filter(o => o.session !== sessionId)].slice(0, MAX_OTHERS + 1);
  }
  kvSet(db, KEY, s);
  return s;
}

const ago = (ms, now) => {
  const m = Math.round((now - ms) / 60000);
  if (m < 2) return 'adesso';
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h fa`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ieri' : `${d} giorni fa`;
};

/** Il blocco schematico da mettere sempre nel contesto (piccolo: al massimo ~1.200 caratteri). */
const RESUME_RE = /^\W*(e\s|allora|quindi|poi\b|fatto\b|com'?era|quella cosa|dicevamo|dicevo|riprendiamo|continua|andiamo avanti|a che punto)/i;

export function block(db, { ms, tz, sessionId, userText = '' }) {
  const s = load(db);
  const today = todayOf(ms, tz);
  const lines = [];
  const acts = s.actions.filter(a => ms - a.ms < 2 * DAY).slice(-5);
  if (acts.length) lines.push('Ultime azioni fatte: ' + acts.map(a => `${a.what} (${ago(a.ms, ms)}${a.session !== sessionId ? ', in un\'altra chat' : ''})`).join('; '));
  const plans = s.open.filter(o => o.kind === 'piano');
  for (const p of plans.slice(-4)) {
    const when = p.due < today ? `era ${p.due === addDays(today, -1) ? 'ieri' : 'il ' + p.due.slice(8) + '/' + p.due.slice(5, 7)}: se c'entra, chiedi com'è andata` : p.due === today ? 'è oggi' : p.due === addDays(today, 1) ? 'è domani' : `il ${p.due.slice(8)}/${p.due.slice(5, 7)}`;
    lines.push(`Filo aperto: "${p.text}" (detto ${ago(p.ms, ms)}; ${when})`);
  }
  const q = s.open.find(o => o.kind === 'domanda');
  if (q && ms - q.ms < 6 * 3600_000) lines.push(`Avevi chiesto${q.session !== sessionId ? ' in un\'altra chat' : ''}: "${q.text}" (${ago(q.ms, ms)})`);
  const topics = s.topics.filter(t => ms - t.ms < 3 * DAY).slice(-6).reverse();
  if (topics.length) lines.push('Argomenti recenti: ' + topics.map(t => `${t.name} (${ago(t.ms, ms)})`).join(', '));
  // L'ultimo scambio di un'altra chat entra solo se il Capo lo sta riprendendo ("allora?", "a che punto siamo")
  // o se parla della stessa cosa: altrimenti sarebbe rumore nel contesto.
  const words = new Set(keywords(userText).map(w => w.slice(0, 5)));
  const other = s.others.find(o => o.session !== sessionId && ms - o.ms < DAY
    && (RESUME_RE.test(userText) || keywords(o.user + ' ' + o.reply).some(w => w.length >= 4 && words.has(w.slice(0, 5)))));
  if (other) lines.push(`Ultimo scambio altrove${other.title ? ` (${other.title})` : ''}, ${ago(other.ms, ms)}: il Capo "${other.user}" — tu "${other.reply}"`);
  if (!lines.length) return '';
  return ('CONTINUITÀ (lo stesso filo in tutte le chat e a voce)\n' + lines.map(l => '- ' + l).join('\n')).slice(0, 1200);
}

/** Per il motore di iniziativa: i piani passati da ieri o prima, non ancora ripresi, diventano una domanda. */
export function dueFollowUps(db, ms, tz) {
  const s = load(db);
  const today = todayOf(ms, tz);
  return s.open.filter(o => o.kind === 'piano' && o.due < today && !o.closed && addDays(o.due, 3) >= today)
    .map(o => ({ key: `fu:${o.said}:${o.text.slice(0, 40)}`, text: `${o.due === addDays(today, -1) ? 'Ieri' : 'L\'altro giorno'} mi avevi detto: "${o.text}". Com'è andata?`, plan: o }));
}

export function closePlan(db, text) {
  const s = load(db);
  for (const o of s.open) if (o.kind === 'piano' && o.text === text) o.closed = true;
  kvSet(db, KEY, s);
}
