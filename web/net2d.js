// La rete di Jarvis appiattita in 2D per la finestra sopra le altre app: anello centrale Jarvis,
// raggi dritti verso i nodi dei rami e bracci curvi orbitali (archi concentrici) per i sotto-nodi.
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

/** Pista ad arco orbitale attorno al centro (0,0) da `from` a `to`, come nel disegno 2D. */
export function arcTrace(from, to, steps = 8) {
  const r0 = Math.hypot(from.x, from.y), r1 = Math.hypot(to.x, to.y);
  const a0 = Math.atan2(from.y, from.x);
  let da = Math.atan2(to.y, to.x) - a0;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  const pts = [{ x: from.x, y: from.y }];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const r = r0 + (r1 - r0) * t;
    const a = a0 + da * t;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  pts.push({ x: to.x, y: to.y });
  return pts;
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
 * Dispone i rami attorno al centro (0,0) in un cerchio di raggio 1:
 * - dal nucleo centrale partono raggi dritti (`spoke`) verso il nodo di ogni ramo (`hub`);
 * - da ogni `hub` partono lunghi archi orbitali concentrici (1-2 per ramo in modalità `sketch`) che terminano
 *   in singoli nodi ben distanziati, più brevi tratti a circuito (`pcbTrace`), fedele al disegno 2D;
 * - senza opzioni mantiene tutti i limiti standard (`MAX_LEAVES = 10`) per i test automatici.
 */
const STAGGER = [0.06, -0.07, 0.1, -0.05, 0.08, -0.08];

export function layout2d(branches = [], opts = {}) {
  const sketch = !!opts.sketch;
  const raw = branches.filter(b => b && b.id);
  const list = sketch ? raw.slice(0, 6) : raw;
  const rings = Math.max(1, ...list.map(b => (Number.isFinite(b.ring) ? b.ring : 1) + 1));
  const radiusOf = (ring, i) => {
    const base = rings === 1 ? 0.48 : 0.34 + (0.30 * ring) / (rings - 1);
    return sketch ? Math.max(0.32, Math.min(0.66, base + (STAGGER[i % STAGGER.length] || 0))) : base;
  };
  const out = [];
  const step = (Math.PI * 2) / Math.max(1, list.length);
  const maxLeaves = sketch ? 2 : MAX_LEAVES;
  const maxSub = sketch ? 1 : MAX_SUB;

  list.forEach((b, i) => {
    const ring = Number.isFinite(b.ring) ? b.ring : 1;
    const rad = radiusOf(ring, i);
    const ang = -Math.PI / 2 + (sketch ? 0.08 : 0.35) + i * step;
    const hub = { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad };
    const isBranchAuto = !!(b.auto || b.kind === 'flow');
    const kids = (b.children || []).filter(c => c && c.id);
    const tops = kids.filter(c => !c.parent || !kids.some(k => k.id === c.parent)).slice(0, maxLeaves);
    const dir = i % 2 === 0 ? 1 : -1;
    const leaves = [];

    if (sketch) {
      // Disegno fedele allo schizzo: al massimo 1-2 lunghi bracci curvi orbitali per ramo,
      // ciascuno con un solo nodo finale ben distanziato (niente file di cerchietti attaccati).
      tops.forEach((c, j) => {
        const isAuto = !!(c.auto || c.kind === 'flow' || isBranchAuto);
        if (j === 0) {
          const sweep = dir * Math.min(0.82, Math.max(0.55, step * 0.68));
          const a0 = ang + sweep;
          const r0 = Math.min(0.90, rad + 0.14);
          const pos0 = { x: Math.cos(a0) * r0, y: Math.sin(a0) * r0 };
          leaves.push({ id: c.id, label: String(c.label || ''), ...pos0, path: arcTrace(hub, pos0, 12), sub: false, auto: isAuto });
        } else {
          // Secondo braccio: arco concentrico interno parallelo (come in alto a sinistra nello schizzo)
          // oppure pista angolata a circuito (come a sinistra nello schizzo).
          if (i % 2 === 0) {
            const sweep2 = dir * Math.min(0.58, Math.max(0.40, step * 0.48));
            const a1 = ang + sweep2;
            const r1 = Math.max(0.28, rad - 0.04);
            const pos1 = { x: Math.cos(a1) * r1, y: Math.sin(a1) * r1 };
            leaves.push({ id: c.id, label: String(c.label || ''), ...pos1, path: arcTrace(hub, pos1, 10), sub: false, auto: isAuto });
          } else {
            const a1 = ang - dir * 0.42;
            const r1 = Math.min(0.88, rad + 0.08);
            const pos1 = { x: Math.cos(a1) * r1, y: Math.sin(a1) * r1 };
            leaves.push({ id: c.id, label: String(c.label || ''), ...pos1, path: pcbTrace(hub, pos1), sub: false, auto: isAuto });
          }
        }
        const hostLeaf = leaves[leaves.length - 1];
        kids.filter(k => k.parent === c.id).slice(0, maxSub).forEach((sub) => {
          const sa = Math.atan2(hostLeaf.y, hostLeaf.x) + dir * 0.36;
          const rSub = Math.min(0.93, Math.hypot(hostLeaf.x, hostLeaf.y) + 0.09);
          const sp = { x: Math.cos(sa) * rSub, y: Math.sin(sa) * rSub };
          const subAuto = !!(sub.auto || sub.kind === 'flow' || isAuto);
          leaves.push({ id: sub.id, label: String(sub.label || ''), ...sp, path: pcbTrace(hostLeaf, sp), sub: true, host: c.id, auto: subAuto });
        });
      });
    } else {
      const maxSweep = Math.min(Math.PI * 0.72, Math.max(0.42, step * 0.85));
      const arcStep = tops.length ? maxSweep / Math.max(1, tops.length) : 0.25;
      tops.forEach((c, j) => {
        const a = ang + dir * (j + 1) * arcStep;
        const rLeaf = Math.min(0.9, rad + 0.05 + (j % 2) * 0.07 + j * 0.012);
        const pos = { x: Math.cos(a) * rLeaf, y: Math.sin(a) * rLeaf };
        const isAuto = !!(c.auto || c.kind === 'flow' || isBranchAuto);
        leaves.push({ id: c.id, label: String(c.label || ''), ...pos, path: arcTrace(hub, pos, 8), sub: false, auto: isAuto });

        kids.filter(k => k.parent === c.id).slice(0, maxSub).forEach((sub, m, subs) => {
          const sa = a + dir * (0.18 + m * 0.18);
          const rSub = Math.min(0.94, rLeaf + (subs.length === 1 ? 0.07 : 0.05 + (m % 2) * 0.04));
          const sp = { x: Math.cos(sa) * rSub, y: Math.sin(sa) * rSub };
          const subAuto = !!(sub.auto || sub.kind === 'flow' || isAuto);
          leaves.push({ id: sub.id, label: String(sub.label || ''), ...sp, path: pcbTrace(pos, sp), sub: true, host: c.id, auto: subAuto });
        });
      });
    }

    out.push({ id: b.id, label: String(b.label || b.id), kind: b.kind || 'module', auto: isBranchAuto, ring, hub, spoke: [{ x: 0, y: 0 }, hub], leaves });
  });

  // Riporta tutto dentro il cerchio di raggio 1.
  let far = 0;
  for (const b of out) { far = Math.max(far, Math.hypot(b.hub.x, b.hub.y)); for (const l of b.leaves) far = Math.max(far, Math.hypot(l.x, l.y)); }
  const k = far > 0.96 ? 0.96 / far : 1;
  if (k !== 1) {
    const sc = (p) => { p.x *= k; p.y *= k; };
    for (const b of out) {
      sc(b.hub);
      for (const l of b.leaves) sc(l);
      for (const l of b.leaves) l.path = l.sub ? pcbTrace(b.leaves.find(x => x.id === l.host), l) : arcTrace(b.hub, l, 8);
      b.spoke = [{ x: 0, y: 0 }, b.hub];
    }
  }
  return out;
}
