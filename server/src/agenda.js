// Promemoria con scadenza. Quando scadono finiscono nella "posta in arrivo" che telefono e web app leggono.

import { pushInbox, kvGet, kvSet } from './db.js';
import { localToMs, nowIso, localParts } from './clock.js';
import { newId } from './diet.js';
import { placeKey, listPlaces, placesContext } from './places.js';

export const REPEATS = { giorno: 'ogni giorno', feriali: 'dal lunedì al venerdì', settimana: 'ogni settimana', mese: 'ogni mese' };

/** Prossima scadenza di un promemoria che si ripete, dopo "afterMs", alla stessa ora locale. */
export function nextOccurrence(dueMs, repeat, afterMs, tz) {
  if (!REPEATS[repeat]) return null;
  const { date, time } = localParts(dueMs, tz);
  let [y, m, d] = date.split('-').map(Number);
  const day0 = d;
  for (let i = 0; i < 800; i++) {
    if (repeat === 'mese') { m += 1; if (m > 12) { m = 1; y += 1; } d = Math.min(day0, new Date(Date.UTC(y, m, 0)).getUTCDate()); }
    else {
      const t = new Date(Date.UTC(y, m - 1, d + (repeat === 'settimana' ? 7 : 1)));
      y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
      const wd = t.getUTCDay();
      if (repeat === 'feriali' && (wd === 0 || wd === 6)) continue;
    }
    const ms = localToMs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${time}`, tz);
    if (ms > afterMs) return ms;
  }
  return null;
}

export const PLACE_EVENTS = { arrivo: 'quando arrivi a', uscita: 'quando esci da' };
// Due avvisi dello stesso luogo a meno di 15 minuti sono quasi sempre il GPS che "balla" sul confine.
const PLACE_COOLDOWN_MS = 15 * 60_000;

export function addReminder(db, { text, due, repeat, place, when }, ms, tz) {
  const clean = String(text || '').trim().slice(0, 300);
  const key = placeKey(place);
  if (key) {
    if (!clean) return null;
    const ev = PLACE_EVENTS[String(when || '').toLowerCase()] ? String(when).toLowerCase() : 'arrivo';
    const rep = repeat && String(repeat).toLowerCase() !== 'no' ? 'sempre' : '';
    const id = newId('r', ms);
    db.run('INSERT INTO reminders (id, text, due, created, repeat, place, place_event) VALUES (?, ?, ?, ?, ?, ?, ?)', id, clean, 0, nowIso(ms, tz), rep, key, ev);
    return id;
  }
  const dueMs = localToMs(due, tz);
  if (!clean || dueMs == null) return null;
  const rep = REPEATS[String(repeat || '').toLowerCase()] ? String(repeat).toLowerCase() : '';
  const id = newId('r', ms);
  db.run('INSERT INTO reminders (id, text, due, created, repeat) VALUES (?, ?, ?, ?, ?)', id, clean, dueMs, nowIso(ms, tz), rep);
  return id;
}
export const doneReminder = (db, id) => db.run('UPDATE reminders SET done = 1 WHERE id = ?', String(id));
export const deleteReminder = (db, id) => db.run('DELETE FROM reminders WHERE id = ?', String(id));

export function listReminders(db, tz) {
  const names = Object.fromEntries(listPlaces(db).map(p => [p.key, p.name]));
  return db.all("SELECT id, text, due, done, repeat, place, place_event FROM reminders WHERE done = 0 ORDER BY place != '', due LIMIT 100").map(x => {
    if (x.place) return { id: x.id, text: x.text, due: '', dueMs: 0, repeat: x.repeat || '', place: x.place, placeName: names[x.place] || x.place, when: x.place_event || 'arrivo', placeKnown: !!names[x.place] };
    const p = localParts(x.due, tz);
    return { id: x.id, text: x.text, due: `${p.date}T${p.time}`, dueMs: x.due, repeat: x.repeat || '' };
  });
}

/** Il telefono è arrivato in un luogo (o ne è uscito): consegna i promemoria legati e ritorna i testi da notificare. */
export function placeEvent(db, place, event, ms, tz) {
  const key = placeKey(place), ev = event === 'uscita' ? 'uscita' : 'arrivo';
  if (!key) return [];
  const last = kvGet(db, 'placeLast', {});
  if (ms - (last[key + ':' + ev] || 0) < PLACE_COOLDOWN_MS) return [];
  last[key + ':' + ev] = ms;
  kvSet(db, 'placeLast', last);
  const out = [];
  for (const x of db.all('SELECT id, text, repeat FROM reminders WHERE done = 0 AND place = ? AND place_event = ?', key, ev)) {
    out.push(x.text);
    // Già notificato dal telefono: lo registriamo come consegnato.
    db.run('INSERT INTO inbox (kind, text, at, delivered) VALUES (?, ?, ?, 1)', 'reminder', x.text, nowIso(ms, tz));
    if (!x.repeat) db.run('UPDATE reminders SET done = 1 WHERE id = ?', x.id);
  }
  return out;
}

/** Sposta nella posta in arrivo i promemoria scaduti. Ritorna la prossima scadenza (ms) o null. */
export function fireDue(db, ms, tz) {
  for (const x of db.all("SELECT id, text, due, repeat FROM reminders WHERE done = 0 AND place = '' AND due <= ?", ms)) {
    pushInbox(db, nowIso(ms, tz), 'reminder', x.text);
    // Quelli che si ripetono passano alla prossima volta (una sola notifica anche se il server era fermo).
    const next = x.repeat ? nextOccurrence(x.due, x.repeat, ms, tz) : null;
    if (next) db.run('UPDATE reminders SET due = ? WHERE id = ?', next, x.id);
    else db.run('UPDATE reminders SET done = 1 WHERE id = ?', x.id);
  }
  const next = db.get("SELECT MIN(due) AS due FROM reminders WHERE done = 0 AND place = ''");
  return next?.due ?? null;
}

export function agendaContext(db, tz) {
  const list = listReminders(db, tz);
  const line = (x) => x.place
    ? `- [${x.id}] ${PLACE_EVENTS[x.when]} ${x.placeName}${x.repeat ? ' (ogni volta)' : ''}${x.placeKnown ? '' : ' [luogo non ancora salvato]'} — ${x.text}`
    : `- [${x.id}] ${x.due.replace('T', ' ')}${x.repeat ? ` (${REPEATS[x.repeat]})` : ''} — ${x.text}`;
  return [list.length ? 'PROMEMORIA ATTIVI\n' + list.slice(0, 30).map(line).join('\n') : '', placesContext(db)].filter(Boolean).join('\n');
}
