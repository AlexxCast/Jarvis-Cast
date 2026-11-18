// Web app di Jarvis: nessuna build, solo moduli ES. Gira nel browser e dentro l'app Android
// (dove window.JarvisNative dà accesso a microfono, voce, contapassi e ai dati della vecchia app).

import { createOrb } from './orb.js';
import { renderVisual, VISUAL_CSS } from './visual.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: VISUAL_CSS }));
// Ogni grafica si costruisce una volta sola: ridisegnare la pagina non fa ripartire l'animazione.
const visuals = new WeakMap();
const visualOf = (m) => { if (!m?.visual) return null; if (!visuals.has(m)) visuals.set(m, renderVisual(m.visual)); return visuals.get(m); };

const native = window.JarvisNative || null;
const nativeCall = (name, ...args) => { try { return native && typeof native[name] === 'function' ? native[name](...args) : null; } catch { return null; } };
const nativeJson = (name, ...args) => { try { return JSON.parse(nativeCall(name, ...args) || 'null'); } catch { return null; } };

const store = {
  token: (nativeJson('getConfig') || {}).token || localStorage.getItem('jarvis_token') || '',
  tab: 'chat', sub: 'storico', state: null, messages: [], sending: false, pendingImage: null, pendingFiles: [],
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

// Umore di Jarvis: gioia → giallo/arancione, tensione → rosso/viola, calma → azzurro/blu.
const MOOD_RGB = { gioia: [255, 170, 40], tensione: [210, 40, 150], calma: [40, 150, 255] };
const MOOD_BASE = { gioia: 0.45, tensione: 0.15, calma: 0.55 };
function applyMood(m) {
  if (!m) return;
  const w = Object.fromEntries(Object.keys(MOOD_RGB).map(k => [k, Math.max(0.02, (m[k] || 0) - MOOD_BASE[k] + 0.12)]));
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const rgb = [0, 1, 2].map(i => Object.keys(w).reduce((a, k) => a + MOOD_RGB[k][i] * w[k] / sum, 0));
  const strength = Math.min(1, Math.max(...Object.keys(MOOD_RGB).map(k => Math.abs((m[k] || 0) - MOOD_BASE[k]))) * 2.5 + 0.15);
  // Il colore va sulla rete e sugli impulsi della sfera, non sullo sfondo.
  const parts = Object.keys(w).sort((a, b) => w[b] - w[a]).map(k => ({ rgb: MOOD_RGB[k], w: w[k] / sum }));
  orb.setTint(rgb, strength, parts, m.tensione || 0);
}

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
  dieta: /(mangiat|pranz|cena|colazion|spuntin|calori|kcal|protein|pes[oa]|dieta)/i,
  sport: /(allenament|corsa|corr[eoi]|palestra|sport|cammin|bici|nuot|passi)/i,
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
// Registrazione della voce: l'app Android manda qui i passaggi e l'esito.
window.jarvisVoiceEnroll = (done, msg) => {
  store.voiceEnroll = done ? '' : String(msg || '');
  if (done) toast(msg ? String(msg) : 'Voce registrata: ora Jarvis la riconosce.');
  render();
};
window.jarvisStatus = (status) => { store.voice = String(status || 'OFF'); updateOrb(); };

/** Azioni che solo il telefono può eseguire (aprire un'app o un indirizzo). */
function runDeviceActions(list) {
  for (const a of list || []) {
    if (a.type === 'open_app') {
      if (!native) { toast(`Per aprire ${a.name} serve l'app Android di Jarvis.`); continue; }
      if (nativeCall('openApp', a.name) !== true) toast(`Non trovo l'app "${a.name}" su questo telefono.`);
    } else if (a.type === 'open_url' && /^https:\/\//i.test(a.url)) {
      if (native) nativeCall('openUrl', a.url); else window.open(a.url, '_blank', 'noopener');
    } else if (a.type === 'call') {
      if (!native) { toast('Per telefonare serve l\'app Android di Jarvis.'); continue; }
      const r = nativeCall('callContact', a.name);
      if (r === 'permesso') toast('Conceda a Jarvis i permessi Contatti e Telefono, poi ripeta.');
      else if (r === 'sconosciuto') toast(`Non trovo "${a.name}" nella rubrica.`);
      else if (r === null) toast('Per telefonare aggiorni l\'app Android di Jarvis.');
      else if (!String(r).startsWith('ok')) toast('Il telefono non ha avviato la chiamata.');
    } else if (a.type === 'save_place') savePlaceHere(a.name);
    else if (a.type === 'phone_task') {
      if (!native) { toast('Per usare il telefono serve l\'app Android di Jarvis.'); continue; }
      if (nativeCall('runPhoneTask', a.goal) === 'spento') toast('Attivi "Jarvis: usa il telefono" in Accessibilità (sezione Altro).');
    } else if (a.type === 'start_live_call') {
      openLiveCall();
    }
  }
}

/** Salva la posizione attuale con un nome ("casa", "palestra"): la usa il telefono per i promemoria all'arrivo. */
function savePlaceHere(name) {
  name = String(name || '').trim();
  if (!name) return;
  if (native) {
    const st = nativeCall('savePlaceHere', name);
    if (st === 'permesso') return toast('Mi serve il permesso della posizione: scelga "Consenti sempre", poi ripeta.');
    if (st === 'spento') return toast('La posizione del telefono è spenta: la accenda e ripeta.');
    toast(`Prendo la posizione per "${name}"…`);
    // Il telefono la invia al server da solo; dopo qualche secondo ricarichiamo.
    setTimeout(() => refresh().then(render).catch(() => {}), 9000);
    return;
  }
  if (!navigator.geolocation) return toast('Questo browser non conosce la posizione.');
  navigator.geolocation.getCurrentPosition(async (p) => {
    try {
      await api('POST', '/places', { name, lat: p.coords.latitude, lon: p.coords.longitude });
      await refresh(); render(); toast(`Luogo "${name}" salvato.`);
    } catch (e) { toast(e.message); }
  }, () => toast('Non riesco a leggere la posizione.'), { enableHighAccuracy: true, timeout: 20000 });
}

/** Il telefono controlla da solo quando entra o esce dai luoghi salvati: gli passiamo l'elenco aggiornato. */
let syncedPlaces = '';
function syncPlaces(list) {
  const json = JSON.stringify(list || []);
  if (!native || json === syncedPlaces) return;
  syncedPlaces = json;
  nativeCall('syncPlaces', json);
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
  file: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  send: 'M5 12h14|M13 6l6 6-6 6', photo: 'M4 8h3l2-3h6l2 3h3v11H4z|M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z|M5 11a7 7 0 0 0 14 0|M12 18v3', trash: 'M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13',
  video: 'M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M16 10l5-3v10l-5-3z',
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
  applyMood(store.state.mood);
  syncPlaces(store.state.places);
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
    // Timer interno di ~1.5 minuti (90s): controlla attività in corso, messaggi in arrivo e stato generale.
    setInterval(async () => {
      if (!store.token || store.sending) return;
      try {
        const inb = await api('POST', '/inbox/consume');
        for (const it of (inb.items || [])) {
          const txt = String(it.text || '').replace(/\[(?:PHONE_TASK|OPEN_APP):[^\]]+\]\s*/g, '').trim();
          if (txt) { toast(txt); if ((nativeJson('getConfig') || {}).speakReplies) nativeCall('speak', txt); }
        }
        await refresh();
        await loadGraph(true);
      } catch {}
    }, 90_000);
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
window.jarvisRefresh = guard(async () => { store.mind = null; store.memory = null; await Promise.all([refresh(), loadHistory(), loadGraph(true)]); render(); scrollChat(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.token && !store.sending) window.jarvisRefresh(); });

// ------------------------------------------------------------------ chat

function scrollChat() { requestAnimationFrame(() => { const c = document.querySelector('.chat'); if (c) c.scrollTop = c.scrollHeight; }); }

async function send(text) {
  text = text.trim();
  const image = store.pendingImage;
  const files = store.pendingFiles || [];
  if ((!text && !image && !files.length) || store.sending) return;
  store.sending = true; store.pendingImage = null; store.pendingFiles = [];
  const labelText = text || (image ? 'Guarda questa foto.' : `Analizza: ${files.map(f => f.name).join(', ')}`);
  store.messages.push({ role: 'user', text: files.length ? `[📎 ${files.map(f => f.name).join(', ')}] ${labelText}` : labelText, image: !!image });
  store.speakingUntil = 0;
  render(); scrollChat();
  orb.highlight(guessTopics(text));
  try {
    const out = await api('POST', '/chat', { text, image, files });
    store.mind = null; store.memory = null;
    // Prima la mappa aggiornata (possono essere nati rami e nodi nuovi), poi si accendono.
    loadGraph(false).then(() => orb.highlight(out.touched || [], out.touchedLeaves || []));
    if ((out.device || []).some(d => d.type === 'phone_task')) {
      setTimeout(() => loadGraph(true), 2500);
      setTimeout(() => loadGraph(true), 6000);
    }
    store.messages.push({ role: 'assistant', text: out.reply, card: out.card, model: out.model, visual: out.visual || null });
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

async function extractPdfContent(file) {
  try {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs');
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf, disableWorker: true, useWorkerFetch: false, isEvalSupported: false }).promise;
    const pages = [];
    const maxPages = Math.min(doc.numPages, 40);
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const txt = tc.items.map(it => it.str || '').join(' ').replace(/\s+/g, ' ').trim();
      if (txt) pages.push(`[Pagina ${p}]\n${txt}`);
    }
    const fullText = pages.join('\n\n').slice(0, 60000);
    if (fullText.length >= 40) {
      toast(`PDF letto: ${pages.length} pagine estratte.`);
      return { text: fullText, image: null };
    }
    // PDF scansionato (solo immagini): renderizza la prima pagina per leggerla con la Visione
    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: 1.5 });
    const canvas = h('canvas', { width: Math.round(vp.width), height: Math.round(vp.height) });
    await page1.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    toast('PDF scansionato: convertito in immagine per la lettura.');
    return { text: '', image: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
  } catch {
    // Riserva offline/CDN: invia i byte base64 al server per la lettura nativa con Gemini
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || '').split(',')[1] || '');
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    toast('PDF allegato (lettura diretta sul server).');
    return { base64: b64 };
  }
}

