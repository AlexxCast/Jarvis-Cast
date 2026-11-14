// Grafiche di Jarvis: grafici, elenchi, numeri grandi, disegni SVG e immagini, con animazioni d'entrata.
// Le usa sia l'app sia la finestra che compare sopra le altre app. Niente HTML del modello: costruiamo noi
// ogni elemento, e i disegni SVG passano da <img>, dove gli script non girano.

const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#39ff14', '#22d3ee', '#facc15', '#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#60a5fa'];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) k === 'style' ? (e.style.cssText = v) : e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}
const fmt = (v, unit) => `${Number(v).toLocaleString('it-IT', { maximumFractionDigits: 1 })}${unit ? ' ' + unit : ''}`;

function bars(v) {
  const max = Math.max(...v.items.map(i => Math.abs(i.value)), 1);
  return el('div', { class: 'v-bars' }, v.items.map((it, k) => el('div', { class: 'v-bar', style: `--d:${k * 90}ms` },
    el('span', { class: 'v-label' }, it.label),
    el('span', { class: 'v-track' }, el('span', { class: 'v-fill', style: `--w:${Math.max(2, Math.abs(it.value) / max * 100)}%;--c:${PALETTE[k % PALETTE.length]}` })),
    el('span', { class: 'v-val' }, fmt(it.value, v.unit)))));
}

