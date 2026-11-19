import test from 'node:test';
import assert from 'node:assert/strict';
import * as cooking from '../src/cooking.js';
import { handleChat } from '../src/brain.js';
import { handleApi } from '../src/api.js';
import { loadDiary } from '../src/diet.js';
import { makeDb, fakeFetch, deps } from './helpers.js';

const ENV = { GEMINI_API_KEY: 'g', JARVIS_TOKEN: 't' };
const reply = (o) => JSON.stringify(o);
const RECIPE = {
  type: 'recipe', title: 'Medaglioni di tacchino con patate', kcal: 430, servings: 1, minutes: 25,
  ingredients: [{ name: 'medaglioni di tacchino', qty: '250 g' }, { name: 'patate', qty: '200 g' }, { name: 'olio piccante croccante', qty: '1 cucchiaio' }],
  steps: ['1. Taglia le patate a rondelle sottili.', 'Rosola le patate 8 minuti.', 'Cuoci i medaglioni 5-6 minuti per lato.'],
};

test('la ricetta del modello apre la sessione di cucina a schermo e "avanti" scorre i passaggi senza modello', async () => {
  const db = makeDb();
  const r = await handleChat(db, ENV, deps(fakeFetch(() => reply({ reply: 'Ecco i medaglioni, 430 kcal in 3 passaggi.', actions: [RECIPE] }))), { text: 'aprimi una sessione di cucina con la ricetta' });
  assert.ok(r.actions.includes('recipe'));
  const s = cooking.session(db);
  assert.equal(s.ingredients[0].qty, '250 g');
  assert.equal(s.steps[0], 'Taglia le patate a rondelle sottili.');
  const next = await handleChat(db, ENV, deps(fakeFetch(() => { throw new Error('niente modello'); })), { text: 'avanti' });
  assert.match(next.reply, /Passo 2 di 3: Rosola/);
  assert.equal(next.model, 'jarvis-core');
});

test('salvare la ricetta la mette anche nel ricettario della dieta e si può riaprire', () => {
  const db = makeDb();
  cooking.apply(db, RECIPE);
  cooking.apply(db, { type: 'recipe_save' });
  assert.equal(cooking.listSaved(db).length, 1);
  const rec = loadDiary(db).savedRecipes.find(x => x.title === RECIPE.title);
  assert.equal(rec.ingredients[0].grams, 250);
  // Il totale è la somma degli ingredienti (qui stimati dalla tabella), non il numero detto dal modello.
  assert.equal(rec.totalKcal, cooking.session(db).kcal);
  assert.ok(rec.ingredients.every(i => i.kcal > 0));
  cooking.apply(db, { type: 'recipe_close' });
  assert.equal(cooking.session(db), null);
  assert.ok(cooking.apply(db, { type: 'recipe_open', title: 'medaglioni di tacchino' }));
  assert.equal(cooking.session(db).steps.length, 3);
});

test('i pulsanti della sessione passano da /api/actions e lo stato la mostra', async () => {
  const db = makeDb();
  cooking.apply(db, RECIPE);
  const call = (actions) => handleApi(db, ENV, deps(fakeFetch(() => '{}')), new Request('https://x/api/actions', { method: 'POST', body: JSON.stringify({ actions }) }));
  let res = await (await call([{ type: 'recipe_step', op: 'next' }, { type: 'recipe_toggle', index: 1 }])).json();
  assert.equal(res.state.cooking.step, 1);
  assert.deepEqual(res.state.cooking.have, [1]);
  res = await (await call([{ type: 'recipe_save' }])).json();
  assert.equal(res.state.recipes[0].title, RECIPE.title);
});

test('ogni ingrediente ha grammi e calorie, e il totale li somma tutti (anche la piadina che il modello scorda)', () => {
  const db = makeDb();
  cooking.apply(db, {
    type: 'recipe', title: 'Piadina kebab', kcal: 420, servings: 1,
    ingredients: [
      { name: 'kebab di pollo', qty: '150 g', grams: 150, kcal: 330, protein: 27, carbs: 4, fat: 23 },
      { name: 'yogurt greco 0%', qty: '100 g', grams: 100, kcal: 57, protein: 10, carbs: 4, fat: 0.2 },
      { name: 'piadina', qty: '1 piadina' },
      { name: 'sale', qty: 'q.b.' },
      { name: 'salsa segreta della nonna', qty: '1 cucchiaio' },
    ],
    steps: ['Scalda la piadina 1 minuto per lato.', 'Farcisci con kebab e yogurt.'],
  });
  const s = cooking.session(db);
  const piadina = s.ingredients.find(i => i.name === 'piadina');
  assert.equal(piadina.grams, 110);
  assert.equal(piadina.kcal, 330);
  assert.equal(piadina.est, true);
  assert.equal(s.ingredients[0].kcal, 330);
  assert.equal(s.ingredients[0].est, false);
  assert.equal(s.kcal, 330 + 57 + 330 + 0);
  assert.equal(s.protein, Math.round((27 + 10 + 8.8) * 10) / 10);
  assert.deepEqual(s.missing, ['salsa segreta della nonna']);
  assert.match(cooking.contextLine(db), /piadina 1 piadina = 330 kcal.*TOTALE 717 kcal.*Senza calorie: salsa segreta/s);
});

test('una correzione con lo stesso titolo tiene i passaggi e il punto in cui eri', () => {
  const db = makeDb();
  cooking.apply(db, RECIPE);
  cooking.apply(db, { type: 'recipe_step', op: 'next' });
  const before = cooking.session(db).kcal;
  assert.ok(cooking.apply(db, { type: 'recipe', title: RECIPE.title, ingredients: [...RECIPE.ingredients, { name: 'piadina', qty: '1 piadina', grams: 110, kcal: 330 }] }));
  const s = cooking.session(db);
  assert.equal(s.steps.length, 3);
  assert.equal(s.step, 1);
  assert.equal(s.kcal, before + 330);
});

test('le dosi scritte diventano grammi', async () => {
  const { gramsOf, findFood } = await import('../src/foods.js');
  assert.equal(gramsOf('250 g'), 250);
  assert.equal(gramsOf('0,2 kg'), 200);
  assert.equal(gramsOf('2 cucchiai', findFood('olio extravergine')), 20);
  assert.equal(gramsOf('due uova', findFood('uova')), 120);
  assert.equal(gramsOf('q.b.', findFood('sale')), 0);
  assert.equal(findFood('salsa allo yogurt').kcal, 110);
  assert.equal(findFood('yogurt greco 0%').kcal, 57);
  assert.equal(findFood('melanzane'), null);
});