function pickFile() {
  const input = h('input', { type: 'file', multiple: true, accept: '.pdf,application/pdf,.txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.kt,.java,.html,.css,.csv,.log,.xml,.yml,.yaml,.sql,.sh,.bat,text/*,application/json,*/*' });
  input.addEventListener('change', async () => {
    const list = Array.from(input.files || []).slice(0, 4);
    for (const file of list) {
      if (file.type.startsWith('image/')) {
        try {
          const bmp = await createImageBitmap(file);
          const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
          const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
          canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
          store.pendingImage = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
        } catch { toast(`Impossibile leggere l'immagine ${file.name}.`); }
      } else if (file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) {
        toast(`Estraggo 4 fotogrammi dal video ${file.name}…`);
        try {
          const b64 = await extractVideoStoryboard(file);
          if (b64) {
            store.pendingImage = b64;
            store.pendingFiles = [...(store.pendingFiles || []).filter(x => x.name !== file.name), { name: file.name, size: file.size, content: `[Video "${file.name}" convertito in griglia 2x2 di 4 fotogrammi chiave nell'immagine allegata: analizza tutti gli oggetti/alimenti visibili]` }].slice(0, 4);
          } else {
            toast(`Impossibile estrarre fotogrammi da ${file.name}.`);
          }
        } catch { toast(`Impossibile leggere il video ${file.name}.`); }
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        toast(`Estraggo testo dal PDF ${file.name}…`);
        const pdf = await extractPdfContent(file);
        if (pdf.image) {
          store.pendingImage = pdf.image;
          store.pendingFiles = [...(store.pendingFiles || []).filter(x => x.name !== file.name), { name: file.name, size: file.size, content: '[PDF scansionato allegato come immagine]' }].slice(0, 4);
        } else if (pdf.text) {
          store.pendingFiles = [...(store.pendingFiles || []).filter(x => x.name !== file.name), { name: file.name, size: file.size, content: pdf.text }].slice(0, 4);
        } else if (pdf.base64) {
          store.pendingFiles = [...(store.pendingFiles || []).filter(x => x.name !== file.name), { name: file.name, size: file.size, encoding: 'base64', content: pdf.base64 }].slice(0, 4);
        } else {
          toast(`Impossibile leggere il PDF ${file.name}.`);
        }
      } else {
        try {
          const content = (await file.text()).slice(0, 60000);
          store.pendingFiles = [...(store.pendingFiles || []).filter(x => x.name !== file.name), { name: file.name, size: file.size, content }].slice(0, 4);
        } catch { toast(`Impossibile leggere il file ${file.name}.`); }
      }
    }
    render();
  });
  input.click();
}

async function extractVideoStoryboard(file) {
  const url = URL.createObjectURL(file);
  const vid = document.createElement('video');
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = 'auto';
  vid.src = url;
  try {
    await new Promise((res, rej) => {
      vid.onloadedmetadata = () => res();
      vid.onerror = () => rej(new Error('video error'));
    });
    const dur = Math.max(0.5, vid.duration || 2);
    const vw = vid.videoWidth || 640, vh = vid.videoHeight || 480;
    const cellW = 512, cellH = Math.round(cellW * (vh / vw));
    const canvas = document.createElement('canvas');
    canvas.width = cellW * 2;
    canvas.height = cellH * 2;
    const ctx = canvas.getContext('2d');
    const spots = [0.15, 0.4, 0.65, 0.9];
    for (let i = 0; i < spots.length; i++) {
      vid.currentTime = Math.min(dur - 0.05, dur * spots[i]);
      await new Promise((res) => {
        const done = () => { vid.removeEventListener('seeked', done); res(); };
        vid.addEventListener('seeked', done);
        setTimeout(done, 1200);
      });
      const x = (i % 2) * cellW, y = Math.floor(i / 2) * cellH;
      ctx.drawImage(vid, x, y, cellW, cellH);
    }
    return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
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

// ------------------------------------------------------------------ riquadri scelti da Jarvis

/** Contenuto di un riquadro: [titolo, valore grande, riga piccola]. */
function widgetData(w) {
  const s = store.state, t = s.today, b = s.balance;
  const kg = (v) => (v >= 0 ? '-' : '+') + Math.abs(v).toFixed(1) + ' kg';
  switch (w.type) {
    case 'deficit_cumulativo': return b ? ['Deficit accumulato', fmt(b.cumulativeDeficitVsMaintenance) + ' kcal', `≈ ${kg(b.estimatedWeightLossKg)} dal ${dateLabel(b.startDate)}`] : ['Deficit accumulato', '—', 'completa il profilo'];
    case 'calorie_oggi': return ['Calorie oggi', `${fmt(t.eaten)} / ${fmt(t.target)}`, t.remaining >= 0 ? `restano ${fmt(t.remaining)} kcal` : `oltre di ${fmt(-t.remaining)} kcal`];
    case 'macro_oggi': return ['Macro oggi', `P${t.protein} C${t.carbs} G${t.fat}`, `proteine obiettivo ${t.proteinTarget} g`];
    case 'passi_oggi': return ['Passi oggi', fmt(t.steps), t.burned ? `${fmt(t.burned)} kcal di attività` : 'nessuna attività'];
    case 'peso': {
      const ws = [...(s.diary.weights || [])].sort((a, c) => (a.date < c.date ? -1 : 1));
      const last = ws[ws.length - 1];
      return ['Peso', last ? last.kg + ' kg' : '—', last && ws.length > 1 ? `${kg(ws[0].kg - last.kg)} dal ${dateLabel(ws[0].date)}` : 'nessuna pesata'];
    }
    case 'deficit_medio': return b ? ['Deficit medio', fmt(b.avgDeficitPerDay) + ' kcal/g', `media netta ${fmt(b.avgNetKcalPerDay)} kcal`] : ['Deficit medio', '—', ''];
    case 'promemoria': { const r = s.reminders.find(x => !x.place) || s.reminders[0]; return ['Promemoria', r ? r.text : 'nessuno', r ? (r.place ? reminderWhen(r) : r.due.replace('T', ' ')) : '']; }
    case 'compiti': { const run = s.jobs.filter(j => j.status !== 'done' && j.status !== 'failed'); return ['Compiti', run.length ? String(run.length) : 'nessuno', run[0]?.title || '']; }
    case 'nota': return [w.title || 'Nota', '', w.text];
    default: return null;
  }
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h2 = Math.floor(s / 3600), m2 = Math.floor((s % 3600) / 60), s2 = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h2 > 0 ? `${h2}:${pad(m2)}:${pad(s2)}` : `${pad(m2)}:${pad(s2)}`;
}

// Ticker locale da 1 secondo per aggiornare in diretta timer, cronometri e schede vive senza ridisegnare la pagina.
if (!window.__jarvisLiveTick) {
  window.__jarvisLiveTick = setInterval(() => {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-countdown]')) {
      const rem = Number(el.getAttribute('data-countdown')) - now;
      el.textContent = rem > 0 ? fmtClock(rem) : '00:00';
      if (rem <= 0 && !el.dataset.done) {
        el.dataset.done = '1';
        setTimeout(() => { if (store.token && !store.sending) refresh().then(render).catch(() => {}); }, 1500);
      }
    }
    for (const el of document.querySelectorAll('[data-stopwatch]')) {
      const start = Number(el.getAttribute('data-stopwatch'));
      el.textContent = fmtClock(Math.max(0, now - start));
    }
  }, 1000);
}

