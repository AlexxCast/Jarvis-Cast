// Gli occhi di Kestra sul PC. Prima il PC era cieco: "scorri" faceva un solo scatto di rotellina e "clicca su…"
// cercava una scritta con Ctrl+F, quindi "il terzo video" o "quello col gatto" su YouTube o Prime non si potevano fare.
// Ora il PC manda una foto dello schermo, un modello con la vista dice dove sono i video e dove cliccare, e il PC
// clicca lì. Lo scorrimento può andare avanti da solo finché il Capo dice "fermo".
import { kvGet, kvSet } from './db.js';
import * as devices from './devices.js';
import * as router from './router.js';
import { nowIso } from './clock.js';

const LOOK_TTL_MS = 3 * 60_000;      // l'elenco numerato vale finché lo schermo non cambia (o per 3 minuti)
const AUTO_SCROLL_TTL_MS = 45_000;   // il PC smette da solo dopo 40 secondi
export const EYES_CAPS = ['look', 'click', 'autoscroll'];

const PRE = String.raw`^(?:(?:ok|okay|e|ora|adesso|poi|dai|allora|no|s[iì]|ma|invece|per\s+favore)\s+)*`;
const ORD = { primo: 1, prima: 1, secondo: 2, seconda: 2, terzo: 3, terza: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5,
  sesto: 6, sesta: 6, settimo: 7, settima: 7, ottavo: 8, ottava: 8, nono: 9, nona: 9, decimo: 10, decima: 10 };
const ORD_WORD = `(?:${Object.keys(ORD).join('|')}|ultim[oa]|penultim[oa]|numero\\s+\\d{1,2}|n\\.?\\s*\\d{1,2})`;
const VERB = String.raw`(?:apri(?:mi)?|metti(?:mi)?|clicca(?:\s+su)?|cliccami|seleziona|scegli|guarda(?:mi)?|fai\s+partire|fammi\s+vedere|vai\s+(?:su|al|alla|sul|sulla)|avvia|riproduci|prendi|voglio(?:\s+vedere)?)`;

// "che video ci sono", "cosa vedi sullo schermo", "leggimi i titoli", "numera i video"
const LIST_RE = new RegExp(PRE + String.raw`(?:(?:dimmi|fammi\s+sapere|sai\s+dirmi|vedi)\s+)?(?:(?:che|quali)\s+(?:video|film|serie|episodi|risultati|canzoni|cose|titoli)\s+(?:ci\s+sono|vedi|hai|ci\s+stanno|trovi)|cosa\s+(?:c['’]?\s*è|ce|vedi|c'?è)\s+(?:sullo\s+schermo|sul\s+pc|nella\s+pagina|in\s+pagina|qui|adesso)|(?:leggimi|dimmi|elencami|numerami|numera)\s+(?:i\s+|gli\s+|le\s+)?(?:video|film|titoli|risultati|episodi|opzioni)|guarda\s+(?:lo\s+schermo|la\s+pagina))\b`, 'iu');
// "il terzo", "apri il secondo video", "metti l'ultimo", "il numero 4"
const ORDINAL_RE = new RegExp(PRE + `(?:${VERB}\\s+)?(?:il|lo|la|l['’]|sul|sulla|sull['’]|al|alla)?\\s*(${ORD_WORD})(?:\\s+(?:video|film|risultato|link|episodio|canzone|riquadro|della\\s+fila|in\\s+alto|in\\s+basso))?\\W*$`, 'iu');
// "guarda quel video lì", "metti quello col gatto", "apri quello con la copertina rossa"
const DEICTIC_RE = new RegExp(PRE + `(?:${VERB}\\s+)?(quell[oaie]|quel)\\b(.*)$`, 'iu');
// "apri il video di Ligabue", "clicca sul film con Tom Hanks"
// "metti il video di X" resta la ricerca su YouTube di prima (funziona senza vista): qui solo apri/clicca/scegli.
const DESCRIBED_RE = new RegExp(PRE + String.raw`(?:apri(?:mi)?|clicca(?:\s+su)?|seleziona|scegli|prendi)\s+(?:il|lo|la|l['’]|sul|sulla|sull['’]|su)?\s*(?:video|film|episodio|serie|risultato)\s+(?:di|del|della|dei|delle|con|col|che|dove|sul|sulla|su)\b(.+)$`, 'iu');
// Senza verbo "quello..." vale solo se dice quale ("quello lì", "quello col gatto", "quello in alto a destra"):
// "quello lì è bello" o "quella è mia sorella" sono commenti, non clic.
const DEICTIC_BARE_RE = /^\W*(?:quell[oaie]|quel)\s+(?:(?:video|film|episodio|riquadro)\s+)?(?:l[iì]|là|col|con|coi|con\s+la|con\s+il|della|del|di|in\s+alto|in\s+basso|a\s+destra|a\s+sinistra|al\s+centro|sopra|sotto)\b(?!.*\b(?:è|era|sono|mi\s+piace|non\s+mi|carino|bello|brutto)\b)/iu;
const HAS_VERB_RE = new RegExp(PRE + VERB + String.raw`\s`, 'iu');

