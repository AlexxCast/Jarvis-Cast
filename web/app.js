// Web app di Jarvis: nessuna build, solo moduli ES. Gira nel browser e dentro l'app Android
// (dove window.JarvisNative dà accesso a microfono, voce, contapassi e ai dati della vecchia app).

import { createOrb } from './orb.js';

const native = window.JarvisNative || null;
const nativeCall = (name, ...args) => { try { return native && typeof native[name] === 'function' ? native[name](...args) : null; } catch { return null; } };
const nativeJson = (name, ...args) => { try { return JSON.parse(nativeCall(name, ...args) || 'null'); } catch { return null; } };

const store = {
  token: (nativeJson('getConfig') || {}).token || localStorage.getItem('jarvis_token') || '',
  tab: 'chat', sub: 'storico', state: null, messages: [], sending: false, pendingImage: null,
  memory: null, models: null, inbox: [], openJob: null, error: '', chatOpen: false,
  voice: (nativeJson('getConfig') || {}).status || 'OFF', speakingUntil: 0,
};

// La sfera vive fuori dal ridisegno della pagina, così l'animazione non riparte a ogni aggiornamento.
const orb = createOrb();
let speakTimer = 0;
function orbState() {
  if (store.sending || store.voice === 'THINKING') return 'thinking';
  if (store.voice === 'SPEAKING' || Date.now() < store.speakingUntil) return 'speaking';
  if (store.voice === 'LISTENING') return 'listening';
  if (native && store.voice === 'OFF') return 'off';
  return 'idle';
}
function updateOrb() { orb.setState(orbState()); }

// I rami della sfera sono i moduli di memoria di Jarvis (più dieta, agenda e compiti).
let lastLit = '';
async function loadGraph(lightUp = false) {
  try {
    const g = await api('GET', '/graph');
    store.graph = g.branches || [];
    orb.setGraph(store.graph);
    const at = g.last?.at || '';
    if (lightUp && at && at !== lastLit) orb.highlight(g.last.touched || [], g.last.leaves || []);
    lastLit = at;
  } catch { /* la sfera resta com'era */ }
}
/** Accende subito i rami di cui sembra parlare il messaggio, senza aspettare il server. */
const TOPIC_HINTS = {
  dieta: /(mangiat|pranz|cena|colazion|spuntin|calori|kcal|protein|pes[oa]|dieta|allenament|corsa|palestra|passi)/i,
  agenda: /(ricord|promemoria|appuntament|agenda|domani|stasera|sveglia)/i,
  compiti: /(compito|ricerca|cerca|organizza|pianifica)/i,
};
function guessTopics(text) {
  const words = new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 3));
  return (store.graph || []).filter(b => TOPIC_HINTS[b.id]?.test(text) ||
    `${b.id} ${b.label} ${b.description || ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).some(w => w.length > 3 && words.has(w))).map(b => b.id);
}
function syncCompact() {
  // Chat chiusa: la sfera occupa lo schermo. Chat aperta: la sfera si rimpicciolisce (se non c'è un ramo aperto).
  orb.el.classList.toggle('full', !store.chatOpen || !!orb.focused);
  orb.el.classList.toggle('compact', store.chatOpen && !orb.focused);
}
// Toccare un ramo lo apre (zoom); toccarlo di nuovo, o toccare altrove, torna alla vista intera.
orb.onPick((id) => { orb.focus(id && id !== orb.focused ? id : null); syncCompact(); });
/** Tiene la sfera in "sto parlando" per la durata stimata della risposta. */
function markSpeaking(text) {
  store.speakingUntil = Date.now() + Math.min(20000, 900 + String(text || '').length * 60);
  clearTimeout(speakTimer);
  speakTimer = setTimeout(updateOrb, store.speakingUntil - Date.now() + 50);
  updateOrb();
}
// L'app Android comunica qui lo stato del servizio vocale (OFF, WAITING, LISTENING, THINKING, SPEAKING, ERROR).
window.jarvisStatus = (status) => { store.voice = String(status || 'OFF'); updateOrb(); };

/** Azioni che solo il telefono può eseguire (aprire un'app o un indirizzo). */
function runDeviceActions(list) {
  for (const a of list || []) {
    if (a.type === 'open_app') {
      if (!native) { toast(`Per aprire ${a.name} serve l'app Android di Jarvis.`); continue; }
      if (nativeCall('openApp', a.name) !== true) toast(`Non trovo l'app "${a.name}" su questo telefono.`);
    } else if (a.type === 'open_url' && /^https:\/\//i.test(a.url)) {
      if (native) nativeCall('openUrl', a.url); else window.open(a.url, '_blank', 'noopener');
    }
  }
}

