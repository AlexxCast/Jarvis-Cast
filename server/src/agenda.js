// Promemoria con scadenza. Quando scadono finiscono nella "posta in arrivo" che telefono e web app leggono.

import { pushInbox } from './db.js';
import { localToMs, nowIso, localParts } from './clock.js';
import { newId } from './diet.js';

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

export function addReminder(db, { text, due, repeat }, ms, tz) {
  const dueMs = localToMs(due, tz);
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean || dueMs == null) return null;
  const rep = REPEATS[String(repeat || '').toLowerCase()] ? String(repeat).toLowerCase() : '';
  const id = newId('r', ms);
  db.run('INSERT INTO reminders (id, text, due, created, repeat) VALUES (?, ?, ?, ?, ?)', id, clean, dueMs, nowIso(ms, tz), rep);
  return id;
}
export const doneReminder = (db, id) => db.run('UPDATE reminders SET done = 1 WHERE id = ?', String(id));
export const deleteReminder = (db, id) => db.run('DELETE FROM reminders WHERE id = ?', String(id));

export function listReminders(db, tz) {
  return db.all('SELECT id, text, due, done, repeat FROM reminders WHERE done = 0 ORDER BY due LIMIT 100').map(x => {
    const p = localParts(x.due, tz);
    return { id: x.id, text: x.text, due: `${p.date}T${p.time}`, dueMs: x.due, repeat: x.repeat || '' };
  });
}

/** Sposta nella posta in arrivo i promemoria scaduti. Ritorna la prossima scadenza (ms) o null. */
export function fireDue(db, ms, tz) {
  for (const x of db.all('SELECT id, text, due, repeat FROM reminders WHERE done = 0 AND due <= ?', ms)) {
    pushInbox(db, nowIso(ms, tz), 'reminder', x.text);
    // Quelli che si ripetono passano alla prossima volta (una sola notifica anche se il server era fermo).
    const next = x.repeat ? nextOccurrence(x.due, x.repeat, ms, tz) : null;
    if (next) db.run('UPDATE reminders SET due = ? WHERE id = ?', next, x.id);
    else db.run('UPDATE reminders SET done = 1 WHERE id = ?', x.id);
  }
  const next = db.get('SELECT MIN(due) AS due FROM reminders WHERE done = 0');
  return next?.due ?? null;
}

export function agendaContext(db, tz) {
  const list = listReminders(db, tz);
  return list.length ? 'PROMEMORIA ATTIVI\n' + list.slice(0, 30).map(x => `- [${x.id}] ${x.due.replace('T', ' ')}${x.repeat ? ` (${REPEATS[x.repeat]})` : ''} — ${x.text}`).join('\n') : '';
}
