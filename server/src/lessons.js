// Apprendimento dalle correzioni: quando il Capo corregge Kestra ("no, intendevo…", "hai sbagliato"),
// la regola che ne esce viene salvata e torna nel contesto le volte dopo, quando è pertinente.
// La regola la scrive il modello con l'azione learn; se non lo fa, si salva comunque la correzione grezza.

import { kvGet, kvSet } from './db.js';
import { keywords } from './memory.js';

const KEY = 'lessons';
const MAX = 80;

export const CORRECTION_RE = /^\W*(?:(?:kestra|chestra)\W+)?(?:no\b(?!\s+(?:grazie|problem))|non\s+(?:intendevo|volevo|ho\s+detto|era\s+quello|è\s+quello|e\s+quello|quello)|hai\s+sbagliato|sbagliat[oa]|ho\s+detto\b|intendevo\b|ti\s+ho\s+(?:detto|chiesto)|non\s+hai\s+capito|ma\s+(?:no|cosa)\b|correggi\b|invece\s+(?:di|che))/i;

const root = (w) => (w.length > 5 ? w.slice(0, 5) : w);
const similar = (a, b) => {
  const A = new Set(keywords(a).map(root)), B = new Set(keywords(b).map(root));
  if (!A.size || !B.size) return false;
  let i = 0; for (const k of A) if (B.has(k)) i++;
  return i / (A.size + B.size - i) >= 0.7;
};

export function list(db) { return kvGet(db, KEY, []); }

/** Salva una regola imparata. Una regola quasi uguale a una esistente la aggiorna invece di duplicarla. */
export function learn(db, rule, nowIso, source = 'model') {
  const text = String(rule || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (text.length < 8) return null;
  const all = list(db);
  const same = all.find(l => similar(l.rule, text));
  if (same) { same.rule = text; same.at = nowIso; same.hits = (same.hits || 1) + 1; kvSet(db, KEY, all); return same.id; }
  const id = 'l' + Date.parse(nowIso).toString(36) + all.length.toString(36);
  kvSet(db, KEY, [...all.slice(-(MAX - 1)), { id, rule: text, at: nowIso, hits: 1, source }]);
  return id;
}

export function forget(db, id) {
  kvSet(db, KEY, list(db).filter(l => l.id !== id));
}

/** Correzione senza regola dal modello: si salva lo scambio, così l'errore non si ripete identico. */
export function learnFromCorrection(db, { previousUser, previousReply, correction }, nowIso) {
  if (!previousReply) return null;
  const rule = `Quando il Capo ha chiesto "${String(previousUser || '').slice(0, 80)}" non andava bene "${String(previousReply).slice(0, 80)}": ha precisato "${String(correction).slice(0, 120)}".`;
  return learn(db, rule, nowIso, 'correzione');
}

/** Le regole utili per questa frase (più le ultime imparate), da mettere nel contesto. */
export function relevant(db, text, limit = 6) {
  const all = list(db);
  if (!all.length) return [];
  const want = new Set(keywords(text).map(root));
  const scored = all.map((l, i) => ({ l, s: keywords(l.rule).map(root).filter(k => want.has(k)).length + (i >= all.length - 2 ? 0.5 : 0) + Math.min(1, (l.hits || 1) / 4) }));
  return scored.filter(x => x.s >= 1).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.l);
}

export function contextBlock(db, text) {
  const rel = relevant(db, text);
  if (!rel.length) return '';
  return 'LEZIONI IMPARATE DALLE CORREZIONI DEL CAPO (rispettale sempre)\n' + rel.map(l => `- ${l.rule}`).join('\n');
}