// ------------------------------------------------------------------ utilità

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); for (const p of d.split('|')) { const e = document.createElementNS(s.namespaceURI, 'path'); e.setAttribute('d', p); s.append(e); } return s; };
const ICONS = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  oggi: 'M12 3v2|M12 19v2|M3 12h2|M19 12h2|M5.6 5.6l1.4 1.4|M17 17l1.4 1.4|M5.6 18.4L7 17|M17 7l1.4-1.4|M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  cucina: 'M6 3v8a3 3 0 0 0 6 0V3|M9 3v18|M18 3c-2 2-3 5-3 8h3v10',
  attivita: 'M9 11l3 3 8-8|M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  altro: 'M4 6h16|M4 12h16|M4 18h16',
  gallery: 'M4 5h16v14H4z|M4 15l4-4 4 4 3-3 5 5|M15 9.5a1 1 0 1 0 0-.01',
  send: 'M5 12h14|M13 6l6 6-6 6', photo: 'M4 8h3l2-3h6l2 3h3v11H4z|M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z|M5 11a7 7 0 0 0 14 0|M12 18v3', trash: 'M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13',
};
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('it-IT');
const dateLabel = (iso) => { const d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }); };

let toastTimer;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method, headers: { authorization: 'Bearer ' + store.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* corpo vuoto */ }
  if (res.status === 401) { logout(false); throw new Error('Token non valido'); }
  if (!res.ok) throw new Error(data?.error || `Errore ${res.status}`);
  return data;
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message || 'Errore'); } };

function logout(clear = true) {
  if (clear) localStorage.removeItem('jarvis_token');
  store.token = ''; store.state = null; render();
}

// ------------------------------------------------------------------ dati

async function refresh() {
  store.state = await api('GET', '/state');
  store.error = '';
}
async function loadHistory() {
  store.messages = (await api('GET', '/history')).messages;
}
async function act(...actions) {
  store.state = (await api('POST', '/actions', { actions })).state;
  render();
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!store.token) return render();
  try {
    await Promise.all([refresh(), loadHistory(), loadGraph(false)]);
    await importLegacyIfNeeded();
    syncSteps();
  } catch (e) { store.error = e.message; }
  render();
  scrollChat();
}

/** Primo avvio dentro l'app Android: porta nel cloud i dati salvati sul telefono, senza cancellarli. */
async function importLegacyIfNeeded() {
  if (!native || store.state?.legacyImported) return;
  const diary = nativeJson('exportLegacyDiary');
  if (!diary || !Array.isArray(diary.meals)) return;
  const hasData = diary.meals.length || (diary.weights || []).length || diary.profile?.birthDate;
  if (!hasData) return;
  const res = await api('POST', '/import/legacy', { diary });
  store.state = res.state;
  await loadHistory();
  toast(`Dati del telefono importati: ${res.meals} pasti, ${res.weights} pesate.`);
}

/** Backup scelto dall'utente: il diario.json della vecchia app o un backup scaricato da Jarvis. Si unisce, non sostituisce. */
function importBackupFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', guard(async () => {
    const file = input.files?.[0];
    if (!file) return;
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { return toast('Il file non è un backup valido.'); }
    const diary = obj && obj.diary && Array.isArray(obj.diary.meals) ? obj.diary : obj;
    if (!diary || !Array.isArray(diary.meals)) return toast('Il file non contiene dati di Jarvis.');
    const res = await api('POST', '/import/legacy', { diary });
    store.state = res.state;
    await loadHistory();
    render();
    toast(`Backup importato: ${res.meals} pasti, ${res.weights} pesate.`);
  }));
  input.click();
}

function syncSteps() {
  const s = nativeJson('getSteps');
  if (s && s.steps > 0 && s.steps !== store.state?.today?.steps) api('POST', '/steps', s).then(refresh).then(render).catch(() => {});
}

// L'app Android chiama questa funzione dopo uno scambio vocale, per aggiornare lo schermo.
window.jarvisRefresh = guard(async () => { await Promise.all([refresh(), loadHistory(), loadGraph(true)]); render(); scrollChat(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.token && !store.sending) window.jarvisRefresh(); });

// ------------------------------------------------------------------ chat

function scrollChat() { requestAnimationFrame(() => { const c = document.querySelector('.chat'); if (c) c.scrollTop = c.scrollHeight; }); }

async function send(text) {
  text = text.trim();
  const image = store.pendingImage;
  if ((!text && !image) || store.sending) return;
  store.sending = true; store.pendingImage = null;
  store.messages.push({ role: 'user', text: text || 'Guarda questa foto.', image: !!image });
  store.speakingUntil = 0;
  render(); scrollChat();
  orb.highlight(guessTopics(text));
  try {
    const out = await api('POST', '/chat', { text, image });
    // Prima la mappa aggiornata (possono essere nati rami nuovi), poi si accendono.
    loadGraph(false).then(() => orb.highlight(out.touched || [], out.touchedLeaves || []));
    store.messages.push({ role: 'assistant', text: out.reply, card: out.card, model: out.model });
    if (out.photoRequest) toast('Jarvis chiede una foto: ' + out.photoRequest);
    if ((nativeJson('getConfig') || {}).speakReplies) nativeCall('speak', out.reply);
    markSpeaking(out.reply);
    runDeviceActions(out.device);
    await refresh();
  } catch (e) {
    store.messages.push({ role: 'assistant', text: 'Non riesco a contattare il server: ' + e.message });
  }
  store.sending = false;
  render(); scrollChat();
  document.querySelector('.composer textarea')?.focus();
}

