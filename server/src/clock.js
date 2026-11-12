// Data e ora nel fuso dell'utente (i Worker girano in UTC).

export function localParts(ms, tz = 'Europe/Rome') {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const giorni = { Monday: 'lunedì', Tuesday: 'martedì', Wednesday: 'mercoledì', Thursday: 'giovedì', Friday: 'venerdì', Saturday: 'sabato', Sunday: 'domenica' };
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: giorni[p.weekday] || p.weekday };
}
export const today = (ms, tz) => localParts(ms, tz).date;
export const nowIso = (ms, tz) => { const p = localParts(ms, tz); return `${p.date}T${p.time}`; };
export const nowHuman = (ms, tz) => { const p = localParts(ms, tz); return `${p.weekday} ${p.date} ore ${p.time}`; };

/** Converte "yyyy-MM-ddTHH:mm" espresso nel fuso dell'utente in millisecondi UTC. */
export function localToMs(local, tz = 'Europe/Rome') {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(local || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Corregge l'offset del fuso (due passate bastano anche a cavallo del cambio d'ora).
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(ms, tz);
    const shown = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), +p.time.slice(0, 2), +p.time.slice(3, 5));
    ms += guess - shown;
  }
  return ms;
}
