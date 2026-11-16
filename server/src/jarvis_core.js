// JARVIS CORE: motore cognitivo proprietario interno a Jarvis.
// Agisce in prima persona (prima e sopra i modelli LLM esterni) con:
// 1. Esecuzione procedurale istantanea (flow già fatti su telefono e PC, zero modelli esterni);
// 2. Orchestrazione multi-dispositivo (controllo diretto di PC Desktop e Smartphone);
// 3. Gestione di problemi complessi e prolungati nel tempo (pianificazione multi-step autonoma);
// 4. Risposta locale autonoma su stato del sistema, dispositivi e memoria.

import * as flows from './flows.js';
import * as devices from './devices.js';
import * as memory from './memory.js';

const PC_TARGET_RE = /\b(sul\s+pc|sul\s+computer|sul\s+desktop|dal\s+pc|nel\s+pc|su\s+windows|sul\s+portatile|computer|desktop)\b/i;
const PC_STATUS_RE = /\b(stato\s+del\s+(?:pc|computer|sistema)|dispositiv[io]\s+conness\w*|come\s+sta\s+il\s+pc|quanta\s+ram|cpu\s+del\s+pc)\b/i;

/**
 * Riconosce comandi diretti al PC Desktop o allo stato multi-dispositivo e li esegue localmente
 * tramite il nucleo proprietario Jarvis Core (zero chiamate a modelli esterni).
 */
export function handleCoreIntent(db, userText, nowMs = Date.now()) {
  const raw = String(userText || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').replace(/\bniente\s+pi[uù]\s+fili\b/gi, '').trim();
  if (!clean) return null;

  // 1. Stato del sistema / dispositivi connessi (PC + Telefono)
  if (PC_STATUS_RE.test(clean)) {
    const list = devices.listDevices(db, nowMs);
    const pc = list.find(d => d.kind === 'desktop');
    if (!pc) {
      return {
        reply: 'Al momento il PC Desktop non risulta ancora collegato, signore. Avvii l\'app Jarvis Desktop sul computer per metterlo sotto il mio controllo.',
        device: [], actions: ['core_status'], touched: ['automazioni'], touchedLeaves: [],
      };
    }
    const m = pc.metrics || {};
    const parts = [
      pc.online ? `${pc.name} è online` : `${pc.name} risulta offline`,
      m.cpu ? `CPU al ${Math.round(m.cpu)}%` : '',
      m.ram ? `RAM al ${Math.round(m.ram)}%` : '',
      m.activeWindow ? `finestra attiva "${m.activeWindow}"` : '',
    ].filter(Boolean);
    return {
      reply: ` Stato sistema: ${parts.join(', ')}, signore.`,
      device: [], actions: ['core_status'], touched: ['automazioni'], touchedLeaves: [],
    };
  }

  // 2. Comandi espliciti verso il PC Desktop ("apri Chrome sul PC", "blocca il PC", "apri VS Code sul computer")
  if (PC_TARGET_RE.test(clean)) {
    const withoutPc = clean.replace(PC_TARGET_RE, ' ').replace(/\s+/g, ' ').trim();

    // Controlli di sistema sul PC (volume, pausa, blocco schermo)
    if (/\b(blocca|lock)\b/i.test(clean)) {
      const cmd = devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'lock', say: 'Blocco lo schermo del PC.' }, nowMs);
      return { reply: 'Blocco subito lo schermo del PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: ['f:' + cmd.id] };
    }
    if (/\b(pausa|play|ferma\s+la\s+musica|riprendi\s+la\s+musica)\b/i.test(clean)) {
      const cmd = devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'play_pause', say: 'Play/Pausa sul PC.' }, nowMs);
      return { reply: 'Invio il comando multimediale al PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: ['f:' + cmd.id] };
    }
    if (/\b(alza\s+il\s+volume|volume\s+su)\b/i.test(clean)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'vol_up' }, nowMs);
      return { reply: 'Alzo il volume sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }
    if (/\b(abbassa\s+il\s+volume|volume\s+gi[uù])\b/i.test(clean)) {
      devices.enqueueCommand(db, 'desktop', { kind: 'system', target: 'vol_down' }, nowMs);
      return { reply: 'Abbasso il volume sul PC, signore.', device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Apertura URL sul PC
    const urlMatch = /\b((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)\b/i.exec(withoutPc);
    if (urlMatch && /\b(apri|vai\s+su|visita)\b/i.test(withoutPc)) {
      const url = /^https?:\/\//i.test(urlMatch[1]) ? urlMatch[1] : 'https://' + urlMatch[1];
      devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: url }, nowMs);
      return { reply: `Apro ${urlMatch[1]} sul PC, signore.`, device: [], actions: ['pc_action'], touched: ['automazioni'], touchedLeaves: [] };
    }

    // Apertura programma/app sul PC ("apri Chrome sul PC", "avvia VS Code sul computer")
    const openMatch = /^(?:apri|avvia|lancia|esegui)\s+(?:il\s+|la\s+|l'|lo\s+)?(?:programma\s+|app\s+)?(.+)$/i.exec(withoutPc);
    if (openMatch) {
      const appName = openMatch[1].replace(/[.!?]+$/, '').trim();
      if (appName) {
        const reg = flows.registerAutoGoal(db, `PC: apri ${appName}`, nowMs);
        devices.enqueueCommand(db, 'desktop', { kind: 'open_app', target: appName }, nowMs);
        memory.touchTopics(db, [{ area: 'tecnologia', topic: appName, parent: 'pc' }], new Date(nowMs).toISOString());
        return {
          reply: `Apro ${appName} sul PC, signore.`,
          device: [], actions: ['pc_action'],
          touched: ['automazioni', 'tecnologia'],
          touchedLeaves: reg ? ['f:' + reg.id] : [],
        };
      }
    }

    // Ricerca su internet / YouTube / Spotify direttamente sul PC ("cerca X su YouTube sul PC")
    const searchMatch = /^(?:cerca|metti|riproduci|ascolta)\s+(.+)$/i.exec(withoutPc);
    if (searchMatch) {
      const query = searchMatch[1].replace(/[.!?]+$/, '').trim();
      const isYt = /\byoutube\b/i.test(query);
      const cleanQ = query.replace(/\b(su\s+youtube|su\s+google|su\s+spotify)\b/gi, '').trim();
      const url = isYt
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`
        : `https://www.google.com/search?q=${encodeURIComponent(cleanQ)}`;
      const reg = flows.registerAutoGoal(db, `PC: cerca ${cleanQ}`, nowMs);
      devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: url }, nowMs);
      return {
        reply: `Cerco "${cleanQ}" sul PC, signore.`,
        device: [], actions: ['pc_action'],
        touched: ['automazioni'],
        touchedLeaves: reg ? ['f:' + reg.id] : [],
      };
    }
  }

  return null;
}

/**
 * Rileva se una richiesta descrive un problema complesso o prolungato nel tempo
 * che merita di essere strutturato in un progetto multi-step in background (se il modello non lo ha già avviato).
 */
export function detectComplexProject(userText) {
  const s = String(userText || '').trim();
  if (s.length < 25) return null;
  const m = /\b(?:avvia\s+un\s+progetto|gestisci\s+nel\s+tempo|pianifica\s+in\s+pi[uù]\s+fasi|studia\s+a\s+fondo|prepara\s+un\s+piano\s+completo\s+(?:per|di|su))\s+(.{10,300})/i.exec(s);
  if (!m) return null;
  const goal = m[1].trim();
  return { title: goal.slice(0, 60), goal: s.slice(0, 1500) };
}
