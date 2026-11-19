// Memoria persistente a moduli. Ogni modulo è un "cassetto" su un'attività o un argomento
// (es. "lavoro", "auto", "viaggio-giappone"): Jarvis lo crea quando serve e lo riapre
// solo quando la conversazione lo richiede, così il contesto resta piccolo.

import * as semantic from './semantic.js';
import { kvGet, kvSet } from './db.js';

const STOP = new Set('il lo la i gli le un uno una di a da in con su per tra fra e o ma che chi cui non mi ti si ci vi ne è sono ho hai ha del della dei delle al alla ai alle dal dalla nel nella sul sulla come quando dove cosa quale quanto questo questa quello quella mio mia tuo tua suo sua più meno molto poco anche già poi ora oggi fare fatto essere avere jarvis'.split(' '));

export function slug(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function keywords(text) {
  return [...new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)))];
}

export function listModules(db) {
  return db.all(`SELECT m.name, m.description, m.created, (SELECT COUNT(*) FROM memories x WHERE x.module = m.name) AS entries FROM modules m ORDER BY m.name`);
}

export function remember(db, { module, text, description }, nowIso) {
  const name = slug(module) || 'generale';
  const clean = String(text || '').trim().slice(0, 600);
  if (!clean) return null;
  db.run('INSERT INTO modules (name, description, created) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = CASE WHEN excluded.description != \'\' THEN excluded.description ELSE modules.description END',
    name, String(description || '').trim().slice(0, 200), nowIso);
  // Evita doppioni identici nello stesso modulo.
  const dup = db.get('SELECT id FROM memories WHERE module = ? AND lower(text) = lower(?)', name, clean);
  if (dup) return dup.id;
  db.run('INSERT INTO memories (module, text, created) VALUES (?, ?, ?)', name, clean, nowIso);
  return db.get('SELECT last_insert_rowid() AS id').id;
}

export function forget(db, id) {
  db.run('DELETE FROM memories WHERE id = ?', Number(id));
  db.run('DELETE FROM modules WHERE name NOT IN (SELECT DISTINCT module FROM memories) AND name NOT IN (SELECT DISTINCT module FROM topics)');
}

/**
 * Segna gli argomenti di cui si è parlato: l'area diventa un ramo (un modulo), l'argomento una sua foglia.
 * Ritorna { modules: [nome], leaves: [id foglia] } per accenderli sulla sfera.
 */
// ---------------------------------------------------------------- argomenti senza doppioni
// "Joy Tifi", "app Joy-TyFi" e "joy-tyfi" sono lo stesso nodo: si confrontano in forma compatta.
const FILLER = /\b(app|applicazione|l|la|il|lo|i|gli|le|un|una|uno|di|del|della|dei|delle|al|alla|ai|alle|dal|dalla|nel|nella|sul|sulla|su|per|con|in|a|da|pronuncia|nome|programma)\b/g;
const PLEONASM = new Set(['app', 'applicazione', 'programma', 'messaggio', 'messaggi', 'chat', 'notifica', 'notifiche', 'brano', 'brani', 'canzone', 'canzoni', 'musica', 'ultimi', 'ultimo', 'nuovi', 'nuovo', 'tutti', 'tutte', 'lista', 'elenco', 'pronuncia', 'nome']);

export const topicKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(FILLER, ' ').replace(/\s+/g, '');

function stemWord(w) {
  if (/^(legg\w*|lettur\w*)$/.test(w)) return 'lettur';
  if (/^(invi\w*|mand\w*|scriv\w*|scrittur\w*)$/.test(w)) return 'invi';
  if (/^(cerc\w*|ricerc\w*|trov\w*)$/.test(w)) return 'cerc';
  if (/^(riproduc\w*|riproduzion\w*|ascolt\w*)$/.test(w)) return 'riproduz';
  return w.length >= 5 ? w.replace(/[aeiou]$/, '') : w;
}

