import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../src/nutrition.js';
import { EMPTY_DIARY } from '../src/diet.js';

const diary = (over = {}, prof = {}) => ({ ...EMPTY_DIARY(), ...over, profile: { ...EMPTY_DIARY().profile, name: 'Alex', birthDate: '1996-01-01', sex: 'M', heightCm: 180, weightKg: 80, ...prof } });
const meal = (id, date, kcal) => ({ id, date, meal: 'pranzo', items: [{ name: 'x', grams: 100, kcal, protein: 50, carbs: 100, fat: 20 }] });
const TODAY = '2026-10-03';

test('BMR come nell\'app Android', () => {
  assert.equal(N.bmrOf(80, 180, 30, 'M'), 1780);
  assert.equal(N.bmrOf(60, 165, 25, 'F'), 1345.25);
});

test('target: dimagrire, mantenere, massa', () => {
  const d = diary();
  const maint = N.maintenance(d, TODAY);
  assert.equal(N.dailyTarget(d, TODAY), Math.round(maint - 550));
  assert.equal(N.dailyTarget(diary({}, { goal: 'mantenere' }), TODAY), Math.round(maint));
  assert.equal(N.dailyTarget(diary({}, { goal: 'massa', weeklyChangeKg: 0.25 }), TODAY), Math.round(maint + 275));
  assert.equal(N.proteinTarget(d), 144);
  assert.equal(N.proteinTarget(diary({}, { goal: 'massa' })), 160);
});

test('età calcolata sulla data di oggi', () => {
  assert.equal(N.age('1996-01-01', '2026-10-03'), 30);
  assert.equal(N.age('1996-12-31', '2026-10-03'), 29);
  assert.equal(N.age('', '2026-10-03'), 25);
});

test('bilancio cumulativo: primo giorno a zero escluso dalle medie', () => {
  const d = diary({
    weights: [{ date: '2026-10-01', kg: 80 }, { date: '2026-10-03', kg: 79.5 }],
    meals: [meal('m1', '2026-10-02', 2000), meal('m2', '2026-10-03', 1800)],
    steps: { '2026-10-01': 0, '2026-10-02': 8000, '2026-10-03': 10000 },
  });
  const b = N.cumulativeBalance(d, TODAY);
  assert.equal(b.isFirstDayZeroExcluded, true);
  assert.equal(b.totalDays, 3);
  assert.equal(b.activeDaysCount, 2);
  assert.equal(b.dailyProgressList.length, 3);
  assert.equal(b.dailyProgressList[0].isZeroDay, true);
  assert.ok(b.dailyProgressList[1].cumulativeDeficit > 0);
  assert.equal(b.dailyProgressList[2].cumulativeDeficit, b.cumulativeDeficitVsMaintenance);
  assert.equal(b.avgStepsPerDay, 9000);
  assert.ok(Math.abs(b.estimatedWeightLossKg - b.cumulativeDeficitVsMaintenance / 7700) < 0.01);
  assert.ok(Math.abs(b.actualWeightLossKg - 0.5) < 0.01);
});

test('bilancio cumulativo: primo giorno con dati incluso', () => {
  const d = diary({ meals: [meal('m1', '2026-10-01', 1500), meal('m2', '2026-10-02', 2000)], steps: { '2026-10-01': 5000, '2026-10-02': 7000 } });
  const b = N.cumulativeBalance(d, '2026-10-02');
  assert.equal(b.isFirstDayZeroExcluded, false);
  assert.equal(b.activeDaysCount, 2);
  assert.equal(b.avgStepsPerDay, 6000);
});

test('target adattivo: mai sotto la soglia di sicurezza, e si abbassa dopo uno sgarro', () => {
  const d = diary({ meals: [meal('m1', '2026-10-20', 9000)] });
  const a = N.weeklyAdaptive(d, '2026-10-21');
  assert.ok(a.adaptiveDailyTarget >= 1400);
  assert.ok(a.adaptiveDailyTarget < a.baseDailyTarget);
});

test('lunedì il target adattivo coincide con quello base', () => {
  const a = N.weeklyAdaptive(diary(), '2026-10-19');
  assert.equal(N.dayOfWeek('2026-10-19'), 1);
  assert.equal(a.adaptiveDailyTarget, a.baseDailyTarget);
});

test('riepilogo di oggi: i passi aumentano il budget al 50%', () => {
  const d = diary({ meals: [meal('m1', TODAY, 600)], steps: { [TODAY]: 10000 } });
  const t = N.todaySummary(d, TODAY);
  assert.equal(t.stepBonus, 200); // 10000 * 0.0005 * 80 * 0.5
  assert.equal(t.target, t.adaptiveTarget + 200);
  assert.equal(t.remaining, t.target - 600);
  assert.equal(t.profileComplete, true);
});

test('date: aritmetica senza fusi orari', () => {
  assert.equal(N.addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(N.addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(N.daysBetween('2026-10-01', '2026-11-01'), 31);
  assert.equal(N.parseDate('2026-02-30'), null);
});
