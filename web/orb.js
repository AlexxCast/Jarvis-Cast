// La "mente" di Jarvis: una sfera di nodi collegati, con impulsi che viaggiano lungo le connessioni.
// Non è decorazione: velocità, impulsi e respiro cambiano a seconda di cosa sta facendo
// (in attesa, in ascolto, sta pensando, sta parlando).

const NODES = 110;
const LINKS_PER_NODE = 3;

// Parametri per stato: rotazione (rad/s), impulsi al secondo, luminosità, ampiezza del "respiro".
const MODES = {
  idle:      { spin: 0.12, rate: 3,  glow: 0.55, breathe: 0.015, label: 'Pronto' },
  listening: { spin: 0.22, rate: 9,  glow: 0.8,  breathe: 0.05,  label: 'In ascolto' },
  thinking:  { spin: 0.85, rate: 34, glow: 1,    breathe: 0.02,  label: 'Sto pensando' },
  speaking:  { spin: 0.3,  rate: 14, glow: 0.95, breathe: 0.09,  label: 'Sto parlando' },
  off:       { spin: 0.05, rate: 0.6, glow: 0.3, breathe: 0.008, label: 'Ascolto spento' },
};

function buildSphere() {
  // Punti distribuiti in modo uniforme (spirale di Fibonacci), con un po' di irregolarità "organica".
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < NODES; i++) {
    const y = 1 - (i / (NODES - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    const jitter = 0.9 + ((i * 7919) % 100) / 500; // 0.9 – 1.1, deterministico
    pts.push({ x: Math.cos(t) * r * jitter, y: y * jitter, z: Math.sin(t) * r * jitter, heat: 0 });
  }
  // Ogni nodo si collega ai più vicini; in più qualche connessione lunga che attraversa la sfera.
  const seen = new Set();
  const links = [];
  const add = (a, b) => {
    const k = a < b ? a + '-' + b : b + '-' + a;
    if (a === b || seen.has(k)) return;
    seen.add(k); links.push([a, b]);
  };
  pts.forEach((p, i) => {
    pts.map((q, j) => [j, (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2])
      .sort((a, b) => a[1] - b[1]).slice(1, LINKS_PER_NODE + 1).forEach(([j]) => add(i, j));
    if (i % 9 === 0) add(i, (i * 37 + 53) % NODES);
  });
  const byNode = pts.map(() => []);
  links.forEach((l, idx) => { byNode[l[0]].push(idx); byNode[l[1]].push(idx); });
  return { pts, links, byNode };
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
  const { pts, links, byNode } = buildSphere();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let mode = 'idle';
  let cur = { ...MODES.idle };           // valori correnti, che scivolano verso quelli dello stato
  let pulses = [];                        // { link, t (0..1), dir, speed }
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
    angle += cur.spin * dt * slow;
    const time = now / 1000;

    // Respiro: lento in attesa, ritmo di voce quando parla, onde regolari quando ascolta.
    let pulse;
    if (mode === 'speaking') pulse = Math.sin(time * 9) * 0.5 + Math.sin(time * 14.3) * 0.3 + Math.sin(time * 5.1) * 0.2;
    else if (mode === 'listening') pulse = Math.sin(time * 3.2);
    else pulse = Math.sin(time * 1.2);
    const scale = 1 + cur.breathe * pulse * slow;

    // Nuovi impulsi
    spawn += cur.rate * dt * slow;
    while (spawn >= 1) { spawn -= 1; firePulse(Math.floor(Math.random() * NODES)); }

    const R = Math.min(w, hgt) * 0.4 * scale;
    const cx = w / 2, cy = hgt / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle), ct = Math.cos(tilt), st = Math.sin(tilt);
    for (const p of pts) {
      const x = p.x * ca + p.z * sa, z0 = -p.x * sa + p.z * ca;
      const y = p.y * ct - z0 * st, z = p.y * st + z0 * ct;
      const persp = 1 / (1.9 - z * 0.55);
      p.sx = cx + x * R * persp * 1.5; p.sy = cy + y * R * persp * 1.5; p.d = (z + 1) / 2; // d: 0 dietro, 1 davanti
      p.heat = Math.max(0, p.heat - dt * 2.2);
    }

    ctx.clearRect(0, 0, w, hgt);

    // Alone centrale
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.35);
    halo.addColorStop(0, `rgba(57,255,20,${0.16 * cur.glow})`);
    halo.addColorStop(0.55, `rgba(34,160,60,${0.06 * cur.glow})`);
    halo.addColorStop(1, 'rgba(5,15,5,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, hgt);

    // Connessioni (piste da circuito)
    ctx.lineWidth = 1;
    for (const [a, b] of links) {
      const p = pts[a], q = pts[b];
      const depth = (p.d + q.d) / 2;
      const hot = Math.max(p.heat, q.heat);
      ctx.strokeStyle = `rgba(${60 + hot * 120},${200 + hot * 55},${90 + hot * 60},${(0.06 + depth * 0.22) * cur.glow + hot * 0.35})`;
      ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(q.sx, q.sy); ctx.stroke();
    }

    // Impulsi che viaggiano e si propagano al nodo successivo
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
      ctx.strokeStyle = `rgba(160,255,140,${0.25 + depth * 0.55})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = `rgba(225,255,215,${0.5 + depth * 0.5})`;
      ctx.beginPath(); ctx.arc(x, y, 1.3 + depth * 1.4, 0, Math.PI * 2); ctx.fill();
      next.push(pu);
    }
    pulses = next;

    // Nodi
    for (const p of pts) {
      const r = 0.9 + p.d * 1.7 + p.heat * 2.2;
      ctx.fillStyle = `rgba(${57 + p.heat * 180},255,${20 + p.heat * 190},${(0.25 + p.d * 0.6) * cur.glow + p.heat * 0.4})`;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
      if (p.heat > 0.3) {
        ctx.fillStyle = `rgba(57,255,20,${p.heat * 0.18})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 3.2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  new ResizeObserver(() => resize()).observe(canvas);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : el.isConnected && start()));

  function setState(next) {
    if (!MODES[next]) next = 'idle';
    if (next !== mode && next === 'thinking') for (let i = 0; i < 14; i++) firePulse(Math.floor(Math.random() * NODES));
    mode = next;
    label.textContent = MODES[next].label;
    el.setAttribute('aria-label', 'Jarvis: ' + MODES[next].label.toLowerCase());
    el.dataset.state = next;
  }
  setState('idle');

  return {
    el, setState,
    /** Da chiamare dopo aver (ri)messo l'elemento nella pagina, o dopo averlo tolto. */
    sync() { if (el.isConnected && !document.hidden) { resize(); start(); } else stop(); },
  };
}
