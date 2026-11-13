// La "mente" di Jarvis: un nucleo di nodi collegati con impulsi, e attorno i rami della sua memoria.
// Ogni ramo è un modulo (un argomento, un progetto, la dieta, l'agenda, i compiti) e le sue foglie
// sono le informazioni dentro. Quando si parla di un argomento, il suo ramo e le sue foglie si accendono;
// toccando un ramo la sfera ruota verso di lui e lo ingrandisce.
// Velocità, impulsi e respiro cambiano con lo stato (in attesa, in ascolto, sta pensando, sta parlando).

const NODES = 90;
const LINKS_PER_NODE = 3;
const CORE = 0.42;        // raggio del nucleo rispetto alla sfera dei rami
const HUB = 1;            // raggio a cui stanno i nodi dei rami
const LEAF = 1.3;         // raggio a cui stanno le foglie
const ZOOM = 2;         // ingrandimento quando un ramo è aperto

// Parametri per stato: rotazione (rad/s), impulsi al secondo, luminosità, ampiezza del "respiro".
const MODES = {
  idle:      { spin: 0.12, rate: 3,  glow: 0.55, breathe: 0.015, label: 'Pronto' },
  listening: { spin: 0.22, rate: 9,  glow: 0.8,  breathe: 0.05,  label: 'In ascolto' },
  thinking:  { spin: 0.85, rate: 34, glow: 1,    breathe: 0.02,  label: 'Sto pensando' },
  speaking:  { spin: 0.3,  rate: 14, glow: 0.95, breathe: 0.09,  label: 'Sto parlando' },
  off:       { spin: 0.05, rate: 0.6, glow: 0.3, breathe: 0.008, label: 'Ascolto spento' },
};

