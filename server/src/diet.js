// Modulo dieta e allenamento: stato (stessa forma del diario dell'app Android), azioni e contesto.

import * as N from './nutrition.js';
import { kvGet, kvSet } from './db.js';

export const EMPTY_DIARY = () => ({
  profile: { name: '', birthDate: '', sex: 'M', heightCm: 0, weightKg: 0, targetWeightKg: 0, goal: 'dimagrire', weeklyChangeKg: 0.5, activityLevel: 'moderato', foodLikes: '', foodDislikes: '', dietNotes: '', appearanceNotes: '' },
  meals: [], activities: [], weights: [], steps: {}, pantry: [], savedRecipes: [], activeRecipeSession: null, pendingPhotoRequest: '',
});

export function loadDiary(db) {
  const d = kvGet(db, 'diary', null);
  const base = EMPTY_DIARY();
  if (!d) return base;
  return { ...base, ...d, profile: { ...base.profile, ...(d.profile || {}) } };
}
export const saveDiary = (db, d) => kvSet(db, 'diary', d);

let counter = 0;
export const newId = (prefix, ms) => prefix + ms.toString(36) + (++counter).toString(36);

const s = (v) => (v == null ? '' : String(v)).trim();
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const validDate = (v, today) => (N.parseDate(s(v)) ? s(v) : today);

function items(a) {
  return (Array.isArray(a.items) ? a.items : []).filter(i => i && s(i.name)).map(i => ({
    name: s(i.name), grams: n(i.grams), kcal: n(i.kcal), protein: n(i.protein), carbs: n(i.carbs), fat: n(i.fat),
  }));
}

const PROFILE_NUMBERS = ['heightCm', 'weightKg', 'targetWeightKg', 'weeklyChangeKg'];
const PROFILE_TEXT = ['name', 'birthDate', 'sex', 'goal', 'activityLevel', 'foodLikes', 'foodDislikes', 'dietNotes'];

export function patchProfile(profile, patch) {
  const p = { ...profile };
  for (const k of PROFILE_NUMBERS) if (patch[k] !== undefined && Number.isFinite(Number(patch[k]))) p[k] = Number(patch[k]);
  for (const k of PROFILE_TEXT) if (patch[k] !== undefined) p[k] = s(patch[k]);
  if (p.sex !== 'F') p.sex = 'M';
  return p;
}

export const DIET_ACTIONS = new Set(['add_meal', 'update_meal', 'delete_meal', 'add_activity', 'delete_activity', 'add_weight', 'set_steps',
  'request_photo', 'update_profile', 'add_pantry_item', 'remove_pantry_item', 'update_recipe_session', 'clear_recipe_session', 'save_recipe', 'delete_recipe']);

