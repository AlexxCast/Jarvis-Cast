// Modulo interno dedicato ad Auto-Diagnostica, Auto-Correzione e Apprendimento continuo di Jarvis.
// Analizza fixLatenti, eventi di errore, cronologia e flussi per correggere doppioni,
// apprendere alias da errori di dettatura vocale e mantenere il sistema sano in autonomia.

import { kvGet, kvSet, logEvent } from './db.js';
import * as flows from './flows.js';
import * as devices from './devices.js';
import * as router from './router.js';
import { nowIso as nowIsoOf } from './clock.js';

const ALIASES_KEY = 'learnedAliases';
const LAST_HEAL_KEY = 'lastSelfHeal';
const STALE_QUEUE_MS = 10 * 60_000;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function listLearnedAliases(db) {
  return kvGet(db, ALIASES_KEY, []);
}

/** Salva o aggiorna un alias appreso (es. dettatura errata -> comando/target reale). */
export function learnAlias(db, fromText, action = {}, nowMs = Date.now()) {
  const from = norm(fromText);
  if (!from || from.length < 3) return null;
  const list = listLearnedAliases(db);
  const existing = list.find(a => a.from === from);
  const entry = {
    from,
    kind: String(action.kind || 'open_app'),
    target: String(action.target || '').trim(),
    device: String(action.device || 'pc'),
    uses: (existing?.uses || 0) + 1,
    updatedAt: nowMs,
  };
  if (!entry.target) return null;
  kvSet(db, ALIASES_KEY, [entry, ...list.filter(a => a.from !== from)].slice(0, 80));
  return entry;
}

/** Verifica se il comando dell'utente corrisponde a un alias/correzione già appresa. */
export function resolveLearnedAlias(db, userText) {
  const clean = norm(userText);
  if (!clean) return null;
  const list = listLearnedAliases(db);
  return list.find(a => clean === a.from || (a.from.length >= 6 && clean.includes(a.from))) || null;
}

/**
 * Auto-correzione deterministica a zero crediti LLM:
 * 1. Pulisce phoneFlows duplicati o finiti sul telefono per comandi PC.
 * 2. Consolida modularSkills per servizio canonico eliminando doppioni.
 * 3. Rimuove comandi PC stantii dalla coda (>10 min) per evitare esecuzioni fantasma in ritardo.
 * 4. Estrae nuovi alias dalle correzioni recenti in chat e da fixLatenti.
 */