function pickPhoto(camera = false) {
  const input = h('input', { type: 'file', accept: 'image/*', capture: camera ? 'environment' : null });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      store.pendingImage = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
      render();
    } catch { toast('Non riesco a leggere questa immagine.'); }
  });
  input.click();
}

function viewChat() {
  syncCompact();
  // La conversazione completa si apre solo se richiesta; altrimenti sotto la sfera c'è solo l'ultima risposta.
  const lastReply = [...store.messages].reverse().find(m => m.role === 'assistant');
  const lastUser = [...store.messages].reverse().find(m => m.role === 'user');
  const caption = store.sending
    ? h('div', { class: 'caption pending' }, lastUser ? h('span', { class: 'you' }, lastUser.text) : null, 'Sto pensando…')
    : h('div', { class: 'caption', 'aria-live': 'polite' }, lastReply ? lastReply.text : (native ? 'Dica "Jarvis" oppure scriva qui sotto.' : 'Scriva a Jarvis qui sotto.'),
      lastReply?.card ? h('span', { class: 'cardline' }, lastReply.card) : null);
  const list = h('div', { class: 'chat' },
    store.messages.length ? null : h('p', { class: 'empty' }, 'Scriva o parli a Jarvis: pasti, allenamenti, promemoria, cose da ricordare, compiti da svolgere.'),
    store.messages.map(m => h('div', { class: 'msg ' + (m.role === 'user' ? 'user' : 'assistant') },
      (m.image ? '📷 ' : '') + m.text,
      m.card ? h('span', { class: 'cardline' }, m.card) : null,
      m.model ? h('span', { class: 'meta' }, m.model.split(':').pop()) : null)),
    store.sending ? h('div', { class: 'msg assistant pending' }, 'Sto pensando…') : null);
  const ta = h('textarea', { rows: 1, placeholder: 'Scrivi a Jarvis…', 'aria-label': 'Messaggio', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value; ta.value = ''; send(v); } } });
  const composer = h('div', { class: 'composer' },
    store.pendingImage ? h('img', { class: 'thumb', alt: 'Foto allegata', src: 'data:image/jpeg;base64,' + store.pendingImage, onclick: () => { store.pendingImage = null; render(); } }) : null,
    h('button', { class: 'btn icon', 'aria-label': native ? 'Scatta una foto' : 'Allega una foto', onclick: () => pickPhoto(!!native) }, icon(ICONS.photo)),
    native ? h('button', { class: 'btn icon', 'aria-label': 'Scegli dalla galleria', onclick: () => pickPhoto(false) }, icon(ICONS.gallery)) : null,
    native ? h('button', { class: 'btn icon', 'aria-label': 'Parla ora', onclick: () => nativeCall('listenNow') }, icon(ICONS.mic)) : null,
    h('button', { class: 'btn icon' + (store.chatOpen ? ' on' : ''), 'aria-label': store.chatOpen ? 'Chiudi la chat' : 'Apri la chat', 'aria-pressed': store.chatOpen ? 'true' : 'false', onclick: () => { store.chatOpen = !store.chatOpen; render(); if (store.chatOpen) scrollChat(); } }, icon(ICONS.chat)),
    ta,
    h('button', { class: 'btn primary icon', 'aria-label': 'Invia', disabled: store.sending, onclick: () => { const v = ta.value; ta.value = ''; send(v); } }, icon(ICONS.send)));
  return store.chatOpen ? [orb.el, list, composer] : [orb.el, caption, composer];
}

// ------------------------------------------------------------------ oggi