/** Estrae le radici concettuali di un'etichetta (ignorando parole pleonastiche come "messaggi" in "lettura messaggi whatsapp"). */
export function topicStems(s, { dropPleonasm = true } = {}) {
  const raw = String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(FILLER, ' ').trim().split(/\s+/).filter(w => w.length >= 2 && !STOP.has(w));
  const filtered = dropPleonasm ? raw.filter(w => !PLEONASM.has(w)) : raw;
  const list = filtered.length ? filtered : raw;
  return [...new Set(list.map(stemWord))];
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Vero se due argomenti sono lo stesso concetto scritto in modo diverso (es. "lettura whatsapp" e "lettura messaggi WhatsApp"). */
export function sameTopic(a, b) {
  const x = topicKey(a), y = topicKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = Math.min(x.length, y.length), long = Math.max(x.length, y.length);
  if (short >= 5 && (x.includes(y) || y.includes(x)) && short / long >= 0.6) return true;
  if (short >= 4 && 1 - editDistance(x, y) / long >= 0.72) return true;

  const sa = topicStems(a, { dropPleonasm: true });
  const sb = topicStems(b, { dropPleonasm: true });
  if (sa.length && sa.length === sb.length && sa.every(w => sb.includes(w))) return true;
  if (Math.min(sa.length, sb.length) >= 2) {
    const common = sa.filter(w => sb.includes(w)).length;
    const union = new Set([...sa, ...sb]).size;
    if (common / union >= 0.66) return true;
  }
  return false;
}

/**
 * Se un argomento è il nome storpiato di un'app installata ("Joy Tifi", "pronuncia joytify"),
 * lo riporta al nome vero dell'app, così tutte le varianti finiscono nello stesso nodo.
 */
export function appLabel(db, label) {
  const key = topicKey(label);
  if (key.length < 4) return label;
  // Somiglianza larga solo quando la frase parla di un'app ("app joy-tyfiche", "pronuncia joytify"):
  // altrimenti parole vere come "strada" o "calendario esami" diventerebbero Strava o Calendario.
  const appish = /\b(app|applicazione|pronuncia|nome)\b/i.test(String(label));
  let best = null, score = 0;
  for (const app of kvGet(db, 'apps', [])) {
    const k = topicKey(app);
    if (k.length < 4) continue;
    if (k === key) return app;
    if (!appish) continue;
    let sc = 1 - editDistance(k, key) / Math.max(k.length, key.length);
    // "joytyfiche": la parte iniziale somiglia al nome dell'app e il resto è un suffisso storpiato.
    if (key.length > k.length && key.length <= k.length * 1.6) sc = Math.max(sc, 0.95 * (1 - editDistance(k, key.slice(0, k.length)) / k.length));
    if (sc > score) { best = app; score = sc; }
  }
  return best && score >= 0.55 ? best : label;
}

/** Trova nel modulo un argomento uguale o quasi; ritorna il suo name oppure null. */
function findTopic(db, mod, label) {
  for (const t of db.all('SELECT name, label FROM topics WHERE module = ? ORDER BY uses DESC', mod)) {
    if (sameTopic(t.label, label) || sameTopic(t.name, label)) return t.name;
  }
  return null;
}

const META_NOISE = /\b(gestione\s+nodi|gestione\s+promemori\w*|gestione\s+graf\w*|nodi\s+del|grafo\s+dell|modulo\s+dieta|riepilogo\s+pasti|ridu[cz]ione\s+nodi|sistem\w+\s+nodi|pulizia\s+nodi)\b/i;
const DIET_NOISE = /^(dieta|pasto|pasti|colazione|pranzo|cena|spuntino|spuntini|spuntino\s+pomeridiano|spuntino\s+mattutino|snack|calorie|kcal|alimentazione|cibo|nutrizione|riepilogo|menu)$/i;
const GENERIC_NOISE = /^(generale|ascolto|conversazione|richiesta|risposta|informazioni|dettagli|altro|varie|aiuto|domanda|azione|comando|esecuzione|stato|sistema|utente|jarvis|traduzione|comunicazione|comunicazioni)$/i;

// Mappa logistica delle aree: consolida sinonimi e trasforma sotto-categorie usate come area in parent.
const CANONICAL_AREAS = {
  alimentazione: { area: 'dieta', parent: '' },
  nutrizione: { area: 'dieta', parent: '' },
  cibo: { area: 'dieta', parent: '' },
  pasti: { area: 'dieta', parent: '' },
  allenamento: { area: 'sport', parent: '' },
  palestra: { area: 'sport', parent: 'palestra' },
  fitness: { area: 'sport', parent: '' },
  promemoria: { area: 'agenda', parent: '' },
  calendario: { area: 'agenda', parent: '' },
  scadenze: { area: 'agenda', parent: '' },
  musica: { area: 'intrattenimento', parent: 'musica' },
  canzoni: { area: 'intrattenimento', parent: 'musica' },
  film: { area: 'intrattenimento', parent: 'cinema e serie' },
  serie: { area: 'intrattenimento', parent: 'cinema e serie' },
  giochi: { area: 'intrattenimento', parent: 'videogiochi' },
  videogiochi: { area: 'intrattenimento', parent: 'videogiochi' },
  svago: { area: 'intrattenimento', parent: '' },
  hobby: { area: 'intrattenimento', parent: '' },
  pc: { area: 'tecnologia', parent: 'PC Desktop' },
  computer: { area: 'tecnologia', parent: 'PC Desktop' },
  viaggio: { area: 'viaggi', parent: '' },
  comunicazione: { area: 'comunicazioni', parent: '' },
};

/** Ripulisce un titolo di nodo da verbi discorsivi o frasi prolisse, lasciando il concetto chiave (2-4 parole). */
export function cleanNodeTitle(raw) {
  let s = String(raw || '').trim()
    .replace(/\s*\(app:[^)]+\)\s*$/i, '')
    .replace(/^(?:ehi\s+|ciao\s+|ok\s+)?jarvis\s+/i, '')
    .replace(/^(?:ricordati\s+che|ricorda\s+che|segna\s+che|memorizza\s+che|l'utente\s+ha\s+detto\s+che|l'utente\s+)/i, '')
    .replace(/\b(?:per\s+favore|subito|adesso|ora|grazie)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 52);
}

