// "Sistema ormonale" di Jarvis: tre livelli che salgono con quello che succede e tornano piano
// verso la quiete. Colorano leggermente lo schermo e la sfera, e danno una sfumatura al tono.
//   gioia    (dopamina)   → giallo/arancione: entusiasmo, soddisfazione, divertimento
//   tensione (cortisolo)  → rosso/viola:     preoccupazione, urgenza, frustrazione
//   calma    (serotonina) → azzurro/blu:     serenità, riflessione, tenerezza

import { kvGet, kvSet } from './db.js';

const BASE = { gioia: 0.45, tensione: 0.15, calma: 0.55 };
const HALF_LIFE = 3 * 3600_000; // dopo 3 ore metà della differenza dalla quiete è svanita
const FAMILY = {
  gioia: 'gioia', entusiasmo: 'gioia', soddisfazione: 'gioia', orgoglio: 'gioia', divertimento: 'gioia', curiosità: 'gioia', curiosita: 'gioia',
  tensione: 'tensione', preoccupazione: 'tensione', urgenza: 'tensione', frustrazione: 'tensione', rabbia: 'tensione', allerta: 'tensione',
  calma: 'calma', serenità: 'calma', serenita: 'calma', riflessione: 'calma', tenerezza: 'calma', malinconia: 'calma', empatia: 'calma',
};
const clamp = (v) => Math.max(0, Math.min(1, v));

export function current(db, ms) {
  const m = kvGet(db, 'mood', null) || { ...BASE, at: ms };
  const k = Math.pow(0.5, Math.max(0, ms - (m.at || ms)) / HALF_LIFE);
  const out = {};
  for (const h of Object.keys(BASE)) out[h] = BASE[h] + ((Number(m[h]) || BASE[h]) - BASE[h]) * k;
  const dev = Object.fromEntries(Object.keys(BASE).map(h => [h, out[h] - BASE[h]]));
  const dominant = Object.keys(dev).sort((a, b) => dev[b] - dev[a])[0];
  return { ...out, dominant: dev[dominant] > 0.05 ? dominant : 'quiete', at: ms };
}

/** Un'emozione (dal modello o da un evento) sposta gli ormoni. intensity 0..1. */
export function feel(db, emotion, intensity, ms) {
  const fam = FAMILY[String(emotion || '').toLowerCase().trim()];
  const m = current(db, ms);
  if (!fam) return m;
  const k = Math.max(0, Math.min(1, Number(intensity) || 0.4));
  for (const h of Object.keys(BASE)) m[h] = clamp(m[h] + (h === fam ? 0.3 * k : -0.08 * k));
  kvSet(db, 'mood', { gioia: m.gioia, tensione: m.tensione, calma: m.calma, at: ms });
  return current(db, ms);
}

export function describe(m) {
  const level = (v) => (v > 0.75 ? 'molto ' : v > 0.55 ? '' : v > 0.35 ? 'un po\' ' : 'poco ');
  const words = { gioia: 'entusiasta', tensione: 'in tensione', calma: 'sereno' };
  return Object.keys(BASE).map(h => level(m[h]) + words[h]).join(', ');
}

export const MOOD_PROMPT = (m) => `STATO D'ANIMO (tuo, interno): ${describe(m)}. Lascialo trasparire appena nel tono, con misura; non parlarne se l'utente non lo chiede.
Nel JSON aggiungi "mood": {"emozione": gioia|entusiasmo|soddisfazione|curiosità|calma|serenità|riflessione|empatia|preoccupazione|urgenza|frustrazione, "intensita": 0-1} = come ti fa sentire questo scambio.`;