/** Renderer modulare per tutte le attività vive (timer, cronometri, contatori, barre, checklist, dispositivi). */
function renderLiveCards(compact = false) {
  const cards = store.state?.liveCards || [];
  if (!cards.length) return null;
  const now = Date.now();
  return h('div', { class: 'live-cards' + (compact ? ' compact' : '') }, cards.map(c => {
    let body = null;
    if (c.kind === 'countdown' && c.targetMs) {
      body = h('b', { class: 'num live-big', 'data-countdown': String(c.targetMs) }, fmtClock(c.targetMs - now));
    } else if (c.kind === 'stopwatch' && c.startMs) {
      body = h('b', { class: 'num live-big', 'data-stopwatch': String(c.startMs) }, fmtClock(now - c.startMs));
    } else if (c.kind === 'progress') {
      const pct = c.max ? Math.min(100, Math.max(0, Math.round((Number(c.value || 0) / c.max) * 100))) : 0;
      body = h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        h('div', { class: 'row' }, h('b', { class: 'num' }, `${c.value ?? 0}${c.unit ? ' ' + c.unit : ''}`), c.max ? h('span', { class: 'muted small grow', style: 'text-align:right' }, `/ ${c.max}`) : null),
        h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })));
    } else if (c.kind === 'counter') {
      body = h('div', { class: 'row', style: 'gap:6px' },
        h('button', { class: 'btn', style: 'min-height:30px;padding:2px 10px', onclick: guard(() => act({ type: 'live_card', op: 'bump', id: c.id, delta: -1 })) }, '−'),
        h('b', { class: 'num live-big grow', style: 'text-align:center' }, `${c.value ?? 0}${c.unit ? ' ' + c.unit : ''}`),
        h('button', { class: 'btn primary', style: 'min-height:30px;padding:2px 10px', onclick: guard(() => act({ type: 'live_card', op: 'bump', id: c.id, delta: 1 })) }, '+'));
    } else if (c.kind === 'checklist' && Array.isArray(c.items)) {
      body = h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, c.items.map((it, idx) =>
        h('label', { class: 'check small', style: 'cursor:pointer' },
          h('input', { type: 'checkbox', checked: !!it.done, onchange: guard(() => act({ type: 'live_card', op: 'toggle', id: c.id, index: idx })) }),
          h('span', { style: it.done ? 'text-decoration:line-through;color:var(--muted)' : '' }, it.label))));
    } else {
      body = h('b', { class: 'num live-big' }, `${c.value ?? '—'}${c.unit ? ' ' + c.unit : ''}`);
    }
    return h('div', { class: 'live-card' },
      h('div', { class: 'row', style: 'gap:6px' },
        h('span', { class: 'wt grow clip' }, c.title),
        c.badge ? h('span', { class: 'tag ok' }, c.badge) : null,
        !c.system ? h('button', { class: 'wx', style: 'position:static;width:20px;height:20px', 'aria-label': 'Chiudi ' + c.title, onclick: guard(() => act({ type: 'live_card', op: 'remove', id: c.id })) }, '×') : null),
      body,
      c.subtitle ? h('span', { class: 'muted small clip' }, c.subtitle) : null);
  }));
}

function widgets(place) {
  const list = (store.state?.layout?.[place] || []).map(w => [w, widgetData(w)]).filter(([, d]) => d);
  if (!list.length) return null;
  return h('div', { class: 'widgets ' + place }, list.map(([w, [title, value, line]]) => h('div', { class: 'widget' },
    h('span', { class: 'wt' }, title),
    value ? h('b', { class: 'num' }, value) : null,
    line ? h('span', { class: 'muted small' }, line) : null,
    h('button', { class: 'wx', 'aria-label': 'Togli ' + title, onclick: guard(() => act({ type: 'ui_unpin', widget: w.type === 'nota' ? w.id : w.type, where: place })) }, '×'))));
}

/** Modifiche all'app preparate da Jarvis: si guardano in anteprima e si approvano o scartano. */
function codeBanner() {
  const items = store.state?.code || [];
  if (!items.length) return null;
  // Mentre Jarvis lavora, ricontrolla ogni 10 secondi finché l'anteprima è pronta.
  if (items.some(c => c.status === 'working') && !store.codePoll) {
    store.codePoll = setTimeout(async () => { store.codePoll = 0; try { await refresh(); render(); } catch { /* riprova al prossimo giro */ } }, 10000);
  }
  const op = (id, what) => guard(async () => {
    store.state = (await api('POST', `/code/${id}/${what}`)).state;
    render();
    toast(what === 'approve' ? 'Approvata: sarà online tra un paio di minuti.' : 'Modifica scartata.');
  });
  return h('div', { class: 'codebar' }, items.map(c => c.status === 'working'
    ? h('div', { class: 'banner' }, h('b', {}, 'Sto preparando la modifica'), h('p', { class: 'muted small' }, c.request))
    : h('div', { class: 'banner' }, h('b', {}, 'Modifica pronta'), h('p', { class: 'small' }, c.summary || c.request),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => { location.href = `/preview/${c.id}/`; } }, 'Anteprima'),
        h('button', { class: 'btn', onclick: op(c.id, 'approve') }, 'Approva'),
        h('button', { class: 'btn ghost danger', onclick: op(c.id, 'discard') }, 'Scarta')))));
}

function viewChat() {
  syncCompact();
  // La conversazione completa si apre solo se richiesta; altrimenti sotto la sfera c'è solo l'ultima risposta.
  const lastReply = [...store.messages].reverse().find(m => m.role === 'assistant');
  const lastUser = [...store.messages].reverse().find(m => m.role === 'user');
  const caption = store.sending
    ? h('div', { class: 'caption pending' }, lastUser ? h('span', { class: 'you' }, lastUser.text) : null, 'Sto pensando…')
    : h('div', { class: 'caption', 'aria-live': 'polite' }, lastReply ? lastReply.text : (native ? 'Dica "Jarvis" oppure scriva qui sotto.' : 'Scriva a Jarvis qui sotto.'),
      lastReply?.card ? h('span', { class: 'cardline' }, lastReply.card) : null,
      visualOf(lastReply));
  const list = h('div', { class: 'chat' },
    store.messages.length ? null : h('p', { class: 'empty' }, 'Scriva o parli a Jarvis: pasti, allenamenti, promemoria, cose da ricordare, compiti da svolgere.'),
    store.messages.map(m => h('div', { class: 'msg ' + (m.role === 'user' ? 'user' : 'assistant') },
      (m.image ? '📷 ' : '') + m.text,
      m.card ? h('span', { class: 'cardline' }, m.card) : null,
      visualOf(m),
      m.role === 'assistant' ? h('button', { type: 'button', class: 'btn icon ghost', style: 'padding:2px 6px;margin-left:6px;vertical-align:middle', title: 'Ascolta (IT/EN)', onclick: () => speakBilingual(m.text) }, '🔊') : null,
      m.model ? h('span', { class: 'meta' }, m.model.split(':').pop()) : null)),
    store.sending ? h('div', { class: 'msg assistant pending' }, 'Sto pensando…') : null);
  const ta = h('textarea', { rows: 1, placeholder: 'Scrivi o registra con 🎙️ e invia quando sei pronto…', 'aria-label': 'Messaggio', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value; ta.value = ''; send(v); } } });
  const attachBar = (store.pendingFiles && store.pendingFiles.length)
    ? h('div', { class: 'attachments' },
      store.pendingFiles.map((f, idx) =>
        h('span', { class: 'chip attach-chip' },
          `📎 ${f.name} (${Math.max(1, Math.round((f.size || f.content.length) / 1024))} KB) `,
          h('button', { type: 'button', class: 'attach-rm', 'aria-label': 'Rimuovi ' + f.name, onclick: () => { store.pendingFiles.splice(idx, 1); render(); } }, '×'))),
      h('button', { type: 'button', class: 'btn primary', style: 'padding:4px 10px;font-size:.82rem', onclick: guard(async () => {
        const files = store.pendingFiles.splice(0);
        const text = ta.value.trim(); ta.value = '';
        toast('Adatto Jarvis al file caricato…');
        const out = await api('POST', '/workspace/enter', { text, files });
        store.state = out.state;
        store.chatOpen = true;
        render();
        toast(`Workspace attivo: ${out.activeWorkspace.title}`);
      }) }, '🎯 Attiva come Workspace Progetto'))
    : null;
  const isTutor = store.state?.activeWorkspace?.kind === 'tutor';
  if (!store.recLang) store.recLang = isTutor ? 'en-US' : 'it-IT';
  const recBar = (isTutor || store.recording)
    ? h('div', { class: 'attachments', style: 'justify-content:space-between' },
      h('span', { class: 'muted small' }, store.recording ? `🔴 Sto registrando in ${store.recLang === 'en-US' ? '🇬🇧 Inglese' : '🇮🇹 Italiano'}… premi 🎙️ per fermare e invia con → quando sei pronto` : '🎙️ Modalità esercizio: registra e invia quando ti senti pronto'),
      h('button', { type: 'button', class: 'btn', style: 'padding:3px 8px;font-size:.78rem', onclick: () => { store.recLang = store.recLang === 'en-US' ? 'it-IT' : 'en-US'; render(); } }, store.recLang === 'en-US' ? '🇬🇧 EN' : '🇮🇹 IT'))
    : null;
  const composer = h('div', { class: 'composer' },
    store.pendingImage ? h('img', { class: 'thumb', alt: 'Foto allegata', src: 'data:image/jpeg;base64,' + store.pendingImage, onclick: () => { store.pendingImage = null; render(); } }) : null,
    h('button', { class: 'btn icon', title: 'Allega file', 'aria-label': 'Allega file', onclick: () => pickFile() }, icon(ICONS.file)),
    h('button', { class: 'btn icon', 'aria-label': native ? 'Scatta una foto' : 'Allega una foto', onclick: () => pickPhoto(!!native) }, icon(ICONS.photo)),
    h('button', { class: 'btn icon', title: 'Video Call Live con Jarvis', 'aria-label': 'Video Call Live', onclick: () => openLiveCall() }, icon(ICONS.video)),
    native ? h('button', { class: 'btn icon', 'aria-label': 'Scegli dalla galleria', onclick: () => pickPhoto(false) }, icon(ICONS.gallery)) : null,
    h('button', { class: 'btn icon' + (store.recording ? ' danger' : ''), title: 'Registra bozza vocale (invii tu quando sei pronto)', 'aria-label': 'Registra bozza vocale', onclick: () => toggleDraftRecording(ta) }, icon(ICONS.mic)),
    h('button', { class: 'btn icon' + (store.chatOpen ? ' on' : ''), 'aria-label': store.chatOpen ? 'Chiudi la chat' : 'Apri la chat', 'aria-pressed': store.chatOpen ? 'true' : 'false', onclick: () => { store.chatOpen = !store.chatOpen; render(); if (store.chatOpen) scrollChat(); } }, icon(ICONS.chat)),
    ta,
    h('button', { class: 'btn primary icon', 'aria-label': 'Invia', disabled: store.sending, onclick: () => { if (store.recording) stopDraftRecording(); const v = ta.value; ta.value = ''; send(v); } }, icon(ICONS.send)));
  const activeProj = (store.state?.jobs || []).find(j => j.status === 'planning' || j.status === 'running');
  const nextRem = (store.state?.reminders || [])[0];
  const nextTimed = (store.state?.timedActions || [])[0];
  const nextItem = nextTimed ? { title: nextTimed.command, when: new Date(nextTimed.dueMs).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) }
    : (nextRem && (!nextRem.dueMs || (nextRem.dueMs - Date.now()) < 36 * 3600_000) ? { title: nextRem.text, when: reminderWhen(nextRem) } : null);
  const upcomingBanner = nextItem && !store.chatOpen ? h('div', { class: 'codebar' }, h('div', { class: 'banner', style: 'cursor:pointer', onclick: () => go('attivita') },
    h('div', { class: 'row' }, h('b', { class: 'grow clip' }, `📅 In arrivo: ${nextItem.title}`), h('span', { class: 'tag ok' }, nextItem.when)))) : null;
  const projBanner = activeProj && !store.chatOpen ? h('div', { class: 'codebar' }, h('div', { class: 'banner', style: 'cursor:pointer', onclick: () => go('attivita') },
    h('div', { class: 'row' }, h('b', { class: 'grow clip' }, `⚙ Progetto: ${activeProj.title}`), h('span', { class: 'tag warn num' }, `${activeProj.stats?.pct || 0}%`)),
    h('div', { class: 'bar' }, h('i', { style: `width:${activeProj.stats?.pct || 8}%` })),
    h('span', { class: 'muted small' }, `${activeProj.stats?.done || 0}/${activeProj.stats?.total || '?'} nodi completati · tocca per dettagli`))) : null;
  const ws = store.state?.activeWorkspace;
  const wsPanel = ws ? renderAdaptiveWorkspace(ws) : null;
  return store.chatOpen
    ? [wsPanel, orb.el, list, attachBar, recBar, composer]
    : [wsPanel, codeBanner(), upcomingBanner, projBanner, renderLiveCards(true), widgets('jarvis'), orb.el, caption, attachBar, recBar, composer];
}

