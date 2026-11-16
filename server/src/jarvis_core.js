// JARVIS CORE: motore cognitivo proprietario interno a Jarvis.
// Agisce in prima persona (prima e sopra i modelli LLM esterni) con:
// 1. Esecuzione procedurale istantanea (flow già fatti su telefono e PC, zero modelli esterni);
// 2. Orchestrazione multi-dispositivo (controllo diretto di PC Desktop e Smartphone, anche per nome es. "Ghideon");
// 3. Gestione della parola d'ordine ("niente più fili") con recupero automatico dell'azione precedente;
// 4. Gestione di problemi complessi e prolungati nel tempo (pianificazione multi-step autonoma).

import { kvGet, kvSet } from './db.js';
import * as flows from './flows.js';
import * as devices from './devices.js';
import * as memory from './memory.js';

const BASE_PC_RE = /\b(sul\s+pc|sul\s+computer|sul\s+desktop|dal\s+pc|nel\s+pc|su\s+windows|sul\s+portatile|su\s+pc|su\s+computer|computer|desktop|ghideon)\b/i;
const PC_STATUS_RE = /\b(stato\s+del\s+(?:pc|computer|sistema|ghideon)|dispositiv[io]\s+conness\w*|come\s+sta\s+il\s+pc|quanta\s+ram|cpu\s+del\s+pc)\b/i;
const PASSPHRASE_RE = /^\W*(?:la\s+parola\s+d'ordine\s+[eè]\s+|parola\s+d'ordine\s+)?niente\s+pi[uù]\s+fili\W*$/i;
const SELF_PROMPT_ECHO_RE = /^\W*parola\s+d'ordine(?:\s+non\s+corretta.*)?\W*$/i;

const WEB_SERVICES = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  instagram: 'https://www.instagram.com',
  whatsapp: 'https://web.whatsapp.com',
  netflix: 'https://www.netflix.com',
  twitch: 'https://www.twitch.com',
  github: 'https://github.com',
  chatgpt: 'https://chatgpt.com',
  maps: 'https://maps.google.com',
  google: 'https://www.google.com',
};

/** Verifica se il testo si riferisce al PC Desktop (anche usando il nome registrato del PC, es. "Ghideon"). */
export function isPcTarget(db, text) {
  const s = String(text || '');
  if (BASE_PC_RE.test(s)) return true;
  const low = s.toLowerCase();
  for (const d of devices.listDevices(db)) {
    if (d.kind === 'desktop' && d.name) {
      const cleanName = d.name.toLowerCase().replace(/^pc\s+/i, '').trim();
      if (cleanName.length >= 3 && low.includes(cleanName)) return true;
    }
  }
  return false;
}

function stripPcWords(db, text) {
  let out = String(text || '').replace(BASE_PC_RE, ' ');
  for (const d of devices.listDevices(db)) {
    if (d.kind === 'desktop' && d.name) {
      const cleanName = d.name.replace(/^PC\s+/i, '').trim();
      if (cleanName.length >= 3) {
        const esc = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`\\b(?:su|sul|in|nel|da|dal)?\\s*(?:pc\\s+)?${esc}\\b`, 'gi'), ' ');
      }
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Invia l'apertura di un'app o servizio web al PC Desktop. */
export function dispatchPcOpen(db, rawTarget, nowMs = Date.now()) {
  const clean = String(rawTarget || '').replace(/[.!?]+$/, '').trim();
  if (!clean) return null;
  const low = clean.toLowerCase();
  const webUrl = WEB_SERVICES[low];
  const reg = flows.registerAutoGoal(db, `PC: apri ${clean}`, nowMs);
  if (webUrl) {
    devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: webUrl }, nowMs);
  } else {
    devices.enqueueCommand(db, 'desktop', { kind: 'open_app', target: clean }, nowMs);
  }
  memory.touchTopics(db, [{ area: 'tecnologia', topic: clean, parent: 'PC Desktop' }], new Date(nowMs).toISOString());
  return {
    reply: `Apro ${clean} sul PC, signore.`,
    device: [], actions: ['pc_action'],
    touched: ['automazioni', 'tecnologia'],
    touchedLeaves: reg ? ['f:' + reg.id] : [],
  };
}

