// Finestra di Jarvis sopra le altre app: la rete di Jarvis appiattita in 2D con anello centrale,
// raggi dritti, archi orbitali per i sotto-nodi e nodi autonomi (verde se calmo, viola se agitato).

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

const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
let net = [], fetchedAt = 0, loading = false;
let moodTension = 0.15, agitation = 0;
const heat = new Map();
let seenTouch = '';

async function loadGraph(force = false) {
  if (!token || loading || (!force && Date.now() - fetchedAt < 30000)) return;
  loading = true;
  try {
    const res = await fetch('/api/graph', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' });
    if (!res.ok) return;
    const g = await res.json();
    net = layout2d(g.branches || []);
    if (g.mood && Number.isFinite(g.mood.tensione)) moodTension = g.mood.tensione;
    fetchedAt = Date.now();
    const at = g.last?.at || '';
    if (at && at !== seenTouch) {
      seenTouch = at;
      for (const id of [...(g.last.touched || []), ...(g.last.leaves || [])]) heat.set(id, 1);
      for (const b of net) if (heat.get(b.id)) fire(b, 3);
    }
  } catch { /* senza rete resta la rete già disegnata */ } finally { loading = false; }
}

let sparks = [];
function fire(b, n = 1) {
  for (let i = 0; i < n; i++) {
     const hot = b.leaves.filter(l => heat.get(l.id));
     const pool = hot.length ? hot : b.leaves;
     const leaf = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
     sparks.push({ path: b.spoke, t: -i * 0.35, speed: 1.1, auto: b.auto, next: leaf && { path: leaf.path, t: 0, speed: 1.9, auto: leaf.auto || b.auto } });
  }
}

const GREEN = [57, 255, 20], LEAF = [120, 235, 110], CYAN = [34, 211, 238];
// Nodi dei percorsi autonomi (flow): verde smeraldo quando è calmo, viola acceso quando è agitato.
const AUTO_CALM = [0, 255, 155], AUTO_AGITATED = [190, 65, 255];
const mix = (a, b, k) => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * Math.max(0, Math.min(1, k))));
const rgba = (c, a, h = 0) => `rgba(${c.map(v => Math.round(v + (255 - v) * h * 0.5)).join(',')},${Math.max(0, Math.min(1, a))})`;
let t = 0, last = performance.now(), nextFire = 0;

function frame(now) {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
  t += dt;
  const targetAgit = Math.min(1, Math.max(0, (moodTension - 0.18) * 1.6) + (modeName === 'THINKING' ? 0.65 : modeName === 'LISTENING' ? 0.25 : 0));
  agitation += (targetAgit - agitation) * Math.min(1, dt * 3);
  const autoCol = mix(AUTO_CALM, AUTO_AGITATED, agitation);

  const W = canvas.width, C = W / 2, R = W * 0.46;
  const P = (p) => ({ x: C + p.x * R, y: C + p.y * R });
  ctx.clearRect(0, 0, W, W);
  for (const [id, h] of heat) { const v = h - dt * 0.04; if (v <= 0) heat.delete(id); else heat.set(id, v); }

  const glow = ctx.createRadialGradient(C, C, 2, C, C, R);
  glow.addColorStop(0, rgba(GREEN, 0.14 + mode.pulse * 0.12)); glow.addColorStop(1, rgba(GREEN, 0));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.fill();
  const wave = (t * (0.35 + mode.speed * 0.3)) % 1;
  ctx.strokeStyle = rgba(CYAN, (1 - wave) * mode.pulse * 0.55); ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(C, C, R * wave, 0, Math.PI * 2); ctx.stroke();

  const line = (path, col, a, w, h = 0) => {
    ctx.strokeStyle = rgba(col, a, h); ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); path.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke();
  };
  const dot = (p, r, col, a, h = 0, isAuto = false) => {
    const q = P(p);
    if (h > 0.15 || isAuto) {
      ctx.fillStyle = rgba(col, (isAuto ? 0.22 : 0) + h * 0.16);
      ctx.beginPath(); ctx.arc(q.x, q.y, r * (isAuto ? 2.4 : 2.1), 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = `rgba(${col.map(v => Math.round(v * (0.14 + h * 0.4))).join(',')},${Math.min(1, a + 0.25)})`;
    ctx.strokeStyle = rgba(col, a, h); ctx.lineWidth = isAuto ? 2.1 : 1.7;
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };

  const g = mode.glow;
  for (const b of net) {
    const hb = heat.get(b.id) || 0;
    const bCol = b.auto ? autoCol : GREEN;
    line(b.spoke, bCol, (0.38 + hb * 0.55) * g, 1.8 + hb * 1.5, hb);
    for (const l of b.leaves) {
      const hl = Math.max(heat.get(l.id) || 0, hb * 0.4);
      const lCol = (l.auto || b.auto) ? autoCol : LEAF;
      line(l.path, lCol, (0.3 + hl * 0.6) * g, 1.3 + hl * 1.2, hl);
    }
  }

  const keep = [];
  for (const s of sparks) {
    s.t += dt * s.speed * (0.6 + mode.speed * 0.5);
    if (s.t >= 1) { if (s.next) keep.push(s.next); continue; }
    if (s.t >= 0) {
      const q = P(pointAt(s.path, s.t));
      const sc = s.auto ? autoCol : GREEN;
      ctx.fillStyle = rgba(sc, 0.22); ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(sc, 0.95, 0.8); ctx.beginPath(); ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2); ctx.fill();
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

  for (const b of net) {
    const hb = heat.get(b.id) || 0;
    const bCol = b.auto ? autoCol : GREEN;
    for (const l of b.leaves) {
      const hl = Math.max(heat.get(l.id) || 0, hb * 0.3);
      const isAuto = !!(l.auto || b.auto);
      dot(l, (l.sub ? 2.6 : 3.6) + hl * 1.5, isAuto ? autoCol : LEAF, (0.55 + hl * 0.45) * g, hl, isAuto);
    }
    const r = 5.6 + hb * 2.2;
    dot(b.hub, r, bCol, (0.78 + hb * 0.22) * g, hb, b.auto);
    ctx.fillStyle = rgba(bCol, 0.9 * g, hb); ctx.beginPath(); const q = P(b.hub); ctx.arc(q.x, q.y, r * 0.4, 0, Math.PI * 2); ctx.fill();
  }

  // Anello centrale Jarvis: nucleo cavo scuro con doppio anello marcato, da cui partono i raggi.
  const beat = 1 + Math.sin(t * (3 + mode.speed * 2)) * 0.08 * mode.pulse;
  const cr = 14 * beat;
  ctx.fillStyle = 'rgba(6, 18, 8, 0.94)';
  ctx.beginPath(); ctx.arc(C, C, cr, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = rgba(GREEN, 0.95 * g); ctx.lineWidth = 2.6;
  ctx.beginPath(); ctx.arc(C, C, cr, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = rgba(GREEN, 0.45 * g); ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(C, C, cr * 1.25, 0, Math.PI * 2); ctx.stroke();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
loadGraph(true);

let cardTimer = 0;
window.overlay = {
  state(s) {
    mode = MODES[s] || MODES.WAITING;
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