// ------------------------------------------------------------------ Sintesi bilingue IT/EN & Registrazione bozza vocale manuale

const EN_TTS_RE = /\b(i'm|you're|we're|they're|it's|didn't|doesn't|don't|wasn't|weren't|won't|i'd|i've|can't|would|could|should|going\s+to|have\s+you|the|was|were|with|from|this|that|there|here|what|where|when|why|how|yesterday|tomorrow|last\s+week|please|sorry|hello|thanks|amazing|wallet|movie|weekend|question|walk)\b/i;
const IT_TTS_RE = /\b(che|per|con|non|sono|hai|abbiamo|signore|esercizio|frase|regola|errore|ripeti|lezione|domani|stasera|oggi|bene|bravo|giusto|sbagliato|risposta|prova|adesso|ora|questo|questa|quello|quella|anche|perch[eé]|come|quando|dove|quindi|allora|molto|poco|tutto|tutti)\b/i;

function speakBilingual(text, onDone) {
  const clean = String(text || '').replace(/[*_`#]/g, ' ').trim();
  if (!clean) { onDone?.(); return; }
  if (native) {
    nativeCall('speak', clean);
    setTimeout(() => onDone?.(), Math.min(18000, 1200 + clean.length * 60));
    return;
  }
  if (!window.speechSynthesis) { onDone?.(); return; }
  window.speechSynthesis.cancel();
  const parts = clean.split(/(?<=[.!?;:\n])\s+|(?="[^"]+")|(?<=")\s+/).map(s => s.replace(/"/g, '').trim()).filter(Boolean);
  const segs = [];
  for (const p of parts) {
    const lang = (EN_TTS_RE.test(p) && !IT_TTS_RE.test(p)) ? 'en-US' : 'it-IT';
    if (segs.length && segs[segs.length - 1].lang === lang) segs[segs.length - 1].text += ' ' + p;
    else segs.push({ text: p, lang });
  }
  if (!segs.length) { onDone?.(); return; }
  const voices = window.speechSynthesis.getVoices?.() || [];
  const pickMaleWebVoice = (langPrefix) => {
    const pool = voices.filter(v => String(v.lang || '').toLowerCase().startsWith(langPrefix));
    const maleRe = /\b(male|cosimo|luca|marco|diego|giorgio|david|daniel|george|guy|ryan|andrew|mark|brian|christopher)\b/i;
    const femaleRe = /\b(female|elsa|alice|federica|paola|zira|samantha|victoria|jenny|aria|susan|isabella)\b/i;
    const natRe = /\b(natural|neural|online|google|premium|enhanced|wavenet)\b/i;
    const score = (v) => (femaleRe.test(v.name) ? -100 : 0) + (maleRe.test(v.name) ? 30 : 0) + (natRe.test(v.name) ? 20 : 0) + (!v.localService ? 5 : 0);
    return pool.slice().sort((a, b) => score(b) - score(a))[0] || null;
  };
  segs.forEach((sg, idx) => {
    const u = new SpeechSynthesisUtterance(sg.text);
    u.lang = sg.lang;
    const mv = pickMaleWebVoice(sg.lang.slice(0, 2));
    if (mv) u.voice = mv;
    u.pitch = 0.96;
    u.rate = sg.lang === 'en-US' ? 0.94 : 1.0;
    if (idx === segs.length - 1) { u.onend = () => onDone?.(); u.onerror = () => onDone?.(); }
    window.speechSynthesis.speak(u);
  });
}

let draftRecog = null;
function stopDraftRecording() {
  store.recording = false;
  try { draftRecog?.stop(); } catch {}
  draftRecog = null;
  render();
}
function toggleDraftRecording(ta) {
  if (store.recording) { stopDraftRecording(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (native) nativeCall('listenNow');
    else toast('Riconoscimento vocale non supportato su questo browser.');
    return;
  }
  try {
    draftRecog = new SR();
    draftRecog.lang = store.recLang || (store.state?.activeWorkspace?.kind === 'tutor' ? 'en-US' : 'it-IT');
    draftRecog.continuous = true;
    draftRecog.interimResults = true;
    let baseText = ta.value ? ta.value.trim() + ' ' : '';
    store.recording = true;
    render();
    draftRecog.onresult = (ev) => {
      let finalChunk = '';
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0]?.transcript || '';
        if (ev.results[i].isFinal) finalChunk += t + ' ';
        else interim += t;
      }
      if (finalChunk) baseText += finalChunk;
      ta.value = (baseText + interim).trim();
    };
    draftRecog.onerror = () => {};
    draftRecog.onend = () => {
      if (store.recording) {
        try { draftRecog.start(); } catch { stopDraftRecording(); }
      }
    };
    draftRecog.start();
  } catch (e) {
    store.recording = false;
    toast('Impossibile avviare la registrazione: ' + e.message);
  }
}

function renderAdaptiveWorkspace(ws) {
  const timerState = store.wsTimer || { running: false, endMs: 0, label: '' };
  const tickTxt = timerState.running ? (() => {
    const rem = Math.max(0, Math.round((timerState.endMs - Date.now()) / 1000));
    const m = Math.floor(rem / 60), s = rem % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  })() : '';

  return h('div', { class: 'ws-panel' },
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'muted small' }, `🎯 MODALITÀ PROGETTO · ${String(ws.kind || 'progetto').toUpperCase()}`),
        h('b', { style: 'font-size:1.02rem;color:#39ff14' }, ws.title)),
      h('button', { class: 'btn danger', style: 'padding:5px 10px;font-size:.82rem', onclick: guard(async () => {
        const out = await api('POST', '/workspace/exit');
        store.state = out.state;
        store.wsTimer = null;
        render();
        toast('Tornato all\'assetto standard di Jarvis.');
      }) }, '✕ Esci')),
    h('div', { class: 'ws-grid' }, (ws.widgets || []).map((w, wIdx) => {
      if (w.type === 'timer') {
        const mins = Number(w.minutes) || 25;
        return h('div', { class: 'ws-card' },
          h('div', { class: 'muted small' }, `⏱ ${w.title || 'Timer'}`),
          h('div', { class: 'row', style: 'margin-top:4px' },
            h('b', { class: 'num', style: 'font-size:1.1rem;color:#39ff14' }, timerState.running ? tickTxt : `${mins}:00`),
            h('button', { class: 'btn', style: 'padding:3px 9px;font-size:.8rem', onclick: () => {
              if (timerState.running) { store.wsTimer = { running: false, endMs: 0 }; clearInterval(store.wsTick); render(); return; }
              store.wsTimer = { running: true, endMs: Date.now() + mins * 60_000 };
              clearInterval(store.wsTick);
              store.wsTick = setInterval(() => { if (!store.wsTimer?.running) return clearInterval(store.wsTick); render(); }, 1000);
              render();
            } }, timerState.running ? 'Ferma' : 'Avvia')));
      }
      if (w.type === 'progress') {
        const pct = Math.min(100, Math.round(((Number(w.value) || 0) / Math.max(1, Number(w.max) || 100)) * 100));
        return h('div', { class: 'ws-card' },
          h('div', { class: 'muted small' }, w.title || 'Avanzamento'),
          w.label ? h('div', { class: 'small', style: 'margin:2px 0' }, w.label) : null,
          h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })));
      }
      if (w.type === 'checklist') {
        return h('div', { class: 'ws-card ws-wide' },
          h('div', { class: 'muted small', style: 'margin-bottom:4px' }, `☑ ${w.title || 'Fasi'}`),
          (w.items || []).map((it, iIdx) => h('label', { class: 'ws-check' },
            h('input', { type: 'checkbox', checked: !!it.done, onchange: guard(async () => {
              const res = await api('POST', '/workspace/toggle', { widgetIdx: wIdx, itemIdx: iIdx });
              store.state.activeWorkspace = res.activeWorkspace;
              render();
            }) }),
            h('span', { style: it.done ? 'text-decoration:line-through;opacity:.6' : '' }, it.label))));
      }
      if (w.type === 'table' && Array.isArray(w.rows)) {
        return h('div', { class: 'ws-card ws-wide' },
          h('div', { class: 'muted small', style: 'margin-bottom:4px' }, `📋 ${w.title || 'Riferimento'}`),
          w.rows.slice(0, 6).map(r => h('div', { class: 'ws-row-tbl small' }, Array.isArray(r) ? r.join(' → ') : String(r))));
      }
      if (w.type === 'actions' && Array.isArray(w.buttons)) {
        return h('div', { class: 'ws-card ws-wide' },
          h('div', { class: 'row wrap' }, w.buttons.slice(0, 5).map(btnTxt =>
            h('button', { class: 'btn', style: 'padding:5px 9px;font-size:.8rem', onclick: () => { store.chatOpen = true; send(btnTxt); } }, btnTxt))));
      }
      return null;
    })));
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
    widgets('oggi'),
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

function reminderWhen(r) {
  if (r.place) return `${r.when === 'uscita' ? 'Quando esce da' : 'Quando arriva a'} ${r.placeName}${r.repeat ? ' · ogni volta' : ''}${r.placeKnown ? '' : ' · luogo da salvare'}`;
  return new Date(r.dueMs).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) + ({ giorno: ' · ogni giorno', feriali: ' · dal lunedì al venerdì', settimana: ' · ogni settimana', mese: ' · ogni mese' }[r.repeat] || '');
}

function viewLuoghi(s) {
  const places = s.places || [];
  const name = h('input', { placeholder: 'Es. Casa, Palestra, Lavoro', 'aria-label': 'Nome del luogo' });
  const perm = native ? nativeCall('locationStatus') : 'always';
  return h('div', { class: 'card' }, h('h2', {}, 'Luoghi'),
    h('p', { class: 'muted' }, 'Per i promemoria "quando arrivo a casa". Si salva la posizione in cui si trova adesso.'),
    native && perm !== 'always' ? h('div', { class: 'row wrap' },
      h('p', { class: 'grow' }, perm === 'foreground' ? 'Per avvisarla anche ad app chiusa scelga "Consenti sempre" nella posizione.' : 'Jarvis non ha ancora il permesso della posizione.'),
      h('button', { class: 'btn', onclick: () => { nativeCall('requestLocation'); setTimeout(render, 1500); } }, 'Concedi posizione')) : null,
    h('div', { class: 'row wrap' }, name, h('button', { class: 'btn primary', onclick: () => {
      if (!name.value.trim()) return toast('Dia un nome al luogo.');
      savePlaceHere(name.value);
    } }, 'Salva dove sono ora')),
    places.length ? h('div', { class: 'list' }, places.map(p => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', {}, p.name), h('div', { class: 'muted num' }, `raggio ${p.radius} m`)),
      h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina luogo', onclick: guard(async () => { s.places = (await api('DELETE', '/places/' + encodeURIComponent(p.key))).places; syncPlaces(s.places); render(); }) }, icon(ICONS.trash)))))
      : h('p', { class: 'empty' }, 'Nessun luogo. Quando è a casa può dire: "Jarvis, salva questo posto come casa".'));
}

function formatWait(ms) {
  const diff = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (diff < 60) return `tra ${diff} min`;
  const h = Math.floor(diff / 60), m = diff % 60;
  return h >= 24 ? `tra ${Math.floor(h / 24)}g ${h % 24}h` : `tra ${h}h ${m}m`;
}

function viewUpcomingCard(s) {
  const items = [
    ...(s.timedActions || []).map(t => ({ id: t.id, kind: 'Azione programmata', title: t.command, when: new Date(t.dueMs).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }), wait: formatWait(t.dueMs), dueMs: Number(t.dueMs) })),
    ...(s.reminders || []).map(r => ({ id: r.id, kind: 'Promemoria', title: r.text, when: reminderWhen(r), wait: r.dueMs ? formatWait(r.dueMs) : '', dueMs: Number(r.dueMs || 0), isRem: true })),
  ].sort((a, b) => (a.dueMs || 0) - (b.dueMs || 0));

  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, '📅 Attività Programmate (In anticipo)'), h('span', { class: 'tag ok num' }, String(items.length))),
    h('p', { class: 'muted small' }, 'Finestra dedicata alle attività future, lezioni, sveglie e azioni automatiche in arrivo.'),
    items.length ? h('div', { class: 'list' }, items.map(it => h('div', { class: 'item' },
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, it.title)),
        h('div', { class: 'muted small num' }, `${it.kind} · ${it.when}${it.wait ? ` (${it.wait})` : ''}`)),
      it.isRem ? h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina', onclick: guard(async () => { s.reminders = (await api('DELETE', '/reminders/' + it.id)).reminders; render(); }) }, icon(ICONS.trash)) : null)))
      : h('p', { class: 'empty' }, 'Nessuna attività programmata in anticipo. Puoi chiedere es. "ricordami stasera alle 21..." o "tra 10 minuti apri YouTube sul PC".'));
}

function openDocViewer(title, html) {
  document.getElementById('doc-viewer-modal')?.remove();
  const iframe = h('iframe', { class: 'doc-frame', srcdoc: html, title: title || 'Documento' });
  const close = () => overlay.remove();
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    a.download = (String(title || 'documento').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'documento') + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const printDoc = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { download(); }
  };
  const overlay = h('div', { id: 'doc-viewer-modal', class: 'live-overlay' },
    h('div', { class: 'live-top' },
      h('b', { class: 'grow clip', style: 'color:#39ff14' }, `📄 ${title || 'Documento'}`),
      h('button', { class: 'btn primary', onclick: printDoc }, '🖨️ Stampa / PDF'),
      h('button', { class: 'btn', onclick: download }, '⬇ Scarica'),
      h('button', { class: 'btn danger', onclick: close }, '✕ Chiudi')),
    h('div', { class: 'doc-stage' }, iframe));
  document.body.append(overlay);
}

function viewManualAutomationCard(s) {
  const skills = s.skills || [];
  const forcePc = guard(async (kind, target, label) => {
    await api('POST', '/devices/command', { targetDevice: 'desktop', kind, target });
    toast(`Forzato sul PC: ${label || target}`);
  });
  const accIn = h('input', { placeholder: 'Profilo/account (opz. es. Ale)', style: 'max-width:170px' });
  const mediaIn = h('input', { placeholder: 'Titolo/ricerca (opz.)', style: 'max-width:170px' });
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, '⚡ Automatismi & Forza Esecuzione'), h('span', { class: 'tag ok num' }, String(skills.length))),
    h('p', { class: 'muted small' }, 'Accesso manuale per forzare subito gli automatismi salvati o le azioni dirette sul PC senza passare dalla voce.'),
    h('div', { class: 'row wrap', style: 'margin-bottom:8px' },
      [['Chrome', 'open_app', 'chrome'], ['YouTube', 'open_url', 'https://www.youtube.com'], ['Prime Video', 'open_url', 'https://www.primevideo.com'], ['Chiudi Scheda', 'hotkey', 'ctrl+w'], ['Chiudi Chrome', 'close_app', 'chrome'], ['Play/Pausa', 'system', 'play_pause'], ['Screenshot PC', 'capture_screen', 'screen']].map(([lbl, k, t]) =>
        h('button', { class: 'btn', onclick: () => forcePc(k, t, lbl) }, lbl))),
    skills.length ? h('div', { class: 'row wrap', style: 'margin-bottom:6px' }, accIn, mediaIn) : null,
    skills.length ? h('div', { class: 'list' }, skills.map(sk => h('div', { class: 'item' },
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, sk.name), ' ', h('span', { class: 'tag' }, sk.device)),
        h('div', { class: 'muted small' }, (sk.steps || []).map(st => st.optional ? `[opz: ${st.param}]` : `${st.kind}:${st.target}`).join(' → '))),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const out = await api('POST', '/skills/run', { id: sk.id, account: accIn.value.trim(), media: mediaIn.value.trim() });
        runDeviceActions(out.device);
        toast(`Forzato: ${sk.name} (${out.executed} step)`);
      }) }, '▶ Forza'),
      h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina automatismo', onclick: guard(async () => {
        s.skills = (await api('DELETE', '/skills/' + encodeURIComponent(sk.id))).skills; render();
      }) }, icon(ICONS.trash)))))
      : h('p', { class: 'empty' }, 'Nessun automatismo modulare salvato ancora. Quando confermi "ha funzionato", apparirà qui.'));
}

function viewAttivita() {
  const s = store.state;
  const text = h('input', { placeholder: 'Cosa devo ricordarle?', 'aria-label': 'Testo del promemoria' });
  const due = h('input', { type: 'datetime-local', 'aria-label': 'Data e ora', value: s.now, style: 'max-width:220px' });
  const goal = h('textarea', { rows: 2, placeholder: 'Es. Pianifica i pasti della settimana con lista della spesa', 'aria-label': 'Compito' });
  return [
    viewUpcomingCard(s),
    viewManualAutomationCard(s),
    (store.state?.liveCards || []).length ? h('div', { class: 'card' }, h('h2', {}, 'Attività vive in diretta'), renderLiveCards(false)) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Promemoria'),
      h('div', { class: 'row wrap' }, text, due, h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!text.value.trim() || !due.value) return toast('Servono testo e orario.');
        s.reminders = (await api('POST', '/reminders', { text: text.value, due: due.value })).reminders; render();
      }) }, 'Aggiungi')),
      s.reminders.length ? h('div', { class: 'list' }, s.reminders.map(r => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', {}, r.text), h('div', { class: 'muted num' }, reminderWhen(r))),
        h('button', { class: 'btn icon ghost danger', 'aria-label': 'Elimina promemoria', onclick: guard(async () => { s.reminders = (await api('DELETE', '/reminders/' + r.id)).reminders; render(); }) }, icon(ICONS.trash)))))
        : h('p', { class: 'empty' }, 'Nessun promemoria. Può anche dire: "Jarvis, ricordami alle 18 di chiamare il dentista".')),
    viewLuoghi(s),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Progetti e Compiti Multi-Agente'),
        s.jobs.some(j => j.status === 'planning' || j.status === 'running') ? h('span', { class: 'tag warn' }, '● In esecuzione') : null),
      h('p', { class: 'muted' }, 'Jarvis divide i progetti complessi in nodi-agente, li esegue in autonomia e mostra qui avanzamento e statistiche.'),
      goal, h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!goal.value.trim()) return;
        s.jobs = (await api('POST', '/jobs', { goal: goal.value })).jobs; goal.value = ''; render(); toast('Progetto avviato.');
      }) }, 'Avvia Progetto')),
    ...(s.jobs.length ? s.jobs.map(j => {
      const st = j.stats || { total: j.steps.length, done: j.steps.filter(x => x.status === 'done').length, pct: 0, files: [], models: [] };
      const pct = st.pct ?? (st.total ? Math.round((st.done / st.total) * 100) : 0);
      if ((j.status === 'planning' || j.status === 'running') && !store.jobPoll) {
        store.jobPoll = setTimeout(async () => { store.jobPoll = 0; try { await refresh(); render(); } catch {} }, 6000);
      }
      return h('div', { class: 'card project-card' },
        h('div', { class: 'row' }, h('h3', { class: 'grow clip', style: 'color:var(--text)' }, j.title), jobTag(j)),
        h('div', { class: 'row', style: 'gap:8px' },
          h('div', { class: 'bar grow' }, h('i', { style: `width:${pct}%` })),
          h('span', { class: 'num small', style: 'color:var(--primary);font-weight:700' }, `${pct}%`)),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Nodi'), h('b', {}, `${st.done} / ${st.total || '—'}`)),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'File creati'), h('b', {}, st.files?.length ? String(st.files.length) : '0')),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, 'Aggiornato'), h('b', { class: 'small' }, (j.updated || j.created || '').slice(11, 16) || '—'))),
        st.models?.length ? h('div', { class: 'chips' }, st.models.map(m => h('span', { class: 'chip' }, m))) : null,
        st.files?.length ? h('div', { class: 'muted small' }, `File: ${st.files.join(', ')}`) : null,
        j.steps.length ? h('div', { class: 'list' }, j.steps.map(x => h('div', { class: 'item', style: 'padding:5px 0' },
          h('span', { style: `color:${x.status === 'done' ? 'var(--primary)' : 'var(--muted)'}` }, x.status === 'done' ? '✓' : '○'),
          h('span', { class: 'grow small' }, (x.role ? `[${x.role}] ` : '') + x.title),
          x.model ? h('span', { class: 'tag' }, x.model) : null))) : null,
        store.openJob === j.id && j.result ? h('p', { class: 'pre small', style: 'margin-top:6px;border-top:1px solid var(--line);padding-top:8px' }, j.result) : null,
        h('div', { class: 'row wrap', style: 'margin-top:4px' },
          h('button', { class: 'btn primary', onclick: guard(async () => {
            toast('Preparo la modalità Workspace del progetto…');
            const out = await api('POST', '/workspace/enter', { jobId: j.id });
            store.state = out.state;
            store.chatOpen = true;
            go('chat');
          }) }, '🎯 Apri Workspace'),
          j.result ? h('button', { class: 'btn', onclick: () => { store.openJob = store.openJob === j.id ? null : j.id; render(); } }, store.openJob === j.id ? 'Chiudi risultato' : 'Leggi risultato') : null,
          j.status === 'done' ? h('button', { class: 'btn primary', onclick: guard(async () => {
            const res = await fetch('/api/jobs/' + j.id + '/document', { headers: { authorization: 'Bearer ' + store.token } });
            if (!res.ok) throw new Error('Impossibile caricare il documento (' + res.status + ')');
            const html = await res.text();
            openDocViewer(j.title, html);
          }) }, 'Apri Documento / PDF') : null,
          h('button', { class: 'btn ghost danger', onclick: guard(async () => { s.jobs = (await api('DELETE', '/jobs/' + j.id)).jobs; render(); }) }, 'Elimina')));
    }) : [h('p', { class: 'empty' }, 'Nessun progetto ancora. Chiedi a Jarvis in chat o avviane uno qui sopra.')]),
  ];
}
const jobTag = (j) => h('span', { class: 'tag ' + ({ done: 'ok', failed: 'bad' }[j.status] || 'warn') }, { planning: 'pianifico', running: 'in corso', done: 'completato', failed: 'non riuscito' }[j.status] || j.status);

// ------------------------------------------------------------------ altro

const SUBS = [['storico', 'Storico'], ['mente', 'Mente'], ['dispositivi', 'Dispositivi'], ['memoria', 'Memoria'], ['modelli', 'Modelli'], ['profilo', 'Profilo'], ['impostazioni', 'Impostazioni']];

function viewAltro() {
  const bar = h('div', { class: 'row wrap' }, SUBS.map(([id, label]) => h('button', { class: 'btn' + (store.sub === id ? ' primary' : ''), 'aria-pressed': String(store.sub === id), onclick: () => go('altro', id) }, label)));
  const body = { storico: viewStorico, mente: viewMente, dispositivi: viewDispositivi, memoria: viewMemoria, modelli: viewModelli, profilo: viewProfilo, impostazioni: viewImpostazioni }[store.sub]();
  return [bar, ...body];
}

function viewDispositivi() {
  if (!store.devices) { api('GET', '/devices').then(d => { store.devices = d; render(); }).catch(e => toast(e.message)); return [h('p', { class: 'empty' }, 'Carico i dispositivi connessi…')]; }
  const devs = store.devices.devices || [];
  const hist = store.devices.history || [];
  const reload = async () => { store.devices = await api('GET', '/devices'); render(); };
  const sendPc = guard(async (kind, target) => {
    await api('POST', '/devices/command', { targetDevice: 'desktop', kind, target });
    toast(`Comando inviato al PC: ${target}`);
    await reload();
  });
  const customApp = h('input', { placeholder: 'Programma o URL da aprire sul PC (es. Chrome, code, https://...)', style: 'flex:1;min-width:190px' });
  return [
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Manager Multi-Dispositivo (Jarvis Core)'), h('button', { class: 'btn', onclick: guard(reload) }, 'Aggiorna')),
      h('p', { class: 'muted small' }, 'Controlla da qui o con la voce ("Jarvis apri Chrome sul PC", "metti in pausa sul PC") sia lo smartphone sia il computer desktop.'),
      devs.length ? h('div', { class: 'list' }, devs.map(d => {
        const m = d.metrics || {};
        return h('div', { class: 'item' },
          h('div', { class: 'grow' },
            h('div', {}, h('b', {}, d.name), ' · ', h('span', { class: 'muted small' }, d.platform || d.kind)),
            h('div', { class: 'muted small num' }, [
              m.cpu ? `CPU ${Math.round(m.cpu)}%` : '',
              m.ram ? `RAM ${Math.round(m.ram)}%` : '',
              m.battery != null ? `Batteria ${Math.round(m.battery)}%` : '',
              m.activeWindow ? `Attivo: ${m.activeWindow}` : '',
            ].filter(Boolean).join(' · ') || 'Pronto')),
          h('span', { class: 'tag ' + (d.online ? 'ok' : 'warn') }, d.online ? '● Online' : '○ Offline'));
      })) : h('p', { class: 'empty' }, 'Nessun PC Desktop ancora connesso. Avvia desktop/Avvia_Jarvis_PC.bat sul computer per collegarlo.')),
    h('div', { class: 'card' }, h('h2', {}, 'Controllo rapido PC Desktop'),
      h('div', { class: 'row wrap' },
        [['Apri Chrome', 'open_app', 'chrome'], ['Apri VS Code', 'open_app', 'code'], ['Esplora File', 'open_app', 'explorer'], ['Terminale', 'open_app', 'powershell'], ['Play / Pausa', 'system', 'play_pause'], ['Volume +', 'system', 'vol_up'], ['Volume -', 'system', 'vol_down'], ['Blocca PC', 'system', 'lock']].map(([lbl, k, t]) =>
          h('button', { class: 'btn', onclick: () => sendPc(k, t) }, lbl))),
      h('div', { class: 'row wrap', style: 'margin-top:8px' },
        customApp,
        h('button', { class: 'btn primary', onclick: () => {
          const v = customApp.value.trim();
          if (!v) return;
          sendPc(/^https?:\/\//i.test(v) ? 'open_url' : 'open_app', v);
          customApp.value = '';
        } }, 'Esegui su PC'))),
    hist.length ? h('div', { class: 'card' }, h('h2', {}, 'Ultimi comandi multi-dispositivo'),
      h('div', { class: 'list' }, hist.slice(0, 8).map(c => h('div', { class: 'item' },
        h('span', { class: 'tag' }, c.targetDevice),
        h('span', { class: 'grow small' }, `${c.kind}: ${c.target}`))))) : null,
  ];
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

const RING_NAMES = ['interno', 'medio', 'esterno'];
const ringName = (r) => RING_NAMES[r] || `livello ${r + 1}`;

/** Come Jarvis archivia e usa i contesti: blocchi piccoli, uno per dipartimento, argomento o riassunto. */
function viewMente() {
  if (!store.mind) { api('GET', '/mind').then(m => { store.mind = m; render(); }).catch(e => toast(e.message)); return [h('p', { class: 'empty' }, 'Carico la mente di Jarvis…')]; }
  const m = store.mind;
  const chip = (text, cls = '') => h('span', { class: 'tag ' + cls }, text);
  const topicTree = (topics) => {
    const top = topics.filter(t => !t.parent || !topics.some(p => p.name === t.parent));
    return h('div', { class: 'chips' }, top.map(t => {
      const subs = topics.filter(s => s.parent === t.name);
      return h('span', { class: 'chip' }, t.label, subs.length ? h('span', { class: 'muted' }, ' › ' + subs.map(s => s.label).join(', ')) : null);
    }));
  };
  return [
    h('div', { class: 'card' }, h('h2', {}, 'Come lavora'),
      h('div', { class: 'blocks' },
        h('div', { class: 'block' }, h('b', {}, 'Nucleo'), h('span', { class: 'muted small' }, 'Personalità, umore e il tuo profilo: sempre presenti.')),
        h('div', { class: 'block' }, h('b', {}, 'Dipartimenti'), h('span', { class: 'muted small' }, 'Un cassetto per area. Entra nel contesto solo se ne parli.')),
        h('div', { class: 'block' }, h('b', {}, 'Riassunti'), h('span', { class: 'muted small' }, 'Le conversazioni lunghe diventano un riassunto breve.')),
        h('div', { class: 'block' }, h('b', {}, 'Compiti'), h('span', { class: 'muted small' }, 'Lavori lunghi a passi, ognuno con un contesto pulito.')))),
    h('div', { class: 'card' }, h('h2', {}, 'Nel contesto adesso'),
      m.active.length ? h('div', { class: 'chips' }, m.active.map(a => chip(a, 'ok'))) : h('p', { class: 'muted small' }, 'Solo il nucleo: nessun dipartimento aperto.')),
    h('div', { class: 'card' }, h('h2', {}, 'Automazioni sul telefono'),
      h('p', { class: 'muted small' }, 'Percorsi autonomi generati in automatico quando chiedi a Jarvis di usare un\'app (nodi verdi/viola sulla sfera).'),
      (m.automations && m.automations.length)
        ? h('div', { class: 'chips' }, m.automations.map(a => chip(a.label, 'ok')))
        : h('p', { class: 'muted small' }, 'Nessuna automazione attiva.')),
    h('div', { class: 'card' }, h('h2', {}, 'Dipartimenti'),
      h('p', { class: 'muted small' }, 'Dal più interno (personale, leggero, usato spesso) al più esterno (pesante, accessorio, raro).'),
      m.departments.length ? h('div', { class: 'blocks' }, m.departments.map(d => h('div', { class: 'block' },
        h('b', { style: 'overflow-wrap:anywhere' }, d.label), chip(ringName(d.ring)),
        h('span', { class: 'muted small' }, `${d.entries} ${d.entries === 1 ? 'ricordo' : 'ricordi'} · ${d.topics.length} ${d.topics.length === 1 ? 'argomento' : 'argomenti'} · usato ${d.uses}`),
        d.description ? h('span', { class: 'muted small clip' }, d.description) : null,
        d.topics.length ? topicTree(d.topics) : null)))
        : h('p', { class: 'empty' }, 'Nessun dipartimento ancora.'),
      m.core.length ? h('div', { class: 'chips', style: 'margin-top:8px' }, m.core.map(c => chip(`${c.label} · ${c.count} · ${ringName(c.ring)}`))) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Riassunti delle conversazioni'),
      m.summaries.length ? h('div', { class: 'blocks' }, m.summaries.map(s => h('details', { class: 'block' },
        h('summary', {}, h('span', { class: 'muted small num' }, (s.updated || '').slice(0, 16).replace('T', ' ')), ' ', s.summary.slice(0, 90) + (s.summary.length > 90 ? '…' : '')),
        h('p', { class: 'small' }, s.summary))))
        : h('p', { class: 'muted small' }, 'Ancora nessuna conversazione abbastanza lunga da riassumere.')),
    m.jobs.length ? h('div', { class: 'card' }, h('h2', {}, 'Progetti e compiti'),
      h('div', { class: 'chips' }, m.jobs.map(j => chip(`${j.title} · ${j.status} · ${j.steps} passi`, j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : '')))) : null,
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
      h('div', {}, h('div', { class: 'small' }, 'Sensibilità quando lo chiama'),
        h('div', { class: 'row wrap' }, [['Bassa', 0.2, 'solo "Ehi Jarvis" all\'inizio'], ['Media', 0.5, 'consigliata'], ['Alta', 0.85, 'risponde anche a nomi simili']].map(([label, v, hint]) =>
          h('button', { class: 'btn' + (Math.abs((cfg.sensitivity ?? 0.5) - v) < 0.2 ? ' primary' : ''), title: hint, onclick: () => { nativeCall('setSensitivity', v); setTimeout(render, 200); } }, label))),
        h('div', { class: 'muted small' }, (cfg.sensitivity ?? 0.5) < 0.35 ? 'Bassa: risponde solo se inizia con "Jarvis" o "Ehi Jarvis".' : (cfg.sensitivity ?? 0.5) > 0.7 ? 'Alta: capisce anche "Jervis", "Giarvis" e il nome in mezzo alla frase.' : 'Media: il nome all\'inizio o alla fine; in mezzo al discorso decide dal contesto.')),
      h('div', { class: 'row wrap' },
        h('p', { class: 'grow' }, nativeCall('phoneControlStatus') === true
          ? 'Jarvis può usare il telefono al posto suo (tocca, scrive, legge). Si ferma prima di inviare, pagare o eliminare cose non richieste.'
          : 'Per far usare il telefono a Jarvis ("scrivi a Marco che arrivo") attivi "Jarvis: usa il telefono" in Accessibilità.'),
        nativeCall('phoneControlStatus') === true ? null : h('button', { class: 'btn', onclick: () => nativeCall('openPhoneControlSettings') }, 'Apri Accessibilità')),
      typeof native.openOverlaySettings === 'function' ? h('div', {},
        cfg.overlayAllowed
          ? toggle('Mostra Jarvis sopra le altre app (sfera, frasi e grafiche) quando lo chiamo', 'overlay', 'setOverlay')
          : h('div', { class: 'row wrap' },
            h('p', { class: 'grow' }, 'Per vedere Jarvis e le sue grafiche sopra le altre app, senza che si apra la sua app, attivi "Mostra sopra altre app".'),
            h('button', { class: 'btn', onclick: () => { nativeCall('openOverlaySettings'); setTimeout(render, 3000); } }, 'Attiva'))) : null,
      typeof native.setPhonePassword === 'function' || typeof native.enrollVoice === 'function' ? h('div', {},
        h('div', { class: 'small' }, 'Parola d\'ordine opzionale ("niente più fili")'),
        toggle('Attiva richiesta parola d\'ordine ("niente più fili") per le attività sul telefono (disattivata di default)', 'voiceLock', 'setVoiceLock'),
        cfg.voiceLock ? h('div', { class: 'row wrap', style: 'margin-top:6px' },
          h('input', { id: 'phonePwdInput', type: 'text', placeholder: 'Parola d\'ordine (predefinita: niente più fili)', style: 'flex:1;min-width:180px' }),
          h('button', { class: 'btn primary', onclick: () => {
            const el = document.getElementById('phonePwdInput');
            const val = (el && el.value || '').trim() || 'niente più fili';
            nativeCall('setPhonePassword', val);
            if (el) el.value = '';
            toast(`Parola d'ordine impostata: "${val}"`);
            setTimeout(render, 200);
          } }, 'Salva parola d\'ordine')) : null) : null,
      typeof native.callPermission === 'function' ? h('div', { class: 'row wrap' },
        h('p', { class: 'grow' }, nativeCall('callPermission') === true ? 'Jarvis può telefonare ai contatti della rubrica ("chiama Marco").' : 'Per le telefonate ("chiama Marco") Jarvis ha bisogno dei permessi Contatti e Telefono.'),
        nativeCall('callPermission') === true ? null : h('button', { class: 'btn', onclick: () => { nativeCall('requestCallPermission'); setTimeout(render, 2500); } }, 'Concedi')) : null,
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
function go(tab, sub) { store.tab = tab; if (sub) { if (sub !== store.sub) { store.mind = null; store.memory = null; } store.sub = sub; } render(); if (tab === 'chat') scrollChat(); }

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
  if (store.tab === 'chat') app.append(...viewChat().filter(Boolean));
  else app.append(h('main', {}, { oggi: viewOggi, cucina: viewCucina, attivita: viewAttivita, altro: viewAltro }[store.tab]()));
  app.append(h('nav', { class: 'tabs', 'aria-label': 'Sezioni' }, TABS.map(([id, label]) =>
    h('button', { 'aria-current': store.tab === id ? 'page' : null, onclick: () => go(id) }, icon(ICONS[id]), label))));
  if (keep) { const ta = document.querySelector('.composer textarea'); if (ta) ta.value = keep; }
  if (scroll) { const m = document.querySelector('main'); if (m) m.scrollTop = scroll; }
  updateOrb(); orb.sync();
}

