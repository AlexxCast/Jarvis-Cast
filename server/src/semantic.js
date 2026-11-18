// Ricerca dei ricordi per significato: ogni ricordo ha un'impronta numerica (embedding) calcolata una volta
// con il modello gratuito di Gemini; a ogni messaggio se ne calcola una sola e si confrontano.
// Così "sono distrutto da stamattina" ritrova "si allena il lunedì" anche senza parole in comune.
// Se Gemini non risponde si torna alla sola ricerca per parole: non blocca mai la risposta.

const MODELS = ['gemini-embedding-001', 'text-embedding-004'];
const DIM = 256;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

const norm = (v) => {
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map(x => Math.round((x / n) * 10000) / 10000);
};

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vettori già normalizzati
}

export const encode = (v) => (v ? JSON.stringify(v) : '');
export function decode(s) { if (!s) return null; try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; } }

/** Impronte per più testi in una sola chiamata. Ritorna un array (null dove fallisce) o null se non disponibile. */
export async function embed(env, fetchFn, texts, { task = 'RETRIEVAL_DOCUMENT', timeoutMs = 4000 } = {}) {
  if (!env.GEMINI_API_KEY || !texts.length) return null;
  for (const model of MODELS) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const res = await fetchFn(`${BASE}${model}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ requests: texts.map(t => ({ model: `models/${model}`, content: { parts: [{ text: String(t).slice(0, 2000) }] }, taskType: task, outputDimensionality: DIM })) }),
        signal: ctrl?.signal,
      }).finally(() => timer && clearTimeout(timer));
      if (!res.ok) continue;
      const j = await res.json();
      const list = Array.isArray(j?.embeddings) ? j.embeddings : [];
      if (list.length !== texts.length) continue;
      return list.map(e => (Array.isArray(e?.values) && e.values.length ? norm(e.values.slice(0, DIM)) : null));
    } catch { /* prova il modello successivo */ }
  }
  return null;
}

/** Impronta del messaggio dell'utente: una sola chiamata veloce, con un tempo massimo stretto. */
export async function embedQuery(env, fetchFn, text) {
  const out = await embed(env, fetchFn, [text], { task: 'RETRIEVAL_QUERY', timeoutMs: 1500 });
  return out?.[0] || null;
}

/**
 * Calcola le impronte dei ricordi che non ce l'hanno, pochi alla volta (una scrittura per ricordo):
 * i ricordi esistenti si sistemano in qualche battito senza pesare sul limite di scritture.
 */
export async function backfill(db, env, fetchFn, limit = 40) {
  if (!env.GEMINI_API_KEY) return 0;
  const rows = db.all("SELECT id, module, text FROM memories WHERE vec = '' ORDER BY id DESC LIMIT ?", limit);
  if (!rows.length) return 0;
  const vecs = await embed(env, fetchFn, rows.map(r => `${r.module}: ${r.text}`));
  if (!vecs) return 0;
  let n = 0;
  rows.forEach((r, i) => { if (vecs[i]) { db.run('UPDATE memories SET vec = ? WHERE id = ?', encode(vecs[i]), r.id); n++; } });
  return n;
}

/**
 * Punteggio di significato da sommare a quello per parole. Conta quanto un ricordo spicca rispetto agli altri:
 * sopra la media di 1,2 deviazioni (e con una somiglianza minima) prende fino a 4,5 punti, come un cassetto citato.
 * Con meno di 4 ricordi con impronta si usa una soglia fissa prudente.
 */
export function relativeScorer(values) {
  if (values.length < 4) return (sim) => Math.min(4.5, Math.max(0, (sim - 0.6) / 0.1) * 1.5);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 0.01;
  return (sim) => (sim < 0.3 ? 0 : Math.min(4.5, Math.max(0, (sim - mean) / sd - 1.2) * 1.5));
}
