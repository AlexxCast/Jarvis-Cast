// Kestra senza server: copia sul telefono di tutto quello che l'app ha letto (stato, storico, grafo, progetti...)
// e coda delle modifiche da mandare quando il server torna. Così l'app si apre sempre, anche offline o con
// le scritture gratuite di Cloudflare finite, e nulla di quello che il Capo dice va perso.

const PREFIX = 'kestra_cache:';
const QUEUE_KEY = 'kestra_queue';
const MAX_ITEM = 2_000_000; // caratteri: localStorage ne tiene ~5 milioni in tutto
// Letture che non serve copiare: grandi, private o che hanno senso solo dal vivo.
const NO_CACHE = /^\/(export|writes|devices\/screen|jobs\/[^/]+\/document|health)/;

export function cacheGet(path) {
  try { return JSON.parse(localStorage.getItem(PREFIX + path) || 'null'); } catch { return null; }
}

export function cacheSet(path, data) {
  if (NO_CACHE.test(path)) return;
  let text;
  try { text = JSON.stringify({ at: Date.now(), data }); } catch { return; }
  if (text.length > MAX_ITEM) return;
  try { localStorage.setItem(PREFIX + path, text); } catch {
    // Memoria piena: si toglie la copia più vecchia (mai lo stato o lo storico) e si riprova una volta.
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX) && !/:\/(state|history)$/.test(k));
      keys.sort((a, b) => (cacheGet(a.slice(PREFIX.length))?.at || 0) - (cacheGet(b.slice(PREFIX.length))?.at || 0));
      if (keys[0]) localStorage.removeItem(keys[0]);
      localStorage.setItem(PREFIX + path, text);
    } catch { /* pazienza: resta la copia precedente */ }
  }
}

// ------------------------------------------------------------------ coda delle modifiche

export function queue() {
  try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : []; } catch { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-200))); } catch { /* piena */ }
}
/** op: { kind: 'actions', actions } | { kind: 'history', messages } | { kind: 'chat', text } */
export function enqueue(op) {
  const full = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), at: Date.now(), ...op };
  saveQueue([...queue(), full]);
  return full;
}
export function dequeue(ids) {
  const done = new Set(ids);
  saveQueue(queue().filter(op => !done.has(op.id)));
}

/** Messaggi ancora solo sul telefono, da mostrare in fondo allo storico finché il server non li ha. */
export function pendingMessages() {
  const out = [];
  for (const op of queue()) {
    if (op.kind === 'history') for (const m of op.messages || []) out.push({ role: m.role, text: m.text, at: m.at, offline: true });
    if (op.kind === 'chat') out.push({ role: 'user', text: op.text, at: op.at, offline: true }, { role: 'assistant', text: 'In attesa del server: lo registro appena torna.', offline: true });
  }
  return out;
}

// Modifiche manuali che si possono ripetere più tardi (lo stesso elenco del server, isReplayable).
export const REPLAYABLE = new Set(['add_meal', 'update_meal', 'delete_meal', 'add_activity', 'delete_activity', 'add_weight', 'set_steps',
  'update_profile', 'add_pantry_item', 'remove_pantry_item', 'save_recipe', 'delete_recipe', 'remember', 'forget', 'add_reminder', 'done_reminder']);

// ------------------------------------------------------------------ cosa Kestra sa fare da sola

const NUM = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12,
  quindici: 15, venti: 20, venticinque: 25, trenta: 30, quaranta: 40, quarantacinque: 45, cinquanta: 50, sessanta: 60, novanta: 90 };
const num = (w) => (/^\d+([.,]\d+)?$/.test(w) ? Number(w.replace(',', '.')) : NUM[w] ?? NaN);