const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function buildCore() {
  // Punti distribuiti in modo uniforme (spirale di Fibonacci), con un po' di irregolarità "organica".
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < NODES; i++) {
    const y = 1 - (i / (NODES - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    const jitter = (0.9 + ((i * 7919) % 100) / 500) * CORE; // deterministico
    pts.push({ x: Math.cos(t) * r * jitter, y: y * jitter, z: Math.sin(t) * r * jitter, heat: 0 });
  }
  const seen = new Set();
  const links = [];
  const link = (a, b) => {
    const k = a < b ? a + '-' + b : b + '-' + a;
    if (a === b || seen.has(k)) return;
    seen.add(k); links.push([a, b]);
  };
  pts.forEach((p, i) => {
    pts.map((q, j) => [j, (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2])
      .sort((a, b) => a[1] - b[1]).slice(1, LINKS_PER_NODE + 1).forEach(([j]) => link(i, j));
    if (i % 9 === 0) link(i, (i * 37 + 53) % NODES);
  });
  const byNode = pts.map(() => []);
  links.forEach((l, idx) => { byNode[l[0]].push(idx); byNode[l[1]].push(idx); });
  return { pts, links, byNode };
}

/** Dispone i rami sulla sfera: nucleo → gomito → nodo del ramo → foglie, con piste "a circuito". */
function layoutBranches(list, old) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const n = list.length;
  return list.map((b, i) => {
    const y = n === 1 ? 0.2 : (1 - ((i + 0.5) / n) * 2) * 0.82;
    const r = Math.sqrt(1 - y * y), t = golden * i + 0.6;
    const dir = norm({ x: Math.cos(t) * r, y, z: Math.sin(t) * r });
    const u = norm(cross(dir, Math.abs(dir.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
    const v = cross(dir, u);
    const prev = old.get(b.id);
    const hub = { ...scale(dir, HUB), heat: prev ? prev.hub.heat : 0 };
    const start = scale(dir, CORE * 1.05);
    const elbow = add(scale(dir, 0.72), scale(u, 0.12 * (i % 2 ? 1 : -1)));
    const kids = (b.children || []).slice(0, 10);
    const leaves = kids.map((c, k) => {
      const a = (k / Math.max(1, kids.length)) * Math.PI * 2 + i;
      const off = add(scale(u, Math.cos(a) * 0.3), scale(v, Math.sin(a) * 0.3));
      const before = prev?.leaves.find(l => l.id === c.id);
      return { id: c.id, label: String(c.label || ''), turn: { ...add(hub, off) }, ...add(scale(dir, LEAF), off), heat: before ? before.heat : 0 };
    });
    return { id: b.id, label: String(b.label || b.id), kind: b.kind || 'module', dir, start, elbow, hub, leaves };
  });
}

export function createOrb() {
  const canvas = document.createElement('canvas');
  const label = document.createElement('span');
  label.className = 'orb-label';
  const el = document.createElement('div');
  el.className = 'orb';
  el.setAttribute('role', 'img');
  el.append(canvas, label);

  const ctx = canvas.getContext('2d');
  const { pts, links, byNode } = buildCore();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let mode = 'idle';
  let cur = { ...MODES.idle, zoom: 1 };    // valori correnti, che scivolano verso quelli dello stato
  let pulses = [];                          // impulsi del nucleo: { link, t (0..1), dir, speed, hops }
  let trails = [];                          // impulsi sui rami: { path: [punti], t, speed, then }
  let branches = [];
  let focus = null;
  let onPick = null;
  let angle = 0, tilt = 0.35, last = 0, spawn = 0, raf = 0, w = 0, hgt = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    w = r.width; hgt = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function firePulse(from) {
    const options = byNode[from];
    if (!options.length || pulses.length > 160) return;
    const link = options[Math.floor(Math.random() * options.length)];
    const dir = links[link][0] === from ? 1 : -1;
    pulses.push({ link, t: 0, dir, speed: 1.4 + Math.random() * 1.6, hops: 0 });
  }

  /** Manda un impulso dal nucleo al ramo; arrivato, prosegue verso le foglie indicate. */
  function fireBranch(b, leafIds = null, speed = 1.1) {
    if (trails.length > 60) return;
    trails.push({ path: [b.start, b.elbow, b.hub], t: 0, speed, then: () => {
      b.hub.heat = 1;
      const targets = leafIds ? b.leaves.filter(l => leafIds.has(l.id)) : [];
      for (const l of targets) trails.push({ path: [b.hub, l.turn, l], t: 0, speed: speed * 1.3, then: () => { l.heat = 1; } });
    } });
  }

  function frame(now) {
    if (!el.isConnected) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    if (!w) resize();
    if (!w) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const target = MODES[mode];
    const ease = 1 - Math.exp(-dt * 4);
    for (const k of ['spin', 'rate', 'glow', 'breathe']) cur[k] += (target[k] - cur[k]) * ease;
    const slow = reduced ? 0.25 : 1;
    const focused = focus && branches.find(b => b.id === focus);
    cur.zoom += ((focused ? ZOOM : 1) - cur.zoom) * (1 - Math.exp(-dt * 3));
    if (focused) {
      // Ruota finché il ramo aperto guarda verso chi usa il telefono.
      const { x, y, z } = focused.dir;
      angle += wrap(Math.atan2(-x, z) - angle) * (1 - Math.exp(-dt * 3));
      tilt += (Math.atan2(y, Math.hypot(x, z)) - tilt) * (1 - Math.exp(-dt * 3));
    } else {
      angle += cur.spin * dt * slow;
      tilt += (0.35 - tilt) * (1 - Math.exp(-dt * 2));
    }
    const time = now / 1000;

    // Respiro: lento in attesa, ritmo di voce quando parla, onde regolari quando ascolta.
    let pulse;
    if (mode === 'speaking') pulse = Math.sin(time * 9) * 0.5 + Math.sin(time * 14.3) * 0.3 + Math.sin(time * 5.1) * 0.2;
    else if (mode === 'listening') pulse = Math.sin(time * 3.2);
    else pulse = Math.sin(time * 1.2);
    const breath = 1 + cur.breathe * pulse * slow;

    // Nuovi impulsi nel nucleo, e ogni tanto uno che esce lungo un ramo a caso.
    spawn += cur.rate * dt * slow;
    while (spawn >= 1) {
      spawn -= 1;
      firePulse(Math.floor(Math.random() * NODES));
      if (branches.length && Math.random() < 0.08) fireBranch(branches[Math.floor(Math.random() * branches.length)], null, 0.8);
    }

    const compact = hgt < 170;
    const R = Math.min(w, hgt) * (branches.length ? 0.4 : 0.38 / CORE) * breath * cur.zoom;
    const cx = w / 2, cy = hgt / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle), ct = Math.cos(tilt), st = Math.sin(tilt);
    const project = (p, radius = LEAF) => {
      const x = p.x * ca + p.z * sa, z0 = -p.x * sa + p.z * ca;
      const y = p.y * ct - z0 * st, z = p.y * st + z0 * ct;
      const persp = 1 / (2.1 - z * 0.55);
      p.sx = cx + x * R * persp * 1.5; p.sy = cy + y * R * persp * 1.5;
      p.d = Math.max(0, Math.min(1, (z / radius + 1) / 2)); // 0 dietro, 1 davanti
    };
    for (const p of pts) { project(p, CORE); p.heat = Math.max(0, p.heat - dt * 2.2); }
    for (const b of branches) {
      for (const p of [b.start, b.elbow, b.hub]) project(p);
      b.hub.heat = Math.max(0, b.hub.heat - dt * 0.3);
      b.fade += ((!focused || focused === b ? 1 : 0.12) - b.fade) * ease;
      for (const l of b.leaves) { project(l.turn); project(l); l.heat = Math.max(0, l.heat - dt * 0.25); }
    }
    const coreFade = focused ? 0.15 + 0.85 * (1 - (cur.zoom - 1) / (ZOOM - 1)) : 1;

    ctx.clearRect(0, 0, w, hgt);

    // Alone centrale
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, hgt) * 0.55);
    halo.addColorStop(0, `rgba(57,255,20,${0.16 * cur.glow})`);
    halo.addColorStop(0.55, `rgba(34,160,60,${0.06 * cur.glow})`);
    halo.addColorStop(1, 'rgba(5,15,5,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, hgt);

    // Rami: piste dal nucleo ai nodi e dai nodi alle foglie, più accese se l'argomento è attivo.
    const poly = (list, alpha, width) => {
      ctx.lineWidth = width; ctx.strokeStyle = alpha;
      ctx.beginPath(); ctx.moveTo(list[0].sx, list[0].sy);
      for (let i = 1; i < list.length; i++) ctx.lineTo(list[i].sx, list[i].sy);
      ctx.stroke();
    };
    for (const b of branches) {
      const hot = b.hub.heat, depth = b.hub.d;
      poly([b.start, b.elbow, b.hub], `rgba(${60 + hot * 150},${200 + hot * 55},${90 + hot * 110},${((0.1 + depth * 0.3) * cur.glow + hot * 0.5) * b.fade})`, 1 + hot * 1.2);
      for (const l of b.leaves) {
        const lh = Math.max(l.heat, hot * 0.4);
        poly([b.hub, l.turn, l], `rgba(${60 + lh * 150},${200 + lh * 55},${90 + lh * 110},${((0.06 + l.d * 0.22) * cur.glow + lh * 0.5) * b.fade})`, 0.8 + lh);
      }
    }

    // Connessioni del nucleo (piste da circuito)
    ctx.lineWidth = 1;
    for (const [a, b] of links) {
      const p = pts[a], q = pts[b];
      const depth = (p.d + q.d) / 2;
      const hot = Math.max(p.heat, q.heat);
      ctx.strokeStyle = `rgba(${60 + hot * 120},${200 + hot * 55},${90 + hot * 60},${((0.06 + depth * 0.22) * cur.glow + hot * 0.35) * coreFade})`;
      ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(q.sx, q.sy); ctx.stroke();
    }

    const spark = (x, y, depth, alpha = 1) => {
      ctx.fillStyle = `rgba(225,255,215,${(0.5 + depth * 0.5) * alpha})`;
      ctx.beginPath(); ctx.arc(x, y, 1.3 + depth * 1.4, 0, Math.PI * 2); ctx.fill();
    };

    // Impulsi del nucleo che viaggiano e si propagano al nodo successivo
    const next = [];
    for (const pu of pulses) {
      pu.t += pu.speed * dt * slow;
      const [a, b] = links[pu.link];
      const from = pu.dir > 0 ? pts[a] : pts[b], to = pu.dir > 0 ? pts[b] : pts[a];
      if (pu.t >= 1) {
        to.heat = 1;
        const chance = mode === 'thinking' ? 0.72 : 0.45;
        if (pu.hops < 6 && Math.random() < chance) {
          const idx = pu.dir > 0 ? b : a;
          const options = byNode[idx].filter(l => l !== pu.link);
          if (options.length) {
            const link = options[Math.floor(Math.random() * options.length)];
            next.push({ link, t: 0, dir: links[link][0] === idx ? 1 : -1, speed: pu.speed, hops: pu.hops + 1 });
          }
        }
        continue;
      }
      const x = from.sx + (to.sx - from.sx) * pu.t, y = from.sy + (to.sy - from.sy) * pu.t;
      const depth = from.d + (to.d - from.d) * pu.t;
      const tx = from.sx + (to.sx - from.sx) * Math.max(0, pu.t - 0.25), ty = from.sy + (to.sy - from.sy) * Math.max(0, pu.t - 0.25);
      ctx.strokeStyle = `rgba(160,255,140,${(0.25 + depth * 0.55) * coreFade})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
      spark(x, y, depth, coreFade);
      next.push(pu);
    }
    pulses = next;

    // Impulsi sui rami (lungo spezzate di più segmenti)
    const nextTrails = [];
    for (const tr of trails) {
      tr.t += tr.speed * dt * slow;
      if (tr.t >= 1) { tr.then?.(); continue; }
      const segs = tr.path.length - 1, pos = tr.t * segs, i = Math.min(segs - 1, Math.floor(pos)), f = pos - i;
      const a = tr.path[i], b = tr.path[i + 1];
      spark(a.sx + (b.sx - a.sx) * f, a.sy + (b.sy - a.sy) * f, a.d + (b.d - a.d) * f);
      nextTrails.push(tr);
    }
    trails = nextTrails;

    // Nodi del nucleo
    for (const p of pts) {
      const r = (0.9 + p.d * 1.7 + p.heat * 2.2) * Math.min(1.6, Math.sqrt(cur.zoom)) * (branches.length ? 0.85 : 1);
      ctx.fillStyle = `rgba(${57 + p.heat * 180},255,${20 + p.heat * 190},${((0.25 + p.d * 0.6) * cur.glow + p.heat * 0.4) * coreFade})`;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
      if (p.heat > 0.3) {
        ctx.fillStyle = `rgba(57,255,20,${p.heat * 0.18 * coreFade})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 3.2, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Nodi dei rami e foglie, con le etichette quando c'è spazio.
    ctx.textBaseline = 'middle';
    for (const b of branches) {
      for (const l of b.leaves) {
        const r = 1.6 + l.d * 1.8 + l.heat * 2.4;
        ctx.fillStyle = `rgba(${57 + l.heat * 180},255,${20 + l.heat * 190},${((0.3 + l.d * 0.5) * cur.glow + l.heat * 0.5) * b.fade})`;
        ctx.beginPath(); ctx.arc(l.sx, l.sy, r, 0, Math.PI * 2); ctx.fill();
        if (focused === b && cur.zoom > 1.6 && !compact) {
          const right = l.sx >= cx;
          ctx.font = '12px system-ui, sans-serif';
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillStyle = `rgba(200,255,190,${0.55 + l.heat * 0.45})`;
          // Il testo resta dentro lo schermo: si accorcia finché ci sta.
          const room = (right ? w - l.sx : l.sx) - 14;
          let text = clip(l.label, 38);
          while (text.length > 4 && ctx.measureText(text).width > room) text = clip(text, text.length - 1);
          ctx.fillText(text, l.sx + (right ? 9 : -9), l.sy);
        }
      }
      const h = b.hub, r = (3 + h.d * 2.6 + h.heat * 3) * (focused === b ? 1.5 : 1);
      ctx.strokeStyle = `rgba(${120 + h.heat * 120},255,${110 + h.heat * 120},${((0.45 + h.d * 0.5) * cur.glow + h.heat * 0.4) * b.fade})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(h.sx, h.sy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(57,255,20,${(0.18 + h.heat * 0.5) * b.fade})`;
      ctx.fill();
      if (h.heat > 0.2) {
        ctx.fillStyle = `rgba(57,255,20,${h.heat * 0.16 * b.fade})`;
        ctx.beginPath(); ctx.arc(h.sx, h.sy, r * 3, 0, Math.PI * 2); ctx.fill();
      }
      if (!compact && (focused === b || (!focused && (h.d > 0.5 || h.heat > 0.2)))) {
        ctx.font = focused === b ? '600 14px system-ui, sans-serif' : '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(190,255,180,${focused === b ? 0.95 : (0.25 + h.d * 0.4 + h.heat * 0.5) * cur.glow})`;
        ctx.fillText(clip(b.label, 22), h.sx, h.sy - r - 9);
      }
    }
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  new ResizeObserver(() => resize()).observe(canvas);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : el.isConnected && start()));

  // Tocco: un ramo vicino al dito si apre; toccando altrove si richiude.
  canvas.addEventListener('click', (e) => {
    if (!onPick || !branches.length) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = 28 * 28;
    for (const b of branches) {
      if (b.fade < 0.5) continue;
      const d = (b.hub.sx - x) ** 2 + (b.hub.sy - y) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    onPick(best ? best.id : null);
  });

  function setLabel() {
    const b = focus && branches.find(x => x.id === focus);
    label.textContent = b ? `${b.label} · ${b.leaves.length} ${b.leaves.length === 1 ? 'nodo' : 'nodi'}` : MODES[mode].label;
    el.setAttribute('aria-label', 'Jarvis: ' + MODES[mode].label.toLowerCase() + (b ? ', ramo aperto: ' + b.label : ''));
  }

  function setState(next) {
    if (!MODES[next]) next = 'idle';
    if (next !== mode && next === 'thinking') for (let i = 0; i < 14; i++) firePulse(Math.floor(Math.random() * NODES));
    mode = next;
    el.dataset.state = next;
    setLabel();
  }
  setState('idle');

  return {
    el, setState,
    /** I rami da disegnare: [{ id, label, kind, children: [{ id, label }] }] (da /api/graph). */
    setGraph(list) {
      const old = new Map(branches.map(b => [b.id, b]));
      branches = layoutBranches(Array.isArray(list) ? list : [], old).map(b => ({ ...b, fade: old.get(b.id)?.fade ?? 1 }));
      if (focus && !branches.some(b => b.id === focus)) focus = null;
      setLabel();
    },
    /** Accende i rami (e le foglie) di cui si sta parlando. */
    highlight(ids = [], leafIds = []) {
      const leaves = new Set(leafIds);
      for (const b of branches) if (ids.includes(b.id)) fireBranch(b, leaves, 1.4);
    },
    /** Apre un ramo (zoom) o, con null, torna alla vista intera. */
    focus(id) { focus = id && branches.some(b => b.id === id) ? id : null; setLabel(); },
    get focused() { return focus; },
    onPick(fn) { onPick = fn; },
    /** Da chiamare dopo aver (ri)messo l'elemento nella pagina, o dopo averlo tolto. */
    sync() { if (el.isConnected && !document.hidden) { resize(); start(); } else stop(); },
  };
}
