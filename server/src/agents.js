// Sistema multi-agente locale di Jarvis (zero chiamate LLM, latenza < 2 ms).
// Ogni agente specializzato cura un aspetto interno senza appesantire il modello principale:
// - GraphAgent: ordina il grafo, fonde doppioni, collega le app e i flow autonomi come nodi;
// - MemoryAgent: intercetta fatti/preferenze esplicite da ricordare quando il modello non lo fa;
// - FlowAgent: mantiene i percorsi autonomi (pulizia di quelli inaffidabili, accensione sulla sfera);
// - UiAgent: applica comandi diretti sull'interfaccia interna.

import { kvGet, kvSet } from './db.js';
import * as memory from './memory.js';
import * as flows from './flows.js';
import * as ui from './ui.js';

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const CLEAN_GRAPH_RE = /(?:(ridu[cz]\w*|sistem\w*|pulisc\w*|snellisc\w*|riordin\w*|sfoltisc\w*|compatt\w*|tropp[io]\s+grand\w*|tropp[io]\s+nod\w*)[\s\S]{0,40}\b(grafo|nod[io]|mappa|ram[oi]|dieta|sport|agenda|memoria)\b|\b(grafo|nod[io]|mappa|ram[oi])\b[\s\S]{0,40}\b(ridu[cz]\w*|sistem\w*|pulisc\w*|snellisc\w*|riordin\w*|sfoltisc\w*|compatt\w*|tropp[io]\s+grand\w*|tropp[io]\s+nod\w*))/i;
const TRIVIAL_RE = /^(?:(?:ehi|ciao|ok|bene|grazie|perfetto|salve|buongiorno|buonasera|buonanotte|jarvis|signore|si|sì|no|va bene|a posto|tutto bene|come stai|come va)\W*)+$/i;
const TOPIC_SKIP = new Set(['cosa', 'come', 'perche', 'quando', 'dove', 'quale', 'quali', 'quanti', 'quante', 'dimmi', 'spiegami', 'parlami', 'aggiungi', 'crea', ' metti', 'fai', 'puoi', 'vorrei', 'voglio', 'nodo', 'nodi', 'grafo', 'mappa', 'ramo', 'rami', 'favore', 'grazie', 'signore']);