// ------------------------------------------------------------------ Video Call Live (Visione dal vivo)

function openLiveCall() {
  if (document.getElementById('live-call-modal')) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('La fotocamera live non è supportata su questo dispositivo/browser.');
    return;
  }

  let facing = 'environment';
  let stream = null;
  let closed = false;
  let busy = false;
  let speaking = false;
  let autoMode = false;
  let autoTimer = null;
  let recog = null;

  const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'live-video' });
  const statusEl = h('span', { class: 'live-pill' }, '● AVVIO CAMERA…');
  const subEl = h('div', { class: 'live-sub' }, 'Inquadra ciò che vuoi mostrarmi e parla pure, oppure tocca "Guarda ora".');
  const autoBtn = h('button', { class: 'btn', onclick: toggleAuto }, 'Auto-osserva: OFF');

  const overlay = h('div', { id: 'live-call-modal', class: 'live-overlay' },
    h('div', { class: 'live-top' },
      h('b', { style: 'color:#39ff14' }, '◉ JARVIS LIVE CALL'),
      statusEl,
      h('button', { class: 'btn', onclick: switchCam }, '🔄 Camera')),
    h('div', { class: 'live-stage' }, video, subEl),
    h('div', { class: 'live-controls' },
      h('button', { class: 'btn primary', onclick: () => askLive('Guarda cosa ti sto mostrando dal vivo e rispondimi in modo diretto e conciso.') }, '👁️ Guarda ora'),
      autoBtn,
      h('button', { class: 'btn danger', onclick: closeCall }, '✕ Chiudi Call')));
  document.body.append(overlay);

  async function startCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      statusEl.textContent = recog ? '● IN ASCOLTO LIVE' : '● LIVE PRONTO';
    } catch (e) {
      statusEl.textContent = '○ CAMERA NON DISPONIBILE';
      subEl.textContent = 'Permesso fotocamera negato o non disponibile (' + (e.message || 'errore') + ').';
    }
  }

  function switchCam() {
    facing = facing === 'environment' ? 'user' : 'environment';
    startCamera();
  }

  function captureFrameB64() {
    if (!video.videoWidth || !video.videoHeight) return null;
    const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.78).split(',')[1];
  }

  function speakLive(text) {
    const clean = String(text || '').trim();
    if (!clean || closed) return;
    speaking = true;
    statusEl.textContent = '◉ JARVIS PARLA';
    const doneSpeak = () => {
      speaking = false;
      if (!closed) statusEl.textContent = recog ? '● IN ASCOLTO LIVE' : '● LIVE PRONTO';
    };
    if (native) {
      nativeCall('speak', clean);
      setTimeout(doneSpeak, Math.min(14000, 1200 + clean.length * 60));
    } else if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = 'it-IT';
      u.onend = doneSpeak;
      u.onerror = doneSpeak;
      window.speechSynthesis.speak(u);
    } else {
      doneSpeak();
    }
  }

  async function askLive(promptText) {
    if (closed || busy) return;
    const image = captureFrameB64();
    if (!image) return;
    busy = true;
    statusEl.textContent = '◌ ANALIZZO LIVE…';
    subEl.textContent = `Tu: ${promptText}`;
    try {
      const out = await api('POST', '/chat', {
        text: `[MODALITÀ VIDEO CALL LIVE] Rispondi breve e naturale (max 2-3 frasi, tono da conversazione dal vivo). Richiesta: ${promptText}`,
        image,
      });
      if (closed) return;
      const reply = out.reply || 'Ho visto, signore.';
      subEl.textContent = reply;
      store.messages.push({ role: 'user', text: `📹 [Live] ${promptText}`, image: true });
      store.messages.push({ role: 'assistant', text: reply, model: out.model });
      speakLive(reply);
    } catch (e) {
      if (!closed) subEl.textContent = 'Errore analisi live: ' + e.message;
    } finally {
      busy = false;
      if (!closed && !speaking) statusEl.textContent = recog ? '● IN ASCOLTO LIVE' : '● LIVE PRONTO';
    }
  }

  function toggleAuto() {
    autoMode = !autoMode;
    autoBtn.textContent = autoMode ? 'Auto-osserva: ON' : 'Auto-osserva: OFF';
    autoBtn.classList.toggle('primary', autoMode);
    clearInterval(autoTimer);
    if (autoMode) {
      autoTimer = setInterval(() => {
        if (!closed && !busy && !speaking) {
          askLive('Osserva la scena attuale e dimmi brevemente cosa vedi o se c\'è qualcosa di nuovo.');
        }
      }, 6500);
    }
  }

  function startVoiceLoop() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try {
      recog = new SR();
      recog.lang = 'it-IT';
      recog.continuous = true;
      recog.interimResults = true;
      recog.onresult = (ev) => {
        if (closed || speaking) return;
        const last = ev.results[ev.results.length - 1];
        const transcript = (last[0]?.transcript || '').trim();
        if (!transcript) return;
        subEl.textContent = `🎤 ${transcript}`;
        if (last.isFinal && transcript.length >= 2) {
          if (/^(chiudi|esci|termina|stop)\s+(?:la\s+)?(?:video\s*)?call/i.test(transcript)) {
            closeCall();
            return;
          }
          askLive(transcript);
        }
      };
      recog.onend = () => { if (!closed) { try { recog.start(); } catch {} } };
      recog.onerror = () => {};
      recog.start();
    } catch { recog = null; }
  }

  function closeCall() {
    if (closed) return;
    closed = true;
    clearInterval(autoTimer);
    try { recog?.stop(); } catch {}
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch {}
    overlay.remove();
    render();
  }

  startCamera();
  startVoiceLoop();
}

boot();