function viewOggi() {
  const s = store.state, t = s.today, d = s.diary;
  if (!t.profileComplete) {
    return [h('div', { class: 'card' }, h('h2', {}, 'Completa il profilo'), h('p', { class: 'muted' }, 'Servono data di nascita, altezza e peso per calcolare il target calorico.'),
      h('button', { class: 'btn primary', onclick: () => go('altro', 'profilo') }, 'Apri il profilo'))];
  }
  const pct = Math.min(100, Math.round((t.eaten / Math.max(t.target, 1)) * 100));
  const meals = d.meals.filter(m => m.date === t.date);
  const acts = d.activities.filter(a => a.date === t.date);
  const kcalOf = (m) => (m.items || []).reduce((x, i) => x + (Number(i.kcal) || 0), 0);
  return [
    d.activeRecipeSession ? h('div', { class: 'banner' }, h('h2', {}, '🍳 In cucina: ' + d.activeRecipeSession.title),
      h('p', { class: 'pre' }, d.activeRecipeSession.currentStep || d.activeRecipeSession.ingredientsNeeded),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: guard(() => act({ type: 'clear_recipe_session' })) }, 'Ho finito'))) : null,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, t.remaining >= 0 ? 'Calorie rimanenti' : 'Calorie oltre il target'), h('div', { class: 'big' }, fmt(Math.abs(t.remaining)))),
        h('div', { class: 'muted num', style: 'text-align:right' }, `${fmt(t.eaten)} / ${fmt(t.target)} kcal`, h('br'), `domani ~${fmt(t.tomorrowTarget)}`)),
      h('div', { class: 'bar' + (t.remaining < 0 ? ' over' : '') }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Proteine'), h('b', {}, `${t.protein} / ${t.proteinTarget} g`)),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Carboidrati'), h('b', {}, `${t.carbs} g`)),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Grassi'), h('b', {}, `${t.fat} g`)),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Passi'), h('b', {}, fmt(t.steps))),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Bonus passi'), h('b', {}, `+${fmt(t.stepBonus)} kcal`)),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Allenamenti'), h('b', {}, `${fmt(t.burned)} kcal`)))),
    h('div', { class: 'card' }, h('h2', {}, 'Pasti di oggi'),
      meals.length ? h('div', { class: 'list' }, meals.map(m => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', {}, m.meal), h('div', { class: 'muted clip' }, (m.items || []).map(i => i.name).join(', ') || m.description)),
        h('span', { class: 'num' }, fmt(kcalOf(m)) + ' kcal'),
        h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina ' + m.meal, onclick: guard(() => act({ type: 'delete_meal', id: m.id })) }, icon(ICONS.trash)))))
        : h('p', { class: 'empty' }, 'Nessun pasto registrato. Dica a Jarvis cosa ha mangiato.')),
    acts.length ? h('div', { class: 'card' }, h('h2', {}, 'Attività di oggi'), h('div', { class: 'list' }, acts.map(a => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', {}, a.type), h('div', { class: 'muted clip' }, `${fmt(a.durationMin)} min · ${a.description}`)),
      h('span', { class: 'num' }, fmt(a.kcalBurned) + ' kcal'),
      h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina attività', onclick: guard(() => act({ type: 'delete_activity', id: a.id })) }, icon(ICONS.trash)))))) : null,
    weightCard(),
  ];
}

function weightCard() {
  const input = h('input', { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'kg', 'aria-label': 'Peso in kg' });
  return h('div', { class: 'card' }, h('h2', {}, 'Peso'), h('div', { class: 'row' }, input,
    h('button', { class: 'btn', onclick: guard(async () => { const kg = Number(input.value); if (!(kg > 20)) return toast('Inserisca un peso valido.'); await act({ type: 'add_weight', kg, date: store.state.today.date }); toast('Peso registrato.'); }) }, 'Registra')));
}

// ------------------------------------------------------------------ cucina

function viewCucina() {
  const d = store.state.diary;
  const name = h('input', { placeholder: 'Ingrediente', 'aria-label': 'Ingrediente' });
  const qty = h('input', { placeholder: 'Quantità', 'aria-label': 'Quantità', style: 'max-width:120px' });
  const add = guard(async () => { if (!name.value.trim()) return; await act({ type: 'add_pantry_item', name: name.value, quantity: qty.value }); });
  return [
    h('div', { class: 'card' }, h('h2', {}, 'Dispensa'),
      h('div', { class: 'row' }, name, qty, h('button', { class: 'btn primary', onclick: add }, 'Aggiungi')),
      d.pantry.length ? h('div', { class: 'list' }, d.pantry.map(i => h('div', { class: 'item' },
        h('div', { class: 'grow clip' }, i.name, i.quantity ? h('span', { class: 'muted' }, ' · ' + i.quantity) : null),
        h('span', { class: 'tag' }, i.category),
        h('button', { class: 'btn icon ghost danger', 'aria-label': 'Rimuovi ' + i.name, onclick: guard(() => act({ type: 'remove_pantry_item', id: i.id })) }, icon(ICONS.trash)))))
        : h('p', { class: 'empty' }, 'Dispensa vuota. Può anche mandare a Jarvis una foto del frigo o della spesa.'),
      h('button', { class: 'btn', onclick: () => { go('chat'); send('Cosa posso cucinare con quello che ho in dispensa, restando nel mio target di oggi?'); } }, 'Chiedi a Jarvis cosa cucinare')),
    h('div', { class: 'card' }, h('h2', {}, 'Ricettario'),
      d.savedRecipes.length ? d.savedRecipes.map(r => h('details', {},
        h('summary', {}, h('span', { style: 'color:var(--text)' }, r.title), ` · ${fmt(r.totalKcal)} kcal (P${fmt(r.totalProtein)} C${fmt(r.totalCarbs)} G${fmt(r.totalFat)})`),
        h('p', { class: 'muted pre', style: 'margin:8px 0' }, (r.ingredients || []).map(i => `${i.name} ${fmt(i.grams)} g`).join(', ') + (r.instructions ? '\n\n' + r.instructions : '')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => { go('chat'); send(`Voglio cucinare la ricetta salvata "${r.title}": adatta le dosi al mio target di oggi e guidami passo passo.`); } }, 'Cucina ora'),
          h('button', { class: 'btn ghost danger', onclick: guard(() => act({ type: 'delete_recipe', id: r.id })) }, 'Elimina'))))
        : h('p', { class: 'empty' }, 'Nessuna ricetta salvata. Quando una proposta le piace, dica "salva la ricetta".')),
  ];
}

// ------------------------------------------------------------------ attività (promemoria e compiti)

function viewAttivita() {
  const s = store.state;
  const text = h('input', { placeholder: 'Cosa devo ricordarle?', 'aria-label': 'Testo del promemoria' });
  const due = h('input', { type: 'datetime-local', 'aria-label': 'Data e ora', value: s.now, style: 'max-width:220px' });
  const goal = h('textarea', { rows: 2, placeholder: 'Es. Pianifica i pasti della settimana con lista della spesa', 'aria-label': 'Compito' });
  return [
    h('div', { class: 'card' }, h('h2', {}, 'Promemoria'),
      h('div', { class: 'row wrap' }, text, due, h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!text.value.trim() || !due.value) return toast('Servono testo e orario.');
        s.reminders = (await api('POST', '/reminders', { text: text.value, due: due.value })).reminders; render();
      }) }, 'Aggiungi')),
      s.reminders.length ? h('div', { class: 'list' }, s.reminders.map(r => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', {}, r.text), h('div', { class: 'muted num' }, new Date(r.dueMs).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }))),
        h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina promemoria', onclick: guard(async () => { s.reminders = (await api('DELETE', '/reminders/' + r.id)).reminders; render(); }) }, icon(ICONS.trash)))))
        : h('p', { class: 'empty' }, 'Nessun promemoria. Può anche dire: "Jarvis, ricordami alle 18 di chiamare il dentista".')),
    h('div', { class: 'card' }, h('h2', {}, 'Compiti in background'),
      h('p', { class: 'muted' }, 'Jarvis divide il lavoro in passi, li svolge uno alla volta e avvisa quando ha finito.'),
      goal, h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!goal.value.trim()) return;
        s.jobs = (await api('POST', '/jobs', { goal: goal.value })).jobs; render(); toast('Compito avviato.');
      }) }, 'Avvia'),
      s.jobs.length ? h('div', { class: 'list' }, s.jobs.map(j => h('div', { class: 'item', style: 'align-items:flex-start' },
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'grow clip' }, j.title), jobTag(j)),
          j.steps.length ? h('div', { class: 'muted small' }, j.steps.map(x => (x.status === 'done' ? '✓ ' : '○ ') + x.title).join('  ')) : null,
          store.openJob === j.id && j.result ? h('p', { class: 'pre', style: 'margin-top:8px' }, j.result) : null,
          h('div', { class: 'row', style: 'margin-top:6px' },
            j.result ? h('button', { class: 'btn', onclick: () => { store.openJob = store.openJob === j.id ? null : j.id; render(); } }, store.openJob === j.id ? 'Chiudi' : 'Leggi il risultato') : null,
            h('button', { class: 'btn ghost danger', onclick: guard(async () => { s.jobs = (await api('DELETE', '/jobs/' + j.id)).jobs; render(); }) }, 'Elimina'))))))
        : null),
  ];
}
const jobTag = (j) => h('span', { class: 'tag ' + ({ done: 'ok', failed: 'bad' }[j.status] || 'warn') }, { planning: 'pianifico', running: 'in corso', done: 'completato', failed: 'non riuscito' }[j.status] || j.status);

