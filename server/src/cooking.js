// Sessione di cucina: la ricetta resta a schermo dentro Kestra (ingredienti con le dosi, passaggi uno alla volta)
// e si può salvare per rifarla. Un solo kv per la sessione aperta e uno per le ricette salvate.
import { kvGet, kvSet } from './db.js';
import { loadDiary, saveDiary } from './diet.js';

const SESSION_KEY = 'cookingSession';
const SAVED_KEY = 'recipes';
const MAX_SAVED = 60;

export const COOKING_ACTIONS = new Set(['recipe', 'recipe_step', 'recipe_save', 'recipe_open', 'recipe_close', 'recipe_toggle', 'recipe_delete']);

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const slug = (t) => clip(t, 60).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ricetta';

/** Normalizza una ricetta arrivata dal modello o dall'interfaccia. Ritorna null se manca l'essenziale. */
export function normalizeRecipe(a = {}) {
  const title = clip(a.title || a.name, 80);
  const ingredients = (Array.isArray(a.ingredients) ? a.ingredients : []).slice(0, 30).map(it => {
    if (typeof it === 'string') return { name: clip(it, 80), qty: '' };
    return { name: clip(it?.name || it?.label, 80), qty: clip(it?.qty || it?.quantity || [it?.grams && `${it.grams} g`].filter(Boolean)[0], 30) };
  }).filter(it => it.name);
  const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 25)
    .map(s => clip(typeof s === 'string' ? s : (s?.text || s?.label), 300).replace(/^\d+[.)]\s*/, ''))
    .filter(Boolean);
  if (!title || (!ingredients.length && !steps.length)) return null;
  return {
    id: slug(title), title, ingredients, steps,
    servings: Number(a.servings) > 0 ? Math.min(20, Math.round(Number(a.servings))) : null,
    kcal: Number(a.kcal) > 0 ? Math.round(Number(a.kcal)) : null,
    minutes: Number(a.minutes) > 0 ? Math.round(Number(a.minutes)) : null,
    notes: clip(a.notes, 300),
  };
}

export const session = (db) => kvGet(db, SESSION_KEY, null);
export const listSaved = (db) => kvGet(db, SAVED_KEY, []);

function saveRecipe(db, r, ms) {
  const { step, have, startedAt, saved, ...clean } = r;
  kvSet(db, SAVED_KEY, [{ ...clean, savedAt: ms }, ...listSaved(db).filter(x => x.id !== r.id)].slice(0, MAX_SAVED));
  // Anche nel ricettario della dieta, così "ho mangiato la ricetta di ieri" ritrova dosi e calorie.
  const d = loadDiary(db);
  const grams = (q) => { const m = /(\d+(?:[.,]\d+)?)\s*(g|gr|grammi|ml)\b/i.exec(q || ''); return m ? Number(m[1].replace(',', '.')) : 0; };
  d.savedRecipes = (d.savedRecipes || []).filter(x => x.id !== 'rec-' + r.id);
  d.savedRecipes.push({
    id: 'rec-' + r.id, title: r.title,
    ingredients: r.ingredients.map(i => ({ name: i.name, grams: grams(i.qty), kcal: 0, protein: 0, carbs: 0, fat: 0 })),
    instructions: r.steps.map((st, i) => `${i + 1}. ${st}`).join('\n'),
    totalKcal: r.kcal || 0, totalProtein: 0, totalCarbs: 0, totalFat: 0, createdAt: new Date(ms).toISOString().slice(0, 10),
  });
  saveDiary(db, d);
}

