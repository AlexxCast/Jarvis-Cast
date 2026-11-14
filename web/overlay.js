// Finestra di Jarvis sopra le altre app: la rete di Jarvis appiattita in 2D che mostra se ascolta, pensa o parla,
// la frase che sta dicendo, e le grafiche che vuole mostrare. L'app Android la comanda con window.overlay.

import { renderVisual, VISUAL_CSS } from './visual.js';
import { layout2d, pointAt } from './net2d.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: VISUAL_CSS }));

const canvas = document.getElementById('orb');
const ctx = canvas.getContext('2d');
const box = document.getElementById('orbbox');
const say = document.getElementById('say');
const card = document.getElementById('card');

const MODES = {
  WAITING: { speed: 0.5, pulse: 0.2, glow: 0.7, label: '' },
  LISTENING: { speed: 1, pulse: 0.7, glow: 1, label: 'Ti ascolto…' },
  THINKING: { speed: 2.6, pulse: 0.45, glow: 1, label: 'Sto pensando…' },
  SPEAKING: { speed: 1.5, pulse: 0.9, glow: 1, label: '' },
  OFF: { speed: 0.2, pulse: 0.05, glow: 0.4, label: '' },
};
let mode = MODES.WAITING, modeName = 'WAITING';

// La vera rete di Jarvis (rami, foglie, collegamenti), presa dal server con il token passato
// dall'app nel frammento dell'indirizzo: il frammento non viene mai inviato in rete.
const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
let net = [], fetchedAt = 0, loading = false;
const heat = new Map(); // id di rami e foglie toccati nell'ultima risposta -> intensità 0..1
let seenTouch = '';