// ------------------------------------------------------------------ altro

const SUBS = [['storico', 'Storico'], ['memoria', 'Memoria'], ['modelli', 'Modelli'], ['profilo', 'Profilo'], ['impostazioni', 'Impostazioni']];

function viewAltro() {
  const bar = h('div', { class: 'row wrap' }, SUBS.map(([id, label]) => h('button', { class: 'btn' + (store.sub === id ? ' primary' : ''), 'aria-pressed': String(store.sub === id), onclick: () => go('altro', id) }, label)));
  const body = { storico: viewStorico, memoria: viewMemoria, modelli: viewModelli, profilo: viewProfilo, impostazioni: viewImpostazioni }[store.sub]();
  return [bar, ...body];
}

function viewStorico() {
  const s = store.state, b = s.balance;
  return [
    b ? h('div', { class: 'card' }, h('h2', {}, `Dal ${dateLabel(b.startDate)}`),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Deficit totale'), h('b', {}, fmt(b.cumulativeDeficitVsMaintenance) + ' kcal')),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Perdita stimata'), h('b', {}, b.estimatedWeightLossKg.toFixed(2) + ' kg')),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Sulla bilancia'), h('b', {}, b.actualWeightLossKg == null ? '—' : (b.actualWeightLossKg >= 0 ? '-' : '+') + Math.abs(b.actualWeightLossKg).toFixed(1) + ' kg')),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Media netta'), h('b', {}, fmt(b.avgNetKcalPerDay) + ' kcal')),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Deficit medio'), h('b', {}, fmt(b.avgDeficitPerDay) + ' kcal')),
        h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Passi medi'), h('b', {}, fmt(b.avgStepsPerDay))))) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Ultimi 30 giorni'),
      h('div', { class: 'list' }, s.days.map(d => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', {}, dateLabel(d.date)), h('div', { class: 'muted small num' }, `P${d.protein} C${d.carbs} G${d.fat} · ${fmt(d.steps)} passi${d.burned ? ` · ${fmt(d.burned)} kcal attività` : ''}`)),
        h('span', { class: 'num' }, fmt(d.kcal) + ' kcal'))))),
    s.diary.weights.length ? h('div', { class: 'card' }, h('h2', {}, 'Pesate'),
      h('div', { class: 'list' }, [...s.diary.weights].sort((a, b2) => (a.date < b2.date ? 1 : -1)).slice(0, 20).map(w => h('div', { class: 'item' }, h('span', { class: 'grow' }, dateLabel(w.date)), h('span', { class: 'num' }, w.kg + ' kg'))))) : null,
  ];
}