/** Agente 1: cura della struttura, pulizia e ridimensionamento dei rami del grafo della mente. */
export const GraphAgent = {
  /** Riconosce app installate o note citate nel messaggio per accenderle o collegarle nel grafo. */
  inferAppTopics(db, userText) {
    if (!userText) return [];
    const apps = kvGet(db, 'apps', []);
    const known = [...new Set([...apps, 'Joytify', 'Spotify', 'WhatsApp', 'Telegram', 'Instagram', 'YouTube', 'Maps', 'Gmail'])];
    const tNorm = norm(userText);
    const out = [];
    if (/\b(joy\s*t\w*|joy\s*f\w*)\b/i.test(userText)) {
      const joy = apps.find(a => /joy/i.test(a)) || 'Joytify';
      out.push({ area: 'intrattenimento', topic: joy, parent: 'musica' });
    }
    for (const app of known) {
      const aNorm = norm(app);
      if (aNorm.length >= 3 && tNorm.includes(aNorm) && !out.some(o => norm(o.topic) === aNorm)) {
        const isMusic = /(joytify|spotify|music|youtube|soundcloud|deezer)/i.test(app);
        out.push({ area: isMusic ? 'intrattenimento' : 'telefono', topic: app, parent: isMusic ? 'musica' : '' });
      }
    }
    return out.slice(0, 2);
  },

  /**
   * Se il modello LLM ha dimenticato di valorizzare "topics" su una frase sostanziosa,
   * estrae in locale l'area e l'argomento così il grafo genera sempre nuovi nodi in automatico.
   */
  inferFallbackTopics(db, userText) {
    const s = String(userText || '').replace(/^\W*(ehi|ciao|ok)?\W*jarvis\W*/i, '').trim();
    if (!s || s.length < 6 || TRIVIAL_RE.test(s) || CLEAN_GRAPH_RE.test(s)) return [];
    const appHits = this.inferAppTopics(db, s);
    if (appHits.length) return appHits;
    const kws = memory.keywords(s).filter(w => !TOPIC_SKIP.has(w) && w.length >= 3);
    if (kws.length < 2) return [];
    let area = 'generale';
    if (/\b(musica|canzon\w*|playlist|brano|album|artist\w*|rock|pop|jazz|rap|film|serie|gioch\w*|videogioc\w*)\b/i.test(s)) area = 'intrattenimento';
    else if (/\b(lavor\w*|ufficio|riunion\w*|collegh\w*|client\w*|azienda|stipendio|fattur\w*|carriera|progett\w*)\b/i.test(s)) area = 'lavoro';
    else if (/\b(studi\w*|esam\w*|universit\w*|scuola|lezion\w*|corso|libro|tesi|storia|scienza|fisica|matematica|filosofia)\b/i.test(s)) area = 'studio';
    else if (/\b(programm\w*|codice|javascript|python|software|server|database|algoritm\w*|intelligenza\s+artificiale)\b/i.test(s)) area = 'tecnologia';
    else if (/\b(auto|macchina|moto|tagliando|gomme|treno|volo|viaggi\w*|vacanz\w*|hotel)\b/i.test(s)) area = 'viaggi';
    else if (/\b(salute|medic\w*|dottor\w*|farmac\w*|dolor\w*|sonno|allerg\w*|intolleran\w*)\b/i.test(s)) area = 'salute';
    if (area === 'generale') return [];
    const topic = kws.slice(0, 3).join(' ');
    return topic ? [{ area, topic, parent: '' }] : [];
  },

  /** Rileva richieste dell'utente di ridurre, pulire o riordinare il grafo (o un ramo specifico come dieta). */
  detectCleanCommand(userText) {
    const t = String(userText || '').trim();
    if (!CLEAN_GRAPH_RE.test(t)) return null;
    let branch = 'all';
    if (/\b(dieta|alimentazion\w*|pasti|cibo|calorie)\b/i.test(t)) branch = 'dieta';
    else if (/\b(sport|allenament\w*|palestra|corsa)\b/i.test(t)) branch = 'sport';
    else if (/\b(agenda|promemoria)\b/i.test(t)) branch = 'agenda';
    else if (/\b(automazion\w*|flow)\b/i.test(t)) branch = 'automazioni';
    const numMatch = /\b(\d{1,2})\s*nod[io]\b/i.exec(t);
    const maxNodes = numMatch ? Math.max(2, Math.min(12, Number(numMatch[1]))) : 4;
    return { branch, maxNodes };
  },

  /** Riduce e riordina i nodi di un ramo (o di tutto il grafo), salvando il tetto di nodi desiderato. */
  cleanBranch(db, branch = 'all', maxNodes = 4) {
    const cap = Math.max(2, Math.min(12, Number(maxNodes) || 4));
    memory.tidyTopics(db);
    const limits = kvGet(db, 'graphLimits', {});
    const targets = branch && branch !== 'all'
      ? [memory.slug(branch)]
      : ['dieta', 'sport', ...db.all('SELECT DISTINCT module FROM topics').map(r => r.module)];

    let removed = 0;
    for (const mod of new Set(targets)) {
      if (!mod) continue;
      limits[mod] = cap;
      const keepTopics = mod === 'dieta' ? Math.max(1, Math.min(2, cap - 3)) : cap;
      const extra = db.all('SELECT name FROM topics WHERE module = ? ORDER BY uses DESC, last_used DESC LIMIT -1 OFFSET ?', mod, keepTopics);
      for (const row of extra) {
        db.run('DELETE FROM topics WHERE module = ? AND name = ?', mod, row.name);
        removed++;
      }
      if (mod === 'dieta') {
        const extraMem = db.all("SELECT id FROM memories WHERE module = 'dieta' ORDER BY uses DESC, id DESC LIMIT -1 OFFSET 2");
        for (const row of extraMem) {
          db.run('DELETE FROM memories WHERE id = ?', row.id);
          removed++;
        }
      }
    }
    kvSet(db, 'graphLimits', limits);
    db.run('DELETE FROM modules WHERE name NOT IN (SELECT DISTINCT module FROM memories) AND name NOT IN (SELECT DISTINCT module FROM topics)');
    return { branch: branch || 'all', maxNodes: cap, removed };
  },

  /** Mantiene pulita la topologia del grafo e restituisce i nodi autonomi attivi. */
  maintain(db) {
    memory.tidyTopics(db);
    FlowAgent.prune(db);
  },
};