/** Rimuove il nome del nodo genitore dall'etichetta del figlio (es. "ristoranti tipici Klagenfurt" sotto "Klagenfurt" -> "ristoranti tipici"). */
function stripParentWord(childLabel, parentLabel) {
  const p = String(parentLabel || '').trim();
  const c = String(childLabel || '').trim();
  if (!p || !c || p.length < 3) return c;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = c
    .replace(new RegExp(`\\b(?:su|in|di|a|per|con|da|del|della)?\\s*${esc}\\b`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.:;\-\s]+|[,.:;\-\s]+$/g, '')
    .trim();
  return cleaned.length >= 3 ? cleaned : c;
}

/** Estrae contenitore (app/dispositivo), titolo conciso e chiave di deduplicazione per un nodo del ramo Automazioni. */
export function formatAutoNode(rawLabel, appHint = '') {
  const raw = cleanNodeTitle(rawLabel);
  let container = String(appHint || '').trim();
  if (!container) {
    if (/^pc\s*:/i.test(raw) || /\bsul\s+(?:pc|computer|desktop)\b/i.test(raw)) container = 'PC Desktop';
    else if (/\b(joytify|joy\s*t\w*|joy\s*f\w*|joy\s+division)\b/i.test(raw)) container = 'Joytify';
    else if (/\bspotify\b/i.test(raw)) container = 'Spotify';
    else if (/\bwhatsapp\b/i.test(raw) || /\bultimi\s+messagg/i.test(raw)) container = 'WhatsApp';
    else if (/\btelegram\b/i.test(raw)) container = 'Telegram';
    else if (/\byoutube\b/i.test(raw)) container = 'YouTube';
    else if (/\binstagram\b/i.test(raw)) container = 'Instagram';
    else if (/\bmaps\b/i.test(raw)) container = 'Maps';
  }
  let title = raw
    .replace(/^pc\s*:\s*/i, '')
    .replace(/^(?:apri|avvia)\s+(?:l'app\s+|la\s+app\s+|il\s+programma\s+)?(?:joytify|spotify|whatsapp|telegram|youtube|instagram|maps)\s*(?:,\s*|\s+e\s+|\s+)/i, '')
    .replace(/^(?:vai\s+su(?:lla\s+barra\s+di)?\s+ricerca\s+e\s+|tocca\s+cerca\s+e\s+|seleziona\s+una\s+|seleziona\s+)/i, '')
    .replace(/\s*(?:,\s*|\s+e\s+)(?:avvia\s+la\s+riproduzione|seleziona\s+il\s+primo\s+risultato|riproduci\w*|invia\w*|fai\s+partire).*$/i, '')
    .replace(/\b(?:su|in|con|dentro)\s+(?:joytify|spotify|whatsapp|telegram|youtube|instagram|maps)\b/gi, '')
    .replace(/\bsul\s+(?:pc|computer|desktop)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.:;\-\s]+|[,.:;\-\s]+$/g, '')
    .trim();
  if (/^legg\w*\s+(?:gli\s+)?(?:ultimi\s+)?messagg\w*/i.test(title)) title = 'Lettura messaggi';
  if (!title || sameTopic(title, container)) title = container ? `Apri ${container}` : raw;
  const pretty = title.charAt(0).toUpperCase() + title.slice(1);
  const dedupKey = `${slug(container || 'auto')}:${topicStems(pretty, { dropPleonasm: true }).join('-') || slug(pretty)}`;
  return { container, title: pretty.slice(0, 44), dedupKey };
}

/** Vero se l'etichetta è un termine generico, meta-comando o coincide col nome stesso del ramo. */
export function isNoiseTopic(mod, label) {
  const s = String(label || '').trim();
  if (!s) return true;
  if (META_NOISE.test(s) || GENERIC_NOISE.test(s)) return true;
  if (mod === 'dieta' && DIET_NOISE.test(s)) return true;
  // Solo se l'etichetta È il nome del ramo ("comunicazione" dentro "comunicazioni"), non se lo contiene:
  // "Programmazione a oggetti" sotto "programmazione" è un argomento vero.
  if (mod) {
    const k = topicKey(s), m = topicKey(mod);
    if (k === m) return true;
    if (Math.min(k.length, m.length) >= 4 && 1 - editDistance(k, m) / Math.max(k.length, m.length) >= 0.8) return true;
  }
  return false;
}

function upsertTopic(db, mod, label, nowIso) {
  label = appLabel(db, label);
  if (isNoiseTopic(mod, label)) return null;
  const existing = findTopic(db, mod, label);
  if (existing) { db.run('UPDATE topics SET uses = uses + 1, last_used = ? WHERE module = ? AND name = ?', nowIso, mod, existing); return existing; }
  const name = slug(label);
  if (!name || name === mod) return null;
  db.run('INSERT INTO topics (module, name, label, last_used) VALUES (?, ?, ?, ?) ON CONFLICT(module, name) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used',
    mod, name, String(label).trim().slice(0, 60), nowIso);
  return name;
}

export function touchTopics(db, topics, nowIso) {
  const out = { modules: [], leaves: [] };
  for (const t of topics || []) {
    const rawMod = slug(t.area);
    if (!rawMod) continue;
    const mapped = CANONICAL_AREAS[rawMod];
    const mod = mapped ? mapped.area : rawMod;
    const effectiveParent = t.parent || (mapped && mapped.parent && !sameTopic(mapped.parent, t.topic) ? mapped.parent : '');
    db.run('INSERT INTO modules (name, description, created) VALUES (?, \'\', ?) ON CONFLICT(name) DO NOTHING', mod, nowIso);
    out.modules.push(mod);
    const cleanTopic = cleanNodeTitle(t.topic);
    if (!slug(cleanTopic) || slug(cleanTopic) === mod) continue;
    const name = upsertTopic(db, mod, cleanTopic, nowIso);
    if (!name) continue;
    // Sotto-argomento: si appende al suo argomento più generale (creato se manca).
    const parent = effectiveParent && !sameTopic(effectiveParent, cleanTopic) && slug(effectiveParent) !== mod ? upsertTopic(db, mod, cleanNodeTitle(effectiveParent), nowIso) : null;
    if (parent && parent !== name) {
      db.run('UPDATE topics SET parent = ? WHERE module = ? AND name = ?', parent, mod, name);
      out.leaves.push(`t:${mod}/${parent}`);
    }
    out.leaves.push(`t:${mod}/${name}`);
  }
  return out;
}

/** Riunisce i doppioni già salvati e rimuove i nodi ridondanti/meta: tiene il nodo più usato, somma gli usi, sposta i figli. */
export function tidyTopics(db) {
  let merged = 0;
  // Rimuove eventuali meta-ricordi ridondanti salvati per errore nel modulo dieta.
  db.run("DELETE FROM memories WHERE module = 'dieta' AND (lower(text) LIKE 'il modulo dieta%' OR lower(text) LIKE 'gestione nodi%')");
  for (const { module: mod } of db.all('SELECT DISTINCT module FROM topics')) {
    const list = db.all('SELECT name, label, uses FROM topics WHERE module = ? ORDER BY uses DESC, last_used DESC', mod);
    const kept = [];
    for (const t of list) {
      if (isNoiseTopic(mod, t.label)) {
        db.run("UPDATE topics SET parent = '' WHERE module = ? AND parent = ?", mod, t.name);
        db.run('DELETE FROM topics WHERE module = ? AND name = ?', mod, t.name);
        merged++;
        continue;
      }
      // Prima riporta i nomi storpiati di app al nome vero, poi cerca un nodo uguale.
      const fixed = appLabel(db, t.label);
      if (fixed !== t.label) { db.run('UPDATE topics SET label = ? WHERE module = ? AND name = ?', fixed, mod, t.name); t.label = fixed; }
      const into = kept.find(k => sameTopic(k.label, t.label) || sameTopic(k.name, t.label));
      if (!into) { kept.push(t); continue; }
      // Se il doppione porta il nome vero di un'app, il nodo che resta prende quel nome.
      if (fixed !== into.label && kvGet(db, 'apps', []).includes(fixed)) { db.run('UPDATE topics SET label = ? WHERE module = ? AND name = ?', fixed, mod, into.name); into.label = fixed; }
      db.run('UPDATE topics SET uses = uses + ? WHERE module = ? AND name = ?', t.uses, mod, into.name);
      db.run('UPDATE topics SET parent = ? WHERE module = ? AND parent = ?', into.name, mod, t.name);
      db.run('DELETE FROM topics WHERE module = ? AND name = ?', mod, t.name);
      merged++;
    }
    // Annidamento logico automatico: se un argomento specifico contiene il nome di un argomento contenitore
    // nello stesso modulo (es. "ristoranti tipici Klagenfurt" sotto "Klagenfurt", o "lettura WhatsApp" sotto "WhatsApp"),
    // lo annida sotto di esso e rimuove dall'etichetta del figlio la ripetizione del nome del genitore.
    const current = db.all('SELECT name, label, parent FROM topics WHERE module = ? ORDER BY length(label) ASC', mod);
    for (const child of current) {
      const cKey = topicKey(child.label);
      const host = child.parent
        ? current.find(p => p.name === child.parent)
        : current.find(p => p.name !== child.name && !p.parent && topicKey(p.label).length >= 4 && cKey.length > topicKey(p.label).length + 2 && cKey.includes(topicKey(p.label)));
      if (host && host.name !== child.name) {
        const shorter = stripParentWord(child.label, host.label);
        if (sameTopic(shorter, host.label)) {
          // Rimossa la parola del genitore non resta altro di significativo: era un doppione, lo fonde nel genitore.
          db.run('UPDATE topics SET parent = ? WHERE module = ? AND parent = ?', host.name, mod, child.name);
          db.run('DELETE FROM topics WHERE module = ? AND name = ?', mod, child.name);
          merged++;
        } else {
          db.run('UPDATE topics SET parent = ?, label = ? WHERE module = ? AND name = ?', host.name, shorter, mod, child.name);
          child.parent = host.name;
          child.label = shorter;
        }
      }
    }
    db.run("UPDATE topics SET parent = '' WHERE module = ? AND parent = name", mod);
  }
  // Pulisce e fonde anche i doppioni già presenti in autoGoals (es. "Apri Joytify, cerca Mannarino e avvia..." vs "Apri Joytify, cerca Mannarino").
  const rawGoals = kvGet(db, 'autoGoals', []);
  if (rawGoals.length > 1) {
    const seenKeys = new Set();
    const cleanGoals = [];
    for (const g of rawGoals) {
      const { dedupKey } = formatAutoNode(g.label || g.id, g.app);
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);
      cleanGoals.push(g);
    }
    if (cleanGoals.length !== rawGoals.length) kvSet(db, 'autoGoals', cleanGoals);
  }
  db.run('DELETE FROM modules WHERE name NOT IN (SELECT DISTINCT module FROM memories) AND name NOT IN (SELECT DISTINCT module FROM topics)');
  return merged;
}

