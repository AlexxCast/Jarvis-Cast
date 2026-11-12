// Ingresso del Worker: serve la web app, controlla il token e passa le API al Durable Object
// che custodisce database, memoria e allarmi (promemoria e compiti in background).

import { DurableObject } from 'cloudflare:workers';
import { wrapDurableSql, migrate } from './db.js';
import { handleApi } from './api.js';
import * as agenda from './agenda.js';
import * as jobs from './jobs.js';
import { PROVIDERS } from './models.js';

function sameToken(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export class JarvisDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = wrapDurableSql(ctx.storage.sql);
    migrate(this.db);
  }

  deps() {
    return {
      now: () => Date.now(),
      tz: this.env.TZ_NAME || 'Europe/Rome',
      fetchFn: (url, init) => fetch(url, init),
      defer: (p) => this.ctx.waitUntil(p),
      schedule: (at) => this.ctx.waitUntil(this.schedule(at)),
    };
  }

  async schedule(at) {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || at < current) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 100));
  }

  async fetch(request) {
    return handleApi(this.db, this.env, this.deps(), request);
  }

  async alarm() {
    const deps = this.deps();
    const nextDue = agenda.fireDue(this.db, Date.now(), deps.tz);
    const delay = await jobs.advance(this.db, this.env, deps);
    const candidates = [nextDue, delay != null ? Date.now() + delay : null].filter(x => x != null);
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), Date.now() + 100));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, tokenConfigured: !!env.JARVIS_TOKEN, providers: Object.values(PROVIDERS).filter(p => env[p.env]).length });
    }
    if (!env.JARVIS_TOKEN) return Response.json({ error: 'Server non configurato: imposta il segreto JARVIS_TOKEN.' }, { status: 503 });
    const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!given || !sameToken(given, env.JARVIS_TOKEN)) return Response.json({ error: 'Token non valido.' }, { status: 401 });

    const stub = env.JARVIS.get(env.JARVIS.idFromName('main'));
    return stub.fetch(request);
  },
};
