// Finestra di Jarvis sopra le altre app: una piccola sfera animata che mostra se ascolta, pensa o parla,
// la frase che sta dicendo, e le grafiche che vuole mostrare. L'app Android la comanda con window.overlay.

import { renderVisual, VISUAL_CSS } from './visual.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: VISUAL_CSS }));

const canvas = document.getElementById('orb');
const ctx = canvas.getContext('2d');
const box = document.getElementById('orbbox');
const say = document.getElementById('say');
const card = document.getElementById('card');

const MODES = {
  WAITING: { speed: 0.4, pulse: 0.15, label: '' },
  LISTENING: { speed: 1, pulse: 0.6, label: 'Ti ascolto…' },
  THINKING: { speed: 3, pulse: 0.35, label: 'Sto pensando…' },
  SPEAKING: { speed: 1.6, pulse: 0.9, label: '' },
  OFF: { speed: 0.2, pulse: 0.05, label: '' },
};
let mode = MODES.WAITING;

// Nodi su una piccola sfera che ruota, collegati ai vicini; impulsi che partono dal centro.
const nodes = Array.from({ length: 34 }, (_, i) => {
  const y = 1 - (i / 33) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
  return { x: Math.cos(th) * r, y, z: Math.sin(th) * r };
});
let angle = 0, t = 0, last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  t += dt; angle += dt * mode.speed;
  const W = canvas.width, C = W / 2, R = W * 0.36;
  ctx.clearRect(0, 0, W, W);
  const beat = 1 + Math.sin(t * (4 + mode.speed * 2)) * 0.06 * mode.pulse;
  const pts = nodes.map(n => {
    const x = n.x * Math.cos(angle) - n.z * Math.sin(angle), z = n.x * Math.sin(angle) + n.z * Math.cos(angle);
    return { x: C + x * R * beat, y: C + n.y * R * beat, z };
  });
  const glow = ctx.createRadialGradient(C, C, 2, C, C, R * 1.4);
  glow.addColorStop(0, `rgba(57,255,20,${0.35 + mode.pulse * 0.3})`); glow.addColorStop(1, 'rgba(57,255,20,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(C, C, R * 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 1.2;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const a = nodes[i], b = nodes[j];
    const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
    if (d > 0.28) continue;
    const depth = (pts[i].z + pts[j].z) / 2;
    ctx.strokeStyle = `rgba(57,255,20,${0.15 + (depth + 1) * 0.25})`;
    ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
  }
  for (const p of pts) { ctx.fillStyle = `rgba(160,255,140,${0.4 + (p.z + 1) * 0.3})`; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2 + p.z, 0, Math.PI * 2); ctx.fill(); }
  // Onda che si allarga quando ascolta o parla.
  const wave = (t * (0.6 + mode.speed * 0.4)) % 1;
  ctx.strokeStyle = `rgba(34,211,238,${(1 - wave) * mode.pulse})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(C, C, R * (0.6 + wave * 0.8), 0, Math.PI * 2); ctx.stroke();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let cardTimer = 0;
window.overlay = {
  state(s) {
    mode = MODES[s] || MODES.WAITING;
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
