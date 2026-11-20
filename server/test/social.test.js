// Monomythos: post da pubblicare su TikTok e Instagram dal telefono, statistiche in Centro social.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as social from '../src/social.js';
import * as phone from '../src/phone.js';
import { kvGet } from '../src/db.js';
import { makeDb } from './helpers.js';

const at = (iso) => Date.parse(iso);
const inbox = (db) => db.all('SELECT kind, text FROM inbox ORDER BY id');
const post = (id, iso, piattaforme, extra = {}) => ({ id, data: iso, prova: false, video: `https://example.test/${id}.mp4`, didascalia_instagram: `Testo di ${id}`, piattaforme, ...extra });

/** Finto GitHub: file del ramo hub-dati e registro delle scritture. */
function fakeGithub(files) {
  const writes = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const raw = /raw\.githubusercontent\.com\/AlexxCast\/Monomytos\/hub-dati\/([\w.]+)/.exec(u);
    if (raw) return files[raw[1]] === undefined ? new Response('', { status: 404 }) : new Response(JSON.stringify(files[raw[1]]));
    const api = /api\.github\.com\/repos\/AlexxCast\/Monomytos\/contents\/([^?]+)/.exec(u);
    if (api) {
      if ((init.method || 'GET') === 'PUT') { writes.push({ path: api[1], body: JSON.parse(init.body), auth: init.headers.authorization }); return new Response('{}', { status: 201 }); }
      const f = files[api[1]];
      if (f === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(JSON.stringify({ sha: 'abc', content: Buffer.from(JSON.stringify(f)).toString('base64') }));
    }
    return new Response('', { status: 500 });
  };
  fn.writes = writes;
  return fn;
}
const depsAt = (fetchFn, clock) => ({ now: () => clock.ms, tz: 'Europe/Rome', fetchFn });

test('Monomythos: quali social mancano (TikTok nella posta, Instagram senza chiavi), YouTube no', () => {
  assert.deepEqual(social.missing({ piattaforme: { tiktok: { esito: 'ok', stato: 'SEND_TO_USER_INBOX (apri TikTok: il video è nella posta)' } } }), ['tiktok']);
  assert.deepEqual(social.missing({ piattaforme: { instagram: { esito: 'saltata', nota: 'mancano i Secrets' } } }), ['instagram']);
  assert.deepEqual(social.missing({ piattaforme: { youtube: { esito: 'ok' }, tiktok: { esito: 'ok', stato: 'PUBLISH_COMPLETE' } } }), []);
});

test('Monomythos: solo post veri delle ultime ore, TikTok prima di Instagram, niente prove né post già segnati', () => {
  const ms = at('2026-11-20T18:00:00+01:00');
  const pubb = [
    post('ig_argo', '2026-11-20T17:20:00+01:00', { instagram: { esito: 'saltata' } }),
    post('tt_eco', '2026-11-20T17:25:00+01:00', { tiktok: { esito: 'ok', stato: 'SEND_TO_USER_INBOX' } }),
    post('tt_prova', '2026-11-20T17:30:00+01:00', { tiktok: { esito: 'prova' } }, { prova: true }),
    post('tt_vecchio', '2026-11-19T17:00:00+01:00', { tiktok: { esito: 'ok', stato: 'SEND_TO_USER_INBOX' } }),
    post('ig_fatto', '2026-11-20T16:00:00+01:00', { instagram: { esito: 'saltata' } }),
  ];
  const dec = { ['ig:' + pubb[4].data]: { stato: 'pubblicata_a_mano' } };
  const list = social.pendingPosts(pubb, dec, { done: {} }, ms);
  assert.deepEqual(list.map(x => `${x.platform}:${x.id}`), ['tiktok:tt_eco', 'instagram:ig_argo']);
  assert.equal(list[0].caption, 'Testo di tt_eco', 'ogni post ha il suo testo');
});

test('Monomythos: un post si offre una volta sola, il controllo va ogni ora e ogni 15 minuti dopo la notifica', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-20T17:30:00+01:00') };
  const files = { 'pubblicazioni.json': [], 'decisioni.json': {} };
  const gh = fakeGithub(files);
  const d = depsAt(gh, clock);
  assert.equal((await social.check(db, {}, d)).found, 0, 'ancora niente: il post arriva in ritardo');
  files['pubblicazioni.json'] = [post('tt_eco', '2026-11-20T17:35:00+01:00', { tiktok: { esito: 'ok', stato: 'SEND_TO_USER_INBOX' } })];
  clock.ms += 20 * 60_000;
  assert.equal((await social.check(db, {}, d)).skipped, 'presto', 'senza notifica si ricontrolla dopo un\'ora');
  assert.equal(social.sawCentroNotification(db, [{ app: 'com.alexxcast.centrosocial', label: 'Centro social', title: 'Video pronto' }], clock.ms), true);
  const r = await social.check(db, {}, d);
  assert.equal(r.offered, 1);
  const msg = inbox(db).at(-1).text;
  assert.match(msg, /^\[SOCIAL_POST:tt_eco@2026-11-20T17:35:00\+01:00\|tiktok\] Nuovo post di Monomythos per TikTok/);
  assert.match(msg, /Pubblica" nella notifica/, 'di base chiede conferma');
  clock.ms += 15 * 60_000;
  const again = await social.check(db, {}, d);
  assert.equal(again.found, 1);
  assert.equal(again.offered, 0, 'stesso post: nessun doppione');
  assert.equal(inbox(db).length, 1);
  assert.equal(social.sawCentroNotification(db, [{ app: 'com.whatsapp', label: 'WhatsApp' }], clock.ms), false);
});