// Scorrimento continuo: "vai giù", "scorri", "continua a scorrere", "scendi piano". Un passo solo resta per
// "un po' più giù", "ancora un po'", "giù".
const AUTO_SCROLL_RE = new RegExp(PRE + String.raw`(continua\s+a\s+scorrere|fai\s+scorrere(?:\s+la\s+pagina)?|scorri(?:\s+la\s+pagina)?|vai|scendi|sali)\s*(gi[uù]|in\s+basso|verso\s+il\s+basso|su|in\s+alto|verso\s+l['’]alto|sopra)?(?:\s+(?:piano|pianino|lentamente|lento|veloce|di\s+continuo|finch[eé]\b.*))?\W*$`, 'iu');
const STOP_RE = new RegExp(PRE + String.raw`(?:fermo|ferma|fermati|fermala|stop|stoppa|basta|alt|lì|li|là|ecco|ok\s+così|così|aspetta|ferma\s+tutto|ferma\s+lì)(?:\s+(?:lì|li|là|qui|qua|così|un\s+attimo|ferma|fermo))*\W*$`, 'iu');
// "un po' più giù", "torna un po' su", "su un pochino": un passo solo (e ferma lo scorrimento se c'è).
const SMALL_STEP_RE = new RegExp(PRE + String.raw`(?:(?:torna|vai|scorri|scendi|sali)\s+)?(?:(?:un\s+(?:po['’]?|pochino|attimo)|di\s+poco)\s+)?(?:pi[uù]\s+)?(gi[uù]|su|sopra|sotto|in\s+basso|in\s+alto|indietro)(?:\s+(?:un\s+(?:po['’]?|pochino|attimo)|di\s+poco))?\W*$`, 'iu');
const SMALL_RE = /\b(?:un\s+(?:po['’]?|pochino|attimo)|di\s+poco)(?=\s|$)/iu;

/** Il PC sa guardare lo schermo? Lo dice il programma del PC aggiornato (heartbeat con caps). */
export function pcHasEyes(db, nowMs = Date.now()) {
  return devices.listDevices(db, nowMs).some(d => d.kind === 'desktop' && d.online && (d.caps || []).includes('look'));
}

const freshLook = (db, nowMs) => {
  const l = kvGet(db, 'pcLook', null);
  if (!l || nowMs - Number(l.at || 0) > LOOK_TTL_MS) return null;
  if (Number(kvGet(db, 'pcScrollAt', 0)) > Number(l.at || 0)) return null; // la pagina si è mossa: i numeri non valgono più
  return l;
};
export const markScrolled = (db, nowMs) => kvSet(db, 'pcScrollAt', nowMs);
export const autoScrolling = (db, nowMs) => {
  const a = kvGet(db, 'pcAutoScroll', null);
  return a && nowMs - Number(a.at || 0) <= AUTO_SCROLL_TTL_MS ? a : null;
};

function ordinalOf(word, count = 0) {
  const w = String(word || '').toLowerCase();
  const num = /(\d{1,2})/.exec(w);
  if (num) return Number(num[1]);
  if (/^ultim/.test(w)) return count ? count : -1;
  if (/^penultim/.test(w)) return count > 1 ? count - 1 : -2;
  return ORD[w] || null;
}

const out = (reply, extra = {}) => ({ reply, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [], ...extra });
const needsUpdate = () => ({
  reply: 'Per vedere lo schermo il programma del PC va aggiornato: fai git pull e riavvia Avvia_Jarvis_PC. Intanto dimmi una parola del titolo e lo cerco.',
  expectReply: true, device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
});

/**
 * Frasi per gli occhi e lo scorrimento sul PC. Ritorna null se la frase non è per loro.
 * ctx.onPc = la conversazione è sul PC (focus, navigazione dal vivo o "sul pc" detto nella frase).
 */
export function handleEyes(db, text, nowMs, { onPc = false, sessionId = 'main' } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const scrolling = autoScrolling(db, nowMs);

  // "fermo" mentre la pagina scorre da sola. Senza scorrimento in corso "fermo" non è per il PC.
  if (scrolling && STOP_RE.test(t)) {
    devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: 'stop' }, nowMs);
    kvSet(db, 'pcAutoScroll', null);
    markScrolled(db, nowMs);
    return out('Fermo.', { expectReply: true });
  }
  const small = SMALL_STEP_RE.exec(t);
  if (small && (scrolling || onPc) && (SMALL_RE.test(t) || (scrolling && /^(?:torna|indietro|su|giù|giu)(?![\p{L}])/iu.test(t.replace(new RegExp(PRE, 'iu'), ''))))) {
    const up = /su|sopra|alto|indietro/i.test(small[1]);
    if (scrolling) devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: 'stop' }, nowMs);
    devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: up ? 'up' : 'down' }, nowMs);
    kvSet(db, 'pcAutoScroll', null);
    markScrolled(db, nowMs);
    return out(up ? 'Un po\' su.' : 'Un po\' giù.', { expectReply: true });
  }
  const screenAsk = LIST_RE.test(t) && /schermo/i.test(t); // "cosa c'è sullo schermo" è per forza il PC
  if (!onPc && !scrolling && !screenAsk) return null;

  const auto = AUTO_SCROLL_RE.exec(t);
  if (auto && !(/^vai$/i.test(auto[1]) && !auto[2])) {
    const up = /su|alto|sopra/i.test(auto[2] || '') || /^sali$/i.test(auto[1]);
    const fast = /veloce/i.test(t);
    if (!pcHasEyes(db, nowMs)) return null; // il programma vecchio sa solo il passo singolo: ci pensano le regole di prima
    devices.enqueueCommand(db, 'desktop', { kind: 'scroll', target: up ? 'up' : 'down', args: fast ? 'auto-fast' : 'auto' }, nowMs);
    kvSet(db, 'pcAutoScroll', { at: nowMs, dir: up ? 'up' : 'down', session: sessionId });
    markScrolled(db, nowMs);
    return out(up ? 'Salgo. Dimmi "fermo" quando vuoi.' : 'Scendo. Dimmi "fermo" quando vuoi.', { expectReply: true });
  }

  const listAsk = LIST_RE.test(t);
  const ord = ORDINAL_RE.exec(t);
  const deictic = DEICTIC_RE.test(t) && (HAS_VERB_RE.test(t) || DEICTIC_BARE_RE.test(t)) && t.split(/\s+/).length <= 12;
  const described = DESCRIBED_RE.exec(t);
  if (!listAsk && !ord && !deictic && !described) return null;
  if (!pcHasEyes(db, nowMs)) return needsUpdate();

  kvSet(db, 'pcLookSession', sessionId);
  if (listAsk) {
    devices.enqueueCommand(db, 'desktop', { kind: 'look', target: '', args: 'list' }, nowMs);
    return out('Guardo lo schermo e ti dico cosa c\'è, con i numeri.', { expectReply: true });
  }

  // "il terzo" subito dopo l'elenco: si sa già dov'è, si clicca senza guardare di nuovo.
  const look = freshLook(db, nowMs);
  if (ord && look?.items?.length) {
    let n = ordinalOf(ord[1], look.items.length);
    if (n < 0) n = look.items.length + 1 + n;
    const item = look.items.find(i => i.n === n);
    if (item) {
      devices.enqueueCommand(db, 'desktop', { kind: 'click', target: `${item.x},${item.y}`, say: '' }, nowMs);
      markScrolled(db, nowMs); // dopo il clic la pagina cambia
      return out(`Apro il ${n}: ${item.label}.`, { expectReply: true });
    }
    return out(`Ne vedo solo ${look.items.length}. Quale vuoi?`, { expectReply: true, actions: [] });
  }
  devices.enqueueCommand(db, 'desktop', { kind: 'look', target: t.slice(0, 200), args: 'pick' }, nowMs);
  markScrolled(db, nowMs);
  return out('Guardo lo schermo e lo apro.', { expectReply: true });
}