function line(v) {
  const W = 300, H = 140, P = 18;
  const vals = v.items.map(i => i.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pts = vals.map((y, i) => [P + (vals.length < 2 ? 0 : i * (W - 2 * P) / (vals.length - 1)), H - P - (y - lo) / span * (H - 2 * P)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'v-line', role: 'img', 'aria-label': v.title || 'grafico' },
    svg('path', { d: d + ` L${pts.at(-1)[0]} ${H - P} L${pts[0][0]} ${H - P} Z`, class: 'v-area' }),
    svg('path', { d, class: 'v-stroke', pathLength: '1' }));
  pts.forEach((p, i) => s.append(svg('circle', { cx: p[0], cy: p[1], r: 3.5, class: 'v-dot', style: `--d:${400 + i * 80}ms` })));
  const labels = el('div', { class: 'v-axis' }, v.items.map(i => el('span', {}, i.label)));
  return el('div', {}, s, labels, el('div', { class: 'v-range muted' }, `min ${fmt(lo, v.unit)} · max ${fmt(hi, v.unit)}`));
}

function pie(v) {
  const total = v.items.reduce((a, i) => a + Math.max(0, i.value), 0) || 1;
  const R = 15.9155; // circonferenza 100: le percentuali diventano lunghezze
  const s = svg('svg', { viewBox: '0 0 42 42', class: 'v-pie', role: 'img', 'aria-label': v.title || 'grafico a torta' });
  let acc = 0;
  v.items.forEach((it, k) => {
    const pct = Math.max(0, it.value) / total * 100;
    s.append(svg('circle', { cx: 21, cy: 21, r: R, fill: 'none', stroke: PALETTE[k % PALETTE.length], 'stroke-width': 6,
      'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': 25 - acc, class: 'v-slice', style: `--d:${k * 120}ms` }));
    acc += pct;
  });
  const legend = el('div', { class: 'v-legend' }, v.items.map((it, k) => el('span', {}, el('i', { style: `background:${PALETTE[k % PALETTE.length]}` }), `${it.label} ${Math.round(Math.max(0, it.value) / total * 100)}%`)));
  return el('div', { class: 'v-pierow' }, s, legend);
}

function list(v) {
  return el('ol', { class: 'v-list' }, v.items.map((it, k) => el('li', { style: `--d:${k * 110}ms` }, it.label, it.value != null && it.value !== '' ? el('b', {}, ' ' + fmt(it.value, v.unit)) : null)));
}

function bigText(v) {
  return el('div', { class: 'v-text' }, v.text);
}

/** Un disegno SVG fatto da Jarvis: mostrato come immagine, così eventuali script non partono. */
function drawing(v) {
  return el('img', { class: 'v-img', alt: v.title || 'disegno', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(v.svg) });
}

function image(v) {
  return el('img', { class: 'v-img', alt: v.title || 'immagine', src: v.url, referrerpolicy: 'no-referrer' });
}

const KINDS = { bars, line, pie, list, text: bigText, svg: drawing, image };

/** Ritorna l'elemento della grafica, oppure null se i dati non bastano. */
export function renderVisual(v) {
  if (!v || !KINDS[v.kind]) return null;
  if (['bars', 'line', 'pie', 'list'].includes(v.kind) && !(v.items || []).length) return null;
  const body = KINDS[v.kind](v);
  return el('figure', { class: 'visual v-' + v.kind },
    v.title ? el('figcaption', {}, v.title) : null, body,
    v.text && v.kind !== 'text' ? el('p', { class: 'v-note' }, v.text) : null);
}

export const VISUAL_CSS = `
.visual, .visual * { box-sizing: border-box; }
.visual > * { min-width: 0; }
.visual { margin: 0; max-width: 100%; overflow: hidden; background: rgba(8,24,8,.92); border: 1px solid #1f3a1f; border-radius: 16px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
  color: #e5f6e5; animation: v-in .45s cubic-bezier(.2,.9,.3,1.2) both; box-shadow: 0 0 24px rgba(57,255,20,.18); }
.visual figcaption { font-weight: 650; font-size: 1rem; }
.v-note { color: #8fb08f; font-size: .88rem; margin: 0; }
@keyframes v-in { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: none; } }
.v-bars { display: flex; flex-direction: column; gap: 8px; }
.v-bar { display: grid; grid-template-columns: minmax(60px, 32%) 1fr auto; gap: 8px; align-items: center; font-size: .9rem; animation: v-in .4s both; animation-delay: var(--d); }
.v-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-track { height: 12px; background: #152a15; border-radius: 6px; overflow: hidden; }
.v-fill { display: block; height: 100%; width: var(--w); background: var(--c); border-radius: 6px; box-shadow: 0 0 10px var(--c); transform-origin: left; animation: v-grow .9s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--d) + 150ms); }
@keyframes v-grow { from { transform: scaleX(0); } }
.v-val { font-variant-numeric: tabular-nums; color: #8fb08f; }
.v-line { width: 100%; height: auto; }
.v-stroke { fill: none; stroke: #39ff14; stroke-width: 2.5; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: v-draw 1.2s ease-out forwards; filter: drop-shadow(0 0 4px #39ff14); }
.v-area { fill: rgba(57,255,20,.12); animation: v-fade 1.2s ease-out both; }
.v-dot { fill: #22d3ee; opacity: 0; animation: v-fade .3s forwards; animation-delay: var(--d); }
@keyframes v-draw { to { stroke-dashoffset: 0; } }
@keyframes v-fade { from { opacity: 0; } to { opacity: 1; } }
.v-axis { display: flex; justify-content: space-between; gap: 4px; font-size: .72rem; color: #8fb08f; }
.v-axis span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-range { font-size: .78rem; color: #8fb08f; }
.v-pierow { display: flex; align-items: center; gap: 14px; }
.v-pie { width: 120px; height: 120px; flex: none; transform: rotate(-90deg); }
.v-slice { animation: v-fade .5s both; animation-delay: var(--d); }
.v-legend { display: flex; flex-direction: column; gap: 4px; font-size: .85rem; }
.v-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
.v-list { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px; }
.v-list li { animation: v-in .4s both; animation-delay: var(--d); }
.v-list b { color: #39ff14; font-weight: 600; }
.v-text { font-size: 1.6rem; font-weight: 700; line-height: 1.25; text-align: center; background: linear-gradient(90deg, #39ff14, #22d3ee, #39ff14); background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; animation: v-shine 3s linear infinite; }
@keyframes v-shine { to { background-position: -200% 0; } }
.v-img { width: 100%; max-height: 60vh; object-fit: contain; border-radius: 10px; animation: v-fade .6s both; }
`;
