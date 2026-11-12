// Calcoli nutrizionali: porting fedele di app/.../data/Nutrition.kt.
// Il "diary" ha la stessa forma del diario dell'app Android (Models.kt), così l'import dei dati è 1:1.

const r = Math.round;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);

export function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isoDate(d) === s ? d : null;
}
export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
/** 1 = lunedì ... 7 = domenica */
export function dayOfWeek(s) {
  const g = parseDate(s).getUTCDay();
  return g === 0 ? 7 : g;
}

export function age(birthDate, today) {
  const b = parseDate(birthDate), t = parseDate(today);
  if (!b || !t) return 25;
  let a = t.getUTCFullYear() - b.getUTCFullYear();
  if (t.getUTCMonth() < b.getUTCMonth() || (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

export function currentWeight(d) {
  const w = [...(d.weights || [])].sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
  return w ? w.kg : (d.profile?.weightKg || 0);
}

export function bmrOf(weightKg, heightCm, ageYears, sex) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'F' ? base - 161 : base + 5;
}
export function bmr(d, today) {
  const p = d.profile || {};
  return bmrOf(currentWeight(d), p.heightCm || 0, age(p.birthDate, today), p.sex);
}
export function activityMultiplier(level) {
  switch (String(level || '').toLowerCase()) {
    case 'sedentario': return 1.2;
    case 'leggero': return 1.375;
    case 'attivo': return 1.725;
    case 'molto attivo': return 1.9;
    default: return 1.55;
  }
}
export function maintenance(d, today) {
  return bmr(d, today) * activityMultiplier(d.profile?.activityLevel);
}
export function safetyFloor(d) {
  return d.profile?.sex === 'F' ? 1200 : 1400;
}
export function dailyTarget(d, today) {
  const p = d.profile || {};
  const maint = maintenance(d, today);
  const delta = clamp(Number(p.weeklyChangeKg ?? 0.5), 0, 1.25) * 7700 / 7;
  let raw = maint;
  const goal = String(p.goal || 'dimagrire').toLowerCase();
  if (goal === 'dimagrire') raw = maint - delta;
  else if (goal === 'massa') raw = maint + Math.min(delta, 600);
  return r(Math.max(raw, safetyFloor(d)));
}
export const kcalPerStep = (d) => 0.0005 * currentWeight(d);
export const proteinTarget = (d) => r(currentWeight(d) * (d.profile?.goal === 'massa' ? 2.0 : 1.8));

export function mealTotals(m) {
  const it = m.items || [];
  return { kcal: sum(it, x => x.kcal), protein: sum(it, x => x.protein), carbs: sum(it, x => x.carbs), fat: sum(it, x => x.fat) };
}

export function totals(d, date) {
  const meals = (d.meals || []).filter(m => m.date === date).map(mealTotals);
  const steps = Number((d.steps || {})[date] || 0);
  const stepBurned = steps * kcalPerStep(d);
  return {
    kcal: sum(meals, m => m.kcal), protein: sum(meals, m => m.protein), carbs: sum(meals, m => m.carbs), fat: sum(meals, m => m.fat),
    burned: sum((d.activities || []).filter(a => a.date === date), a => a.kcalBurned),
    steps, stepBurned, stepBonus: stepBurned * 0.5,
  };
}

export function weeklyAdaptive(d, today) {
  const base = dailyTarget(d, today);
  const dow = dayOfWeek(today);
  const monday = addDays(today, -(dow - 1));
  const daysPassed = dow - 1;
  const daysRemaining = Math.max(7 - daysPassed, 1);
  const floor = safetyFloor(d);
  const maxCap = maintenance(d, today) + 1200;

  let consumedPast = 0;
  for (let i = 0; i < daysPassed; i++) {
    const t = totals(d, addDays(monday, i));
    const credit = t.burned * 0.5 + t.stepBonus;
    consumedPast += t.kcal > 0 ? t.kcal - credit : credit > 0 ? Math.max(base - credit, floor) : base;
  }
  const weeklyBudget = base * 7;
  const remainingBudget = weeklyBudget - consumedPast;
  const adaptiveToday = r(clamp(remainingBudget / daysRemaining, floor, maxCap));

  const tt = totals(d, today);
  const todayBonus = tt.burned * 0.5 + tt.stepBonus;
  const todayNet = tt.kcal > 0 ? tt.kcal - todayBonus : 0;
  const todaySurplus = tt.kcal > 0 ? r(todayNet - adaptiveToday) : 0;

  let tomorrow = base;
  if (dow < 7) {
    const eff = tt.kcal > 0 ? todayNet : todayBonus > 0 ? Math.max(base - todayBonus, floor) : adaptiveToday;
    tomorrow = r(clamp((weeklyBudget - (consumedPast + eff)) / (7 - dow), floor, maxCap));
  }
  return {
    baseDailyTarget: base, adaptiveDailyTarget: adaptiveToday, estimatedTomorrowTarget: tomorrow,
    daysPassed, daysRemaining, weeklyBudgetTotal: weeklyBudget, consumedThisWeek: r(consumedPast),
    remainingBudgetWeek: r(remainingBudget), deltaKcal: adaptiveToday - base, todaySurplusOrDeficit: todaySurplus,
    tomorrowDeltaKcal: tomorrow - base, todayActivityBonus: todayBonus,
  };
}

function recordedDates(d) {
  const set = new Set([
    ...(d.meals || []).map(m => m.date), ...(d.activities || []).map(a => a.date),
    ...Object.entries(d.steps || {}).filter(([, v]) => v > 0).map(([k]) => k), ...(d.weights || []).map(w => w.date),
  ].filter(x => parseDate(x)));
  return [...set].sort();
}

export function monthlyBalance(d, today) {
  const base = dailyTarget(d, today);
  const maint = r(maintenance(d, today));
  const dates = recordedDates(d);
  const start = dates.length ? dates[0] : today;
  const days = Math.min(30, Math.max(1, daysBetween(start, today) + 1));
  let food = 0, stepK = 0, stepB = 0, actK = 0, steps = 0, recorded = 0;
  for (let i = 0; i < days; i++) {
    const t = totals(d, addDays(today, -i));
    if (t.kcal > 0 || t.steps > 0 || t.burned > 0) recorded++;
    food += t.kcal; stepK += t.stepBurned; stepB += t.stepBonus; actK += t.burned; steps += t.steps;
  }
  const credits = r(stepB + actK * 0.5);
  const net = r(food - credits);
  return {
    baseDailyTarget: base, daysCount: days, targetTotal: base * days, maintenanceTotal: maint * days,
    foodKcalTotal: r(food), stepKcalTotal: r(stepK), stepBonusTotal: r(stepB), activityKcalTotal: r(actK),
    activityBonusTotal: r(actK * 0.5), totalActivityCredits: credits, netConsumedTotal: net,
    netDifferenceVsTarget: net - base * days, realizedDeficitVsMaintenance: maint * days - net,
    totalSteps: steps, avgStepsPerDay: Math.trunc(steps / days), avgNetKcalPerDay: Math.trunc(net / (recorded || 1)),
    estimatedWeightChangeKg: (net - maint * days) / 7700,
  };
}

export function cumulativeBalance(d, today) {
  const maint = r(maintenance(d, today));
  const baseTarget = dailyTarget(d, today);
  const dates = recordedDates(d);
  const start = dates.length && dates[0] <= today ? dates[0] : today;
  const sortedW = [...(d.weights || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  const startWeight = sortedW.length ? sortedW[0].kg : (d.profile?.weightKg || 0);
  const currentW = currentWeight(d);
  const ft = totals(d, start);
  const firstZero = ft.kcal <= 0 && ft.steps === 0 && ft.burned <= 0;

  let cumDeficit = 0, cumNet = 0, cumMaint = 0, cumFood = 0, cumStepB = 0, cumActB = 0, cumSteps = 0, cumTarget = 0;
  let sNet = 0, sDef = 0, sSteps = 0, nAvg = 0;
  const progress = [];
  const total = daysBetween(start, today) + 1;
  for (let i = 0; i < total; i++) {
    const date = addDays(start, i);
    const t = totals(d, date);
    const hasData = t.kcal > 0 || t.steps > 0 || t.burned > 0;
    const exclude = i === 0 && firstZero;
    const net = r(t.kcal - r(t.burned * 0.5 + t.stepBonus));
    const dayMaint = exclude && !hasData ? 0 : maint;
    const dailyDeficit = dayMaint - net;
    cumFood += t.kcal; cumStepB += t.stepBonus; cumActB += t.burned * 0.5; cumSteps += t.steps;
    cumNet += net; cumMaint += dayMaint; cumTarget += exclude && !hasData ? 0 : baseTarget; cumDeficit += dailyDeficit;
    if (!exclude && (hasData || i !== 0)) { nAvg++; sNet += net; sDef += dailyDeficit; sSteps += t.steps; }
    const w = sortedW.filter(x => x.date <= date).pop();
    progress.push({
      date, netConsumed: net, dailyDeficit, cumulativeDeficit: cumDeficit,
      cumulativeEstimatedWeightChangeKg: (cumNet - cumMaint) / 7700,
      recordedWeightKg: w ? w.kg : null, weightLossFromStartKg: w && startWeight > 0 ? startWeight - w.kg : null, isZeroDay: !hasData,
    });
  }
  const div = nAvg || 1;
  const change = (cumNet - cumMaint) / 7700;
  return {
    startDate: start, totalDays: total, activeDaysCount: nAvg, isFirstDayZeroExcluded: firstZero,
    totalFoodKcal: r(cumFood), totalActivityCredits: r(cumStepB + cumActB), totalNetConsumed: cumNet, totalTarget: cumTarget,
    totalMaintenance: cumMaint, cumulativeDeficitVsMaintenance: cumDeficit, cumulativeDifferenceVsTarget: cumNet - cumTarget,
    estimatedWeightLossKg: -change, estimatedWeightChangeKg: change, avgNetKcalPerDay: Math.trunc(sNet / div),
    avgDeficitPerDay: Math.trunc(sDef / div), avgStepsPerDay: Math.trunc(sSteps / div), totalSteps: cumSteps,
    startWeightKg: startWeight, currentWeightKg: currentW,
    actualWeightLossKg: startWeight > 0 && currentW > 0 ? startWeight - currentW : null, dailyProgressList: progress,
  };
}

/** Riepilogo "oggi" usato da web app e contesto. */
export function todaySummary(d, today) {
  const adapt = weeklyAdaptive(d, today);
  const t = totals(d, today);
  const target = adapt.adaptiveDailyTarget + r(t.burned * 0.5 + t.stepBonus);
  return {
    date: today, target, baseTarget: adapt.baseDailyTarget, adaptiveTarget: adapt.adaptiveDailyTarget,
    eaten: r(t.kcal), remaining: target - r(t.kcal), protein: r(t.protein), carbs: r(t.carbs), fat: r(t.fat),
    proteinTarget: proteinTarget(d), steps: t.steps, stepBonus: r(t.stepBonus), burned: r(t.burned),
    tomorrowTarget: adapt.estimatedTomorrowTarget, profileComplete: !!(d.profile?.birthDate && d.profile?.heightCm > 0 && currentWeight(d) > 0),
  };
}
