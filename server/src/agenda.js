// Promemoria con scadenza. Quando scadono finiscono nella "posta in arrivo" che telefono e web app leggono.

import { pushInbox } from './db.js';
import { localToMs, nowIso, localParts } from './clock.js';
import { newId } from './diet.js';

export function addReminder(db, { text, due }, ms, tz) {
  const dueMs = localToMs(due, tz);
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean || dueMs == null) return null;
  const id = newId('r', ms);
  db.run('INSERT INTO reminders (id, text, due, created) VALUES (?, ?, ?, ?)', id, clean, dueMs, nowIso(ms, tz));
  return id;
}
export const doneReminder = (db, id) => db.run('UPDATE reminders SET done = 1 WHERE id = ?', String(id));
export const deleteReminder = (db, id) => db.run('DELETE FROM reminders WHERE id = ?', String(id));

export function listReminders(db, tz) {
  return db.all('SELECT id, text, due, done FROM reminders WHERE done = 0 ORDER BY due LIMIT 100').map(x => {
    const p = localParts(x.due, tz);
    return { id: x.id, text: x.text, due: `${p.date}T${p.time}`, dueMs: x.due };
  });
}

/** Sposta nella posta in arrivo i promemoria scaduti. Ritorna la prossima scadenza (ms) o null. */
export function fireDue(db, ms, tz) {
  for (const x of db.all('SELECT id, text FROM reminders WHERE done = 0 AND due <= ?', ms)) {
    pushInbox(db, nowIso(ms, tz), 'reminder', x.text);
    db.run('UPDATE reminders SET done = 1 WHERE id = ?', x.id);
  }
  const next = db.get('SELECT MIN(due) AS due FROM reminders WHERE done = 0');
  return next?.due ?? null;
}

export function agendaContext(db, tz) {
  const list = listReminders(db, tz);
  return list.length ? 'PROMEMORIA ATTIVI\n' + list.slice(0, 30).map(x => `- [${x.id}] ${x.due.replace('T', ' ')} — ${x.text}`).join('\n') : '';
}
