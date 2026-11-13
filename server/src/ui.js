// Interfaccia su misura: Jarvis può decidere cosa mostrare e dove, quando l'utente lo chiede
// ("voglio vedere sempre il deficit accumulato"). Non scrive codice: sceglie tra riquadri già pronti
// e note libere, così il cambiamento è immediato e non può rompere l'app.

import { kvGet, kvSet } from './db.js';

/** Riquadri disponibili: id → descrizione (serve al modello per scegliere). */
export const WIDGETS = {
  deficit_cumulativo: 'deficit calorico accumulato dall\'inizio e perdita di peso stimata',
  calorie_oggi: 'calorie mangiate oggi, obiettivo e quanto resta',
  macro_oggi: 'proteine, carboidrati e grassi di oggi',
  passi_oggi: 'passi di oggi e calorie bruciate con le attività',
  peso: 'ultimo peso registrato e variazione dall\'inizio',
  deficit_medio: 'deficit medio al giorno e media calorie nette',
  promemoria: 'prossimi promemoria',
  compiti: 'compiti in corso in background',
};
export const PLACES = ['jarvis', 'oggi'];
const MAX_PER_PLACE = 6;

export function loadLayout(db) {
  const raw = kvGet(db, 'layout', null) || {};
  const out = { jarvis: [], oggi: [] };
  for (const p of PLACES) {
    out[p] = (Array.isArray(raw[p]) ? raw[p] : []).filter(w => w && (WIDGETS[w.type] || (w.type === 'nota' && w.text))).slice(0, MAX_PER_PLACE);
  }
  return out;
}

const placeOf = (where) => (PLACES.includes(String(where || '').toLowerCase()) ? String(where).toLowerCase() : 'jarvis');
const sameWidget = (a, b) => a.type === b.type && (a.type !== 'nota' || a.id === b.id);

/** Applica ui_pin, ui_unpin, ui_note, ui_reset. Ritorna true se ha cambiato qualcosa. */
export function applyUiAction(db, a, nowIso = '') {
  const layout = loadLayout(db);
  if (a.type === 'ui_reset') {
    kvSet(db, 'layout', { jarvis: [], oggi: [] });
    return true;
  }
  if (a.type === 'ui_pin') {
    const type = String(a.widget || '').toLowerCase();
    if (!WIDGETS[type]) return false;
    const place = placeOf(a.where);
    if (layout[place].some(w => w.type === type)) return false;
    layout[place] = [{ type }, ...layout[place]].slice(0, MAX_PER_PLACE);
  } else if (a.type === 'ui_unpin') {
    const type = String(a.widget || '').toLowerCase();
    const places = a.where ? [placeOf(a.where)] : PLACES;
    let changed = false;
    for (const p of places) {
      const before = layout[p].length;
      layout[p] = layout[p].filter(w => !(w.type === type || (w.type === 'nota' && (w.id === a.id || w.id === type))));
      changed = changed || layout[p].length !== before;
    }
    if (!changed) return false;
  } else if (a.type === 'ui_note') {
    const text = String(a.text || '').trim().slice(0, 160);
    if (!text) return false;
    const place = placeOf(a.where);
    const note = { type: 'nota', id: 'n' + Date.parse(nowIso || 0).toString(36) + Math.random().toString(36).slice(2, 5), title: String(a.title || '').trim().slice(0, 40), text };
    layout[place] = [note, ...layout[place].filter(w => !sameWidget(w, note))].slice(0, MAX_PER_PLACE);
  } else return false;
  kvSet(db, 'layout', layout);
  return true;
}

export const UI_ACTIONS = new Set(['ui_pin', 'ui_unpin', 'ui_note', 'ui_reset']);

export function uiPrompt(layout) {
  const now = PLACES.map(p => `${p}: ${layout[p].map(w => (w.type === 'nota' ? `nota[${w.id}] "${w.text}"` : w.type)).join(', ') || 'vuoto'}`).join(' · ');
  return `PERSONALIZZARE L'APP
- Se l'utente chiede di vedere sempre qualcosa, di togliere qualcosa o di cambiare cosa mostra l'app, usa ui_pin / ui_unpin / ui_note. Il cambiamento è immediato.
- where: "jarvis" (schermata principale con la sfera) oppure "oggi" (scheda Oggi). Se non lo dice, usa "jarvis".
- Riquadri: ${Object.entries(WIDGETS).map(([k, v]) => `${k} (${v})`).join('; ')}.
- Per qualcosa che non è tra i riquadri usa ui_note con un testo breve da tenere in vista; se serve davvero una funzione nuova, dillo chiaramente invece di inventarla.
- Ora mostrato: ${now}.`;
}
