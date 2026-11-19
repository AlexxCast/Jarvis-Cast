import test from 'node:test';
import assert from 'node:assert/strict';
import * as flows from '../src/flows.js';
import * as devices from '../src/devices.js';
import * as router from '../src/router.js';
import { kvSet } from '../src/db.js';
import { makeDb } from './helpers.js';

const BAD = [
  { id: 'skill-pc-google', name: 'google su PC', service: 'google', device: 'pc', verified: true, steps: [{ kind: 'open_url', target: 'https://www.google.com/search?q=El+uva+boss' }] },
  { id: 'skill-pc-prime', name: 'uva boss su prime video su PC', service: 'prime', device: 'pc', verified: true, steps: [{ kind: 'open_app', target: 'uva boss su prime video' }] },
];
const GOOD = { id: 'skill-pc-prime2', name: 'prime su PC', service: 'prime', device: 'pc', verified: true, steps: [{ kind: 'open_url', target: 'https://www.primevideo.com/' }, { kind: 'dynamic_media', param: 'media', optional: true }] };

test('automatismi imparati male non scattano più, e serve un verbo di comando', () => {
  const db = makeDb();
  kvSet(db, 'modularSkills', BAD);
  assert.equal(flows.findMatchingSkill(db, 'collegati alle mie email Outlook e alla mia agenda Google'), null);
  assert.equal(flows.findMatchingSkill(db, 'apri helluva boss su prime video dal pc'), null);
  kvSet(db, 'modularSkills', [...BAD, GOOD]);
  assert.equal(flows.findMatchingSkill(db, 'apri helluva boss su prime video dal pc').id, 'skill-pc-prime2');
  assert.equal(flows.findMatchingSkill(db, 'mi piace prime video'), null);
});

test('"apri X su prime video" cerca X; la coda "e apri il video" non entra nel titolo', () => {
  const plan = flows.planSkillExecution(GOOD, 'apri helluva boss su prime video dal pc');
  assert.equal(plan.media, 'helluva boss');
  assert.match(plan.steps[0].target, /phrase=helluva%20boss/);
  const yt = { ...GOOD, service: 'youtube', steps: [{ kind: 'open_url', target: 'https://www.youtube.com/' }, { kind: 'dynamic_media', param: 'media', optional: true }] };
  assert.equal(flows.planSkillExecution(yt, 'cerca avenger doomsday su youtube e apri il video più rilevante').media, 'avenger doomsday');
  assert.equal(flows.planSkillExecution(GOOD, 'apri prime con l\'account Outlook').overrides.account, undefined);
});

test('proposta di automatismo: niente ricerca già scritta, e una domanda dopo non la conferma', () => {
  const db = makeDb();
  flows.proposeSkill(db, 'main', { name: 'google su PC', service: 'google', device: 'pc', userText: 'cerca el uva boss', steps: [{ kind: 'open_url', target: 'https://www.google.com/search?q=El+uva+boss' }] });
  assert.equal(flows.implicitSkillFeedback(db, 'main', 'cosa c\'è aperto ora sul pc?'), null);
  assert.equal(flows.implicitSkillFeedback(db, 'main', 'non mi sembra che sia successo nulla').discarded, true);
  assert.equal(flows.proposeSkill(db, 'main', { service: 'prime', device: 'pc', steps: [{ kind: 'open_app', target: 'uva boss su prime video' }] }), false);
});

test('i comandi al PC riportano l\'esito e il prompt lo mostra', () => {
  const db = makeDb();
  const now = 1_800_000_000_000;
  const c = devices.enqueueCommand(db, 'desktop', { kind: 'open_url', target: 'https://www.primevideo.com/' }, now);
  assert.match(devices.recentCommandsPrompt(db, now + 1000), /IN CODA/);
  const hb = devices.heartbeat(db, { id: 'desktop-x', kind: 'desktop', name: 'PC' }, now + 2000);
  assert.equal(hb.commands.length, 1);
  assert.equal(devices.listCommandHistory(db)[0].status, 'consegnato');
  devices.reportResult(db, { id: c.id, ok: false, error: 'browser non trovato' }, now + 3000);
  assert.match(devices.recentCommandsPrompt(db, now + 4000), /FALLITO \(browser non trovato\)/);
});

test('router: i modelli lite non restano incollati e non pianificano azioni', () => {
  const db = makeDb();
  const env = { GEMINI_API_KEY: 'g' };
  const ms = Date.now();
  const lite = 'gemini:gemini-flash-lite-latest';
  const top = (o) => router.rank(db, env, { tier: 'fast', ms, ...o })[0].key;
  assert.notEqual(top({ preferKey: lite }), lite);
  assert.notEqual(top({ needsActions: true }), lite);
  assert.ok(router.estimateTokens('a'.repeat(350)) > 100);
});
