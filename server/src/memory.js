// Memoria persistente a moduli. Ogni modulo è un "cassetto" su un'attività o un argomento
// (es. "lavoro", "auto", "viaggio-giappone"): Jarvis lo crea quando serve e lo riapre
// solo quando la conversazione lo richiede, così il contesto resta piccolo.

const STOP = new Set('il lo la i gli le un uno una di a da in con su per tra fra e o ma che chi cui non mi ti si ci vi ne è sono ho hai ha del della dei delle al alla ai alle dal dalla nel nella sul sulla come quando dove cosa quale quanto questo questa quello quella mio mia tuo tua suo sua più meno molto poco anche già poi ora oggi fare fatto essere avere jarvis'.split(' '));

export function slug(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function keywords(text) {
  return [...new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)))];
}

export function listModules(db) {
  return db.all(`SELECT m.name, m.description, m.created, COUNT(x.id) AS entries FROM modules m LEFT JOIN memories x ON x.module = m.name GROUP BY m.name ORDER BY m.name`);
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
  db.run('DELETE FROM modules WHERE name NOT IN (SELECT DISTINCT module FROM memories)');
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
