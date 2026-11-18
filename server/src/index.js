// Ingresso del Worker: serve la web app, controlla il token e passa le API al Durable Object
// che custodisce database, memoria e allarmi (promemoria e compiti in background).

import { DurableObject } from 'cloudflare:workers';
import { wrapDurableSql, migrate, friendlyError, WRITE_LIMIT_RE } from './db.js';
import { handleApi } from './api.js';
import * as agenda from './agenda.js';
import * as jobs from './jobs.js';
import * as jarvisCore from './jarvis_core.js';
import { PROVIDERS } from './models.js';
import { forwardToBrain } from './forward.js';

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
    // Se l'aggiornamento dello schema fallisce, l'oggetto deve comunque rispondere spiegando il perché.
    try { migrate(this.db); this.bootError = null; } catch (e) { this.bootError = e; console.error('Migrazione fallita:', e?.stack || e); }
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
    // Il battito parte alla prima richiesta e poi si mantiene da solo nell'allarme.
    if (this.bootError) {
      try { migrate(this.db); this.bootError = null; } catch (e) {
        // Con il limite di scritture esaurito il database si legge ancora: l'app si apre in sola lettura.
        if (!WRITE_LIMIT_RE.test(String(e?.message || e))) {
          return Response.json({ error: `Errore all'avvio del database: ${friendlyError(e).slice(0, 240)}` }, { status: 500 });
        }
      }
    }
    if (!this.beat) { this.beat = true; this.ctx.waitUntil(this.schedule(Date.now() + 15 * 60_000)); }
    try {
      return await handleApi(this.db, this.env, this.deps(), request);
    } catch (e) {
      // Errore fuori dal gestore (per esempio mentre si registra un altro errore): risposta leggibile, mai una 500 muta.
      console.error('Errore nel Durable Object:', e?.stack || e);
      return Response.json({ error: `Errore interno: ${friendlyError(e).slice(0, 240)}` }, { status: 500 });
    }
  }

  async alarm() {
    const deps = this.deps();
    const pulse = jarvisCore.selfInterrogate(this.db, this.env, Date.now(), deps.tz);
    const nextDue = agenda.fireDue(this.db, Date.now(), deps.tz);
    const delay = await jobs.advance(this.db, this.env, deps);
    // Battito: anche senza promemoria o compiti, Kestra si risveglia ogni 15 minuti per il motore di iniziativa.
    const candidates = [nextDue, pulse?.nextTimed, delay != null ? Date.now() + delay : null, Date.now() + 15 * 60_000].filter(x => x != null);
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), Date.now() + 100));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Anteprime delle modifiche proposte da Jarvis: l'indirizzo contiene un codice casuale lungo.
    if (url.pathname.startsWith('/preview/')) return env.JARVIS.get(env.JARVIS.idFromName('main')).fetch(request);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, tokenConfigured: !!env.JARVIS_TOKEN, providers: Object.values(PROVIDERS).filter(p => env[p.env]).length });
    }
    if (!env.JARVIS_TOKEN) return Response.json({ error: 'Server non configurato: imposta il segreto JARVIS_TOKEN.' }, { status: 503 });
    const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!given || !sameToken(given, env.JARVIS_TOKEN)) return Response.json({ error: 'Token non valido.' }, { status: 401 });

    return forwardToBrain(env, request);
  },
};
