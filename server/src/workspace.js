// Modulo Workspace Adattivo per Progetti:
// Quando l'utente entra in un progetto (o carica un file/PDF di contesto), adatta dinamicamente
// il prompt di sistema, la sessione chat e i widget della schermata ad hoc all'obiettivo del progetto.
// All'uscita ripristina istantaneamente l'assetto standard di Jarvis.

import { kvGet, kvSet } from './db.js';
import * as router from './router.js';
import * as jobs from './jobs.js';
import { nowIso as nowIsoOf } from './clock.js';

const ACTIVE_KEY = 'activeWorkspace';
const SPECS_KEY = 'workspaceSpecs';

export function getActiveWorkspace(db) {
  return kvGet(db, ACTIVE_KEY, null);
}

export function exitWorkspace(db) {
  kvSet(db, ACTIVE_KEY, null);
  return null;
}

export function getSavedSpec(db, jobId) {
  const map = kvGet(db, SPECS_KEY, {});
  return map[String(jobId || '')] || null;
}

export function saveSpec(db, jobId, spec) {
  const map = kvGet(db, SPECS_KEY, {});
  map[String(jobId || '')] = spec;
  kvSet(db, SPECS_KEY, map);
}

/** Costruisce una schermata ad hoc e un contesto di fallback se i modelli sono occupati. */
function buildFallbackSpec(title, rawText) {
  const t = String(title || 'Progetto').trim();
  const low = (t + ' ' + rawText).toLowerCase();
  const isTutor = /\b(inglese|tutor|lezione|b1|b2|a2|dsa|studio|esame|grammatica|english)\b/i.test(low);
  const isCode = /\b(codice|code|app|svilupp|bug|api|server|python|javascript|architettura)\b/i.test(low);
  const kind = isTutor ? 'tutor' : isCode ? 'coding' : 'progetto';

  const lines = String(rawText || '').split(/\n+/).map(l => l.trim()).filter(l => l.length > 6).slice(0, 10);
  const widgets = [
    {
      type: 'timer',
      title: isTutor ? 'Sessione Studio (30 min)' : 'Focus Progetto (25 min)',
      minutes: isTutor ? 30 : 25,
    },
    {
      type: 'checklist',
      title: isTutor ? 'Struttura Sessione' : 'Fasi del Progetto',
      items: isTutor
        ? [
            { label: '5\' Riscaldamento sugli errori ricorrenti', done: false },
            { label: '10\' Regola nuova con schema breve', done: false },
            { label: '10\' Pratica guidata (1 esercizio alla volta)', done: false },
            { label: '5\' Chiusura e riepilogo in 3 punti', done: false },
          ]
        : (lines.slice(0, 4).length ? lines.slice(0, 4).map(l => ({ label: l.slice(0, 70), done: false })) : [
            { label: 'Analisi contesto e obiettivi', done: false },
            { label: 'Esecuzione step principali', done: false },
            { label: 'Verifica finale', done: false },
          ]),
    },
    {
      type: 'actions',
      title: 'Azioni Rapide Progetto',
      buttons: isTutor
        ? ['Inizia riscaldamento (3 frasi)', 'Spiega prossima regola (schema DSA)', 'Esercizio parlato veloce', 'Dammi prompt riepilogo']
        : ['Mostra stato e prossimi passi', 'Avvia prossimo step', 'Genera riepilogo'],
    },
  ];

  return {
    title: t.slice(0, 70),
    kind,
    systemContext: `MODALITÀ PROGETTO ATTIVA: "${t}".\nSegui rigorosamente le istruzioni e il contesto forniti dall'utente per questo progetto fino a quando non esce dalla modalità progetto.\n\nCONTESTO DEL PROGETTO:\n${String(rawText || t).slice(0, 10000)}`,
    widgets,
  };
}

/**
 * Attiva un Workspace Adattivo per un progetto esistente o a partire da testo/file/PDF allegati.
 */