/** Gli argomenti esistenti, per farli riusare al modello invece di crearne di simili. */
export function topicsIndex(db, modules) {
  const out = [];
  for (const m of modules) {
    const t = db.all('SELECT label FROM topics WHERE module = ? ORDER BY uses DESC LIMIT 12', m).map(r => r.label);
    if (t.length) out.push(`${m}: ${t.join(', ')}`);
  }
  return out.length ? 'ARGOMENTI GIÀ NELLA MAPPA: ' + out.join(' · ') : '';
}

/**
 * Sceglie i ricordi utili per questo messaggio.
 * - "generale" (fatti stabili sull'utente) entra sempre, entro un limite.
 * - Gli altri moduli entrano se il testo ne richiama nome, descrizione o contenuti,
 *   oppure se erano attivi nei turni precedenti (sticky).
 */
// Radice grossolana per l'italiano: "allenamento", "allenamenti" e "allenarsi" si toccano.
const rootOf = (w) => (w.length > 5 ? w.slice(0, 5) : w);

/**
 * Ricordi pertinenti a una frase. Conta le parole in comune per radice (non solo uguali), premia il modulo
 * di cui si sta parlando, un po' i ricordi usati spesso e quelli recenti; i fatti "generale" restano come base.
 * Le memorie dei progetti (modulo "p:<id>") non escono qui: entrano solo dentro il loro progetto.
 */