export function runDeterministicHeal(db, nowMs = Date.now(), tz = 'Europe/Rome') {
  const actions = [];

  // 1. Pulizia phoneFlows errati (PC finiti su Android) e duplicati
  const rawFlows = flows.listFlows(db);
  const cleanFlows = rawFlows.filter(f => {
    const txt = `${f.id || ''} ${f.sampleGoal || ''}`.toLowerCase();
    return !/\b(gideon|ghideon|sul\s+pc|al\s+pc|persona\s*1|alessio\s+cast|alexx\s+cast)\b/i.test(txt);
  });
  const removedFlows = rawFlows.length - cleanFlows.length;
  if (removedFlows > 0) {
    kvSet(db, 'phoneFlows', cleanFlows);
    actions.push(`Rimossi ${removedFlows} flussi telefono errati/duplicati`);
  }

  // 2. Consolidamento modularSkills (un solo automatismo per dispositivo + servizio canonico)
  const rawSkills = flows.listSkills(db);
  const byId = new Map();
  for (const sk of rawSkills) {
    const svc = flows.canonicalService(sk.service || sk.name || '');
    const key = `${sk.device || 'pc'}:${svc}`;
    const prev = byId.get(key);
    if (!prev || Number(sk.updatedAt || 0) > Number(prev.updatedAt || 0)) {
      byId.set(key, { ...sk, service: svc });
    }
  }
  const mergedSkills = [...byId.values()];
  const removedSkills = rawSkills.length - mergedSkills.length;
  if (removedSkills > 0) {
    kvSet(db, 'modularSkills', mergedSkills);
    actions.push(`Consolidati ${removedSkills} automatismi doppi`);
  }

  // 3. Rimozione comandi PC scaduti (>10 min) rimasti in coda
  const queue = kvGet(db, 'devicesQueue', []);
  const freshQueue = queue.filter(c => (nowMs - Number(c.createdAt || nowMs)) <= STALE_QUEUE_MS);
  const removedQueue = queue.length - freshQueue.length;
  if (removedQueue > 0) {
    kvSet(db, 'devicesQueue', freshQueue);
    actions.push(`Rimossi ${removedQueue} comandi PC scaduti dalla coda`);
  }

  // 4. Apprendimento automatico da correzioni recenti ("no chiudi X", "doveva essere Y")
  let learned = 0;
  const recent = db.all("SELECT role, text FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 10").reverse();
  for (let i = 1; i < recent.length; i++) {
    const prevTxt = String(recent[i - 1].text || '').trim();
    const curTxt = String(recent[i].text || '').trim();
    if (/^(?:no(?:\s+no)?|sbagliato|non\s+hai)\b/i.test(curTxt)) {
      const mClose = /\bchiudi\s+(google\s+chrome|chrome|prime(?:\s+video)?|youtube|spotify|vscode)\b/i.exec(curTxt);
      if (mClose && prevTxt.length >= 4 && prevTxt.length <= 45 && !/\bchiudi\b/i.test(prevTxt)) {
        const tgt = /chrome/i.test(mClose[1]) ? 'chrome' : mClose[1].toLowerCase();
        if (learnAlias(db, prevTxt, { kind: 'close_app', target: tgt, device: 'pc' }, nowMs)) learned++;
      }
      const mAcc = /\b(?:dovrebbe\s+essere|usa|intendevo)\s+(alexx\s+cast|alessio\s+cast|persona\s*1|ale)\b/i.exec(curTxt);
      if (mAcc) {
        const devs = kvGet(db, 'devicesRegistry', []);
        const pc = devs.find(d => d.kind === 'desktop');
        if (pc) {
          flows.saveAccount(db, mAcc[1]);
        }
      }
    }
  }
  if (learned > 0) actions.push(`Appresi ${learned} nuovi alias dai comandi corretti`);

  const report = {
    at: nowIsoOf(nowMs, tz),
    atMs: nowMs,
    actions,
    learnedTotal: listLearnedAliases(db).length,
    skillsTotal: mergedSkills.length,
    flowsTotal: cleanFlows.length,
    openIssues: kvGet(db, 'fixLatenti', []).length,
  };
  kvSet(db, LAST_HEAL_KEY, report);
  if (actions.length) logEvent(db, report.at, 'heal', actions.join(' · '));
  return report;
}

/**
 * Diagnosi approfondita tramite modello LLM interno su fixLatenti (chiamata solo su richiesta esplicita di auto-riparazione):
 * estrae nuovi alias e correzioni strutturate senza modificare codice alla cieca.
 */
export async function diagnoseWithModel(db, env, fetchFn, nowMs = Date.now(), tz = 'Europe/Rome') {
  const baseReport = runDeterministicHeal(db, nowMs, tz);
  const issues = kvGet(db, 'fixLatenti', []);
  if (!issues.length) return { ...baseReport, aiSummary: 'Nessun problema aperto in fixLatenti.' };

  const snippet = issues.slice(0, 4).map(it =>
    `## ${it.title}\n` +
    (it.errors || []).slice(0, 3).join('\n') + '\n' +
    (it.messages || []).slice(-6).map(m => `${m.role}: ${m.text}`).join('\n')
  ).join('\n\n');

  try {
    const res = await router.chat(db, env, {
      tier: 'smart',
      maxTokens: 700,
      fetchFn,
      tz,
      build: () => [
        {
          role: 'system',
          content: 'Sei il modulo interno SelfHeal di Jarvis. Analizza i problemi ricorrenti in fixLatenti e rispondi SOLO in JSON valido: {"aliases":[{"from":"frase errata","kind":"open_app|close_app|open_url|open_chrome_profile","target":"...","device":"pc|telefono"}],"summary":"breve sintesi in italiano delle cause e correzioni applicate"}.',
        },
        { role: 'user', content: snippet.slice(0, 6000) },
      ],
    });
    const rawJson = String(res.text || '').replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(rawJson);
    let added = 0;
    for (const a of (Array.isArray(parsed.aliases) ? parsed.aliases : []).slice(0, 8)) {
      if (learnAlias(db, a.from, a, nowMs)) added++;
    }
    const summary = String(parsed.summary || '').trim();
    const nextReport = { ...baseReport, aiAddedAliases: added, aiSummary: summary, model: res.key };
    kvSet(db, LAST_HEAL_KEY, nextReport);
    return nextReport;
  } catch (e) {
    return { ...baseReport, aiSummary: `Analisi locale completata (modello non disponibile: ${e.message}).` };
  }
}