/** Applica un'azione al diario (modificato sul posto). Ritorna il motivo se è stata chiesta una foto. */
export function applyDietAction(d, a, { today, nowIso, ms, hadPhoto = false }) {
  switch (a.type) {
    case 'add_meal': {
      const it = items(a);
      if (!it.length && !s(a.description)) return null;
      d.meals.push({ id: newId('m', ms), date: validDate(a.date, today), meal: s(a.meal) || 'spuntino', description: s(a.description), items: it, loggedAt: nowIso, hasPhoto: hadPhoto });
      return null;
    }
    case 'update_meal': {
      const m = d.meals.find(x => x.id === s(a.id));
      if (!m) return null;
      if (s(a.date)) m.date = validDate(a.date, today);
      if (s(a.meal)) m.meal = s(a.meal);
      if (s(a.description)) m.description = s(a.description);
      const it = items(a);
      if (it.length) m.items = it;
      return null;
    }
    case 'delete_meal': d.meals = d.meals.filter(x => x.id !== s(a.id)); return null;
    case 'add_activity':
      d.activities.push({ id: newId('a', ms), date: validDate(a.date, today), type: s(a.activity_type) || 'allenamento', description: s(a.description), durationMin: n(a.duration_min), kcalBurned: n(a.kcal_burned) });
      return null;
    case 'delete_activity': d.activities = d.activities.filter(x => x.id !== s(a.id)); return null;
    case 'add_weight': {
      if (n(a.kg) <= 20) return null;
      const date = validDate(a.date, today);
      d.weights = d.weights.filter(w => w.date !== date).concat({ date, kg: n(a.kg) });
      return null;
    }
    case 'set_steps': {
      const st = Math.trunc(n(a.steps));
      if (st >= 0) d.steps[s(a.date) ? validDate(a.date, today) : today] = st;
      return null;
    }
    case 'request_photo': d.pendingPhotoRequest = s(a.reason) || 'stimare le porzioni'; return d.pendingPhotoRequest;
    case 'update_profile':
      if (a.field && !PROFILE_NUMBERS.concat(PROFILE_TEXT).includes(a.field)) return null;
      d.profile = patchProfile(d.profile, a.field ? { [a.field]: a.value } : (a.profile || {}));
      return null;
    case 'add_pantry_item':
      if (s(a.name)) d.pantry.push({ id: newId('p', ms), name: s(a.name), quantity: s(a.quantity), category: s(a.category) || 'generale', addedAt: today });
      return null;
    case 'remove_pantry_item': {
      const id = s(a.id), name = s(a.name).toLowerCase();
      d.pantry = d.pantry.filter(x => !((id && x.id === id) || (name && x.name.toLowerCase() === name)));
      return null;
    }
    case 'update_recipe_session': {
      const prev = d.activeRecipeSession || { title: '', currentStep: '', ingredientsNeeded: '', notes: '', startedAt: nowIso };
      d.activeRecipeSession = {
        title: s(a.title) || prev.title, currentStep: s(a.current_step) || prev.currentStep,
        ingredientsNeeded: s(a.ingredients_needed) || prev.ingredientsNeeded, notes: s(a.notes) || prev.notes, startedAt: prev.startedAt || nowIso,
      };
      return null;
    }
    case 'clear_recipe_session': d.activeRecipeSession = null; return null;
    case 'save_recipe': {
      const title = s(a.title) || d.activeRecipeSession?.title;
      if (!title) return null;
      const it = items(a);
      const tot = (k, f) => (n(a[k]) > 0 ? n(a[k]) : it.reduce((x, i) => x + i[f], 0));
      d.savedRecipes.push({
        id: newId('rec', ms), title, ingredients: it, instructions: s(a.instructions) || d.activeRecipeSession?.notes || '',
        totalKcal: tot('total_kcal', 'kcal'), totalProtein: tot('total_protein', 'protein'), totalCarbs: tot('total_carbs', 'carbs'), totalFat: tot('total_fat', 'fat'), createdAt: today,
      });
      d.activeRecipeSession = null;
      return null;
    }
    case 'delete_recipe': {
      const id = s(a.id), title = s(a.title).toLowerCase();
      d.savedRecipes = d.savedRecipes.filter(x => !((id && x.id === id) || (title && x.title.toLowerCase() === title)));
      return null;
    }
    default: return null;
  }
}

/** Importa il diario dell'app Android: unisce senza duplicare (per id / data) e non cancella nulla. */
export function mergeLegacy(current, legacy) {
  const d = { ...current };
  const byId = (a, b) => { const seen = new Set(a.map(x => x.id)); return a.concat((b || []).filter(x => x && x.id && !seen.has(x.id))); };
  d.meals = byId(d.meals, legacy.meals);
  d.activities = byId(d.activities, legacy.activities);
  d.pantry = byId(d.pantry, legacy.pantry);
  d.savedRecipes = byId(d.savedRecipes, legacy.savedRecipes);
  const wDates = new Set(d.weights.map(w => w.date));
  d.weights = d.weights.concat((legacy.weights || []).filter(w => w && w.date && !wDates.has(w.date)));
  d.steps = { ...(legacy.steps || {}), ...d.steps };
  for (const [k, v] of Object.entries(legacy.steps || {})) d.steps[k] = Math.max(Number(d.steps[k] || 0), Number(v || 0));
  const complete = (p) => p && p.birthDate && p.heightCm > 0;
  if (!complete(d.profile) && legacy.profile) d.profile = patchProfile({ ...d.profile, appearanceNotes: s(legacy.profile.appearanceNotes) }, legacy.profile);
  if (!d.activeRecipeSession && legacy.activeRecipeSession) d.activeRecipeSession = legacy.activeRecipeSession;
  return d;
}

const r = Math.round;
const f1 = (v) => Number(v).toFixed(1);
const f2 = (v) => Number(v).toFixed(2);
const sign = (v) => (v >= 0 ? `+${v}` : `${v}`);
const mealOrder = (m) => ({ colazione: 0, pranzo: 1, spuntino: 2 }[m] ?? 3);

/** Tre righe sempre presenti nel contesto: costano poco e tengono Jarvis aggiornato sulla giornata. */
export function dietBrief(d, today) {
  const t = N.todaySummary(d, today);
  if (!t.profileComplete) return 'DIETA: profilo non ancora completo (servono data di nascita, altezza e peso).';
  return `DIETA OGGI: target ${t.target} kcal, mangiato ${t.eaten}, rimanenti ${t.remaining} kcal; proteine ${t.protein}/${t.proteinTarget} g; passi ${t.steps}.`
    + (d.activeRecipeSession ? ` Ricetta in corso: ${d.activeRecipeSession.title}.` : '');
}

