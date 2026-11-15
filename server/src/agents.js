// Sistema multi-agente locale di Jarvis (zero chiamate LLM, latenza < 2 ms).
// Ogni agente specializzato cura un aspetto interno senza appesantire il modello principale:
// - GraphAgent: ordina il grafo, fonde doppioni, collega le app e i flow autonomi come nodi;
// - MemoryAgent: intercetta fatti/preferenze esplicite da ricordare quando il modello non lo fa;
// - FlowAgent: mantiene i percorsi autonomi (pulizia di quelli inaffidabili, accensione sulla sfera);
// - UiAgent: applica comandi diretti sull'interfaccia interna.

import { kvGet, kvSet } from './db.js';
import * as memory from './memory.js';
import * as ui from './ui.js';

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Agente 1: cura della struttura e dell'ordine del grafo della mente. */
export const GraphAgent = {
  /** Riconosce app installate citate nel messaggio per accenderle o collegarle nel grafo. */
  inferAppTopics(db, userText) {
    const apps = kvGet(db, 'apps', []);
    if (!apps.length || !userText) return [];
    const tNorm = norm(userText);
    const out = [];
    for (const app of apps) {
      const aNorm = norm(app);
      if (aNorm.length >= 3 && tNorm.includes(aNorm)) {
        const isMusic = /(joytify|spotify|music|youtube music|soundcloud|deezer)/i.test(app);
        out.push({ area: isMusic ? 'intrattenimento' : 'telefono', topic: app, parent: isMusic ? 'musica' : '' });
      }
    }
    return out.slice(0, 2);
  },

  /** Mantiene pulita la topologia del grafo e restituisce i nodi autonomi attivi. */
  maintain(db) {
    memory.tidyTopics(db);
    FlowAgent.prune(db);
  },
};

/** Agente 2: intercettazione locale di ricordi espliciti ("ricordati che...", "sono allergico a..."). */
export const MemoryAgent = {
  extractExplicit(userText) {
    const t = String(userText || '').trim();
    const m = /^(?:jarvis\s+)?(?:ricordati|ricorda|segna(?:ti)?|memorizza)\s+che\s+(.{6,240})$/i.exec(t);
    if (!m) return null;
    const fact = m[1].trim().replace(/[.!]+$/, '') + '.';
    let mod = 'generale';
    if (/\b(lavor\w*|ufficio|collegh\w*|riunion\w*|progett\w*|client\w*)\b/i.test(fact)) mod = 'lavoro';
    else if (/\b(auto|macchina|panda|tagliando|gomme|assicurazion\w*)\b/i.test(fact)) mod = 'auto';
    else if (/\b(viaggi\w*|volo|hotel|vacanz\w*)\b/i.test(fact)) mod = 'viaggi';
    else if (/\b(musica|canzon\w*|playlist|ascolt\w*)\b/i.test(fact)) mod = 'intrattenimento';
    return { module: mod, text: fact };
  },
};

/** Agente 3: gestione dei percorsi autonomi (flow) e illuminazione dei relativi nodi sulla sfera. */
export const FlowAgent = {
  /** Rimuove o declassa flow che hanno fallito troppe volte senza riuscire. */
  prune(db) {
    const flows = kvGet(db, 'phoneFlows', []);
    if (!flows.length) return;
    const kept = flows.filter(f => !((f.fails || 0) >= 4 && (f.uses || 0) <= 1));
    if (kept.length !== flows.length) kvSet(db, 'phoneFlows', kept);
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