const LOOK_PROMPT = `Sei gli occhi di Kestra, l'assistente vocale del Capo. Ricevi una foto dello schermo del suo PC (spesso YouTube, Prime Video, Netflix, Google o un sito).
Coordinate: x e y da 0 a 1000, con 0,0 in alto a sinistra e 1000,1000 in basso a destra della foto.
1) Elenca in "items" le cose che il Capo potrebbe voler aprire: video, film, episodi, risultati di ricerca, link principali. Niente menu, pubblicità o pulsanti di sistema, a meno che la frase li chieda.
   Ordine di lettura: righe dall'alto in basso, dentro la riga da sinistra a destra. Al massimo 12. "label" = titolo breve (max 8 parole), "x","y" = il centro della miniatura o del titolo, dove un clic lo apre.
2) Se c'è una FRASE, scegli in "pick" il numero dell'elemento che indica: "il terzo" = n 3 nell'ordine di lettura, "l'ultimo" = l'ultimo, "quello col gatto" = la miniatura con un gatto, "quel video lì" = quello sotto il puntatore del mouse se c'è, altrimenti l'unico in evidenza.
   Se la frase indica un punto preciso che non è nell'elenco (un pulsante, "riproduci", "salta intro") mettilo in "point" {"x","y","label"}.
   Se non si capisce quale vuole, o non lo vedi, pick null e scrivi in "ask" una domanda brevissima in italiano (es. "Quale, quello rosso o quello col cane?"). Non inventare: se non lo vedi, dillo.
Rispondi SOLO con JSON: {"items":[{"n":1,"label":"...","x":0,"y":0}],"pick":null,"point":null,"ask":""}`;