/** Contesto completo del modulo, in blocchi con priorità: i meno importanti saltano se il modello ha poco spazio. */
export function dietContext(d, today) {
  const p = d.profile;
  const adapt = N.weeklyAdaptive(d, today);
  const cum = N.cumulativeBalance(d, today);
  const month = N.monthlyBalance(d, today);
  const tt = N.totals(d, today);
  const target = adapt.adaptiveDailyTarget + r(tt.burned * 0.5 + tt.stepBonus);
  const remaining = target - r(tt.kcal);
  const blocks = [];

  blocks.push({ prio: 1, text: [
    'PROFILO',
    `- Sesso ${p.sex === 'F' ? 'femmina' : 'maschio'}, età ${N.age(p.birthDate, today)}, altezza ${r(p.heightCm)} cm, peso attuale ${f1(N.currentWeight(d))} kg`,
    `- Obiettivo ${p.goal}${p.targetWeightKg > 0 ? ` fino a ${f1(p.targetWeightKg)} kg` : ''}, ritmo ${p.weeklyChangeKg} kg/settimana, attività: ${p.activityLevel}`,
    `- Metabolismo basale ${r(N.bmr(d, today))} kcal, mantenimento ~${r(N.maintenance(d, today))} kcal, target base ${adapt.baseDailyTarget} kcal, proteine ~${N.proteinTarget(d)} g`,
    p.foodLikes ? `- Gli piace: ${p.foodLikes}` : null, p.foodDislikes ? `- Evita: ${p.foodDislikes}` : null, p.dietNotes ? `- Note: ${p.dietNotes}` : null,
    p.appearanceNotes ? `- Fisico: ${p.appearanceNotes}` : null,
    '',
    'BILANCIO DI OGGI (target adattivo settimanale)',
    `- Target adattato di oggi: ${adapt.adaptiveDailyTarget} kcal (${sign(adapt.deltaKcal)} rispetto al base)`,
    `- Passi ${tt.steps} (+${r(tt.stepBonus)} kcal al budget, 50% del bruciato), attività ${r(tt.burned)} kcal (+${r(tt.burned * 0.5)} kcal al budget)`,
    `- TARGET EFFETTIVO DI OGGI: ${target} kcal · mangiato ${r(tt.kcal)} kcal · RIMANENTI ${remaining} kcal`,
    `- Stima target di domani: ~${adapt.estimatedTomorrowTarget} kcal (${sign(adapt.tomorrowDeltaKcal)})`,
    `- Settimana: consumate ${adapt.consumedThisWeek} kcal nei giorni passati, restano ${adapt.remainingBudgetWeek} kcal su ${adapt.daysRemaining} giorni (oggi incluso)`,
    `- Ogni passo vale ~${(N.kcalPerStep(d)).toFixed(3)} kcal.`,
  ].filter(x => x !== null).join('\n') });

  if (d.activeRecipeSession) {
    const x = d.activeRecipeSession;
    blocks.push({ prio: 1, text: `RICETTA IN CORSO: ${x.title}\n- Passaggio: ${x.currentStep}\n- Dosi: ${x.ingredientsNeeded}\n- Note: ${x.notes}` });
  }
  if (d.pendingPhotoRequest) blocks.push({ prio: 1, text: `Hai chiesto una foto per: ${d.pendingPhotoRequest}` });

  const diaryLines = (from, to) => {
    const lines = [];
    for (let i = from; i <= to; i++) {
      const date = N.addDays(today, -i);
      const meals = d.meals.filter(m => m.date === date);
      const acts = d.activities.filter(a => a.date === date);
      const steps = Number(d.steps[date] || 0);
      if (!meals.length && !acts.length && !steps && i > 0) continue;
      const t = N.totals(d, date);
      lines.push(`## ${date}${i === 0 ? ' (OGGI)' : i === 1 ? ' (IERI)' : ''} — ${r(t.kcal)} kcal (P${r(t.protein)} C${r(t.carbs)} G${r(t.fat)}), attività ${r(t.burned)} kcal, passi ${steps}`);
      for (const m of [...meals].sort((a, b) => mealOrder(a.meal) - mealOrder(b.meal))) {
        lines.push(`  - [${m.id}] ${m.meal}: ${(m.items || []).map(i => `${i.name} ${r(i.grams)}g ${r(i.kcal)}kcal`).join('; ') || m.description}`);
      }
      for (const a of acts) lines.push(`  - [${a.id}] attività ${a.type}: ${a.description} ${r(a.durationMin)} min ~${r(a.kcalBurned)} kcal`);
    }
    return lines.join('\n');
  };
  blocks.push({ prio: 1, text: 'DIARIO ULTIMI 3 GIORNI (gli id servono per update/delete)\n' + diaryLines(0, 2) });

  blocks.push({ prio: 2, text: d.pantry.length
    ? 'DISPENSA\n' + d.pantry.map(i => `- [${i.id}] ${i.name}${i.quantity ? ` (${i.quantity})` : ''} [${i.category}]`).join('\n')
    : 'DISPENSA: vuota.' });
  if (d.savedRecipes.length) {
    blocks.push({ prio: 2, text: 'RICETTARIO\n' + d.savedRecipes.map(x => `- [${x.id}] "${x.title}": ~${r(x.totalKcal)} kcal (P${r(x.totalProtein)} C${r(x.totalCarbs)} G${r(x.totalFat)}) | ${(x.ingredients || []).map(i => `${i.name} (${r(i.grams)}g)`).join(', ')}`).join('\n') });
  }

  blocks.push({ prio: 3, text: [
    `BILANCIO CUMULATIVO (dal ${cum.startDate}, ${cum.totalDays} giorni, ${cum.activeDaysCount} contati nelle medie${cum.isFirstDayZeroExcluded ? ', primo giorno a zero escluso' : ''})`,
    `- Deficit totale vs mantenimento: ${cum.cumulativeDeficitVsMaintenance} kcal → perdita stimata ${f2(cum.estimatedWeightLossKg)} kg`,
    cum.actualWeightLossKg != null ? `- Bilancia: ${cum.startWeightKg} kg → ${cum.currentWeightKg} kg (${cum.actualWeightLossKg >= 0 ? '-' : '+'}${f1(Math.abs(cum.actualWeightLossKg))} kg)` : '',
    `- Medie: netto ${cum.avgNetKcalPerDay} kcal/g, deficit ${cum.avgDeficitPerDay} kcal/g, passi ${cum.avgStepsPerDay}/g`,
    `ULTIMI 30 GIORNI: cibo ${month.foodKcalTotal} kcal, bonus attività ${month.totalActivityCredits} kcal, netto ${month.netConsumedTotal} kcal; vs target ${sign(month.netDifferenceVsTarget)} kcal; deficit reale ${month.realizedDeficitVsMaintenance} kcal (${f2(month.estimatedWeightChangeKg)} kg stimati)`,
    d.weights.length ? 'PESATE: ' + [...d.weights].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-20).map(w => `${w.date} ${w.kg}kg`).join(', ') : '',
  ].filter(Boolean).join('\n') });

  const older = diaryLines(3, 30);
  if (older) blocks.push({ prio: 4, text: 'DIARIO GIORNI 4-31\n' + older });
  blocks.push({ prio: 5, text: 'STORICO GIORNO PER GIORNO ("in quel momento")\n' + cum.dailyProgressList.slice(-15).map(x =>
    `- [${x.date}] netto ${x.netConsumed} kcal, deficit ${x.dailyDeficit}; cumulato ${x.cumulativeDeficit} kcal, stima ${f2(-x.cumulativeEstimatedWeightChangeKg)} kg${x.recordedWeightKg != null ? `, peso ${x.recordedWeightKg} kg` : ''}`).join('\n') });
  return blocks;
}

