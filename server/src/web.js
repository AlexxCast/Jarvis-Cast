// Accesso a internet per Jarvis: ricerca con le fonti (Google tramite Gemini, gratis con la chiave
// che c'è già), lettura di una pagina, e Wikipedia come ripiego se manca la chiave Gemini.

const WEB_TIMEOUT_MS = 15_000;

/** Frasi che chiedono informazioni fresche o esplicitamente una ricerca online. */
export const WEB_WORDS = /(cerca (su |in )?(internet|google|online|in rete|sul web)|su internet|online|in rete|notizi|ultime news|news|cosa (è|e') successo|che succede|attualit|ultim[oa] (versione|uscit|risultat|partit)|risultat[oi] (della|di|del)|chi ha vinto|classifica|quando esce|quando gioca|prezzo d|quanto costa|quotazion|borsa|bitcoin|cambio (euro|dollar)|orari[o]? d|aperto (oggi|adesso|ora)|recension|trailer|uscit[oa] (oggi|ieri)|elezion|governo|guerra|sciopero|traffico|voli|treni)/i;

async function fetchJson(fetchFn, url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), WEB_TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { ...(init || {}), signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/** Ricerca con Google (grounding di Gemini): risposta riassunta e fonti. */
async function googleSearch(env, fetchFn, query, today) {
  if (!env.GEMINI_API_KEY) return null;
  for (const model of ['gemini-flash-latest', 'gemini-flash-lite-latest']) {
    const j = await fetchJson(fetchFn, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Oggi è ${today}. Cerca su Google e rispondi in italiano con i fatti principali, date e numeri precisi, in modo conciso (massimo 12 righe): ${query}` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 900, temperature: 0.2 },
      }),
    });
    const c = j?.candidates?.[0];
    const text = (c?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) continue;
    const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(w => w && w.uri)
      .slice(0, 5).map(w => ({ title: String(w.title || '').slice(0, 80), url: w.uri }));
    return { text: text.slice(0, 4000), sources, via: 'google' };
  }
  return null;
}

/** Ripiego senza chiave Gemini: le voci di Wikipedia più vicine alla domanda. */
async function wikipedia(fetchFn, query) {
  const q = encodeURIComponent(String(query).slice(0, 200));
  const j = await fetchJson(fetchFn, `https://it.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&exchars=900&format=json&origin=*`, { headers: { 'user-agent': 'JarvisAssistant/1.0' } });
  const pages = Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  if (!pages.length) return null;
  return {
    text: pages.map(p => `${p.title}: ${String(p.extract || '').trim()}`).join('\n\n').slice(0, 4000),
    sources: pages.map(p => ({ title: p.title, url: `https://it.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}` })),
    via: 'wikipedia',
  };
}

export async function search(env, fetchFn, query, today) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return null;
  return (await googleSearch(env, fetchFn, q, today)) || (await wikipedia(fetchFn, q));
}

/** Testo leggibile di una pagina web (solo https), senza script e stili. */
export async function readUrl(fetchFn, url) {
  if (!/^https:\/\//i.test(String(url || ''))) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), WEB_TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (JarvisAssistant)', accept: 'text/html,text/plain' } });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/text|html|json|xml/i.test(type)) return null;
    const raw = (await r.text()).slice(0, 400_000);
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '').trim();
    const text = raw.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return { text: text.slice(0, 6000), sources: [{ title: title.slice(0, 80) || url, url }], via: 'page' };
  } catch { return null; } finally { clearTimeout(t); }
}

/** Blocco di contesto con i risultati, da dare al modello. */
export function webBlock(query, res) {
  if (!res) return `RICERCA SU INTERNET per "${query}": nessun risultato (servizio non raggiungibile). Dillo all'utente invece di inventare.`;
  return `RISULTATI DA INTERNET (${res.via === 'page' ? 'pagina letta' : 'ricerca'} per "${String(query).slice(0, 120)}", aggiornati ad adesso: usali e non dire che non hai accesso a internet)\n${res.text}\nFONTI: ${res.sources.map(s => `${s.title} (${s.url})`).join('; ') || 'nessuna'}`;
}
