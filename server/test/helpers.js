import { DatabaseSync } from 'node:sqlite';
import { wrapNodeSqlite, migrate } from '../src/db.js';

export function makeDb() {
  const db = wrapNodeSqlite(new DatabaseSync(':memory:'));
  migrate(db);
  return db;
}

/** Finto provider OpenAI-compatibile: handler(url, body) → { status, json, headers } | stringa di testo. */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    let out = await handler(url, body, calls.length);
    if (typeof out === 'string') out = { status: 200, json: { choices: [{ message: { content: out } }], usage: { total_tokens: 100 } } };
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

export const T0 = Date.UTC(2026, 10, 12, 11, 0); // giovedì 12 nov 2026, 12:00 a Roma
export function deps(fetchFn, clock = { ms: T0 }) {
  const jobs = [];
  return { now: () => clock.ms, tz: 'Europe/Rome', fetchFn, clock, jobs, startJob: (j) => jobs.push(j) };
}
export const reply = (obj) => JSON.stringify({ reply: 'Fatto.', expect_reply: false, card: '', actions: [], ...obj });