/**
 * Riconosce comandi diretti al PC Desktop, la parola d'ordine "niente più fili" o lo stato multi-dispositivo
 * e li esegue localmente tramite il nucleo proprietario Jarvis Core (zero chiamate a modelli esterni).
 */
export function handleCoreIntent(db, userText, nowMs = Date.now()) {
  const raw = String(userText || '').trim();
  if (!raw) return null;

  // 0. Eco della domanda "Parola d'ordine?" catturata dal microfono: ignorala senza chiamare modelli.
  if (SELF_PROMPT_ECHO_RE.test(raw)) {
    return {
      reply: 'Mi dica la parola d\'ordine: "niente più fili".',
      device: [], actions: [], touched: [], touchedLeaves: [],
    };
  }

  // 1. L'utente ha pronunciato "niente più fili": autorizza ed esegue subito l'ultima azione richiesta!
  if (PASSPHRASE_RE.test(raw)) {
    const lastPhoneGoal = kvGet(db, 'lastPhoneGoal', null);
    const recentUser = db.all("SELECT text FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 6")
      .map(r => String(r.text || '').trim())
      .find(t => !PASSPHRASE_RE.test(t) && !SELF_PROMPT_ECHO_RE.test(t));
    const goal = lastPhoneGoal || recentUser || '';
    if (goal) {
      const reg = flows.registerAutoGoal(db, goal, nowMs);
      return {
        reply: `Parola d'ordine confermata, signore. Eseguo subito: ${goal}.`,
        device: [{ type: 'phone_task', goal }],
        actions: ['phone_task'],
        touched: ['automazioni'],
        touchedLeaves: reg ? ['f:' + reg.id] : [],
      };
    }
    return {
      reply: 'Parola d\'ordine confermata, signore. Sono operativo per i prossimi 15 minuti.',
      device: [], actions: [], touched: ['automazioni'], touchedLeaves: [],
    };
  }

  const clean = raw.replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').replace(/\bniente\s+pi[uù]\s+fili\b/gi, '').trim();
  if (!clean) return null;

  // 2. Stato del sistema / dispositivi connessi (PC + Telefono)
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
      reply: `Stato sistema: ${parts.join(', ')}, signore.`,
      device: [], actions: ['core_status'], touched: ['automazioni'], touchedLeaves: [],
    };
  }

  // 3. Comandi verso il PC Desktop (anche per nome, es. "apri youtube su ghideon", o correzione "ma no sul pc")
  if (isPcTarget(db, clean)) {
    const withoutPc = stripPcWords(db, clean);

    // Correzione rapida ("ma no sul pc", "aprilo sul pc", "fallo sul pc"): recupera l'azione dal messaggio precedente!
    if (/^(?:ma\s+)?(?:no\s+)?(?:aprilo|fallo|eseguilo|mettilo|cercalo)?\s*$/i.test(withoutPc)) {
      const prev = db.all("SELECT text FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 4")
        .map(r => stripPcWords(db, r.text))
        .find(t => /\b(apri|avvia|cerca|metti|youtube|chrome|spotify|code)\b/i.test(t));
      if (prev) {
        const mOpen = /\b(?:apri|avvia|lancia)\s+(?:l'app\s+|il\s+programma\s+)?([a-z0-9\s._-]+)/i.exec(prev);
        if (mOpen) return dispatchPcOpen(db, mOpen[1], nowMs);
      }
    }

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

    // Apertura programma/app/sito sul PC ("apri YouTube su Ghideon", "apri Chrome sul PC", "avvia VS Code sul computer")
    const openMatch = /^(?:per\s+favore\s+)?(?:mi\s+)?(?:apri|avvia|lancia|esegui)\s+(?:il\s+|la\s+|l'|lo\s+)?(?:programma\s+|app\s+|sito\s+)?(.+)$/i.exec(withoutPc);
    if (openMatch) {
      const res = dispatchPcOpen(db, openMatch[1], nowMs);
      if (res) return res;
    }

    // Ricerca su internet / YouTube / Spotify direttamente sul PC ("cerca X su YouTube sul PC")
    const searchMatch = /^(?:cerca|metti|riproduci|ascolta|fai\s+partire)\s+(.+)$/i.exec(withoutPc);
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
