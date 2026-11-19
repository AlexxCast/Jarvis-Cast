// Il parlato vero del Capo, come lo scrive il riconoscimento vocale: esitazioni ("ehm", "tipo"), il nome detto
// all'inizio (anche storpiato), parole ripetute ("apri apri") e numeri a parole ("dieci minuti", "mezz'ora").
// Queste funzioni puliscono la frase PRIMA delle regole locali (timer, telefonate, cucina), così una frase
// incerta non finisce in un'azione sbagliata ("timer di dieci minuti" diventava un timer da 1 minuto).

// Suoni di esitazione: si tolgono ovunque. Le parole "di riempimento" (allora, tipo, senti...) solo all'inizio,
// perché in mezzo alla frase possono voler dire qualcosa ("che tipo di pasta", "non ho mangiato niente").
export const FILLER_RE = /(?<![\p{L}'])(?:e+h+m*|e+m+|m+h*|u+h*m+|u+h+|a+h+|cioè|cioe)(?![\p{L}'])/giu;
const LEAD_RE = /^\W*(?:(?:allora|senti|ok(?:ay)?|okei|dai|scusa|ecco|tipo|ehi|beh|boh|vabb?[eè]|dunque|insomma)\b\W*)+/i;
export const WAKE_RE = /^\W*(?:(?:ehi|ciao|ok|okay|allora|senti|e+h+)\W+)*(?:kestra|chestra|questra|cestra|kesta|kestrà|khestra|jarvis)\b\W*/i;

const UNITS = { zero: 0, un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19 };
const TENS = { venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90 };

/** "dieci" → 10, "venticinque" → 25, "ventuno" → 21, "cento" → 100. null se non è un numero a parole. */
export function wordToNumber(w) {
  const s = String(w || '').toLowerCase().replace(/[’']/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  if (s in UNITS) return UNITS[s];
  if (s === 'cento') return 100;
  for (const [t, v] of Object.entries(TENS)) {
    if (s === t) return v;
    const stem = t.slice(0, -1); // "vent", "trent"... per "ventuno", "trentotto"
    for (const head of [t, stem]) {
      if (s.startsWith(head)) {
        const rest = s.slice(head.length);
        if (rest in UNITS && UNITS[rest] > 0 && UNITS[rest] < 10) return v + UNITS[rest];
      }
    }
  }
  return null;
}

const NUM_WORD = '(?:un|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|trenta|quaranta|cinquanta|sessanta|cento|vent\\w*|trent\\w*|quarant\\w*|cinquant\\w*)';

/** Numeri a parole davanti a un'unità di tempo diventano cifre: "tra dieci minuti" → "tra 10 minuti". */
export function numbersToDigits(text) {
  return String(text || '')
    .replace(/\bun\s+quarto\s+d['’]\s*ora\b/gi, '15 minuti')
    .replace(/\bmezz['’]?\s*ora\b/gi, '30 minuti')
    .replace(/\bun['’]\s*ora\s+e\s+mezz[ao]\b/gi, '90 minuti')
    .replace(/\bun\s+paio\s+di\s+(second\w*|minut\w*|or[ae])\b/gi, '2 $1')
    .replace(/\bun['’]\s*ora\b/gi, '1 ora')
    .replace(/\bun['’]\s*oretta\b/gi, '1 ora')
    .replace(new RegExp(`\\b(${NUM_WORD})\\s+(second\\w*|minut\\w*|or[ae]|giorn\\w*)\\b`, 'gi'), (m, w, u) => {
      const v = wordToNumber(w);
      return v == null ? m : `${v} ${u}`;
    });
}

/**
 * Frase pronta per le regole locali: senza il nome all'inizio, senza esitazioni, senza parole ripetute
 * ("apri apri youtube"), con i numeri in cifre. Ritorna '' se dentro c'era solo esitazione ("ehm", "kestra").
 */
export function cleanSpoken(text) {
  let t = String(text || '').trim().replace(WAKE_RE, '');
  t = t.replace(FILLER_RE, ' ').replace(LEAD_RE, '').replace(WAKE_RE, '');
  t = numbersToDigits(t);
  t = t.replace(/\b(\p{L}+)(?:\s+\1\b)+/giu, '$1'); // "apri apri" → "apri", "di di" → "di"
  return t.replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.;:!?-]+/, '').replace(/\s+/g, ' ').trim();
}

/** Vero se la frase è solo esitazione, il nome o rumore ("ehm", "kestra", "mmh boh"). */
// "ciao kestra" è un saluto vero (merita una risposta), non esitazione.
export const isOnlyFiller = (text) => !/\b(?:ciao|buongiorno|buonasera|buonanotte|salve)\b/i.test(String(text || '')) && !cleanSpoken(text).replace(/[^\p{L}\p{N}]+/gu, '');

/** "1 minuti" → "1 minuto". */
export function unitLabel(amount, unit) {
  const u = String(unit || '').toLowerCase();
  const one = Number(amount) === 1;
  if (u.startsWith('second')) return one ? 'secondo' : 'secondi';
  if (u.startsWith('or')) return one ? 'ora' : 'ore';
  return one ? 'minuto' : 'minuti';
}