/** Agente 2: intercettazione locale di ricordi espliciti ("ricordati che...", "sono allergico a..."). */
export const MemoryAgent = {
  extractExplicit(dbOrText, maybeText, maybeNow) {
    const hasDb = dbOrText && typeof dbOrText.run === 'function';
    const userText = hasDb ? maybeText : dbOrText;
    const t = String(userText || '').trim();
    const m = /^(?:jarvis\s+)?(?:ricordati|ricorda|segna(?:ti)?|memorizza)\s+che\s+(.{6,240})$/i.exec(t);
    if (!m) return hasDb ? [] : null;
    const fact = m[1].trim().replace(/[.!]+$/, '') + '.';
    let mod = 'generale';
    if (/\b(allerg\w*|intolleran\w*|medic\w*|salute| Sintom\w*|dolor\w*|farmac\w*)\b/i.test(fact)) mod = 'salute';
    else if (/\b(lavor\w*|ufficio|collegh\w*|riunion\w*|progett\w*|client\w*)\b/i.test(fact)) mod = 'lavoro';
    else if (/\b(auto|macchina|panda|tagliando|gomme|assicurazion\w*)\b/i.test(fact)) mod = 'auto';
    else if (/\b(viaggi\w*|volo|hotel|vacanz\w*)\b/i.test(fact)) mod = 'viaggi';
    else if (/\b(musica|canzon\w*|playlist|ascolt\w*)\b/i.test(fact)) mod = 'intrattenimento';
    if (hasDb) {
      const nowIso = typeof maybeNow === 'string' ? maybeNow : new Date(Number(maybeNow) || Date.now()).toISOString();
      const id = memory.remember(dbOrText, { module: mod, text: fact }, nowIso);
      return id ? [{ id, branch: mod, text: fact }] : [];
    }
    return { module: mod, text: fact };
  },
};

/** Agente 3: gestione dei percorsi autonomi (flow) e illuminazione dei relativi nodi sulla sfera. */
export const FlowAgent = {
  /** Rimuove o declassa flow che hanno fallito troppe volte senza riuscire. Ritorna quanti ne ha rimossi. */
  prune(db) {
    const flows = kvGet(db, 'phoneFlows', []);
    if (!flows.length) return 0;
    const kept = flows.filter(f => !((f.fails || 0) >= 4 && (f.uses || 0) <= 1));
    const removed = flows.length - kept.length;
    if (removed > 0) kvSet(db, 'phoneFlows', kept);
    return removed;
  },

  /** Trova il nodo autonomo corrispondente a un obiettivo per accenderlo sulla sfera. */
  touchedForGoal(db, goal) {
    const flows = kvGet(db, 'phoneFlows', []);
    if (!flows.length || !goal) return null;
    const gNorm = norm(goal);
    const hit = flows.find(f => norm(f.sampleGoal) === gNorm || (f.app && gNorm.includes(norm(f.app))));
    return hit ? { branch: 'automazioni', leaf: 'f:' + hit.id } : null;
  },
};

/** Agente 4: comandi diretti sull'interfaccia interna. */
export const UiAgent = {
  detectReset(userText) {
    return /^\s*(?:jarvis\s+)?(?:ripristina|resetta)\s+(?:i\s+riquadri|la\s+schermata|l'interfaccia)\s*$/i.test(String(userText || ''));
  },
};

/** Aggiorna lo stato del grafo quando il gatekeeper locale risolve la richiesta senza LLM. */
export function onLocalHit(db, userText, localHit, nowIso, ms) {
  const touched = new Set();
  const leaves = [];
  for (const d of localHit.device || []) {
    if (d.type === 'phone_task') {
      touched.add('automazioni');
      const f = FlowAgent.touchedForGoal(db, d.goal);
      if (f) leaves.push(f.leaf);
      else {
        const reg = flows.registerAutoGoal(db, d.goal, ms);
        if (reg) leaves.push('f:' + reg.id);
      }
    } else if (d.type === 'open_app' && d.name) {
      const hits = memory.touchTopics(db, [{ area: 'telefono', topic: d.name }], nowIso);
      for (const m of hits.modules) touched.add(m);
      leaves.push(...hits.leaves);
    }
  }
  const tList = [...touched];
  if (tList.length) {
    kvSet(db, 'lastTouched', { at: nowIso + '#' + ms, touched: tList, leaves });
    memory.noteUse(db, tList, ms);
  }
  return { touched: tList, touchedLeaves: leaves };
}
