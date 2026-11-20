// API HTTP di Jarvis (gira dentro il Durable Object, una richiesta alla volta).

import { kvGet, kvSet, logEvent, WRITE_LIMIT_RE, friendlyError, setWriteSource, writeReport, writesBlocked, writeBlock } from './db.js';
import { handleChat, isAddressed, applyActions, addMessage, isReplayable } from './brain.js';
import { loadDiary, saveDiary, mergeLegacy, patchProfile, DIET_ACTIONS } from './diet.js';
import * as N from './nutrition.js';
import * as memory from './memory.js';
import * as phone from './phone.js';
import * as cooking from './cooking.js';
import * as flows from './flows.js';
import * as devices from './devices.js';
import * as jarvisCore from './jarvis_core.js';
import * as selfHeal from './self_heal.js';
import * as workspace from './workspace.js';
import * as projects from './projects.js';
import * as initiative from './initiative.js';
import * as lessons from './lessons.js';
import * as places from './places.js';
import * as agenda from './agenda.js';
import * as ui from './ui.js';
import * as coder from './coder.js';
import * as mood from './mood.js';
import * as jobs from './jobs.js';
import * as router from './router.js';
import { sanitizeModels, DEFAULT_MODELS, PROVIDERS } from './models.js';
import { today as todayOf, nowIso as nowIsoOf } from './clock.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const MAX_BODY = 6 * 1024 * 1024;

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('richiesta troppo grande');
  if (!text) return {};
  try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : {}; } catch { throw new Error('JSON non valido'); }
}

function statePayload(db, ms, tz, env = {}) {
  const today = todayOf(ms, tz);
  const d = loadDiary(db);
  const days = [];
  for (let i = 0; i < 30; i++) {
    const date = N.addDays(today, -i);
    const t = N.totals(d, date);
    if (i > 0 && !t.kcal && !t.steps && !t.burned) continue;
    days.push({ date, kcal: Math.round(t.kcal), protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat), burned: Math.round(t.burned), steps: t.steps });
  }
  const complete = N.todaySummary(d, today).profileComplete;
  return {
    now: nowIsoOf(ms, tz), today: N.todaySummary(d, today), days,
    balance: complete ? (({ dailyProgressList, ...rest }) => rest)(N.cumulativeBalance(d, today)) : null,
    diary: d, reminders: agenda.listReminders(db, tz), jobs: jobs.listJobs(db), places: places.listPlaces(db),
    liveCards: jarvisCore.listLiveCards(db, ms),
    cooking: cooking.session(db),
    recipes: cooking.listSaved(db).map(r => ({ id: r.id, title: r.title, kcal: r.kcal, minutes: r.minutes, savedAt: r.savedAt })),
    timedActions: kvGet(db, 'timedActions', []).filter(t => Number(t.dueMs) > ms),
    skills: flows.listSkills(db),
    activeWorkspace: workspace.getActiveWorkspace(db),
    activeProject: projects.activeSummary(db),
    legacyImported: kvGet(db, 'legacyImported', null),
    layout: ui.loadLayout(db),
    mood: mood.current(db, ms),
    code: coder.enabled(env) ? safe(() => coder.listProposals(db), []).filter(x => ['working', 'ready', 'testing'].includes(x.status)) : null,
    server: serverStatus(),
  };
}

/** Una parte secondaria dello stato che si rompe non deve impedire all'app di aprirsi. */
function safe(fn, fallback) { try { return fn(); } catch (e) { console.error('stato:', e?.message || e); return fallback; } }

/** Stato del server per l'app: con le scritture finite si legge tutto, le modifiche le tiene il telefono. */
function serverStatus() {
  return { writesBlocked: writesBlocked(), until: writesBlocked() ? (writeBlock.resetAt || null) : null };
}

const OFFLINE_NOTE_SAVED = ' (Oggi Cloudflare non mi lascia salvare: lo tengo sul telefono e lo salvo da sola appena il limite si azzera.)';
const OFFLINE_NOTE_CHAT = ' (Oggi non posso salvare la chat sul server: la tiene il telefono e la porto qui appena il limite si azzera.)';

/**
 * deps: { now, tz, fetchFn, defer(promise), schedule(atMs) }
 */