async function loadGraph(force = false) {
  if (!token || loading || (!force && Date.now() - fetchedAt < 30000)) return;
  loading = true;
  try {
    const res = await fetch('/api/graph', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' });
    if (!res.ok) return;
    const g = await res.json();
    net = layout2d(g.branches || []);
    fetchedAt = Date.now();
    const at = g.last?.at || '';
    if (at && at !== seenTouch) {
      seenTouch = at;
      for (const id of [...(g.last.touched || []), ...(g.last.leaves || [])]) heat.set(id, 1);
      for (const b of net) if (heat.get(b.id)) fire(b, 3);
    }
  } catch { /* senza rete resta la rete già disegnata */ } finally { loading = false; }
}

// Impulsi: partono da Jarvis, corrono lungo la pista del ramo e poi verso una foglia.
let sparks = [];
function fire(b, n = 1) {
  for (let i = 0; i < n; i++) {
    const hot = b.leaves.filter(l => heat.get(l.id));
    const pool = hot.length ? hot : b.leaves;
    const leaf = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    sparks.push({ path: b.spoke, t: -i * 0.35, speed: 1.1, next: leaf && { path: leaf.path, t: 0, speed: 2.2 } });
  }
}

const GREEN = [57, 255, 20], LEAF = [120, 235, 110], CYAN = [34, 211, 238];
const rgba = (c, a, h = 0) => `rgba(${c.map(v => Math.round(v + (255 - v) * h * 0.5)).join(',')},${Math.max(0, Math.min(1, a))})`;
let t = 0, last = performance.now(), nextFire = 0;

function frame(now) {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
  t += dt;
  const W = canvas.width, C = W / 2, R = W * 0.46;
  const P = (p) => ({ x: C + p.x * R, y: C + p.y * R });
  ctx.clearRect(0, 0, W, W);
  for (const [id, h] of heat) { const v = h - dt * 0.04; if (v <= 0) heat.delete(id); else heat.set(id, v); }

  // Alone e onda dal centro quando ascolta o parla.
  const glow = ctx.createRadialGradient(C, C, 2, C, C, R);
  glow.addColorStop(0, rgba(GREEN, 0.16 + mode.pulse * 0.12)); glow.addColorStop(1, rgba(GREEN, 0));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.fill();
  const wave = (t * (0.35 + mode.speed * 0.3)) % 1;
  ctx.strokeStyle = rgba(CYAN, (1 - wave) * mode.pulse * 0.6); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(C, C, R * wave, 0, Math.PI * 2); ctx.stroke();

  const line = (path, col, a, w, h = 0) => {
    ctx.strokeStyle = rgba(col, a, h); ctx.lineWidth = w; ctx.lineJoin = 'round';
    ctx.beginPath(); path.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke();
  };
  const dot = (p, r, col, a, h = 0, fill = true) => {
    const q = P(p);
    if (h > 0.15) { ctx.fillStyle = rgba(col, h * 0.14); ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = `rgba(${col.map(v => Math.round(v * (0.15 + h * 0.4))).join(',')},${Math.min(1, a + 0.2)})`;
    ctx.strokeStyle = rgba(col, a, h); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); if (fill) ctx.fill(); ctx.stroke();
  };

  const g = mode.glow;
  // Piste: dal centro ai rami, dai rami alle foglie, dalle foglie alle sotto-foglie.
  for (const b of net) {
    const hb = heat.get(b.id) || 0;
    line(b.spoke, GREEN, (0.3 + hb * 0.6) * g, 1.6 + hb * 1.6, hb);
    for (const l of b.leaves) { const hl = Math.max(heat.get(l.id) || 0, hb * 0.4); line(l.path, LEAF, (0.22 + hl * 0.6) * g, 1 + hl * 1.2, hl); }
  }
  // Impulsi.
  const keep = [];
  for (const s of sparks) {
    s.t += dt * s.speed * (0.6 + mode.speed * 0.5);
    if (s.t >= 1) { if (s.next) keep.push(s.next); continue; }
    if (s.t >= 0) {
      const q = P(pointAt(s.path, s.t));
      ctx.fillStyle = rgba(GREEN, 0.2); ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(GREEN, 0.95, 0.8); ctx.beginPath(); ctx.arc(q.x, q.y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    keep.push(s);
  }
  sparks = keep.slice(-60);
  if (net.length && t > nextFire) {
    const hot = net.filter(b => heat.get(b.id));
    const pool = hot.length && Math.random() < 0.7 ? hot : net;
    fire(pool[Math.floor(Math.random() * pool.length)]);
    nextFire = t + 1.4 / (0.4 + mode.speed);
  }
  // Nodi: foglie, poi rami.
  for (const b of net) {
    const hb = heat.get(b.id) || 0;
    for (const l of b.leaves) { const hl = Math.max(heat.get(l.id) || 0, hb * 0.3); dot(l, (l.sub ? 2.4 : 3.2) + hl * 1.5, LEAF, (0.45 + hl * 0.5) * g, hl); }
    const r = 6 + hb * 2.5;
    dot(b.hub, r, GREEN, (0.7 + hb * 0.3) * g, hb);
    ctx.fillStyle = rgba(GREEN, 0.9 * g, hb); ctx.beginPath(); const q = P(b.hub); ctx.arc(q.x, q.y, r * 0.42, 0, Math.PI * 2); ctx.fill();
  }
  // Il nodo Jarvis al centro: anello doppio con nucleo che pulsa.
  const beat = 1 + Math.sin(t * (3 + mode.speed * 2)) * 0.1 * mode.pulse;
  const core = ctx.createRadialGradient(C, C, 0, C, C, 15 * beat);
  core.addColorStop(0, 'rgba(230,255,220,1)'); core.addColorStop(0.45, rgba(GREEN, 0.95)); core.addColorStop(1, rgba(GREEN, 0));
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(C, C, 15 * beat, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = rgba(GREEN, 0.9 * g); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(C, C, 11 * beat, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = rgba(GREEN, 0.45 * g); ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(C, C, 16 * beat, 0, Math.PI * 2); ctx.stroke();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
loadGraph(true);

let cardTimer = 0;
window.overlay = {
  state(s) {
    mode = MODES[s] || MODES.WAITING;
    // Quando inizia ad ascoltare rinfresca la rete; quando parla prende i rami appena toccati.
    if (s === 'LISTENING' && modeName !== 'LISTENING') loadGraph();
    if (s === 'SPEAKING' && modeName !== 'SPEAKING') loadGraph(true);
    modeName = s;
    const active = s === 'LISTENING' || s === 'THINKING' || s === 'SPEAKING';
    box.classList.toggle('hide', !active && !card.firstChild);
    if (mode.label) say.textContent = mode.label;
  },
  caption(text) { say.textContent = String(text || '').slice(0, 220); },
  show(v, seconds = 12) {
    const node = renderVisual(typeof v === 'string' ? JSON.parse(v) : v);
    if (!node) return false;
    clearTimeout(cardTimer);
    card.classList.remove('gone');
    card.replaceChildren(node);
    box.classList.remove('hide');
    cardTimer = setTimeout(() => { card.classList.add('gone'); setTimeout(() => card.replaceChildren(), 400); }, Math.max(4, Math.min(60, seconds)) * 1000);
    return true;
  },
  clear() { clearTimeout(cardTimer); card.replaceChildren(); },
};