function viewMemoria() {
  if (!store.memory) { api('GET', '/memory').then(m => { store.memory = m; render(); }).catch(e => toast(e.message)); return [h('p', { class: 'empty' }, 'Carico la memoria…')]; }
  const mod = h('input', { placeholder: 'Modulo (es. lavoro)', 'aria-label': 'Modulo', style: 'max-width:170px', list: 'mods' });
  const text = h('input', { placeholder: 'Cosa deve ricordare Jarvis?', 'aria-label': 'Ricordo' });
  const reload = async () => { store.memory = await api('GET', '/memory'); render(); };
  return [
    h('div', { class: 'card' }, h('h2', {}, 'Memoria a moduli'),
      h('p', { class: 'muted' }, 'Jarvis crea un modulo per ogni attività o argomento e lo riapre solo quando serve. Qui può aggiungere o cancellare ricordi a mano.'),
      h('datalist', { id: 'mods' }, store.memory.modules.map(m => h('option', { value: m.name }))),
      h('div', { class: 'row wrap' }, mod, text, h('button', { class: 'btn primary', onclick: guard(async () => { if (!text.value.trim()) return; await api('POST', '/memory', { module: mod.value || 'generale', text: text.value }); await reload(); }) }, 'Salva'))),
    store.memory.modules.length ? store.memory.modules.map(m => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, m.name), h('span', { class: 'tag' }, m.entries + ' ricordi')),
      m.description ? h('p', { class: 'muted' }, m.description) : null,
      h('div', { class: 'list' }, store.memory.entries.filter(e => e.module === m.name).map(e => h('div', { class: 'item' },
        h('span', { class: 'grow' }, e.text),
        h('button', { class: 'btn icon ghost danger', 'aria-label': 'Dimentica', onclick: guard(async () => { await api('DELETE', '/memory/' + e.id); await reload(); }) }, icon(ICONS.trash)))))))
      : [h('p', { class: 'empty' }, 'Ancora nessun ricordo. Provi a dire: "Jarvis, ricordati che…".')],
  ];
}