/** Applica un'azione di cucina. Ritorna true se ha fatto qualcosa. */
export function apply(db, a = {}, ms = Date.now()) {
  const cur = session(db);
  switch (a.type) {
    case 'recipe': {
      const r = normalizeRecipe(a);
      if (!r) return false;
      const next = { ...r, step: 0, have: [], startedAt: ms, saved: !!a.save };
      kvSet(db, SESSION_KEY, next);
      if (a.save) saveRecipe(db, next, ms);
      return true;
    }
    case 'recipe_step': {
      if (!cur || !cur.steps.length) return false;
      const op = String(a.op || 'next');
      const to = op === 'prev' ? cur.step - 1 : op === 'goto' ? Number(a.index) : cur.step + 1;
      kvSet(db, SESSION_KEY, { ...cur, step: Math.max(0, Math.min(cur.steps.length - 1, Number.isFinite(to) ? to : cur.step)) });
      return true;
    }
    case 'recipe_toggle': {
      if (!cur) return false;
      const i = Number(a.index);
      const have = new Set(cur.have || []);
      have.has(i) ? have.delete(i) : have.add(i);
      kvSet(db, SESSION_KEY, { ...cur, have: [...have] });
      return true;
    }
    case 'recipe_save': {
      if (!cur) return false;
      saveRecipe(db, cur, ms);
      kvSet(db, SESSION_KEY, { ...cur, saved: true });
      return true;
    }
    case 'recipe_open': {
      const q = slug(a.id || a.title || '');
      let r = listSaved(db).find(x => x.id === q) || listSaved(db).find(x => x.id.includes(q) || q.includes(x.id));
      if (!r) {
        const old = (loadDiary(db).savedRecipes || []).find(x => slug(x.title) === q || slug(x.title).includes(q));
        r = old ? normalizeRecipe({ title: old.title, kcal: old.totalKcal, ingredients: (old.ingredients || []).map(i => ({ name: i.name, qty: i.grams ? `${i.grams} g` : '' })), steps: String(old.instructions || '').split(/\n+/) }) : null;
      }
      if (!r) return false;
      kvSet(db, SESSION_KEY, { ...r, step: 0, have: [], startedAt: ms, saved: true });
      return true;
    }
    case 'recipe_close':
      if (!cur) return false;
      kvSet(db, SESSION_KEY, null);
      return true;
    case 'recipe_delete':
      kvSet(db, SAVED_KEY, listSaved(db).filter(x => x.id !== String(a.id || '')));
      return true;
    default:
      return false;
  }
}

const NEXT_RE = /^\W*(?:ok\W*|fatto\W*|e\s+)?(?:avanti|prossimo(?:\s+passo|\s+passaggio)?|passo\s+successivo|vai\s+avanti|poi|dopo|e\s+adesso|e\s+ora)\W*$/i;
const PREV_RE = /^\W*(?:torna\s+indietro|indietro|passo\s+precedente|ripeti\s+il\s+passo\s+prima)\W*$/i;
const REPEAT_RE = /^\W*(?:ripeti|ripetilo|cosa\s+devo\s+fare(?:\s+ora)?|a\s+che\s+punto\s+(?:sono|siamo))\W*$/i;

/** Comandi a voce durante la cucina, senza chiamare un modello ("avanti", "indietro", "ripeti"). */
export function voiceStep(db, text, ms = Date.now()) {
  const cur = session(db);
  if (!cur || !cur.steps?.length) return null;
  const t = String(text || '').trim();
  let op = null;
  if (NEXT_RE.test(t)) op = 'next'; else if (PREV_RE.test(t)) op = 'prev'; else if (REPEAT_RE.test(t)) op = 'repeat';
  if (!op) return null;
  if (op !== 'repeat') apply(db, { type: 'recipe_step', op }, ms);
  const now = session(db);
  const last = now.step === now.steps.length - 1;
  return `Passo ${now.step + 1} di ${now.steps.length}: ${now.steps[now.step]}${last && op === 'next' ? ' È l\'ultimo, buon appetito!' : ''}`;
}

/** Riga di contesto per il modello quando c'è una sessione aperta. */
export function contextLine(db) {
  const cur = session(db);
  if (!cur) return '';
  return `SESSIONE DI CUCINA APERTA: "${cur.title}", passo ${cur.step + 1}/${cur.steps.length}${cur.saved ? ' (salvata)' : ' (non ancora salvata)'}. Per modificarla rimanda l'azione recipe completa con le correzioni.`;
}
