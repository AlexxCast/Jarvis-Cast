import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, deps, T0, reply } from './helpers.js';
import * as accounts from '../src/accounts.js';
import { handleChat } from '../src/brain.js';
import { handleApi } from '../src/api.js';

const ENV = {
  JARVIS_TOKEN: 't', GROQ_API_KEY: 'g', ACCOUNTS_KEY: 'chiave-di-prova-lunga-abbastanza',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', MS_CLIENT_ID: 'mid', MS_CLIENT_SECRET: 'msec',
};
const ORIGIN = 'https://kestra.example.workers.dev';

beforeEach(() => accounts._resetCache());

/** Finti Google e Microsoft: rispondono come le API vere quel tanto che serve. */
function fakeServices({ model = () => reply({}) } = {}) {
  const log = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    log.push({ url: u, method: init.method || 'GET', body: init.body });
    const ok = (obj) => new Response(JSON.stringify(obj), { status: 200 });
    if (u.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'g-acc', refresh_token: 'g-ref', expires_in: 3600 });
    if (u.includes('login.microsoftonline.com') && u.includes('/token')) return ok({ access_token: 'm-acc', refresh_token: 'm-ref-' + log.length, expires_in: 3600 });
    if (u.includes('openidconnect.googleapis.com')) return ok({ email: 'alessio.cast@gmail.com' });
    if (u.startsWith('https://graph.microsoft.com/v1.0/me?')) return ok({ mail: 'alessio.cast@edu.aau.at' });
    if (u.includes('gmail/v1/users/me/messages/send')) return ok({ id: 'sent1' });
    if (/gmail\/v1\/users\/me\/messages\?/.test(u)) return ok({ messages: [{ id: 'm1' }] });
    if (u.includes('gmail/v1/users/me/messages/m1')) return ok({ internalDate: String(T0 - 3600_000), labelIds: ['UNREAD'], snippet: 'Il tuo codice di verifica è 482913, non condividerlo',
      payload: { headers: [{ name: 'From', value: 'Banca <no-reply@banca.it>' }, { name: 'Subject', value: 'Accesso' }] } });
    if (u.includes('calendar/v3/users/me/calendarList')) return ok({ items: [{ id: 'primary', summary: 'Alessio' }, { id: 'fam@group', summary: 'Famiglia Cast' }] });
    if (u.includes('calendar/v3/calendars/fam%40group/events') && init.method === 'POST') return ok({ id: 'ev1' });
    if (u.includes('calendar/v3/calendars/fam%40group/events')) return ok({ items: [{ summary: 'Cena dalla nonna', start: { dateTime: '2026-11-13T19:30:00+01:00' }, end: { dateTime: '2026-11-13T22:00:00+01:00' }, creator: { email: 'mamma@gmail.com' } }] });
    if (u.includes('calendar/v3/calendars/primary/events')) return ok({ items: [{ summary: 'Palestra', start: { dateTime: '2026-11-13T08:00:00+01:00' }, end: { dateTime: '2026-11-13T09:00:00+01:00' }, creator: { self: true } }] });
    if (u.includes('graph.microsoft.com/v1.0/me/calendarView')) return ok({ value: [{ subject: 'Advanced AI', start: { dateTime: '2026-11-13T10:00:00.0000000' }, end: { dateTime: '2026-11-13T12:00:00.0000000' }, location: { displayName: 'HS 3' } }] });
    if (u.includes('graph.microsoft.com/v1.0/me/mailFolders/inbox/messages')) return ok({ value: [{ id: 'o1', subject: 'Esame', from: { emailAddress: { name: 'Prof', address: 'prof@aau.at' } }, receivedDateTime: '2026-11-12T09:00:00Z', bodyPreview: 'Data esame spostata', isRead: false }] });
    if (u.includes('/chat/completions')) { const body = JSON.parse(init.body); fn.prompts.push(body.messages); return ok({ choices: [{ message: { content: model(body, fn.prompts.length) } }], usage: { total_tokens: 50 } }); }
    return new Response('{}', { status: 404 });
  };
  fn.log = log; fn.prompts = [];
  return fn;
}

