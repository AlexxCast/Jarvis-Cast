// Memoria persistente a moduli. Ogni modulo è un "cassetto" su un'attività o un argomento
// (es. "lavoro", "auto", "viaggio-giappone"): Jarvis lo crea quando serve e lo riapre
// solo quando la conversazione lo richiede, così il contesto resta piccolo.

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
export function touchTopics(db, topics, nowIso) {
  const out = { modules: [], leaves: [] };
  for (const t of topics || []) {
    const mod = slug(t.area);
    if (!mod) continue;
    db.run('INSERT INTO modules (name, description, created) VALUES (?, \'\', ?) ON CONFLICT(name) DO NOTHING', mod, nowIso);
    out.modules.push(mod);
    const name = slug(t.topic);
    if (!name || name === mod) continue;
    db.run('INSERT INTO topics (module, name, label, last_used) VALUES (?, ?, ?, ?) ON CONFLICT(module, name) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used',
      mod, name, String(t.topic).trim().slice(0, 60), nowIso);
    out.leaves.push(`t:${mod}/${name}`);
  }
  return out;
}

/**
 * Sceglie i ricordi utili per questo messaggio.
 * - "generale" (fatti stabili sull'utente) entra sempre, entro un limite.
 * - Gli altri moduli entrano se il testo ne richiama nome, descrizione o contenuti,
 *   oppure se erano attivi nei turni precedenti (sticky).
 */
export function recall(db, text, { sticky = [], limit = 24 } = {}) {
  const kw = keywords(text);
  const rows = db.all('SELECT id, module, text, uses FROM memories ORDER BY id DESC LIMIT 2000');
  const mods = db.all('SELECT name, description FROM modules');
  const modScore = new Map();
  for (const m of mods) {
    const hay = new Set(keywords(m.name.replace(/-/g, ' ') + ' ' + m.description));
    modScore.set(m.name, kw.filter(k => hay.has(k)).length * 3 + (sticky.includes(m.name) ? 2 : 0));
  }
  const scored = rows.map(row => {
    const hay = new Set(keywords(row.text));
    const overlap = kw.filter(k => hay.has(k)).length;
    const base = row.module === 'generale' ? 1 : 0;
    return { ...row, score: overlap * 2 + (modScore.get(row.module) || 0) + base };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.id - a.id).slice(0, limit);
  const active = [...new Set(scored.filter(x => x.module !== 'generale').map(x => x.module))];
  return { entries: scored, active };
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
  for (const m of listModules(db)) {
    const topics = db.all('SELECT name, label FROM topics WHERE module = ? ORDER BY uses DESC, last_used DESC LIMIT ?', m.name, perModule)
      .map(t => ({ id: `t:${m.name}/${t.name}`, label: t.label, kind: 'topic' }));
    const rows = db.all('SELECT id, text FROM memories WHERE module = ? ORDER BY uses DESC, id DESC LIMIT ?', m.name, Math.max(2, perModule - topics.length))
      .map(r => ({ id: 'm:' + r.id, label: r.text }));
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