export const DIET_KEYWORDS = /(mangi|pasto|pasti|colazione|pranzo|cena|spuntin|merenda|kcal|calori|protein|carboidrat|grassi|macro|peso|pesat|bilancia|dieta|dimagr|deficit|ricett|dispensa|frigo|cucin|fame|spesa|ingredient|allenament|palestra|corsa|corso|camminat|passi|bruciat|sgarr|pizza|pasta|pollo|riso|uova|grammi|porzion|digiun|massa|addominal|nuot|bici)/i;

export const DIET_RULES = `REGOLE DIETA E ALLENAMENTO
- Pasti: stima grammi, kcal e macro e registra con add_meal. Se le quantità sono vaghe e contano, chiedi la quantità o una foto (request_photo).
- Dopo aver registrato un pasto di' le kcal stimate e quante ne restano oggi rispetto al TARGET EFFETTIVO DI OGGI.
- Pasti dimenticati o sgarri di giorni passati: registrali sulla data giusta, rassicura (il bilancio è settimanale) e spiega come si adatta il target dei prossimi giorni, senza digiuni.
- Se si parla di un pasto già registrato usa update_meal con il suo id. Se manca il tipo di pasto, deducilo dall'ora.
- Allenamenti: add_activity con kcal bruciate stimate in modo prudente. Passi detti a voce: set_steps. Peso: add_weight.
- Ricette: quando proponi o si cucina una ricetta usa subito update_recipe_session e aggiorna il passaggio a ogni turno; a fine cottura clear_recipe_session; "salva la ricetta" → save_recipe.
- Adatta sempre le dosi di una ricetta al budget di oggi e a ciò che c'è in dispensa, spiegando le modifiche.
- Dispensa: proponi pasti partendo da ciò che c'è; aggiungi con add_pantry_item ciò che l'utente compra o mostra in foto; rimuovi con remove_pantry_item ciò che finisce.
- Mai diete estreme o compensazioni dannose.`;