async function connectGoogle(db, fetchFn) {
  const url = new URL(accounts.startConnect(db, ENV, { provider: 'google', origin: ORIGIN, ms: T0 }));
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/oauth/google/callback`);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  return accounts.finishConnect(db, ENV, fetchFn, { provider: 'google', code: 'c', state: url.searchParams.get('state'), origin: ORIGIN, ms: T0 + 1000 });
}
async function connectMicrosoft(db, fetchFn) {
  const url = new URL(accounts.startConnect(db, ENV, { provider: 'microsoft', origin: ORIGIN, ms: T0 }));
  return accounts.finishConnect(db, ENV, fetchFn, { provider: 'microsoft', code: 'c', state: url.searchParams.get('state'), origin: ORIGIN, ms: T0 + 1000 });
}

test('collegamento: refresh token cifrato, etichetta dal dominio, state monouso', async () => {
  const db = makeDb(); const f = fakeServices();
  const acc = await connectGoogle(db, f);
  assert.equal(acc.label, 'Gmail alessio.cast');
  const row = db.get('SELECT secret FROM accounts');
  assert.ok(!row.secret.includes('g-ref'));
  assert.equal(await accounts.unseal(ENV, row.secret), 'g-ref');
  const ms = await connectMicrosoft(db, f);
  assert.equal(ms.label, 'Università di Klagenfurt');
  await assert.rejects(accounts.finishConnect(db, ENV, f, { provider: 'google', code: 'c', state: 'inventato', origin: ORIGIN, ms: T0 }), /scaduto/);
});

test('senza i segreti il collegamento non parte e lo dice', () => {
  const db = makeDb();
  assert.throws(() => accounts.startConnect(db, { ACCOUNTS_KEY: 'x'.repeat(20) }, { provider: 'google', origin: ORIGIN, ms: T0 }), /GOOGLE_CLIENT_ID/);
});

test('agenda: unisce Google (anche famiglia) e Outlook, ordinati per ora', async () => {
  const db = makeDb(); const f = fakeServices();
  await connectGoogle(db, f); await connectMicrosoft(db, f);
  const res = await accounts.calendarList(db, ENV, f, { from: '2026-11-13', days: 1, ms: T0 });
  assert.deepEqual(res.items.map(e => e.title), ['Palestra', 'Advanced AI', 'Cena dalla nonna']);
  const block = accounts.calendarBlock(res);
  assert.match(block, /venerdì 2026-11-13 11:00-13:00 · Advanced AI @ HS 3/);
  assert.match(block, /Famiglia Cast.*messo da mamma@gmail.com/);
});

test('posta: anteprime da tutti gli account, codici di verifica nascosti', async () => {
  const db = makeDb(); const f = fakeServices();
  await connectGoogle(db, f); await connectMicrosoft(db, f);
  const res = await accounts.mailSearch(db, ENV, f, { ms: T0 });
  assert.equal(res.items.length, 2);
  const block = accounts.mailBlock(res);
  assert.ok(!block.includes('482913'));
  assert.match(block, /codice nascosto/);
  assert.match(block, /prof@aau.at/);
  const only = await accounts.mailSearch(db, ENV, f, { account: 'klagenfurt', ms: T0 });
  assert.deepEqual(only.items.map(m => m.subject), ['Esame']);
});

test('chat: domanda sull\'agenda letta subito, senza automatismi del PC', async () => {
  const db = makeDb(); const f = fakeServices({ model: () => reply({ reply: 'Domani hai palestra alle 8.' }) });
  await connectGoogle(db, f);
  const out = await handleChat(db, ENV, deps(f), { text: 'che impegni ho domani nel calendario di famiglia?' });
  assert.equal(out.reply, 'Domani hai palestra alle 8.');
  const system = f.prompts[0][0].content;
  assert.match(system, /AGENDE COLLEGATE/);
  assert.match(system, /Cena dalla nonna/);
});

test('chat: la mail parte solo dopo il "sì", con i dettagli detti prima', async () => {
  const db = makeDb();
  const f = fakeServices({ model: () => reply({ reply: 'Ok.', actions: [{ type: 'mail_send', account: 'gmail', to: 'marco@example.com', subject: 'Domani', body: 'Ci vediamo alle 10.' }] }) });
  await connectGoogle(db, f);
  const first = await handleChat(db, ENV, deps(f), { text: 'manda una mail a marco@example.com che ci vediamo domani alle 10' });
  assert.match(first.reply, /marco@example.com.*Confermi\?/);
  assert.equal(first.expectReply, true);
  assert.ok(!f.log.some(x => x.url.includes('messages/send')));
  const second = await handleChat(db, ENV, deps(f), { text: 'sì' });
  assert.match(second.reply, /^Fatto: Mail inviata da alessio.cast@gmail.com a marco@example.com/);
  const sent = f.log.find(x => x.url.includes('messages/send'));
  const raw = Buffer.from(JSON.parse(sent.body).raw, 'base64url').toString('utf8');
  assert.match(raw, /To: marco@example.com/);
  assert.match(raw, /Ci vediamo alle 10\./);
});

test('chat: "no" annulla, e senza indirizzo valido non si mette in coda', async () => {
  const db = makeDb();
  const f = fakeServices({ model: () => reply({ reply: 'Ok.', actions: [{ type: 'event_add', calendar: 'famiglia', title: 'Cena', start: '2026-11-14T20:00' }] }) });
  await connectGoogle(db, f);
  const first = await handleChat(db, ENV, deps(f), { text: 'metti cena sabato alle 20 nel calendario di famiglia' });
  assert.match(first.reply, /evento "Cena" il 2026-11-14 alle 20:00 nel calendario famiglia\. Confermi\?/);
  const no = await handleChat(db, ENV, deps(f), { text: 'no lascia stare' });
  assert.equal(no.reply, 'Va bene, non faccio nulla.');
  assert.ok(!f.log.some(x => x.method === 'POST' && x.url.includes('/events')));
  assert.equal(accounts.queueWrite(db, { type: 'mail_send', to: 'marco' }, { ms: T0 }).ok, false);
});

test('evento confermato nel calendario di famiglia, fine un\'ora dopo', async () => {
  const db = makeDb();
  const f = fakeServices({ model: () => reply({ reply: 'Ok.', actions: [{ type: 'event_add', calendar: 'famiglia', title: 'Cena', start: '2026-11-14T20:00' }] }) });
  await connectGoogle(db, f);
  await handleChat(db, ENV, deps(f), { text: 'metti cena sabato alle 20 nel calendario di famiglia' });
  const yes = await handleChat(db, ENV, deps(f), { text: 'sì confermo' });
  assert.match(yes.reply, /Evento "Cena" messo nel calendario Famiglia Cast/);
  const post = JSON.parse(f.log.find(x => x.method === 'POST' && x.url.includes('/events')).body);
  assert.equal(post.start.dateTime, '2026-11-14T20:00:00');
  assert.equal(post.end.dateTime, '2026-11-14T21:00:00');
});

test('ics: eventi singoli e lezioni settimanali', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Vienna:20261102T100000', 'DTEND;TZID=Europe/Vienna:20261102T120000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261231T000000Z', 'SUMMARY:Machine Learning', 'LOCATION:HS 1', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261113T150000Z', 'DTEND:20261113T160000Z', 'SUMMARY:Ricevimento\\, prof', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const from = Date.UTC(2026, 10, 12, 0, 0), to = Date.UTC(2026, 10, 17, 0, 0);
  const ev = accounts.parseIcs(ics, from, to);
  assert.deepEqual(ev.map(e => e.title), ['Machine Learning', 'Ricevimento, prof', 'Machine Learning']);
  assert.equal(new Date(ev[0].start).toISOString(), '2026-11-12T09:00:00.000Z');
});

test('api: callback pubblica con errore di consenso suggerisce il calendario .ics', async () => {
  const db = makeDb();
  const res = await handleApi(db, ENV, deps(fakeServices()), new Request(`${ORIGIN}/oauth/microsoft/callback?error=access_denied&error_description=AADSTS65001%20admin%20approval%20required`));
  const html = await res.text();
  assert.match(html, /approvazione dell'amministratore/);
  const list = await (await handleApi(db, ENV, deps(fakeServices()), new Request(`${ORIGIN}/api/accounts`))).json();
  assert.deepEqual(list.accounts, []);
  assert.equal(list.ready.google, true);
  assert.ok(!JSON.stringify(list).includes('secret'));
});
