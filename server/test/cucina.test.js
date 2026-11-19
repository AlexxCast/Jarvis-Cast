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
  assert.equal(rec.totalKcal, 430);
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
