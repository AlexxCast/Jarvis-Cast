// La "mente" di Jarvis: al centro c'è solo il nodo Jarvis. Ogni argomento di cui si parla diventa un nodo
// sulla superficie di una sfera, collegato al centro; i sotto-argomenti sono nodi vicini, uniti da piste
// di circuito stampato che corrono sulla superficie curva (prima lungo un parallelo, poi lungo un meridiano).
// La sfera quindi non è finta: si compone piano piano, un nodo alla volta.
// Quando si parla di un argomento il suo ramo si accende; toccando un ramo la sfera ruota verso di lui e fa zoom.
// Velocità, impulsi e respiro cambiano con lo stato (in attesa, in ascolto, sta pensando, sta parlando).

const ZOOM = 2;           // ingrandimento quando un ramo è aperto
const SPREAD = 0.42;      // distanza (in radianti) delle foglie dal loro ramo, sulla superficie
const STEPS = 7;          // punti per tratto di pista curva
const SHELL_MIN = 0.42;   // raggio del guscio più interno (informazioni personali, leggere, frequenti)
const LEVEL_STEP = 1 - SHELL_MIN; // raggio guadagnato per ogni unità di livello (non c'è un massimo)

const MODES = {
  idle:      { spin: 0.12, rate: 1.2, glow: 0.6,  breathe: 0.03, label: 'Pronto' },
  listening: { spin: 0.2,  rate: 3,   glow: 0.85, breathe: 0.08, label: 'In ascolto' },
  thinking:  { spin: 0.7,  rate: 12,  glow: 1,    breathe: 0.04, label: 'Sto pensando' },
  speaking:  { spin: 0.28, rate: 5,   glow: 0.95, breathe: 0.14, label: 'Sto parlando' },
  off:       { spin: 0.05, rate: 0.3, glow: 0.35, breathe: 0.01, label: 'Ascolto spento' },
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clampLat = (v) => Math.max(-1.3, Math.min(1.3, v));
/** Punto sulla sfera di raggio r da latitudine e longitudine. */
const onSphere = (lat, lon, r = 1) => ({ x: Math.cos(lat) * Math.cos(lon) * r, y: Math.sin(lat) * r, z: Math.cos(lat) * Math.sin(lon) * r });

/** Pista "a circuito" sulla superficie: prima lungo il parallelo, poi lungo il meridiano. */
function surfaceTrace(a, b, r = 1) {
  const pts = [];
  const dLon = wrap(b.lon - a.lon);
  for (let i = 0; i <= STEPS; i++) pts.push(onSphere(a.lat, a.lon + dLon * (i / STEPS), r));
  for (let i = 1; i <= STEPS; i++) pts.push(onSphere(a.lat + (b.lat - a.lat) * (i / STEPS), b.lon, r));
  return pts;
}

/** Raggio del guscio di un ramo: livello 0 = vicino a Jarvis, 1 = superficie esterna. */
const shellOf = (b) => SHELL_MIN + (Number.isFinite(b.level) ? Math.max(0, b.level) : 0.6) * LEVEL_STEP;
/** Centro di ogni guscio da disegnare: 0 interno, 1 medio, 2 esterno, poi uno ogni 0.3 di livello. */
const ringLevel = (k) => (k === 0 ? 0.2 : k === 1 ? 0.51 : 0.77 + (k - 2) * 0.3);

/** Dispone i rami: nodo sulla sfera per ogni argomento, foglie attorno, piste verso il centro e tra i nodi. */
function layoutBranches(list, old) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const n = list.length;
  return list.map((b, i) => {
    const y = n === 1 ? 0.15 : (1 - ((i + 0.5) / n) * 2) * 0.8;
    const lat = Math.asin(y), lon = golden * i + 0.6;
    const prev = old.get(b.id);
    // Livelli: i rami personali e leggeri stanno su un guscio interno, quelli pesanti e accessori fuori.
    const r = shellOf(b);
    const hub = { ...onSphere(lat, lon, r), lat, lon, rad: r, heat: prev ? prev.hub.heat : 0 };
    // Dal centro: dritto verso l'esterno, poi una curva a gomito fino al nodo (come una pista).
    const bend = { ...onSphere(lat + (i % 2 ? 0.25 : -0.25), lon - 0.2, r * 0.55), rad: r * 0.55 };
    const spoke = [{ x: 0, y: 0, z: 0 }, bend, hub];
    const kids = (b.children || []).slice(0, 32);
    const leaves = kids.map((c, k) => {
      const a = ((k % 10) / Math.min(10, Math.max(1, kids.length))) * Math.PI * 2 + i * 0.7 + Math.floor(k / 10) * 0.31;
      // Stessa distanza a schermo su ogni guscio: sui gusci piccoli l'angolo è più ampio.
      // Tante foglie: si dispongono su più giri attorno al ramo, sempre più fitti.
      const turn = Math.floor(k / 10);
      const dist = Math.min(0.75, SPREAD / Math.sqrt(r)) * (k % 2 ? 1.25 : 1) * (1 + turn * 0.45);
      const llat = clampLat(lat + Math.sin(a) * dist);
      const llon = lon + (Math.cos(a) * dist) / Math.max(0.35, Math.cos(llat));
      const before = prev?.leaves.find(l => l.id === c.id);
      const pos = { ...onSphere(llat, llon, r), lat: llat, lon: llon, rad: r };
      return { id: c.id, label: String(c.label || ''), ...pos, path: surfaceTrace(hub, pos, r), heat: before ? before.heat : 0 };
    });
    return { id: b.id, label: String(b.label || b.id), kind: b.kind || 'module', ring: b.ring ?? 1, zone: i, dir: hub, hub, spoke, leaves, fade: prev?.fade ?? 0 };
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
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const center = { x: 0, y: 0, z: 0, heat: 0 };
  let mode = 'idle';
  let cur = { ...MODES.idle, zoom: 1 };    // valori correnti, che scivolano verso quelli dello stato
  let trails = [];                          // impulsi lungo le piste: { path: [punti], t, speed, then }
  let branches = [];
  let focus = null;
  let onPick = null;
  // Umore: colora la rete e gli impulsi (non lo sfondo). Un cambio parte da Jarvis e si propaga verso
  // l'esterno come un'onda; le emozioni secondarie colorano alcune zone e una parte degli impulsi.
  const BASE = [60, 205, 80];
  let tintFrom = BASE, tintTo = BASE, tintA = 0, wave = 9, parts = [];
  let fit = 1, rings = 3, maxRad = 1;                // la sfera si allontana quando i gusci crescono
  let angle = 0.4, tilt = 0.35, last = 0, spawn = 0, raf = 0, w = 0, hgt = 0, spinRing = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    w = r.width; hgt = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Un impulso parte da Jarvis, raggiunge il ramo e, se indicato, prosegue verso le foglie. */
  function fireBranch(b, leafIds = null, speed = 1) {
    if (trails.length > 50) return;
    center.heat = 1;
    const col = pulseColor();
    trails.push({ path: b.spoke, t: 0, speed, col, then: () => {
      b.hub.heat = Math.max(b.hub.heat, leafIds ? 1 : 0.6);
      const targets = leafIds === null
        ? (b.leaves.length && Math.random() < 0.6 ? [b.leaves[Math.floor(Math.random() * b.leaves.length)]] : [])
        : b.leaves.filter(l => leafIds.has(l.id));
      for (const l of targets) trails.push({ path: l.path, t: 0, speed: speed * 0.9, col, then: () => { l.heat = Math.max(l.heat, leafIds ? 1 : 0.6); } });
    } });
  }

  const mix = (a, b, k) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * k);
  /** Colore della rete a distanza rad dal centro: dietro l'onda il nuovo umore, davanti il vecchio. */
  const tintAt = (rad) => {
    const k = Math.max(0, Math.min(1, (wave - rad) / 0.3));
    return mix(BASE, mix(tintFrom, tintTo, k * k * (3 - 2 * k)), 0.25 + tintA * 0.7);
  };
  /** Colore di un impulso: di solito l'umore dominante, a volte un'emozione secondaria. */
  function pulseColor() {
    let x = Math.random();
    for (const p of parts) { if ((x -= p.w) <= 0) return mix(BASE, p.rgb, 0.35 + tintA * 0.65); }
    return tintAt(0);
  }
  /** Zone: ogni ramo prende anche un po' del colore di un'emozione secondaria, se c'è. */
  const zoneOf = (b, base) => {
    const side = parts.length > 1 ? parts[1 + (b.zone % (parts.length - 1))] : null;
    return side && side.w > 0.18 ? mix(base, side.rgb, Math.min(0.45, side.w) * tintA) : base;
  };

  function frame(now) {
    if (!el.isConnected) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    if (!w) resize();
    if (!w) return;
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000 || 0.016));
    last = now;
    const target = MODES[mode];
    const ease = 1 - Math.exp(-dt * 4);
    for (const k of ['spin', 'rate', 'glow', 'breathe']) cur[k] += (target[k] - cur[k]) * ease;
    const slow = reduced ? 0.25 : 1;
    const focused = focus && branches.find(b => b.id === focus);
    const camEase = 1 - Math.exp(-dt * 3);
    cur.zoom += ((focused ? ZOOM : 1) - cur.zoom) * camEase;
    if (focused) {
      // Ruota finché il ramo aperto guarda verso chi usa il telefono.
      const { x, y, z } = focused.hub;
      angle += wrap(Math.atan2(-x, z) - angle) * camEase;
      tilt += (Math.atan2(y, Math.hypot(x, z)) - tilt) * camEase;
    } else {
      angle += cur.spin * dt * slow;
      tilt += (0.35 - tilt) * (1 - Math.exp(-dt * 2));
    }
    spinRing += dt * (mode === 'thinking' ? 5 : 0.8) * slow;
    if (wave < maxRad + 0.6) wave += dt * 0.55 * (reduced ? 4 : 1);
    const time = now / 1000;

    // Respiro del nodo centrale: lento in attesa, ritmo di voce quando parla, onde quando ascolta.
    let pulse;
    if (mode === 'speaking') pulse = Math.sin(time * 9) * 0.5 + Math.sin(time * 14.3) * 0.3 + Math.sin(time * 5.1) * 0.2;
    else if (mode === 'listening') pulse = Math.sin(time * 3.2);
    else pulse = Math.sin(time * 1.2);
    const breath = 1 + cur.breathe * pulse * slow;

    // Impulsi spontanei dal centro verso i rami (più fitti quando pensa).
    spawn += cur.rate * dt * slow;
    while (spawn >= 1) {
      spawn -= 1;
      if (branches.length) fireBranch(branches[Math.floor(Math.random() * branches.length)], null, mode === 'thinking' ? 1.6 : 0.9);
    }

    const compact = hgt < 170;
    // Più gusci = sfera più grande: la camera si allontana piano per farla stare tutta.
    fit += (1 / Math.max(1, ...branches.map(b => b.hub.rad * 1.08), 1) - fit) * camEase;
    const R = Math.min(w, hgt) * 0.36 * cur.zoom * fit;
    const cx = w / 2, cy = hgt / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle), ct = Math.cos(tilt), st = Math.sin(tilt);
    const project = (p) => {
      const x = p.x * ca + p.z * sa, z0 = -p.x * sa + p.z * ca;
      const y = p.y * ct - z0 * st, z = p.y * st + z0 * ct;
      const persp = 1 / (2.1 - z * 0.55);
      p.sx = cx + x * R * persp * 2; p.sy = cy + y * R * persp * 2;
      p.d = Math.max(0, Math.min(1, (z + 1) / 2)); // 0 dietro, 1 davanti
    };
    project(center);
    center.heat = Math.max(0, center.heat - dt * 1.5);
    for (const b of branches) {
      for (const p of b.spoke) project(p);
      b.hub.heat = Math.max(0, b.hub.heat - dt * 0.35);
      b.fade += ((!focused || focused === b ? 1 : 0.12) - b.fade) * ease; // i nodi nuovi compaiono piano
      for (const l of b.leaves) { project(l); for (const p of l.path) project(p); l.heat = Math.max(0, l.heat - dt * 0.3); }
    }

    ctx.clearRect(0, 0, w, hgt);

    // Alone attorno a Jarvis (solo vicino al nucleo, del colore dell'umore)
    const core = tintAt(0).map(Math.round).join(',');
    const halo = ctx.createRadialGradient(center.sx, center.sy, 0, center.sx, center.sy, Math.min(w, hgt) * 0.3);
    halo.addColorStop(0, `rgba(${core},${0.12 * cur.glow})`);
    halo.addColorStop(1, `rgba(${core},0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, hgt);

    // Gusci dei livelli: cerchi sottili tratteggiati, interno, medio ed esterno.
    if (!compact) {
      ctx.setLineDash([2, 6]); ctx.lineWidth = 1;
      for (let k = 0; k < rings; k++) {
        const r = SHELL_MIN + ringLevel(k) * LEVEL_STEP;
        ctx.strokeStyle = `rgba(${tintAt(r).map(Math.round).join(',')},${0.1 * cur.glow})`;
        ctx.beginPath(); ctx.arc(center.sx, center.sy, R * r * 0.95, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // L'onda di un cambio d'umore che si allarga dal centro.
    if (wave < maxRad + 0.3) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${tintTo.map(Math.round).join(',')},${(1 - wave / (maxRad + 0.3)) * 0.35 * cur.glow})`;
      ctx.beginPath(); ctx.arc(center.sx, center.sy, R * wave * 0.95, 0, Math.PI * 2); ctx.stroke();
    }

    // heat schiarisce il colore verso il bianco; rgb = colore della zona.
    const color = (heat, alpha, rgb = BASE) => {
      const c = rgb.map(v => Math.round(v + (255 - v) * heat * 0.55));
      return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
    };
    const trace = (pts, alpha, width) => {
      ctx.lineWidth = width; ctx.strokeStyle = alpha;
      ctx.beginPath(); ctx.moveTo(pts[0].sx, pts[0].sy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
      ctx.stroke();
    };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // Piste: prima quelle dietro, poi quelle davanti, così la sfera si legge in profondità.
    const order = [...branches].sort((a, b) => a.hub.d - b.hub.d);
    for (const b of order) {
      const hot = b.hub.heat;
      b.rgb = zoneOf(b, tintAt(b.hub.rad));
      for (const l of b.leaves) {
        const lh = Math.max(l.heat, hot * 0.35);
        const depth = (b.hub.d + l.d) / 2;
        trace(l.path, color(lh, ((0.12 + depth * 0.4) * cur.glow + lh * 0.5) * b.fade, b.rgb), 1 + lh * 1.3 + depth * 0.6);
      }
      // La pista dal centro cambia colore man mano che l'onda la percorre.
      const inner = tintAt(b.hub.rad * 0.4);
      trace(b.spoke.slice(0, 2), color(hot, ((0.15 + b.hub.d * 0.4) * cur.glow + hot * 0.5) * b.fade, inner), 1.3 + hot * 1.5 + b.hub.d * 0.7);
      trace(b.spoke.slice(1), color(hot, ((0.15 + b.hub.d * 0.4) * cur.glow + hot * 0.5) * b.fade, b.rgb), 1.3 + hot * 1.5 + b.hub.d * 0.7);
    }

    // Impulsi che corrono lungo le piste
    const spark = (x, y, depth, rgb) => {
      ctx.fillStyle = color(0.75, 0.55 + depth * 0.45, rgb);
      ctx.beginPath(); ctx.arc(x, y, 1.6 + depth * 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color(0, 0.14 + depth * 0.14, rgb);
      ctx.beginPath(); ctx.arc(x, y, 5 + depth * 4, 0, Math.PI * 2); ctx.fill();
    };
    const nextTrails = [];
    for (const tr of trails) {
      tr.t += tr.speed * dt * slow;
      if (tr.t >= 1) { tr.then?.(); continue; }
      const segs = tr.path.length - 1, pos = tr.t * segs, i = Math.min(segs - 1, Math.floor(pos)), f = pos - i;
      const a = tr.path[i], b = tr.path[i + 1];
      spark(a.sx + (b.sx - a.sx) * f, a.sy + (b.sy - a.sy) * f, a.d + (b.d - a.d) * f, tr.col || BASE);
      nextTrails.push(tr);
    }
    trails = nextTrails;

    // Nodi: foglie (cerchietti come nel disegno) e nodi dei rami, dal fondo verso il davanti.
    ctx.textBaseline = 'middle';
    const ring = (p, r, heat, alpha, fill, rgb = BASE) => {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color(heat, alpha, rgb);
      const dark = rgb.map(v => Math.round(v * (0.12 + heat * 0.45)));
      ctx.fillStyle = `rgba(${dark.join(',')},${Math.min(1, alpha + 0.2)})`;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); if (fill) ctx.fill(); ctx.stroke();
      if (heat > 0.2) {
        ctx.fillStyle = color(0, heat * 0.16 * alpha, rgb);
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 2.8, 0, Math.PI * 2); ctx.fill();
      }
    };
    const scale = Math.min(1.5, Math.sqrt(cur.zoom));
    for (const b of order) {
      for (const l of b.leaves) {
        ring(l, (2.6 + l.d * 2 + l.heat * 1.8) * scale, l.heat, ((0.35 + l.d * 0.6) * cur.glow + l.heat * 0.4) * b.fade, true, b.rgb);
        if (!compact && b.fade > 0.5 && (focused === b ? cur.zoom > 1.6 : (l.heat > 0.3 && l.d > 0.4))) {
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
      const h = b.hub, r = (4 + h.d * 2.8 + h.heat * 2) * scale * (focused === b ? 1.3 : 1);
      ring(h, r, h.heat, ((0.5 + h.d * 0.5) * cur.glow + h.heat * 0.4) * b.fade, true, b.rgb);
      ctx.fillStyle = color(h.heat, (0.6 + h.heat * 0.4) * b.fade, b.rgb);
      ctx.beginPath(); ctx.arc(h.sx, h.sy, r * 0.4, 0, Math.PI * 2); ctx.fill();
      if (!compact && b.fade > 0.3 && (focused === b || (!focused && (h.d > (branches.length > 12 ? 0.7 : 0.35) || h.heat > 0.2)))) {
        ctx.font = focused === b ? '600 14px system-ui, sans-serif' : '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(190,255,180,${focused === b ? 0.95 : Math.min(1, (0.3 + h.d * 0.5 + h.heat * 0.5) * cur.glow) * b.fade})`;
        ctx.fillText(clip(b.label.toUpperCase(), 22), h.sx, h.sy - r - 9);
      }
    }

    // Il nodo Jarvis al centro: anello doppio con il nucleo luminoso, come nel disegno.
    const fadeCenter = focused ? Math.max(0.25, 1 - (cur.zoom - 1) / (ZOOM - 1) * 0.75) : 1;
    const cr = Math.min(w, hgt) * (compact ? 0.07 : 0.045) * breath * Math.min(1.3, scale);
    const heat = center.heat;
    const g = ctx.createRadialGradient(center.sx, center.sy, 0, center.sx, center.sy, cr * 3.2);
    g.addColorStop(0, `rgba(${core},${(0.35 + heat * 0.2) * cur.glow * fadeCenter})`);
    g.addColorStop(1, `rgba(${core},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(center.sx, center.sy, cr * 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(8,30,8,${0.9 * fadeCenter})`;
    ctx.strokeStyle = color(0.4 + heat * 0.3, (0.7 + heat * 0.3) * cur.glow * fadeCenter, tintAt(0));
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(center.sx, center.sy, cr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Arco che gira attorno: lento in attesa, veloce quando pensa.
    ctx.strokeStyle = color(0.55, 0.8 * cur.glow * fadeCenter, tintAt(0));
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(center.sx, center.sy, cr * 1.35, spinRing, spinRing + Math.PI * 0.7); ctx.stroke();
    ctx.beginPath(); ctx.arc(center.sx, center.sy, cr * 1.35, spinRing + Math.PI, spinRing + Math.PI * 1.35); ctx.stroke();
    ctx.fillStyle = `rgba(225,255,215,${(0.75 + heat * 0.25) * fadeCenter})`;
    ctx.beginPath(); ctx.arc(center.sx, center.sy, cr * 0.45, 0, Math.PI * 2); ctx.fill();
    if (!compact && !focused) {
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(190,255,180,${0.75 * cur.glow})`;
      ctx.fillText('JARVIS', center.sx, center.sy + cr * 1.35 + 12);
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
    let best = null, bestD = 30 * 30;
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
    if (next !== mode && next === 'thinking') { center.heat = 1; for (const b of branches.slice(0, 6)) fireBranch(b, null, 1.6); }
    mode = next;
    el.dataset.state = next;
    setLabel();
  }
  setState('idle');

  return {
    el, setState,
    /** Sfumatura dell'umore: colore [r,g,b] e intensità 0..1 (resta sempre una velatura, il verde domina). */
    /** rgb = colore complessivo dell'umore, amount 0..1, list = [{rgb, w}] emozioni ordinate per peso. */
    setTint(rgb, amount, list = []) {
      const next = rgb.map(v => Math.round(v));
      if (next.some((v, i) => Math.abs(v - tintTo[i]) > 6)) {
        tintFrom = mix(tintFrom, tintTo, Math.max(0, Math.min(1, wave / (maxRad + 0.3)))); // da dove era arrivata l'onda
        tintTo = next; wave = 0;
      }
      tintA = Math.max(0, Math.min(1, amount));
      parts = list.filter(p => p && p.rgb && p.w > 0);
    },
    /** I rami da disegnare: [{ id, label, kind, children: [{ id, label }] }] (da /api/graph). Quelli vuoti non si vedono. */
    setGraph(list) {
      const old = new Map(branches.map(b => [b.id, b]));
      const shown = (Array.isArray(list) ? list : []).filter(b => (b.children || []).length || b.kind !== 'core');
      branches = layoutBranches(shown, old);
      rings = Math.max(3, ...branches.map(b => (Number.isFinite(b.ring) ? b.ring : 1) + 1));
      maxRad = Math.max(1, ...branches.map(b => b.hub.rad));
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