export function recall(db, text, { sticky = [], limit = 24, qvec = null } = {}) {
  const kw = keywords(text);
  const roots = new Set(kw.map(rootOf));
  const rows = db.all("SELECT id, module, text, uses, last_used, vec FROM memories WHERE module NOT LIKE 'p:%' ORDER BY id DESC LIMIT 2000");
  const mods = db.all('SELECT name, description FROM modules');
  const modScore = new Map();
  for (const m of mods) {
    const hay = new Set(keywords(m.name.replace(/-/g, ' ') + ' ' + m.description).map(rootOf));
    modScore.set(m.name, [...roots].filter(k => hay.has(k)).length * 3 + (sticky.includes(m.name) ? 2 : 0));
  }
  const newest = rows.length ? rows[0].id : 0;
  // Significato: la somiglianza si misura rispetto a tutti i ricordi (quanto spicca), non con una soglia fissa,
  // perché ogni modello di embedding ha una sua scala.
  const sims = new Map();
  if (qvec) for (const r of rows) { const v = semantic.decode(r.vec); if (v) sims.set(r.id, semantic.cosine(qvec, v)); }
  const semOf = semantic.relativeScorer([...sims.values()]);
  const scored = rows.map(row => {
    const hay = new Set(keywords(row.text));
    const hayRoots = new Set([...hay].map(rootOf));
    let overlap = 0;
    for (const k of kw) overlap += hay.has(k) ? 2 : hayRoots.has(rootOf(k)) ? 1.5 : 0;
    const base = row.module === 'generale' ? 1 : 0;
    // Significato: pesa quanto le parole, così entra anche ciò che è collegato senza parole in comune.
    const sem = sims.has(row.id) ? semOf(sims.get(row.id)) : 0;
    const relevant = overlap + (modScore.get(row.module) || 0) + base + sem;
    // Uso e recenza contano solo se il ricordo è già pertinente: non riempiono il contesto da soli.
    const bonus = relevant > 0 ? Math.min(1, Math.log2(1 + (row.uses || 0)) / 4) + (newest - row.id < 30 ? 0.3 : 0) : 0;
    const { vec, ...plain } = row;
    return { ...plain, score: relevant + bonus };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.id - a.id).slice(0, limit);
  const active = [...new Set(scored.filter(x => x.module !== 'generale').map(x => x.module))];
  return { entries: scored, active };
}

/** I ricordi di un cassetto (o cercati per parole/significato), quando il modello li chiede con l'azione recall. */
export function recallFor(db, { module = '', query = '' } = {}, limit = 15) {
  const mod = String(module || '').toLowerCase().trim();
  if (mod && !mod.startsWith('p:')) {
    const rows = db.all('SELECT id, module, text FROM memories WHERE module = ? ORDER BY id DESC LIMIT ?', mod, limit);
    if (rows.length) return rows;
  }
  const q = String(query || module || '').trim();
  return q ? recall(db, q, { limit }).entries : [];
}

/**
 * Consolidamento automatico: nello stesso modulo, due ricordi che dicono quasi la stessa cosa diventano uno
 * (resta il più recente, che di solito è il più aggiornato, con la somma degli usi). Non cancella mai ricordi
 * diversi tra loro. Ritorna quanti ne ha uniti.
 */
export function consolidate(db) {
  let merged = 0;
  const mods = db.all('SELECT DISTINCT module FROM memories').map(r => r.module);
  for (const mod of mods) {
    const rows = db.all('SELECT id, text, uses FROM memories WHERE module = ? ORDER BY id DESC LIMIT 400', mod)
      .map(r => ({ ...r, set: new Set(keywords(r.text).map(rootOf)) }));
    const gone = new Set();
    for (let a = 0; a < rows.length; a++) {
      if (gone.has(rows[a].id) || rows[a].set.size < 2) continue;
      for (let b = a + 1; b < rows.length; b++) {
        if (gone.has(rows[b].id)) continue;
        const A = rows[a].set, B = rows[b].set;
        let inter = 0;
        for (const k of A) if (B.has(k)) inter++;
        const jacc = inter / (A.size + B.size - inter);
        if (jacc >= 0.8) {
          db.run('UPDATE memories SET uses = uses + ? WHERE id = ?', rows[b].uses || 0, rows[a].id);
          db.run('DELETE FROM memories WHERE id = ?', rows[b].id);
          gone.add(rows[b].id);
          merged++;
        }
      }
    }
  }
  return merged;
}

export function markUsed(db, ids, nowIso) {
  for (const id of ids) db.run('UPDATE memories SET uses = uses + 1, last_used = ? WHERE id = ?', nowIso, id);
}

/**
 * La "mappa" di Jarvis per la sfera: ogni modulo è un ramo, i suoi ricordi più usati sono le foglie.
 * Più dati fissi: dieta e agenda (sempre presenti), compiti in corso.
 */
export function graph(db, { perModule = 24 } = {}) {
  const branches = [
    { id: 'dieta', label: 'Dieta', kind: 'core', children: [] },
    { id: 'sport', label: 'Sport', kind: 'core', children: [] },
    { id: 'agenda', label: 'Agenda', kind: 'core', children: db.all('SELECT id, text FROM reminders WHERE done = 0 ORDER BY due LIMIT 24').map(r => ({ id: 'r:' + r.id, label: r.text })) },
  ];
  const jobs = db.all("SELECT id, title, status FROM jobs ORDER BY created DESC LIMIT 24");
  if (jobs.length) branches.push({ id: 'compiti', label: 'Compiti', kind: 'core', children: jobs.map(j => ({ id: 'j:' + j.id, label: j.title, status: j.status })) });
  // Progetti come i progetti di Claude: un ramo con un nodo per progetto.
  let projRows = [];
  try { projRows = db.all('SELECT id, name FROM projects ORDER BY updated DESC LIMIT 24'); } catch { /* tabella non pronta */ }
  if (projRows.length) branches.push({ id: 'progetti', label: 'Progetti', kind: 'core', children: projRows.map(p => ({ id: 'p:' + p.id, label: p.name })) });
  const flows = kvGet(db, 'phoneFlows', []);
  const autoGoals = kvGet(db, 'autoGoals', []);
  const seenAuto = new Set();
  const combinedAuto = [];
  const containers = new Map();
  const addAutoItem = (id, rawLabel, appHint) => {
    const { container, title, dedupKey } = formatAutoNode(rawLabel, appHint);
    if (seenAuto.has(id) || seenAuto.has(dedupKey)) return;
    seenAuto.add(id);
    seenAuto.add(dedupKey);
    let parentId = '';
    if (container && !sameTopic(container, title)) {
      const cSlug = slug(container);
      parentId = 'fa:' + cSlug;
      if (!containers.has(parentId)) containers.set(parentId, { id: parentId, label: container, kind: 'flow', auto: true });
    }
    combinedAuto.push({ id: 'f:' + id, label: title, ...(parentId ? { parent: parentId } : {}), kind: 'flow', auto: true });
  };
  for (const f of flows) addAutoItem(f.id, f.sampleGoal || f.app || f.id, f.app);
  for (const g of autoGoals) addAutoItem(g.id, g.label || g.app || g.id, g.app);
  const autoChildren = combinedAuto.length
    ? [...combinedAuto.slice(0, perModule), ...containers.values()]
    : [{ id: 'f:joytify-ricerca-musica', label: 'Apri e cerca musica', parent: 'fa:joytify', kind: 'flow', auto: true }, { id: 'fa:joytify', label: 'Joytify', kind: 'flow', auto: true }];
  branches.push({
    id: 'automazioni', label: 'Automazioni', kind: 'flow', auto: true, entries: combinedAuto.length || 1,
    children: autoChildren,
  });
  for (const m of listModules(db)) {
    const topics = db.all('SELECT name, label, parent FROM topics WHERE module = ? ORDER BY uses DESC, last_used DESC LIMIT ?', m.name, perModule)
      .map(t => ({ id: `t:${m.name}/${t.name}`, label: t.label, kind: 'topic', ...(t.parent ? { parent: `t:${m.name}/${t.parent}` } : {}) }));
    // Se il modulo ha già i suoi nodi concettuali (topics), non mostra come nodi separati le frasi intere dei ricordi
    // che parlano già degli stessi concetti (es. "A Klagenfurt sono consigliati..." quando c'è già "Klagenfurt" / "ristoranti tipici").
    const memCap = Math.max(2, Math.min(6, perModule - topics.length));
    const rows = db.all('SELECT id, text FROM memories WHERE module = ? ORDER BY uses DESC, id DESC LIMIT ?', m.name, memCap)
      .filter(r => {
        if (!topics.length) return true;
        if (topics.some(t => sameTopic(t.label, r.text))) return false;
        const rKw = new Set(keywords(r.text));
        const covered = topics.some(t => keywords(t.label).some(k => rKw.has(k)));
        return !covered;
      })
      .map(r => ({ id: 'm:' + r.id, label: cleanNodeTitle(r.text) }));
    const children = [...topics, ...rows].slice(0, perModule + 4);
    // Un'area con lo stesso nome di un ramo fisso (es. "dieta") si aggiunge a quel ramo.
    const fixed = branches.find(b => b.id === m.name && b.kind === 'core');
    if (fixed) { fixed.children.push(...children); continue; }
    branches.push({ id: m.name, label: m.name.replace(/-/g, ' '), description: m.description, kind: 'module', entries: m.entries, children });
  }
  return { branches };
}

// ---------------------------------------------------------------- livelli della sfera
// Ogni ramo sta su un guscio: dentro le informazioni leggere, personali e usate spesso (quelle che
// "fanno" Jarvis per questo utente), fuori quelle pesanti, accessorie e usate di rado.

const IDENTITY = /(person|profil|prefer|identit|caratter|famigli|valori|abitudin|obiettiv|salute|relazion|amic|carriera|sogn|emozion|umore|chi sono|io\b)/i;
const HALF_LIFE_DAYS = 10;

/** Quanto è "personale" un ramo: 1 definisce chi è l'utente, 0 è puro contorno. */
export function personalOf(branch) {
  if (branch.id === 'automazioni' || branch.kind === 'flow') return 0.85;
  if (branch.id === 'dieta' || branch.id === 'sport') return 0.7;
  if (branch.id === 'agenda') return 0.55;
  if (branch.id === 'compiti') return 0.2;
  return IDENTITY.test(`${branch.id} ${branch.label || ''} ${branch.description || ''}`) ? 1 : 0.3;
}

/** Ogni volta che si parla di un ramo il suo uso sale; col tempo scende (mezza vita 10 giorni). */
export function noteUse(db, ids, ms) {
  const all = kvGet(db, 'branchUse', {});
  for (const id of new Set(ids || [])) {
    const u = all[id] || { score: 0, at: ms };
    all[id] = { score: decayed(u, ms) + 1, at: ms };
  }
  kvSet(db, 'branchUse', all);
}
const decayed = (u, ms) => u.score * Math.pow(0.5, Math.max(0, ms - u.at) / (HALF_LIFE_DAYS * 86_400_000));

/** Livello da 0 (centro) in su, bilanciando mole di informazioni, frequenza d'uso e quanto è personale.
 * Non c'è un tetto: un ramo che continua a crescere scende su gusci sempre più esterni e la sfera si allarga. */
export function levelOf({ size, use, personal }) {
  const heavy = Math.log10(1 + Math.max(0, size)) / 2.3;                // ~200 elementi = 1, ~40.000 = 2
  const freq = 1 - Math.exp(-Math.max(0, use) / 4);                      // ~10 usi recenti = frequentissimo
  return Math.round(Math.max(0, 0.4 * heavy + 0.3 * (1 - freq) + 0.3 * (1 - personal)) * 100) / 100;
}

/** Guscio di un livello: 0 interno, 1 medio, 2 esterno, poi 3, 4... man mano che Jarvis cresce. */
export const ringOf = (level) => (level < 0.4 ? 0 : level < 0.62 ? 1 : 2 + Math.floor((level - 0.62) / 0.3));

/** Aggiunge a ogni ramo level (da 0 in su) e ring. sizes: {id: numero di elementi}. */
export function addLevels(db, branches, sizes, ms) {
  const use = kvGet(db, 'branchUse', {});
  for (const b of branches) {
    const size = sizes[b.id] ?? (b.entries || 0) + (b.children || []).length;
    b.level = levelOf({ size, use: use[b.id] ? decayed(use[b.id], ms) : 0, personal: personalOf(b) });
    b.ring = ringOf(b.level);
  }
  return branches;
}