function viewModelli() {
  if (!store.models) { api('GET', '/models').then(m => { store.models = m; render(); }).catch(e => toast(e.message)); return [h('p', { class: 'empty' }, 'Carico i modelli…')]; }
  const m = store.models;
  const reload = async () => { store.models = await api('GET', '/models'); render(); };
  const editor = h('textarea', { rows: 8, 'aria-label': 'Elenco modelli in JSON', spellcheck: 'false', style: 'font-family:ui-monospace,monospace;font-size:.8rem' });
  editor.value = JSON.stringify(m.models.map(x => ({ provider: x.provider, model: x.model, tiers: x.tiers, ctx: x.ctx, ...x.limits, free: x.free, prio: x.prio })), null, 1);
  return [
    h('div', { class: 'card' }, h('h2', {}, 'Provider'),
      h('p', { class: 'muted' }, 'Le chiavi si impostano come segreti su Cloudflare. Jarvis usa solo i provider con la chiave e cambia modello all\'80% del limite.'),
      h('div', { class: 'row wrap' }, m.providers.map(p => h('span', { class: 'tag ' + (p.configured ? 'ok' : '') , title: p.env }, (p.configured ? '● ' : '○ ') + p.name)))),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Modelli'), h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/models/unblock'); await reload(); toast('Pause azzerate.'); }) }, 'Riattiva tutti')),
      h('div', { class: 'list' }, m.models.filter(x => x.configured).map(x => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'clip' }, x.model), h('div', { class: 'muted small' }, `${x.provider} · ${x.tiers.join(', ')} · oggi ${x.requestsToday} richieste${x.lastError ? ' · ' + x.lastError.slice(0, 60) : ''}`)),
        x.blockedForSec ? h('span', { class: 'tag bad' }, 'in pausa ' + (x.blockedForSec > 3600 ? Math.round(x.blockedForSec / 3600) + ' h' : Math.ceil(x.blockedForSec / 60) + ' min'))
          : h('span', { class: 'tag ' + (x.load >= 80 ? 'warn' : 'ok') }, x.load + '%'))),
        m.models.some(x => x.configured) ? null : h('p', { class: 'empty' }, 'Nessuna chiave API configurata sul server.'))),
    m.events.length ? h('div', { class: 'card' }, h('h2', {}, 'Registro'), h('div', { class: 'list' }, m.events.slice(0, 15).map(e => h('div', { class: 'item' },
      h('span', { class: 'tag ' + (e.kind === 'error' ? 'bad' : '') }, e.kind), h('span', { class: 'grow small pre' }, e.text), h('span', { class: 'muted small num' }, e.at.slice(5).replace('T', ' ')))))) : null,
    h('div', { class: 'card' }, h('details', {}, h('summary', {}, 'Modifica l\'elenco dei modelli (avanzato)'),
      h('p', { class: 'muted', style: 'margin:8px 0' }, 'Se un provider cambia nome a un modello, lo corregga qui: vale subito, senza aggiornare nulla.'),
      editor,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn primary', onclick: guard(async () => { let list; try { list = JSON.parse(editor.value); } catch { return toast('JSON non valido.'); } await api('PUT', '/models', { models: list }); await reload(); toast('Elenco salvato.'); }) }, 'Salva'),
        h('button', { class: 'btn', onclick: guard(async () => { await api('PUT', '/models', { reset: true }); await reload(); toast('Elenco predefinito ripristinato.'); }) }, 'Ripristina predefiniti')))),
  ];
}

function viewProfilo() {
  const p = store.state.diary.profile;
  const f = {};
  const field = (key, label, attrs = {}) => h('label', { class: 'field' }, label, f[key] = h('input', { value: p[key] ?? '', ...attrs }));
  const select = (key, label, options) => h('label', { class: 'field' }, label, f[key] = h('select', {}, options.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = String(p[key]) === String(v); return o; })));
  return [h('div', { class: 'card' }, h('h2', {}, 'Profilo'),
    h('div', { class: 'row wrap' }, field('name', 'Nome'), field('birthDate', 'Data di nascita', { type: 'date' }), select('sex', 'Sesso', [['M', 'Maschio'], ['F', 'Femmina']])),
    h('div', { class: 'row wrap' }, field('heightCm', 'Altezza (cm)', { type: 'number', inputmode: 'decimal' }), field('weightKg', 'Peso iniziale (kg)', { type: 'number', step: '0.1', inputmode: 'decimal' }), field('targetWeightKg', 'Peso obiettivo (kg)', { type: 'number', step: '0.1', inputmode: 'decimal' })),
    h('div', { class: 'row wrap' }, select('goal', 'Obiettivo', [['dimagrire', 'Dimagrire'], ['mantenere', 'Mantenere'], ['massa', 'Massa']]),
      select('weeklyChangeKg', 'Ritmo (kg a settimana)', [[0.25, '0,25'], [0.5, '0,5'], [0.75, '0,75'], [1, '1']]),
      select('activityLevel', 'Attività', [['sedentario', 'Sedentario'], ['leggero', 'Leggero'], ['moderato', 'Moderato'], ['attivo', 'Attivo'], ['molto attivo', 'Molto attivo']])),
    field('foodLikes', 'Cibi che ama'), field('foodDislikes', 'Cibi da evitare'), field('dietNotes', 'Note (es. vegetariano, orari, budget)'),
    h('button', { class: 'btn primary', onclick: guard(async () => {
      const profile = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      store.state = (await api('PUT', '/profile', { profile })).state; render(); toast('Profilo salvato.');
    }) }, 'Salva'))];
}