/** "tra 10 minuti", "timer di cinque minuti", "mezz'ora", "un'ora e mezza" → millisecondi, oppure 0. */
export function parseDuration(text) {
  const t = String(text || '').toLowerCase().replace(/[’']/g, "'");
  if (/mezz'?ora/.test(t) && !/\d|un'?ora|due ore/.test(t.replace(/mezz'?ora/, ''))) return 30 * 60_000;
  let ms = 0;
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?|[a-z]+)\s*(?:'\s*)?(ore|ora|minuti|minuto|min|secondi|secondo|sec)\b/g)) {
    const n = m[1] === 'un' || m[1] === 'una' ? 1 : num(m[1]);
    if (!(n > 0)) continue;
    ms += n * (/^or/.test(m[2]) ? 3_600_000 : /^min/.test(m[2]) ? 60_000 : 1000);
  }
  if (/un'ora/.test(t) && !/\b1\s*ora/.test(t)) ms += 3_600_000;
  if (/(ore|ora) e mezza/.test(t)) ms += 30 * 60_000;
  return ms;
}

/**
 * Risposta senza server. ctx: { state, native: { openApp, callContact, speak }, startTimer(ms, label) }.
 * Ritorna { reply, queue?: true } oppure null se non c'è niente di sensato da fare da soli.
 */
export function localAnswer(text, ctx) {
  const t = String(text || '').trim();
  const low = t.toLowerCase().replace(/^(ehi |ciao )?(kestra|jarvis)[,!\s]*/i, '').trim();
  const s = ctx.state || {};
  const today = s.today || {};

  if (/^(che ore sono|che ora è|dimmi l'ora)/.test(low)) {
    return { reply: `Sono le ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.` };
  }
  if (/(timer|sveglia|avvisami|ricordami|conto alla rovescia)/.test(low)) {
    const ms = parseDuration(low);
    if (ms >= 5000 && ms <= 12 * 3_600_000) {
      const what = (low.match(/(?:di|per)\s+([a-zà-ù ]{3,40})$/) || [])[1];
      const label = what && !/minut|or[ae]|second/.test(what) ? what.trim() : 'Timer';
      ctx.startTimer(ms, label);
      const mins = Math.round(ms / 60_000);
      return { reply: `Timer partito: ${mins >= 1 ? mins + (mins === 1 ? ' minuto' : ' minuti') : Math.round(ms / 1000) + ' secondi'}. Ti avviso io (tieni l'app aperta o in sottofondo).` };
    }
  }
  const open = low.match(/^(?:apri|avvia|lancia|fammi vedere)\s+(?:l'app\s+|l'applicazione\s+|app\s+)?(.{2,40})$/);
  if (open && ctx.native?.openApp) {
    const name = open[1].replace(/[.!?]+$/, '').trim();
    return { reply: ctx.native.openApp(name) ? `Apro ${name}.` : `Non trovo l'app ${name} sul telefono.` };
  }
  const call = low.match(/^(?:chiama|telefona a)\s+(.{2,40})$/);
  if (call && ctx.native?.callContact) {
    const who = call[1].replace(/[.!?]+$/, '').trim();
    if (/\d/.test(who)) return { reply: 'Senza server chiamo solo i contatti della rubrica, non i numeri.' };
    const res = String(ctx.native.callContact(who) || '');
    if (res.startsWith('ok:')) return { reply: `Chiamo ${res.slice(3) || who}.` };
    if (res === 'permesso') return { reply: 'Mi servono i permessi Contatti e Telefono: te li chiedo ora.' };
    if (res === 'sconosciuto') return { reply: `Non trovo ${who} in rubrica.` };
    return { reply: `Non riesco a chiamare ${who}.` };
  }
  if (/(calori|kcal)/.test(low) && /(quant|rimast|mancan|ho mangiato oggi|oggi)/.test(low) && !/^ho mangiato\b/.test(low)) {
    if (!today.date) return { reply: 'Non ho ancora una copia del diario sul telefono.' };
    const rest = Math.round(today.remaining ?? 0);
    return { reply: `Oggi hai mangiato ${today.eaten || 0} kcal${today.target ? ` su ${today.target}` : ''}: ${rest >= 0 ? `ne restano ${rest}` : `sei sopra di ${-rest}`}. Proteine ${today.protein || 0} g${today.proteinTarget ? ` su ${today.proteinTarget}` : ''}. (Dati salvati sul telefono.)` };
  }
  if (/(quanto peso|il mio peso|ultim[ao] pes)/.test(low)) {
    const w = (s.diary?.weights || []).slice(-1)[0];
    return { reply: w ? `L'ultima pesata è ${w.kg} kg del ${String(w.date).split('-').reverse().join('/')}.` : 'Non ho pesate salvate sul telefono.' };
  }
  if (/(promemoria|cosa devo fare|impegni|appuntament)/.test(low) && !/(ricordami|aggiungi|metti|crea)/.test(low)) {
    const list = (s.reminders || []).filter(r => !r.place).slice(0, 5);
    if (!list.length) return { reply: 'Non vedo promemoria in arrivo nella copia sul telefono.' };
    return { reply: 'Prossimi promemoria: ' + list.map(r => `${r.text} (${new Date(r.dueMs).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`).join('; ') + '.' };
  }
  // Pasti, sport, peso, cose da ricordare: si segnano e si registrano quando il server torna, con l'ora di adesso.
  if (/(ho mangiato|ho bevuto|ho fatto colazione|ho pranzato|ho cenato|spuntino|mi sono pesat|peso \d|ho corso|ho camminato|allenament|palestra|ricorda(mi)? che|ricordati|ricordami di|promemoria)/.test(low)) {
    return { reply: 'Il server non risponde: me lo segno sul telefono e lo registro con l\'ora di adesso appena torna.', queue: true };
  }
  return null;
}

export const OFFLINE_HELP = 'Il server non risponde. Da sola posso: timer ("timer 10 minuti"), aprire app, chiamare un contatto, dirti calorie, peso e promemoria salvati sul telefono, e segnarmi pasti, allenamenti e cose da ricordare per registrarli dopo.';