function parseLook(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let o;
  try { o = JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
  const clamp = (v) => Math.max(0, Math.min(1000, Math.round(Number(v))));
  const okXY = (p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
  const items = (Array.isArray(o.items) ? o.items : [])
    .filter(okXY)
    .slice(0, 12)
    .map((i, k) => ({ n: k + 1, label: String(i.label || i.title || `elemento ${k + 1}`).replace(/\s+/g, ' ').trim().slice(0, 70), x: clamp(i.x), y: clamp(i.y) }));
  const pickN = Number(o.pick);
  const pick = Number.isInteger(pickN) && pickN >= 1 && pickN <= items.length ? pickN : null;
  const point = okXY(o.point) ? { x: clamp(o.point.x), y: clamp(o.point.y), label: String(o.point.label || '').slice(0, 60) } : null;
  return { items, pick, point, ask: String(o.ask || '').trim().slice(0, 160) };
}

const spokenList = (items) => items.slice(0, 6).map(i => `${i.n}, ${i.label}`).join('. ');

/**
 * Il PC manda la foto dello schermo: un modello con la vista trova i video e dove cliccare.
 * Ritorna al PC cosa dire e, se c'è, il punto da cliccare (da 0 a 1000 sulla foto).
 */
export async function look(db, env, deps, b = {}, nowMs = Date.now(), tz = 'Europe/Rome') {
  const image = String(b.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!image) return { ok: false, say: 'Non ho ricevuto la foto dello schermo.' };
  const mode = b.mode === 'pick' ? 'pick' : 'list';
  const phrase = String(b.phrase || '').slice(0, 200);
  const w = Number(b.w) || 0, h = Number(b.h) || 0;
  const cursor = b.cursor && Number.isFinite(Number(b.cursor.x)) && w && h
    ? `Il puntatore del mouse è a x=${Math.round(Number(b.cursor.x) / w * 1000)}, y=${Math.round(Number(b.cursor.y) / h * 1000)}.` : '';
  const title = String(b.title || '').slice(0, 120);
  let parsed = null;
  try {
    const res = await router.chat(db, env, {
      tier: 'fast', needsVision: true, maxTokens: 900, fetchFn: deps.fetchFn, now: deps.now, tz,
      build: () => [
        { role: 'system', content: LOOK_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: `${title ? `Finestra: ${title}. ` : ''}${cursor}\n${mode === 'pick' ? `FRASE: ${phrase}` : 'Nessuna frase: fai solo l\'elenco.'}` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
        ] },
      ],
    });
    parsed = parseLook(res.text);
  } catch {
    return { ok: false, say: 'Adesso non riesco a guardare lo schermo: i modelli con la vista non rispondono.' };
  }
  if (!parsed) return { ok: false, say: 'Ho guardato lo schermo ma non ho capito cosa c\'è. Riprova tra un attimo.' };

  if (parsed.items.length) kvSet(db, 'pcLook', { at: nowMs, items: parsed.items });
  const toUnit = (p) => ({ x: p.x, y: p.y }); // da 0 a 1000, come il comando click
  let say, click = null;
  if (mode === 'list') {
    say = parsed.items.length
      ? `Vedo ${parsed.items.length === 1 ? 'una cosa' : `${parsed.items.length} cose`}: ${spokenList(parsed.items)}${parsed.items.length > 6 ? ', e altre' : ''}. Dimmi il numero.`
      : 'Non vedo video o risultati da aprire su questa pagina.';
  } else if (parsed.pick) {
    const it = parsed.items[parsed.pick - 1];
    click = toUnit(it);
    say = `Apro ${it.label}.`;
    kvSet(db, 'pcScrollAt', nowMs + 1); // dopo il clic la pagina cambia: l'elenco non vale più
  } else if (parsed.point) {
    click = toUnit(parsed.point);
    say = parsed.point.label ? `Clicco su ${parsed.point.label}.` : 'Clicco lì.';
    kvSet(db, 'pcScrollAt', nowMs + 1);
  } else {
    say = parsed.ask || (parsed.items.length ? `Non ho capito quale. Vedo: ${spokenList(parsed.items)}. Dimmi il numero.` : 'Non lo vedo sullo schermo.');
  }
  // Lo dice il PC ad alta voce (il telefono lo saprebbe solo minuti dopo). Resta nella chat della stessa
  // conversazione, così "il terzo" detto dopo ha l'elenco davanti anche per il modello.
  const session = String(kvGet(db, 'pcLookSession', 'main') || 'main');
  db.run('INSERT INTO messages (session, role, text, at) VALUES (?, ?, ?, ?)', session, 'assistant', say, nowIso(nowMs, tz));
  return { ok: true, say, click, items: parsed.items, ask: !click };
}