function viewImpostazioni() {
  const cfg = nativeJson('getConfig');
  const toggle = (label, key, method) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cfg[key], onchange: (e) => { nativeCall(method, e.target.checked); setTimeout(render, 300); } }), label);
  return [
    native && cfg ? h('div', { class: 'card' }, h('h2', {}, 'Telefono'),
      toggle('Ascolto continuo di "Jarvis" (anche a schermo spento)', 'listening', 'setListening'),
      toggle('Leggi le risposte ad alta voce', 'speakReplies', 'setSpeakReplies'),
      toggle('Lascia il microfono alle altre app (Gemini, vocali, chiamate)', 'micGuard', 'setMicGuard'),
      h('p', { class: 'muted' }, `App ${cfg.version || ''}. Quando un'altra app registra, Jarvis si mette in pausa e riprende da solo.`),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: guard(async () => { store.state.legacyImported = null; await importLegacyIfNeeded(); render(); }) }, 'Reimporta i dati del telefono'),
        h('button', { class: 'btn ghost danger', onclick: () => nativeCall('disconnectCloud') }, 'Torna all\'app classica'))) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Dati'),
      h('p', { class: 'muted' }, store.state.legacyImported ? `Dati della vecchia app importati il ${store.state.legacyImported.replace('T', ' alle ')}.` : 'I dati vivono sul suo server Cloudflare.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: guard(async () => {
          const data = await api('GET', '/export');
          const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `jarvis-backup-${data.exportedAt.slice(0, 10)}.json` });
          a.click(); URL.revokeObjectURL(a.href);
        }) }, 'Scarica un backup'),
        h('button', { class: 'btn', onclick: importBackupFile }, 'Importa un backup'),
        native ? null : h('button', { class: 'btn ghost danger', onclick: () => logout() }, 'Esci'))),
  ];
}

// ------------------------------------------------------------------ struttura

function viewLogin() {
  const input = h('input', { type: 'password', placeholder: 'Token di accesso', 'aria-label': 'Token di accesso', autocomplete: 'current-password' });
  const submit = guard(async () => {
    store.token = input.value.trim();
    if (!store.token) return;
    try { await refresh(); } catch (e) { store.token = ''; throw e; }
    localStorage.setItem('jarvis_token', store.token);
    await Promise.all([loadHistory(), loadGraph(false)]); render(); scrollChat();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return h('div', { class: 'card login' }, h('img', { src: '/logo.png', alt: '' }), h('h1', { style: 'text-align:center' }, 'Jarvis Assistente'),
    h('p', { class: 'muted', style: 'text-align:center' }, 'Inserisca il token scelto durante l\'installazione (JARVIS_TOKEN).'), input, h('button', { class: 'btn primary', onclick: submit }, 'Entra'));
}

const TABS = [['chat', 'Jarvis'], ['oggi', 'Oggi'], ['cucina', 'Cucina'], ['attivita', 'Attività'], ['altro', 'Altro']];
function go(tab, sub) { store.tab = tab; if (sub) store.sub = sub; render(); if (tab === 'chat') scrollChat(); }

function render() {
  const app = document.getElementById('app');
  const keep = document.querySelector('.composer textarea')?.value;
  const scroll = document.querySelector('main')?.scrollTop;
  app.replaceChildren();
  if (!store.token) return app.append(viewLogin());
  if (!store.state) {
    return app.append(h('div', { class: 'card login' }, h('p', { class: 'empty' }, store.error ? 'Non riesco a contattare il server: ' + store.error : 'Carico…'),
      store.error ? h('button', { class: 'btn primary', onclick: boot }, 'Riprova') : null));
  }
  const listening = !!(nativeJson('getConfig') || {}).listening;
  const title = { chat: 'Jarvis', oggi: 'Oggi', cucina: 'Cucina', attivita: 'Attività', altro: 'Altro' }[store.tab];
  app.append(h('header', { class: 'top' }, h('h1', {}, title),
    native ? h('span', { class: 'muted small' }, listening ? 'in ascolto' : 'ascolto spento') : null, native ? h('span', { class: 'dot' + (listening ? ' on' : '') }) : null));
  if (store.tab === 'chat') app.append(...viewChat());
  else app.append(h('main', {}, { oggi: viewOggi, cucina: viewCucina, attivita: viewAttivita, altro: viewAltro }[store.tab]()));
  app.append(h('nav', { class: 'tabs', 'aria-label': 'Sezioni' }, TABS.map(([id, label]) =>
    h('button', { 'aria-current': store.tab === id ? 'page' : null, onclick: () => go(id) }, icon(ICONS[id]), label))));
  if (keep) { const ta = document.querySelector('.composer textarea'); if (ta) ta.value = keep; }
  if (scroll) { const m = document.querySelector('main'); if (m) m.scrollTop = scroll; }
  updateOrb(); orb.sync();
}

boot();