test('Monomythos: pubblicato dal telefono → segnato in Centro social con la chiave, statistiche nella cartella giusta', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-20T18:00:00+01:00') };
  const p = post('ig_argo', '2026-11-20T17:20:00+01:00', { instagram: { esito: 'saltata' } });
  const files = { 'pubblicazioni.json': [p], 'decisioni.json': { vecchia: { stato: 'annullata' } } };
  const gh = fakeGithub(files);
  const d = depsAt(gh, clock);
  const env = { MONOMYTOS_TOKEN: 'tok' };
  await social.check(db, env, d, { force: true });
  const it = await social.item(db, env, d, social.keyOf(p), 'instagram');
  assert.equal(it.caption, 'Testo di ig_argo');
  assert.equal(it.auto, false);
  const r = await social.done(db, env, d, { key: social.keyOf(p), platform: 'instagram', ok: true });
  assert.equal(r.centro, 'segnato');
  const w = gh.writes[0];
  assert.equal(w.path, 'decisioni.json');
  assert.equal(w.body.branch, 'hub-dati');
  assert.equal(w.auth, 'Bearer tok');
  const saved = JSON.parse(Buffer.from(w.body.content, 'base64').toString());
  assert.equal(saved['ig:' + p.data].stato, 'pubblicata_a_mano');
  assert.ok(saved.vecchia, 'le altre decisioni restano');
  assert.equal((await social.check(db, env, d, { force: true })).found, 0, 'fatto: non si ripropone');
  const s = await social.uploadStats(db, env, d, { images: ['A'.repeat(200)] });
  assert.match(s.files[0], /^instagram_screen\/2026-11-20-17-00_kestra_1\.jpg$/);
  assert.match(social.status(db, env).log[0].text, /Statistiche Instagram caricate/);
  assert.ok(kvGet(db, 'socialState').done[social.keyOf(p)].instagram);
});

test('Monomythos: senza chiave GitHub il post resta fatto e il motivo è chiaro', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-20T18:00:00+01:00') };
  const p = post('tt_eco', '2026-11-20T17:25:00+01:00', { tiktok: { esito: 'ok', stato: 'SEND_TO_USER_INBOX' } });
  const d = depsAt(fakeGithub({ 'pubblicazioni.json': [p], 'decisioni.json': {} }), clock);
  await social.check(db, {}, d, { force: true });
  const r = await social.done(db, {}, d, { key: social.keyOf(p), platform: 'tiktok', ok: true });
  assert.match(r.centro, /MONOMYTOS_TOKEN/);
  await assert.rejects(social.uploadStats(db, {}, d, { images: ['A'.repeat(200)] }), /MONOMYTOS_TOKEN/);
});

test('Monomythos: impostazioni (spento = nessun controllo, automatico = pubblica senza chiedere)', async () => {
  const db = makeDb();
  const clock = { ms: at('2026-11-20T18:00:00+01:00') };
  const d = depsAt(fakeGithub({ 'pubblicazioni.json': [post('tt_eco', '2026-11-20T17:25:00+01:00', { tiktok: { esito: 'ok', stato: 'SEND_TO_USER_INBOX' } })] }), clock);
  social.saveSettings(db, { enabled: false });
  assert.equal((await social.check(db, {}, d, { force: true })).skipped, 'spento');
  social.saveSettings(db, { enabled: true, auto: true, nonEsiste: true });
  assert.equal(social.settings(db).nonEsiste, undefined);
  await social.check(db, {}, d, { force: true });
  assert.match(inbox(db)[0].text, /Lo pubblico adesso/);
});

test('telefono: mossa paste e conferma col tocco nel prompt', () => {
  assert.deepEqual(phone.parseMove('{"do":"paste","n":4,"say":"incollo"}'), { do: 'paste', n: 4, say: 'incollo' });
  assert.equal(phone.parseMove('{"do":"paste"}').do, 'ask', 'paste senza campo: si ferma');
  assert.match(phone.systemFor(false, true), /toccando un pulsante/);
  assert.match(phone.systemFor(false), /NON è stata verificata/);
  assert.match(phone.systemFor(true), /appena riconosciuta/);
});
