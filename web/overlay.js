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
    net = layout2d(g.branches || [], { sketch: true });
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

  const W = canvas.width, C = W / 2, R = W * 0.45;
  const P = (p) => ({ x: C + p.x * R, y: C + p.y * R });
  ctx.clearRect(0, 0, W, W);
  for (const [id, h] of heat) { const v = h - dt * 0.04; if (v <= 0) heat.delete(id); else heat.set(id, v); }

  const glow = ctx.createRadialGradient(C, C, 2, C, C, R);
  glow.addColorStop(0, rgba(GREEN, 0.10 + mode.pulse * 0.10)); glow.addColorStop(1, rgba(GREEN, 0));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.fill();

  const beat = 1 + Math.sin(t * (3 + mode.speed * 2)) * 0.05 * mode.pulse;
  const cr = W * 0.14 * beat;
  const g = mode.glow;

  // Rotazione a scatti cadenzati (come se stesse pensando)
  const steppedAngle = (timeVal, freq, stepSize, dir = 1) => {
    const p = timeVal * freq;
    const idx = Math.floor(p);
    const frac = p - idx;
    const move = frac < 0.35 ? (frac / 0.35) * (frac / 0.35) * (3 - 2 * (frac / 0.35)) : 1;
    return (idx + move) * stepSize * dir;
  };

  const hudFreq = modeName === 'THINKING' ? 2.6 : modeName === 'LISTENING' ? 1.5 : modeName === 'SPEAKING' ? 1.9 : 0.7;
  const cells = net.length ? net.slice(0, 9) : [
    { id: 'c1', auto: false, leaves: [{}, {}] },
    { id: 'c2', auto: true, leaves: [{}, {}, {}] },
    { id: 'c3', auto: false, leaves: [{}] },
    { id: 'c4', auto: false, leaves: [{}, {}] },
  ];
  const ringsCount = 3;
  for (let i = 0; i < cells.length; i++) {
    const b = cells[i];
    const hb = heat.get(b.id) || 0;
    const ringIdx = i % ringsCount;
    const rIn = cr * (1.28 + ringIdx * 0.56);
    const rOut = rIn + cr * 0.4;
    const rMid = (rIn + rOut) * 0.5;
    const group = cells.filter((_, k) => k % ringsCount === ringIdx);
    const slotIdx = group.indexOf(b);
    const slotSpan = (Math.PI * 2) / Math.max(1, group.length);
    const pad = 0.14;
    const arcLen = Math.max(0.45, slotSpan - pad * 2);
    const rot = steppedAngle(t + ringIdx * 0.35, hudFreq * (1 + ringIdx * 0.2), 0.34, ringIdx % 2 === 0 ? 1 : -1);
    const a0 = slotIdx * slotSpan + pad + rot;
    const a1 = a0 + arcLen;
    const bCol = b.auto ? autoCol : GREEN;
    const alpha = (0.48 + hb * 0.45 + (modeName === 'THINKING' ? 0.2 : 0)) * g;

    // Cella curva attorno al nucleo
    ctx.beginPath();
    ctx.arc(C, C, rOut, a0, a1);
    ctx.arc(C, C, rIn, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = rgba(bCol, Math.min(0.26, alpha * 0.28), hb);
    ctx.fill();
    ctx.strokeStyle = rgba(bCol, Math.min(0.96, alpha), hb);
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Caselle nodi figli incastonate dentro la cella curva
    const kidsCount = Math.min(4, Math.max(1, (b.leaves || []).length));
    const stepK = arcLen / (kidsCount + 1);
    for (let k = 0; k < kidsCount; k++) {
      const ka = a0 + stepK * (k + 1);
      const kx = C + Math.cos(ka) * rMid;
      const ky = C + Math.sin(ka) * rMid;
      ctx.save();
      ctx.translate(kx, ky);
      ctx.rotate(ka + Math.PI / 2);
      ctx.fillStyle = rgba(bCol, Math.min(0.85, 0.4 + hb * 0.5), hb);
      ctx.strokeStyle = rgba(LEAF, Math.min(0.98, 0.7 + g * 0.25), hb);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.rect(-4.5, -3, 9, 6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Nucleo centrale JARVIS
  ctx.fillStyle = 'rgba(5, 14, 6, 0.97)';
  ctx.beginPath(); ctx.arc(C, C, cr, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = rgba(GREEN, 0.96 * g); ctx.lineWidth = 2.6;
  ctx.beginPath(); ctx.arc(C, C, cr, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `700 ${Math.max(8, Math.round(cr * 0.42))}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = rgba([220, 255, 210], 0.94 * g);
  ctx.fillText('JARVIS', C, C);
  ctx.textBaseline = 'alphabetic';
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
