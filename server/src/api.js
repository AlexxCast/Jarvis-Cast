// API HTTP di Jarvis (gira dentro il Durable Object, una richiesta alla volta).

import { kvGet, kvSet, logEvent } from './db.js';
import { handleChat, isAddressed, applyActions, addMessage } from './brain.js';
import { loadDiary, saveDiary, mergeLegacy, patchProfile, DIET_ACTIONS } from './diet.js';
import * as N from './nutrition.js';
import * as memory from './memory.js';
import * as phone from './phone.js';
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
    legacyImported: kvGet(db, 'legacyImported', null),
    layout: ui.loadLayout(db),
    mood: mood.current(db, ms),
    code: coder.enabled(env) ? coder.listProposals(db).filter(x => ['working', 'ready'].includes(x.status)) : null,
  };
}

/**
 * deps: { now, tz, fetchFn, defer(promise), schedule(atMs) }
 */
export async function handleApi(db, env, deps, request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const ms = deps.now(), tz = deps.tz;
  const startJob = (j) => { jobs.createJob(db, j, deps.now(), tz); deps.schedule?.(deps.now() + 500); };
  const chatDeps = { ...deps, startJob };

  try {
    if (path === '/api/chat' && method === 'POST') {
      const b = await body(request);
      const image = typeof b.image === 'string' && b.image.length > 100 ? b.image.replace(/^data:image\/\w+;base64,/, '') : null;
      const out = await handleChat(db, env, chatDeps, { text: b.text, image, sessionId: String(b.session || 'main').slice(0, 40), source: b.source === 'voice' ? 'voice' : 'app' });
      const nextDue = agenda.fireDue(db, deps.now(), tz);
      if (nextDue) deps.schedule?.(nextDue);
      return json(out);
    }
    if (path === '/api/phone/step' && method === 'POST') return json(await phone.step(db, env, deps, await body(request)));
    if (path === '/api/addressed' && method === 'POST') {
      const b = await body(request);
      try { return json({ addressed: await isAddressed(db, env, deps, b.text) }); } catch { return json({ addressed: false, error: true }); }
    }
    if (path === '/api/state' && method === 'GET') return json(statePayload(db, ms, tz, env));

    if (path === '/api/history' && method === 'GET') {
      const session = String(url.searchParams.get('session') || 'main');
      const rows = db.all('SELECT id, role, text, at, meta FROM messages WHERE session = ? ORDER BY id DESC LIMIT 80', session).reverse();
      return json({ messages: rows.map(m => ({ id: m.id, role: m.role, text: m.text, at: m.at, ...(safeParse(m.meta) || {}) })) });
    }

    if (path === '/api/actions' && method === 'POST') {
      // Modifiche fatte a mano dall'interfaccia: stesse azioni che usa il modello.
      const b = await body(request);
      const actions = (Array.isArray(b.actions) ? b.actions : []).filter(a => a && (DIET_ACTIONS.has(a.type) || ['remember', 'forget', 'add_reminder', 'done_reminder'].includes(a.type) || ui.UI_ACTIONS.has(a.type)));
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
    const codeOp = /^\/api\/code\/([a-z0-9]+)\/(approve|discard)$/.exec(path);
    if (codeOp && method === 'POST') {
      await (codeOp[2] === 'approve' ? coder.approve : coder.discard)(db, env, deps, codeOp[1]);
      return json({ ok: true, state: statePayload(db, ms, tz, env) });
    }
    if (path === '/api/graph' && method === 'GET') {
      // Foglie della dieta: gli ultimi pasti e allenamenti registrati.
      const g = memory.graph(db), d = loadDiary(db);
      const meals = (d.meals || []).slice(-6).reverse().map(m => ({ id: 'meal:' + m.id, label: `${m.date.slice(5)} ${m.meal}: ${m.description || (m.items || []).map(i => i.name).filter(Boolean).slice(0, 3).join(', ')}` }));
      const dieta = g.branches.find(b => b.id === 'dieta');
      dieta.children = [...dieta.children, ...meals];
      // Sport: un nodo per ogni tipo di attività (corsa, palestra...), con quante volte e l'ultima data.
      const kinds = new Map();
      for (const a of d.activities || []) {
        const name = String(a.type || '').trim().toLowerCase();
        if (!name) continue;
        const k = kinds.get(name) || { n: 0, last: '' };
        kinds.set(name, { n: k.n + 1, last: a.date > k.last ? a.date : k.last });
      }
      const sport = g.branches.find(b => b.id === 'sport');
      sport.children = [...sport.children, ...[...kinds].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
        .map(([name, k]) => ({ id: 'sport:' + name, label: `${name} · ${k.n === 1 ? "una volta" : k.n + " volte"}, ultima ${k.last.slice(5)}` }))];
      return json({ ...g, last: kvGet(db, 'lastTouched', null) });
    }
    if (path === '/api/memory' && method === 'GET') {
      return json({ modules: memory.listModules(db), entries: db.all('SELECT id, module, text, created, uses FROM memories ORDER BY module, id DESC LIMIT 1000') });
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
    const job = /^\/api\/jobs\/([\w-]+)$/.exec(path);
    if (job && method === 'GET') {
      const j = db.get('SELECT * FROM jobs WHERE id = ?', job[1]);
      return j ? json({ ...j, steps: safeParse(j.steps) || [] }) : bad('non trovato', 404);
    }
    if (job && method === 'DELETE') { db.run('DELETE FROM jobs WHERE id = ?', job[1]); return json({ jobs: jobs.listJobs(db) }); }

    if (path === '/api/inbox' && method === 'GET') return json({ items: db.all('SELECT id, kind, text, at FROM inbox ORDER BY id DESC LIMIT 30') });
    if (path === '/api/inbox/consume' && method === 'POST') {
      const nextDue = agenda.fireDue(db, ms, tz);
      if (nextDue) deps.schedule?.(nextDue);
      const items = db.all('SELECT id, kind, text, at FROM inbox WHERE delivered = 0 ORDER BY id LIMIT 10');
      for (const i of items) db.run('UPDATE inbox SET delivered = 1 WHERE id = ?', i.id);
      return json({ items });
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
      if (b.reset) { kvSet(db, 'models', null); return json({ ok: true, count: DEFAULT_MODELS.length }); }
      const list = sanitizeModels(b.models);
      if (!list.length) return bad('elenco modelli vuoto o non valido');
      kvSet(db, 'models', list);
      return json({ ok: true, count: list.length });
    }
    if (path === '/api/models/unblock' && method === 'POST') { db.run('UPDATE model_state SET blocked_until = 0, fails = 0, low_until = 0'); return json({ ok: true }); }

    if (path === '/api/export' && method === 'GET') {
      return json({
        exportedAt: nowIsoOf(ms, tz), diary: loadDiary(db), memories: db.all('SELECT module, text, created FROM memories ORDER BY id'),
        modules: db.all('SELECT * FROM modules'), reminders: db.all('SELECT * FROM reminders'), jobs: db.all('SELECT * FROM jobs'),
        messages: db.all('SELECT session, role, text, at FROM messages ORDER BY id'), sessions: db.all('SELECT id, summary FROM sessions'),
        places: places.listPlaces(db), topics: db.all('SELECT * FROM topics'), layout: ui.loadLayout(db),
      });
    }
    return bad('non trovato', 404);
  } catch (e) {
    logEvent(db, nowIsoOf(deps.now(), tz), 'error', `${method} ${path}: ${e.message}`);
    return bad(e.message || 'errore interno', /JSON|grande/.test(e.message || '') ? 400 : 500);
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