export async function handleApi(db, env, deps, request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const ms = deps.now(), tz = deps.tz;
  // Letture e chat non si bloccano se finiscono le scritture: si salta quello che non si può salvare.
  // Le altre richieste restano rigide (rispondono 503 e il telefono mette la modifica in coda).
  if (db.view) db = db.view({ tolerant: method === 'GET' || path === '/api/chat', pendingReplay: [] });
  const startJob = (j) => { jobs.createJob(db, j, deps.now(), tz); deps.schedule?.(deps.now() + 500); };
  setWriteSource(`${method} ${path.replace(/\/[0-9a-z_-]*\d[0-9a-z_-]*(?=\/|$)/gi, '/:id')}`);
  const chatDeps = { ...deps, startJob };

  try {
    if (path === '/api/chat' && method === 'POST') {
      devices.markActive(db, ms); // il Capo sta parlando: il PC torna a chiedere comandi ogni 2 secondi
      const b = await body(request);
      const image = typeof b.image === 'string' && b.image.length > 100 ? b.image.replace(/^data:image\/\w+;base64,/, '') : null;
      const files = Array.isArray(b.files) ? b.files.slice(0, 4).filter(f => f && f.name && typeof f.content === 'string').map(f => ({
        name: String(f.name).slice(0, 80),
        encoding: f.encoding === 'base64' ? 'base64' : 'text',
        content: String(f.content).slice(0, f.encoding === 'base64' ? 4_000_000 : 60000),
      })) : [];
      const out = await handleChat(db, env, chatDeps, { text: b.text, image, files, sessionId: String(b.session || 'main').slice(0, 40), source: b.source === 'voice' ? 'voice' : 'app', followup: b.followup === true, afterWake: b.afterWake === true, media: b.media === true });
      const nextDue = agenda.fireDue(db, deps.now(), tz);
      if (nextDue) deps.schedule?.(nextDue);
      if (db.swallowed) {
        const pending = db.pendingReplay || [];
        out.unsaved = true; out.writesBlocked = true; out.pendingActions = pending;
        if (out.reply) out.reply += pending.length ? OFFLINE_NOTE_SAVED : OFFLINE_NOTE_CHAT;
      }
      return json(out);
    }
    if (path === '/api/sync' && method === 'POST') {
      // Il telefono ripete qui quello che non si è potuto salvare (server irraggiungibile o scritture finite).
      // Ogni operazione ha un id: se una risposta si perde e il telefono la rimanda, non si applica due volte.
      const b = await body(request);
      const ops = (Array.isArray(b.ops) ? b.ops : []).slice(0, 30);
      const seen = kvGet(db, 'syncedOps', []);
      const done = [], replies = [];
      let chats = 0;
      for (const op of ops) {
        const id = String(op?.id || '').slice(0, 60);
        if (!id) continue;
        if (seen.includes(id)) { done.push(id); continue; }
        // L'ora vera dell'operazione: un pasto delle 22 rimandato dopo mezzanotte resta nel suo giorno.
        const at = Math.min(ms, Math.max(ms - 7 * 86_400_000, Number(op.at) || ms));
        if (op.kind === 'actions') {
          const actions = (Array.isArray(op.actions) ? op.actions : []).filter(a => a && isReplayable(a.type));
          applyActions(db, actions, { today: todayOf(at, tz), nowIso: nowIsoOf(at, tz), ms: at, tz, hadPhoto: false });
        } else if (op.kind === 'history') {
          const session = String(op.session || projects.activeSession(db)).slice(0, 80);
          for (const m of (Array.isArray(op.messages) ? op.messages : []).slice(0, 20)) {
            if (!m || !['user', 'assistant'].includes(m.role) || !String(m.text || '').trim()) continue;
            const mAt = Math.min(ms, Math.max(ms - 7 * 86_400_000, Number(m.at) || at));
            addMessage(db, session, m.role, String(m.text).slice(0, 8000), nowIsoOf(mAt, tz), { offline: true });
          }
        } else if (op.kind === 'chat') {
          if (chats++ >= 3) break; // un modello per volta: il resto al prossimo giro
          const text = String(op.text || '').trim().slice(0, 4000);
          if (text) {
            const when = new Intl.DateTimeFormat('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);
            const out = await handleChat(db, env, chatDeps, { text: `(Messaggio del Capo del ${when}, scritto mentre il server non rispondeva: registralo con quel giorno e quell'ora, senza azioni sul telefono o sul PC.) ${text}`, sessionId: 'main', source: 'app' });
            replies.push({ id, text, reply: out.reply });
          }
        } else continue;
        seen.push(id); done.push(id);
        kvSet(db, 'syncedOps', seen.slice(-300));
      }
      const nextDue = agenda.fireDue(db, deps.now(), tz);
      if (nextDue) deps.schedule?.(nextDue);
      return json({ done, replies, state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/apps' && method === 'POST') {
      // Etichette delle app installate, mandate dal telefono quando cambiano.
      const b = await body(request);
      const apps = [...new Set((Array.isArray(b.apps) ? b.apps : []).map(a => String(a || '').trim().slice(0, 40)).filter(Boolean))].sort((x, y) => x.localeCompare(y)).slice(0, 400);
      kvSet(db, 'apps', apps);
      return json({ count: apps.length });
    }
    if (path === '/api/phone/step' && method === 'POST') return json(await phone.step(db, env, deps, await body(request)));
    if (path === '/api/flows' && method === 'GET') return json({ flows: flows.listFlows(db), skills: flows.listSkills(db) });
    const flowDel = /^\/api\/flows\/([^/]+)$/.exec(path);
    if (flowDel && method === 'DELETE') return json({ flows: flows.deleteFlow(db, decodeURIComponent(flowDel[1])) });
    if (path === '/api/skills/run' && method === 'POST') {
      const b = await body(request);
      const skill = flows.listSkills(db).find(s => s.id === b.id);
      if (!skill) return bad('automatismo non trovato', 404);
      const overrideText = [
        b.account ? `con account ${b.account}` : '',
        b.media ? `metti ${b.media}` : '',
      ].filter(Boolean).join(' ');
      const plan = flows.planSkillExecution(skill, overrideText);
      const devList = [];
      for (const st of plan.steps) {
        if (skill.device === 'pc') {
          devices.enqueueCommand(db, 'desktop', { kind: st.kind, target: st.target, args: st.args || '' }, ms);
        } else if (st.kind === 'open_url') {
          devList.push({ type: 'open_url', url: st.target });
        } else if (st.kind === 'open_app') {
          devList.push({ type: 'open_app', name: st.target });
        }
      }
      return json({ ok: true, executed: plan.steps.length, device: devList, skill: skill.name });
    }
    const skillDel = /^\/api\/skills\/([^/]+)$/.exec(path);
    if (skillDel && method === 'DELETE') {
      const id = decodeURIComponent(skillDel[1]);
      const next = flows.listSkills(db).filter(s => s.id !== id);
      kvSet(db, 'modularSkills', next);
      return json({ skills: next });
    }
    if (path === '/api/devices' && method === 'GET') return json({ devices: devices.listDevices(db, ms), history: devices.listCommandHistory(db) });
    if (path === '/api/devices/heartbeat' && method === 'POST') return json(devices.heartbeat(db, await body(request), ms));
    if (path === '/api/devices/result' && method === 'POST') return json(devices.reportResult(db, await body(request), ms));
    if (path === '/api/devices/command' && method === 'POST') {
      const b = await body(request);
      devices.markActive(db, ms);
      const cmd = devices.enqueueCommand(db, b.targetDevice || 'desktop', b, ms);
      return json({ command: cmd, devices: devices.listDevices(db, ms), history: devices.listCommandHistory(db) });
    }
    if (path === '/api/devices/screen' && method === 'POST') {
      const b = await body(request);
      const img = String(b.image || '').replace(/^data:image\/\w+;base64,/, '');
      if (!img) return bad('immagine mancante');
      kvSet(db, 'pcScreen', { image: img, title: String(b.title || 'Schermo PC').slice(0, 100), at: ms });
      return json({ ok: true, at: ms });
    }
    if (path === '/api/devices/screen' && method === 'GET') {
      const scr = kvGet(db, 'pcScreen', null);
      return json(scr || { image: '', title: 'In attesa dello screenshot dal PC...', at: 0 });
    }
    if (path === '/api/addressed' && method === 'POST') {
      const b = await body(request);
      try { return json({ addressed: await isAddressed(db, env, deps, b.text) }); } catch { return json({ addressed: false, error: true }); }
    }
    if (path === '/api/writes' && method === 'GET') return json(writeReport());
    if (path === '/api/state' && method === 'GET') return json(statePayload(db, ms, tz, env));

    if (path === '/api/history' && method === 'GET') {
      // Senza sessione indicata: la chat in corso (quella del progetto attivo, se ce n'è uno).
      const session = String(url.searchParams.get('session') || projects.activeSession(db));
      const rows = db.all('SELECT id, role, text, at, meta FROM messages WHERE session = ? ORDER BY id DESC LIMIT 80', session).reverse();
      return json({ messages: rows.map(m => ({ id: m.id, role: m.role, text: m.text, at: m.at, ...(safeParse(m.meta) || {}) })) });
    }

    if (path === '/api/actions' && method === 'POST') {
      // Modifiche fatte a mano dall'interfaccia: stesse azioni che usa il modello.
      const b = await body(request);
      const actions = (Array.isArray(b.actions) ? b.actions : []).filter(a => a && a.type !== 'show' && (DIET_ACTIONS.has(a.type) || cooking.COOKING_ACTIONS.has(a.type) || ['remember', 'forget', 'add_reminder', 'done_reminder', 'live_card'].includes(a.type) || ui.UI_ACTIONS.has(a.type)));
      const done = applyActions(db, actions, { today: todayOf(ms, tz), nowIso: nowIsoOf(ms, tz), ms, tz, hadPhoto: false });
      const nextDue = agenda.fireDue(db, ms, tz);
      if (nextDue) deps.schedule?.(nextDue);
      return json({ applied: done.applied, state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/profile' && method === 'PUT') {
      const b = await body(request);
      const d = loadDiary(db);
      d.profile = patchProfile(d.profile, b.profile || {});
      if (Number(b.profile?.weightKg) > 20 && !d.weights.length) d.weights.push({ date: todayOf(ms, tz), kg: Number(b.profile.weightKg) });
      saveDiary(db, d);
      return json({ state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/steps' && method === 'POST') {
      const b = await body(request);
      const date = N.parseDate(b.date) ? b.date : todayOf(ms, tz);
      const steps = Math.trunc(Number(b.steps));
      if (!(steps >= 0 && steps < 200000)) return bad('passi non validi');
      const d = loadDiary(db);
      d.steps[date] = steps;
      saveDiary(db, d);
      return json({ ok: true });
    }
    if (path === '/api/import/legacy' && method === 'POST') {
      const b = await body(request);
      const legacy = b.diary;
      if (!legacy || typeof legacy !== 'object' || !Array.isArray(legacy.meals)) return bad('diario non valido');
      const merged = mergeLegacy(loadDiary(db), legacy);
      saveDiary(db, merged);
      // La vecchia chat entra nella sessione principale solo se questa è ancora vuota.
      if (Array.isArray(legacy.chat) && !db.get("SELECT id FROM messages WHERE session = 'main' LIMIT 1")) {
        for (const m of legacy.chat.slice(-60)) if (m && m.text) addMessage(db, 'main', m.role === 'user' ? 'user' : 'assistant', String(m.text).slice(0, 4000), String(m.at || nowIsoOf(ms, tz)));
      }
      kvSet(db, 'legacyImported', nowIsoOf(ms, tz));
      logEvent(db, nowIsoOf(ms, tz), 'import', `diario app: ${legacy.meals.length} pasti`);
      return json({ ok: true, meals: merged.meals.length, activities: merged.activities.length, weights: merged.weights.length, state: statePayload(db, ms, tz, env) });
    }

    if (path.startsWith('/preview/')) return await coder.servePreview(db, env, deps, path + (url.pathname.endsWith('/') && !path.endsWith('/') ? '/' : ''));
    if (path === '/api/code' && method === 'GET') return json({ enabled: coder.enabled(env), items: coder.listProposals(db) });
    if (path === '/api/code' && method === 'POST') {
      if (!coder.enabled(env)) return bad('Per far modificare l\'app a Jarvis serve il segreto GITHUB_TOKEN su Cloudflare.');
      const b = await body(request);
      const req = String(b.request || '').trim();
      if (!req) return bad('Descrivi la modifica.');
      const id = coder.propose(db, req, ms, tz);
      deps.defer ? deps.defer(coder.work(db, env, deps, id)) : await coder.work(db, env, deps, id);
      return json({ id, state: statePayload(db, ms, tz, env) });
    }
    const codeOp = /^\/api\/code\/([a-z0-9]+)\/(approve|discard|revert)$/.exec(path);
    if (codeOp && method === 'POST') {
      await ({ approve: coder.approve, discard: coder.discard, revert: coder.revert })[codeOp[2]](db, env, deps, codeOp[1]);
      return json({ ok: true, state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/graph' && method === 'GET') {
      // Foglie della dieta: per non affollare la sfera con decine di vecchi pasti,
      // mostra solo l'ultimo pasto per fascia (colazione, pranzo, cena, spuntino) entro il tetto del ramo.
      // Riordino dei rami: solo manutenzione. Con le scritture finite non serve (non resterebbe) e non deve mai far sparire la sfera.
      if (!writesBlocked()) { try { memory.tidyIfDirty(db); } catch (e) { console.error('tidyTopics:', e?.message || e); } }
      const limits = kvGet(db, 'graphLimits', {});
      const g = memory.graph(db), d = loadDiary(db);
      const dietCap = Math.max(2, Math.min(10, Number(limits.dieta) || 5));
      const SLOT_LABELS = { colazione: 'Colazione', pranzo: 'Pranzo', cena: 'Cena', spuntino: 'Spuntino' };
      const bySlot = new Map();
      const slotContainers = new Map();
      for (const m of [...(d.meals || [])].reverse()) {
        const slot = String(m.meal || 'pasto').toLowerCase();
        if (bySlot.has(slot)) continue;
        const desc = (m.items || []).map(i => i.name).filter(Boolean).slice(0, 3).join(', ') || m.description || slot;
        const slotId = 'slot:' + slot;
        slotContainers.set(slotId, { id: slotId, label: SLOT_LABELS[slot] || (slot.charAt(0).toUpperCase() + slot.slice(1)), kind: 'topic' });
        bySlot.set(slot, { id: 'meal:' + m.id, label: desc.slice(0, 42), parent: slotId });
        if (bySlot.size >= 4) break;
      }
      const dieta = g.branches.find(b => b.id === 'dieta');
      dieta.children = [...dieta.children.slice(0, Math.max(1, dietCap - bySlot.size)), ...slotContainers.values(), ...bySlot.values()].slice(0, dietCap + slotContainers.size);
      // Sport: un nodo per ogni tipo di attività (corsa, palestra...), con quante volte e l'ultima data.
      const kinds = new Map();
      for (const a of d.activities || []) {
        const name = String(a.type || '').trim().toLowerCase();
        if (!name) continue;
        const k = kinds.get(name) || { n: 0, last: '' };
        kinds.set(name, { n: k.n + 1, last: a.date > k.last ? a.date : k.last });
      }
      const sport = g.branches.find(b => b.id === 'sport');
      const sportCap = Math.max(2, Math.min(12, Number(limits.sport) || 8));
      sport.children = [...sport.children, ...[...kinds].sort((a, b) => b[1].n - a[1].n).slice(0, sportCap)
        .map(([name, k]) => ({ id: 'sport:' + name, label: `${name} · ${k.n === 1 ? "una volta" : k.n + " volte"}, ultima ${k.last.slice(5)}` }))].slice(0, sportCap);
      for (const b of g.branches) {
        if (b.id !== 'dieta' && b.id !== 'sport' && limits[b.id]) b.children = (b.children || []).slice(0, Math.max(2, Number(limits[b.id]) || 6));
      }
      const sizes = { dieta: (d.meals || []).length, sport: (d.activities || []).length + (d.weights || []).length,
        agenda: (db.get('SELECT COUNT(*) AS n FROM reminders WHERE done = 0')?.n || 0), compiti: (db.get('SELECT COUNT(*) AS n FROM jobs')?.n || 0) };
      for (const b of g.branches) if (b.kind === 'module') sizes[b.id] = (b.entries || 0) + (db.get('SELECT COUNT(*) AS n FROM topics WHERE module = ?', b.id)?.n || 0);
      try { memory.addLevels(db, g.branches, sizes, ms); } catch (e) { console.error('addLevels:', e?.message || e); }
      return json({ ...g, last: kvGet(db, 'lastTouched', null), mood: mood.current(db, ms) });
    }
    if (path === '/api/mind' && method === 'GET') {
      // Come Jarvis archivia e usa i contesti: dipartimenti, argomenti, riassunti, compiti.
      if (!writesBlocked()) { try { memory.tidyIfDirty(db); } catch (e) { console.error('tidyTopics:', e?.message || e); } }
      const g = memory.graph(db, { perModule: 40 });
      const sizes = {};
      for (const b of g.branches) if (b.kind === 'module') sizes[b.id] = (b.entries || 0) + (db.get('SELECT COUNT(*) AS n FROM topics WHERE module = ?', b.id)?.n || 0);
      try { memory.addLevels(db, g.branches, sizes, ms); } catch (e) { console.error('addLevels:', e?.message || e); }
      const use = kvGet(db, 'branchUse', {});
      const last = db.get("SELECT modules FROM sessions ORDER BY updated DESC LIMIT 1");
      let active = [];
      try { active = Object.entries(JSON.parse(last?.modules || '{}')).filter(([, ttl]) => ttl > 0).map(([k]) => k); } catch { /* vuoto */ }
      return json({
        departments: g.branches.filter(b => b.kind === 'module').map(b => {
          const tRows = db.all('SELECT name, label, parent, uses FROM topics WHERE module = ? ORDER BY uses DESC LIMIT 40', b.id);
          const mRows = tRows.length ? [] : db.all('SELECT id, text, uses FROM memories WHERE module = ? ORDER BY uses DESC, id DESC LIMIT 15', b.id)
            .map(r => ({ name: 'm-' + r.id, label: String(r.text || '').slice(0, 55), parent: '', uses: r.uses || 1 }));
          return {
            id: b.id, label: b.label, description: b.description || '', entries: b.entries || 0, level: b.level, ring: b.ring,
            uses: Math.round((use[b.id]?.score || 0) * 10) / 10,
            topics: [...tRows, ...mRows],
          };
        }).sort((a, b) => a.level - b.level),
        automations: (g.branches.find(b => b.id === 'automazioni')?.children || []).map(c => ({ id: c.id, label: c.label })),
        core: g.branches.filter(b => b.kind === 'core').map(b => ({ id: b.id, label: b.label, count: (b.children || []).length, level: b.level, ring: b.ring })),
        summaries: db.all("SELECT id, summary, updated FROM sessions WHERE summary != '' ORDER BY updated DESC LIMIT 20"),
        active,
        jobs: jobs.listJobs(db).slice(0, 10).map(j => ({ id: j.id, title: j.title, status: j.status, steps: j.steps.length })),
        // Cosa è entrato nel contesto dell'ultima risposta, e com'è andata la gestione della memoria.
        context: kvGet(db, 'contextReport', null),
        contextHistory: kvGet(db, 'contextReports', []),
        consolidation: kvGet(db, 'consolidationLog', []).slice(-7),
        improvements: kvGet(db, 'improvementRequests', []).slice(-10),
        ignoredHeard: kvGet(db, 'ignoredHeard', []).slice(-5),
        projects: projects.listProjects(db).slice(0, 12),
        lessons: lessons.list(db).slice(-12).reverse(),
        initiative: { settings: initiative.settings(db), history: kvGet(db, 'initiativeHistory', []).slice(-8).reverse() },
      });
    }
    if (path === '/api/memory' && method === 'GET') {
      return json({ modules: memory.listModules(db), entries: db.all("SELECT id, module, text, created, uses FROM memories WHERE module NOT LIKE 'p:%' ORDER BY module, id DESC LIMIT 1000") });
    }
    if (path === '/api/memory' && method === 'POST') {
      const b = await body(request);
      const id = memory.remember(db, b, nowIsoOf(ms, tz));
      return id ? json({ id }) : bad('testo mancante');
    }
    const mem = /^\/api\/memory\/(\d+)$/.exec(path);
    if (mem && method === 'DELETE') { memory.forget(db, mem[1]); return json({ ok: true }); }

    if (path === '/api/reminders' && method === 'POST') {
      const b = await body(request);
      const id = agenda.addReminder(db, b, ms, tz);
      if (!id) return bad('testo o data non validi');
      const nextDue = agenda.fireDue(db, ms, tz);
      if (nextDue) deps.schedule?.(nextDue);
      return json({ id, reminders: agenda.listReminders(db, tz) });
    }
    if (path === '/api/places' && method === 'GET') return json({ places: places.listPlaces(db) });
    if (path === '/api/places' && method === 'POST') {
      const b = await body(request);
      if (!places.savePlace(db, b)) return bad('nome o coordinate non validi');
      return json({ places: places.listPlaces(db), reminders: agenda.listReminders(db, tz) });
    }
    const plc = /^\/api\/places\/([^/]+)$/.exec(path);
    if (plc && method === 'DELETE') { places.deletePlace(db, decodeURIComponent(plc[1])); return json({ places: places.listPlaces(db) }); }
    if (path === '/api/place-event' && method === 'POST') {
      const b = await body(request);
      return json({ items: agenda.placeEvent(db, b.place, b.event, ms, tz) });
    }
    const rem = /^\/api\/reminders\/([\w-]+)$/.exec(path);
    if (rem && method === 'DELETE') { agenda.deleteReminder(db, rem[1]); return json({ reminders: agenda.listReminders(db, tz) }); }

    if (path === '/api/jobs' && method === 'POST') {
      const b = await body(request);
      if (!String(b.goal || '').trim()) return bad('descrivi il compito');
      startJob({ title: b.title || String(b.goal).slice(0, 60), goal: b.goal });
      return json({ jobs: jobs.listJobs(db) });
    }
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: jobs.listJobs(db) });
    const jobDoc = /^\/api\/jobs\/([\w-]+)\/document$/.exec(path);
    if (jobDoc && method === 'GET') {
      const j = db.get('SELECT * FROM jobs WHERE id = ?', jobDoc[1]);
      if (!j) return bad('non trovato', 404);
      let steps = [];
      try { steps = JSON.parse(j.steps || '[]'); } catch {}
      const htmlFile = steps.flatMap(s => jobs.extractProjectFiles(s.output || '')).find(f => /\.html?$/i.test(f.path));
      const html = htmlFile ? htmlFile.content : jobs.buildDsaHtml(j.title, j.result || j.goal);
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const job = /^\/api\/jobs\/([\w-]+)$/.exec(path);
    if (job && method === 'GET') {
      const j = db.get('SELECT * FROM jobs WHERE id = ?', job[1]);
      return j ? json({ ...j, steps: safeParse(j.steps) || [] }) : bad('non trovato', 404);
    }
    if (job && method === 'DELETE') { db.run('DELETE FROM jobs WHERE id = ?', job[1]); return json({ jobs: jobs.listJobs(db) }); }

    // ---------------------------------------------------------------- iniziativa, notifiche, lezioni
    if (path === '/api/notify' && method === 'POST') {
      // Notifiche lette dall'app Android: contesto per "chi mi ha scritto?" e avvisi se urgenti.
      const b = await body(request);
      return json(initiative.ingestNotifications(db, b.items, ms, tz));
    }
    if (path === '/api/initiative' && method === 'GET') return json({ settings: initiative.settings(db), history: kvGet(db, 'initiativeHistory', []).slice(-20).reverse() });
    if (path === '/api/initiative' && method === 'POST') return json({ settings: initiative.saveSettings(db, await body(request)) });
    if (path === '/api/lessons' && method === 'GET') return json({ lessons: lessons.list(db).slice().reverse() });
    const lessonDel = /^\/api\/lessons\/([\w-]+)$/.exec(path);
    if (lessonDel && method === 'DELETE') { lessons.forget(db, lessonDel[1]); return json({ lessons: lessons.list(db).slice().reverse() }); }

    // ---------------------------------------------------------------- progetti (come i progetti di Claude)
    if (path === '/api/projects' && method === 'GET') return json({ projects: projects.listProjects(db), active: projects.activeSummary(db) });
    if (path === '/api/projects' && method === 'POST') {
      const b = await body(request);
      if (!String(b.name || '').trim()) return bad('serve un nome');
      const id = projects.createProject(db, { name: b.name, instructions: b.instructions || '' }, nowIsoOf(ms, tz), ms);
      return json({ id, projects: projects.listProjects(db) });
    }
    if (path === '/api/projects/exit' && method === 'POST') {
      projects.exitProject(db);
      return json({ state: statePayload(db, ms, tz, env) });
    }
    const pr = /^\/api\/projects\/([\w-]+)(?:\/(files|memory|chats|jobs|enter|progress)(?:\/([\w-]+))?)?$/.exec(path);
    if (pr) {
      const [, pid, sub, subId] = pr;
      const p = projects.getProject(db, pid);
      if (!p) return bad('progetto non trovato', 404);
      const at = nowIsoOf(ms, tz);
      const detail = () => json({
        project: projects.getProject(db, pid), files: projects.listFiles(db, pid), chats: projects.listChats(db, pid),
        memories: projects.listMemories(db, pid), jobs: jobs.listJobs(db).filter(j => j.project === pid), active: projects.activeSummary(db),
        progress: projects.logSummary(projects.getLog(db, pid), { last: 30 }),
      });
      if (!sub && method === 'GET') return detail();
      if (!sub && (method === 'POST' || method === 'PATCH')) { const b = await body(request); projects.updateProject(db, pid, b, at); return detail(); }
      if (!sub && method === 'DELETE') { projects.deleteProject(db, pid); return json({ projects: projects.listProjects(db), state: statePayload(db, ms, tz, env) }); }
      if (sub === 'enter' && method === 'POST') {
        const b = await body(request);
        projects.enterProject(db, pid, { chatId: String(b.chatId || ''), newChat: b.newChat === true }, at, ms);
        return json({ state: statePayload(db, ms, tz, env) });
      }
      if (sub === 'files' && !subId && method === 'POST') {
        const b = await body(request);
        let content = typeof b.content === 'string' ? b.content : '';
        if (b.encoding === 'base64') {
          // PDF: il testo viene estratto una volta sola e salvato, così ogni modello lo può leggere.
          content = await router.readPdfWithGemini(env, deps.fetchFn, content.replace(/^data:[^,]+,/, ''), 'Estrai fedelmente tutto il testo, le tabelle e le istruzioni di questo PDF.') || '';
          if (!content) return bad('non sono riuscita a leggere il PDF');
        }
        if (!projects.upsertFile(db, pid, { name: b.name, content }, at)) return bad('file vuoto');
        return detail();
      }
      if (sub === 'files' && subId && method === 'DELETE') { projects.deleteFile(db, pid, subId); return detail(); }
      if (sub === 'progress' && method === 'DELETE') { projects.clearLog(db, pid); return detail(); }
      if (sub === 'files' && subId && method === 'POST') {
        // "Usa come istruzioni": il file diventa le istruzioni del progetto (intero se ci sta).
        const f = db.get('SELECT content FROM project_files WHERE project = ? AND id = ?', pid, Number(subId));
        if (!f) return bad('file non trovato');
        const instr = await projects.instructionsFromDoc(db, env, deps.fetchFn, f.content, { tz });
        if (!instr) return bad('file vuoto');
        projects.updateProject(db, pid, { instructions: instr }, at);
        return detail();
      }
      if (sub === 'memory' && method === 'POST') { const b = await body(request); if (!projects.remember(db, pid, b.text, at)) return bad('testo mancante'); return detail(); }
      if (sub === 'memory' && subId && method === 'DELETE') { db.run('DELETE FROM memories WHERE id = ? AND module = ?', Number(subId), projects.memModule(pid)); return detail(); }
      if (sub === 'chats' && subId && method === 'DELETE') {
        const c = db.get('SELECT * FROM project_chats WHERE id = ? AND project = ?', subId, pid);
        if (c) { db.run('DELETE FROM messages WHERE session = ?', c.session); db.run('DELETE FROM sessions WHERE id = ?', c.session); db.run('DELETE FROM project_chats WHERE id = ?', c.id); }
        if (kvGet(db, 'activeProject', null)?.chat === subId) projects.exitProject(db);
        return detail();
      }
      if (sub === 'jobs' && method === 'POST') {
        const b = await body(request);
        if (!String(b.goal || '').trim()) return bad('serve un obiettivo');
        startJob({ title: String(b.title || b.goal).slice(0, 60), goal: String(b.goal), project: pid });
        return detail();
      }
      return bad('richiesta non valida', 404);
    }

    if (path === '/api/workspace/enter' && method === 'POST') {
      const b = await body(request);
      const fileList = Array.isArray(b.files) ? b.files.slice(0, 4).filter(f => f && f.name && typeof f.content === 'string') : [];
      const pdfB64 = fileList.find(f => f.encoding === 'base64' && /\.pdf$/i.test(f.name))?.content || null;
      const textJoined = fileList.filter(f => f.encoding !== 'base64').map(f => `=== ${f.name} ===\n${f.content}`).join('\n\n');
      const active = await workspace.enterWorkspace(db, env, deps.fetchFn, {
        jobId: String(b.jobId || '').trim(),
        title: String(b.title || '').trim(),
        contextText: [b.text, textJoined].filter(Boolean).join('\n\n'),
        pdfBase64: pdfB64,
        nowMs: ms,
        tz,
      });
      return json({ activeWorkspace: active, state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/workspace/exit' && method === 'POST') {
      workspace.exitWorkspace(db);
      return json({ activeWorkspace: null, state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/workspace/toggle' && method === 'POST') {
      const b = await body(request);
      const active = workspace.toggleWorkspaceItem(db, b.widgetIdx, b.itemIdx);
      return json({ activeWorkspace: active });
    }

    if (path === '/api/inbox' && method === 'GET') return json({ items: db.all('SELECT id, kind, text, at FROM inbox ORDER BY id DESC LIMIT 30') });
    if (path === '/api/fix-latenti' && method === 'GET') {
      if (url.searchParams.get('format') === 'json') return json({ items: jarvisCore.listFixLatenti(db) });
      return new Response(jarvisCore.renderFixLatentiMarkdown(db), { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (path === '/api/fix-latenti' && method === 'DELETE') {
      db.run("DELETE FROM kv WHERE key = 'fixLatenti'");
      return json({ ok: true });
    }
    if (path === '/api/self-heal' && method === 'GET') {
      return json({
        aliases: selfHeal.listLearnedAliases(db),
        lastHeal: selfHeal.lastHeal(db),
        openIssues: jarvisCore.listFixLatenti(db).length,
      });
    }
    if (path === '/api/self-heal' && method === 'POST') {
      const report = await selfHeal.diagnoseWithModel(db, env, deps.fetchFn, ms, tz);
      return json(report);
    }
    if (path === '/api/inbox/consume' && method === 'POST') {
      const nextDue = agenda.fireDue(db, ms, tz);
      if (nextDue) deps.schedule?.(nextDue);
      const items = db.all('SELECT id, kind, text, at FROM inbox WHERE delivered = 0 ORDER BY id LIMIT 10');
      for (const i of items) db.run('UPDATE inbox SET delivered = 1 WHERE id = ?', i.id);
      // Tra quanto scade il prossimo promemoria: il telefono torna a chiedere proprio allora, non minuti dopo.
      return json({ items, nextInMs: nextDue ? Math.max(0, nextDue - ms) : null });
    }

    if (path === '/api/models' && method === 'GET') {
      return json({
        models: router.status(db, env, ms), custom: !!sanitizeModels(kvGet(db, 'models', null)).length,
        providers: Object.entries(PROVIDERS).map(([name, p]) => ({ name, env: p.env, configured: !!env[p.env] })),
        events: db.all('SELECT at, kind, text FROM events ORDER BY id DESC LIMIT 40'),
      });
    }
    if (path === '/api/models' && method === 'PUT') {
      const b = await body(request);
      if (b.reset) { kvSet(db, 'models', null); kvSet(db, 'modelsRemoved', []); return json({ ok: true, count: DEFAULT_MODELS.length }); }
      const list = sanitizeModels(b.models);
      if (!list.length) return bad('elenco modelli vuoto o non valido');
      kvSet(db, 'models', list);
      // Chi salva un elenco suo sceglie anche cosa lasciare fuori: i modelli del catalogo assenti non vengono riaggiunti.
      const keep = new Set(list.map(m => `${m.provider}:${m.model}`));
      kvSet(db, 'modelsRemoved', DEFAULT_MODELS.map(m => `${m.provider}:${m.model}`).filter(k => !keep.has(k)));
      return json({ ok: true, count: list.length });
    }
    if (path === '/api/models/unblock' && method === 'POST') { db.run('UPDATE model_state SET blocked_until = 0, fails = 0, low_until = 0'); return json({ ok: true }); }

    if (path === '/api/export' && method === 'GET') {
      return json({
        exportedAt: nowIsoOf(ms, tz), diary: loadDiary(db), memories: db.all('SELECT module, text, created FROM memories ORDER BY id'),
        modules: db.all('SELECT * FROM modules'), reminders: db.all('SELECT * FROM reminders'), jobs: db.all('SELECT * FROM jobs'),
        messages: db.all('SELECT session, role, text, at FROM messages ORDER BY id'), sessions: db.all('SELECT id, summary FROM sessions'),
        places: places.listPlaces(db), topics: db.all('SELECT * FROM topics'), layout: ui.loadLayout(db),
        flows: flows.listFlows(db),
      });
    }
    return bad('non trovato', 404);
  } catch (e) {
    try { logEvent(db, nowIsoOf(deps.now(), tz), 'error', `${method} ${path}: ${e.message}`); } catch { /* database in sola lettura */ }
    if (WRITE_LIMIT_RE.test(e.message || '')) return json({ error: friendlyError(e), writesBlocked: true, until: writeBlock.resetAt || null }, 503);
    return bad(e.message || 'errore interno', /JSON|grande/.test(e.message || '') ? 400 : 500);
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