export async function enterWorkspace(db, env, fetchFn, { jobId = '', title = '', contextText = '', pdfBase64 = null, nowMs = Date.now(), tz = 'Europe/Rome' } = {}) {
  let fullText = String(contextText || '').trim();
  let projTitle = String(title || '').trim();

  if (jobId) {
    const existingSpec = getSavedSpec(db, jobId);
    if (existingSpec && !fullText && !pdfBase64) {
      const active = { ...existingSpec, jobId, enteredAt: nowIsoOf(nowMs, tz) };
      kvSet(db, ACTIVE_KEY, active);
      return active;
    }
    const j = db.get('SELECT * FROM jobs WHERE id = ?', jobId);
    if (j) {
      projTitle = projTitle || j.title;
      fullText = [fullText, j.goal, j.result].filter(Boolean).join('\n\n');
    }
  }

  if (pdfBase64) {
    const extracted = await router.readPdfWithGemini(env, fetchFn, pdfBase64, 'Estrai fedelmente tutto il testo, le tabelle, le regole e le istruzioni presenti in questo PDF.');
    if (extracted) fullText = [fullText, extracted].filter(Boolean).join('\n\n');
  }

  projTitle = projTitle || fullText.split('\n').find(l => l.trim().length > 3)?.replace(/^#+\s*/, '').slice(0, 60) || 'Progetto Adattivo';
  const id = jobId || `ws-${nowMs.toString(36)}`;

  let spec = null;
  try {
    const res = await router.chat(db, env, {
      tier: 'smart',
      maxTokens: 1400,
      fetchFn,
      tz,
      build: () => [
        {
          role: 'system',
          content: `Sei l'architetto adattivo di Jarvis. Trasforma il contesto/documento del progetto in un Workspace Adattivo JSON valido (SOLO JSON, nessun testo fuori).
Schema obbligatorio:
{
  "title": "titolo breve (max 60 car.)",
  "kind": "tutor|coding|studio|fitness|lavoro|progetto",
  "systemContext": "istruzioni operative complete per l'IA quando l'utente è dentro questo progetto: ruolo esatto, regole di formattazione/DSA, errori da evitare, lingua, ritmo, temi e obiettivi estratti dal materiale (max 3500 car.)",
  "widgets": [
    { "type": "progress", "title": "...", "value": 0, "max": 100, "label": "stato sintetico" },
    { "type": "timer", "title": "...", "minutes": 30 },
    { "type": "checklist", "title": "...", "items": [{ "label": "...", "done": false }] },
    { "type": "table", "title": "...", "rows": [["colonna 1", "colonna 2"]] },
    { "type": "actions", "title": "Azioni Rapide", "buttons": ["testo bottone 1", "testo bottone 2", "testo bottone 3"] }
  ]
}
Includi solo widget davvero utili e specifici per quel documento/obiettivo.`,
        },
        {
          role: 'user',
          content: `Titolo: ${projTitle}\n\nContenuto/Istruzioni:\n${fullText.slice(0, 14000)}`,
        },
      ],
    });
    const cleanJson = String(res.text || '').replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleanJson);
    if (parsed && parsed.systemContext && Array.isArray(parsed.widgets)) {
      spec = {
        title: String(parsed.title || projTitle).slice(0, 70),
        kind: String(parsed.kind || 'progetto').slice(0, 20),
        systemContext: String(parsed.systemContext).slice(0, 12000),
        widgets: parsed.widgets.slice(0, 6),
      };
    }
  } catch { /* fallback deterministico sotto */ }

  if (!spec) spec = buildFallbackSpec(projTitle, fullText);
  saveSpec(db, id, spec);
  const active = { ...spec, jobId: id, enteredAt: nowIsoOf(nowMs, tz) };
  kvSet(db, ACTIVE_KEY, active);
  return active;
}

/** Spunta/despunta un elemento della checklist del workspace attivo. */
export function toggleWorkspaceItem(db, widgetIdx, itemIdx) {
  const active = getActiveWorkspace(db);
  if (!active || !Array.isArray(active.widgets)) return null;
  const w = active.widgets[Number(widgetIdx)];
  if (!w || w.type !== 'checklist' || !Array.isArray(w.items) || !w.items[Number(itemIdx)]) return active;
  w.items[Number(itemIdx)].done = !w.items[Number(itemIdx)].done;
  kvSet(db, ACTIVE_KEY, active);
  if (active.jobId) saveSpec(db, active.jobId, active);
  return active;
}
