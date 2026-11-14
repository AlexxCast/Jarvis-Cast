// La rete di Jarvis appiattita in 2D per la finestra sopra le altre app: gli stessi rami, foglie e
// sotto-foglie della sfera, con il nodo Jarvis al centro e piste a 45° come su un circuito stampato.
// Solo calcoli, niente DOM: così si può provare anche fuori dal browser.

const MAX_LEAVES = 10;
const MAX_SUB = 4;

/** Pista da a verso b: prima in diagonale a 45°, poi dritta. Ritorna i punti [a, gomito, b]. */
export function pcbTrace(from, to) {
  const a = { x: from.x, y: from.y }, b = { x: to.x, y: to.y };
  const dx = b.x - a.x, dy = b.y - a.y;
  const k = Math.min(Math.abs(dx), Math.abs(dy));
  const bend = { x: a.x + Math.sign(dx) * k, y: a.y + Math.sign(dy) * k };
  const same = (p, q) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
  return same(bend, a) || same(bend, b) ? [a, b] : [a, bend, b];
}

export function traceLength(path) {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return n;
}

/** Punto a frazione f (0..1) lungo la pista. */
export function pointAt(path, f) {
  const total = traceLength(path) || 1;
  let left = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= d || i === path.length - 1) { const t = d ? Math.min(1, left / d) : 0; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
    left -= d;
  }
  return path[path.length - 1];
}

/**
 * Dispone i rami attorno al centro (0,0) in un cerchio di raggio 1: i rami del livello più interno
 * (personali, usati spesso) più vicini a Jarvis, gli altri sugli anelli esterni. Le foglie si aprono
 * a ventaglio verso l'esterno del loro ramo, le sotto-foglie attorno alla foglia che le ospita.
 */
export function layout2d(branches = []) {
  const list = branches.filter(b => b && b.id);
  const rings = Math.max(1, ...list.map(b => (Number.isFinite(b.ring) ? b.ring : 1) + 1));
  // Ogni ramo ha la sua direzione (così non si sovrappongono), la distanza dal centro dipende dal livello.
  const radiusOf = (ring) => (rings === 1 ? 0.5 : 0.36 + (0.3 * ring) / (rings - 1));
  const out = [];
  const step = (Math.PI * 2) / Math.max(1, list.length);
  list.forEach((b, i) => {
    const ring = Number.isFinite(b.ring) ? b.ring : 1;
    const rad = radiusOf(ring);
    const ang = -Math.PI / 2 + 0.38 + i * step; // sfalsato: le piste a 45° piegano come su un circuito
    const hub = { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad };
    const kids = (b.children || []).filter(c => c && c.id);
    const tops = kids.filter(c => !c.parent || !kids.some(k => k.id === c.parent)).slice(0, MAX_LEAVES);
    const spread = Math.min(step * 0.9 + 0.5, 0.34 * Math.max(1, tops.length - 1));
    const leafR = 0.17 + Math.min(0.07, tops.length * 0.008);
    const leaves = [];
    tops.forEach((c, j) => {
      const a = ang + (tops.length === 1 ? 0 : -spread / 2 + (j / (tops.length - 1)) * spread);
      const pos = { x: hub.x + Math.cos(a) * leafR, y: hub.y + Math.sin(a) * leafR };
      leaves.push({ id: c.id, label: String(c.label || ''), ...pos, path: pcbTrace(hub, pos), sub: false });
      kids.filter(k => k.parent === c.id).slice(0, MAX_SUB).forEach((sub, m, subs) => {
        const sa = a + (subs.length === 1 ? 0 : (-0.7 + (m / (subs.length - 1)) * 1.4));
        const sp = { x: pos.x + Math.cos(sa) * 0.08, y: pos.y + Math.sin(sa) * 0.08 };
        leaves.push({ id: sub.id, label: String(sub.label || ''), ...sp, path: pcbTrace(pos, sp), sub: true, host: c.id });
      });
    });
    out.push({ id: b.id, label: String(b.label || b.id), ring, hub, spoke: pcbTrace({ x: 0, y: 0 }, hub), leaves });
  });
  // Riporta tutto dentro il cerchio di raggio 1 (le foglie degli anelli esterni possono uscire).
  let far = 0;
  for (const b of out) { far = Math.max(far, Math.hypot(b.hub.x, b.hub.y)); for (const l of b.leaves) far = Math.max(far, Math.hypot(l.x, l.y)); }
  const k = far > 0.96 ? 0.96 / far : 1;
  if (k !== 1) {
    const sc = (p) => { p.x *= k; p.y *= k; };
    for (const b of out) {
      sc(b.hub);
      for (const l of b.leaves) sc(l);
      for (const l of b.leaves) l.path = pcbTrace(l.sub ? b.leaves.find(x => x.id === l.host) : b.hub, l);
      b.spoke = pcbTrace({ x: 0, y: 0 }, b.hub);
    }
  }
  return out;
}
