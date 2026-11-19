// Catalogo dei modelli. Si può cambiare senza toccare il codice: dalla web app
// (Impostazioni → Modelli) si salva un elenco personalizzato che sostituisce questo.
//
// tiers:  fast = risposte rapide · smart = ragionamenti e piani · vision = legge immagini
// rpm/rpd/tpm/tpd: limiti indicativi del piano gratuito (richieste e token al minuto e al giorno).
//   Sono volutamente prudenti: i limiti reali cambiano spesso, quindi il router impara anche
//   dalle intestazioni di risposta e dagli errori 429 di ogni provider.
// prio: più basso = provato prima. free: false = a pagamento, usato solo se i gratuiti sono esauriti.
// q: qualità stimata da 1 a 10 (ragionamento, codice, JSON delle azioni). La chat dal vivo guarda prima la
//   velocità (prio); i compiti in background ("best") guardano prima q, così vanno ai modelli più forti.
// tier "deep": modelli fortissimi ma lenti (pensano a lungo): usati SOLO per i compiti in background, mai in chat.

export const PROVIDERS = {
  gemini:     { env: 'GEMINI_API_KEY',      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', kind: 'openai' },
  groq:       { env: 'GROQ_API_KEY',        url: 'https://api.groq.com/openai/v1/chat/completions', kind: 'openai' },
  cerebras:   { env: 'CEREBRAS_API_KEY',    url: 'https://api.cerebras.ai/v1/chat/completions', kind: 'openai' },
  sambanova:  { env: 'SAMBANOVA_API_KEY',   url: 'https://api.sambanova.ai/v1/chat/completions', kind: 'openai' },
  nvidia:     { env: 'NVIDIA_API_KEY',      url: 'https://integrate.api.nvidia.com/v1/chat/completions', kind: 'openai' },
  openrouter: { env: 'OPENROUTER_API_KEY',  url: 'https://openrouter.ai/api/v1/chat/completions', kind: 'openai' },
  mistral:    { env: 'MISTRAL_API_KEY',     url: 'https://api.mistral.ai/v1/chat/completions', kind: 'openai' },
  github:     { env: 'GITHUB_MODELS_TOKEN', url: 'https://models.github.ai/inference/chat/completions', kind: 'openai' },
  deepseek:   { env: 'DEEPSEEK_API_KEY',    url: 'https://api.deepseek.com/chat/completions', kind: 'openai' },
  anthropic:  { env: 'ANTHROPIC_API_KEY',   url: 'https://api.anthropic.com/v1/messages', kind: 'anthropic' },
  // Workers AI: gira dentro Cloudflare con il binding "AI" (wrangler.toml), nessuna chiave da creare.
  // Gratis 10.000 "neuroni" al giorno: pochi, quindi è una riserva e i limiti sotto sono stretti.
  workersai:  { env: 'AI', url: '', kind: 'cfai' },
};

export const DEFAULT_MODELS = [
  // Aggiornato il 18/11/2026 dai cataloghi ufficiali (Gemini, Groq, Cerebras, NVIDIA, OpenRouter).
  // Se un provider ritira un modello risponde 404: il router lo mette in pausa per 24 ore e passa al successivo.

  // --- Google Gemini (gratuiti, finestra 1M, visione e ragionamento) ---
  { provider: 'gemini', model: 'gemini-flash-latest',      tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 10, q: 8 },
  { provider: 'gemini', model: 'gemini-3.8-flash',         tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 11, q: 8 },
  { provider: 'gemini', model: 'gemini-flash-lite-latest', tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 12, q: 4 },
  { provider: 'gemini', model: 'gemini-3.6-flash',         tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 13, q: 7 },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview',   tiers: ['smart', 'vision'],         ctx: 1000000, rpm: 5,  rpd: 50,   tpm: 250000, free: true, prio: 14, q: 9 },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite',    tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 15, q: 4 },
  { provider: 'gemini', model: 'gemini-2.5-pro',           tiers: ['smart', 'vision'],         ctx: 1000000, rpm: 5,  rpd: 100,  tpm: 250000, free: true, prio: 16, q: 7 },
  { provider: 'gemini', model: 'gemini-2.5-flash',         tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 17, q: 6 },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite',    tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 18, q: 3 },

  // --- Groq (velocissimi, gratuiti) ---
  { provider: 'groq', model: 'qwen/qwen3.8-27b',           tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 6000,  tpd: 500000, free: true, prio: 20, q: 7 },
  { provider: 'groq', model: 'llama-3.3-70b-versatile',    tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000, free: true, prio: 21, q: 4 },
  { provider: 'groq', model: 'openai/gpt-oss-120b',        tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 7500,  tpd: 200000, free: true, prio: 22, q: 6 },
  { provider: 'groq', model: 'minimaxai/minimax-m2.7',     tiers: ['smart'],         ctx: 196608, rpm: 30, rpd: 1000, tpm: 6000,  tpd: 200000, free: true, prio: 23, q: 7 },
  { provider: 'groq', model: 'openai/gpt-oss-20b',         tiers: ['fast'],          ctx: 131072, rpm: 30, rpd: 2000, tpm: 7500,  tpd: 300000, free: true, prio: 24, q: 3 },
  { provider: 'groq', model: 'meta-models/muse-spark-open', tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 6000, tpd: 200000, free: true, prio: 25, q: 6 },
  { provider: 'groq', model: 'llama-3.1-8b-instant',       tiers: ['fast'],          ctx: 131072, rpm: 30, rpd: 14400, tpm: 6000, tpd: 500000, free: true, prio: 28, q: 2 },

  // --- Cerebras (ultra-veloci, gratuiti, 1M token al giorno) ---
  { provider: 'cerebras', model: 'gpt-oss-120b',  tiers: ['fast', 'smart'], ctx: 64000, rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000, free: true, prio: 30, q: 6 },
  { provider: 'cerebras', model: 'qwen-3.8-27b',  tiers: ['fast', 'smart'], ctx: 64000, rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000, free: true, prio: 31, q: 7 },

  // --- SambaNova Cloud (crediti gratuiti) ---
  { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct', tiers: ['fast', 'smart'], ctx: 128000, rpm: 30, free: true, prio: 39, q: 4 },

  // --- NVIDIA NIM (gratuito a crediti: i più grandi per i ragionamenti) ---
  { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', tiers: ['smart'],         ctx: 1000000, rpm: 40, free: true, prio: 35, q: 7 },
  { provider: 'nvidia', model: 'z-ai/glm-5.3',                      tiers: ['smart'],         ctx: 128000,  rpm: 40, free: true, prio: 36, q: 9 },
  { provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', tiers: ['fast', 'smart'], ctx: 256000,  rpm: 40, free: true, prio: 40, q: 5 },
  { provider: 'nvidia', model: 'openai/gpt-oss-20b',                tiers: ['fast'],          ctx: 128000,  rpm: 40, free: true, prio: 44, q: 3 },

  // Aggiunti il 19/11/2026: i modelli aperti più forti con endpoint gratuito sul catalogo NVIDIA (stessa chiave).
  // Kimi K3.1 Pro e Kimi K3 pensano a lungo: solo compiti in background (tier "deep").
  { provider: 'nvidia', model: 'moonshotai/kimi-k3.1-pro',               tiers: ['deep'],             ctx: 1000000, rpm: 40, rpd: 400, free: true, prio: 33, q: 10, added: 20261119 },
  { provider: 'nvidia', model: 'moonshotai/kimi-k3',                     tiers: ['deep'],             ctx: 1000000, rpm: 40, rpd: 400, free: true, prio: 34, q: 9,  added: 20261119 },
  { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash',        tiers: ['fast', 'smart'],    ctx: 1000000, rpm: 40, rpd: 1000, free: true, prio: 32, q: 8, added: 20261119 },
  { provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', tiers: ['smart', 'vision'], ctx: 1000000, rpm: 40, free: true, prio: 41, q: 6, added: 20261119 },

  // --- OpenRouter Free (50 richieste al giorno in tutto senza credito) ---
  { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', tiers: ['smart'],                   ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 50, q: 7 },
  { provider: 'openrouter', model: 'thinkingmachines/inkling-2-small:free',  tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 51, q: 7 },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free',      tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 52, q: 6 },
  { provider: 'openrouter', model: 'baidu/ernie-5.5-flash-preview:free',     tiers: ['fast', 'smart'],           ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 53, q: 6 },
  { provider: 'openrouter', model: 'google/gemma-4-31b-it:free',             tiers: ['fast', 'smart', 'vision'], ctx: 262000,  rpm: 20, rpd: 50, free: true, prio: 54, q: 5 },
  { provider: 'openrouter', model: 'openrouter/free',                        tiers: ['fast', 'smart', 'vision'], ctx: 64000,   rpm: 20, rpd: 50, free: true, prio: 58, q: 4 },

  // --- Mistral AI ---
  { provider: 'mistral', model: 'mistral-small-latest', tiers: ['fast', 'vision'], ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 60, q: 4 },
  { provider: 'mistral', model: 'codestral-latest',     tiers: ['fast', 'smart'],  ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 61, q: 5 },
  { provider: 'mistral', model: 'mistral-large-latest', tiers: ['smart'],          ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 62, q: 6 },

  // --- GitHub Models ---
  { provider: 'github', model: 'openai/gpt-4.1-mini',       tiers: ['fast', 'smart', 'vision'], ctx: 32000, rpm: 15, rpd: 150, free: true, prio: 70, q: 4 },
  { provider: 'github', model: 'openai/gpt-4.1',            tiers: ['smart', 'vision'],         ctx: 32000, rpm: 10, rpd: 50,  free: true, prio: 72, q: 5 },
  { provider: 'github', model: 'openai/gpt-4o-mini',        tiers: ['fast', 'vision'],          ctx: 32000, rpm: 15, rpd: 150, free: true, prio: 73, q: 3 },
  { provider: 'github', model: 'deepseek/DeepSeek-V3-0324', tiers: ['smart'],                   ctx: 32000, rpm: 10, rpd: 50,  free: true, prio: 74, q: 5 },

  // --- Cloudflare Workers AI (riserva: 10.000 neuroni gratis al giorno, circa 20-40 richieste in tutto) ---
  { provider: 'workersai', model: '@cf/zai-org/glm-5.3',      tiers: ['deep', 'smart'], ctx: 128000, rpm: 10, rpd: 8,  free: true, prio: 65, q: 9, added: 20261119 },
  { provider: 'workersai', model: '@cf/qwen/qwen3.8-27b',     tiers: ['fast', 'smart'], ctx: 128000, rpm: 10, rpd: 15, free: true, prio: 66, q: 7, added: 20261119 },
  { provider: 'workersai', model: '@cf/openai/gpt-oss-120b',  tiers: ['fast', 'smart'], ctx: 128000, rpm: 10, rpd: 15, free: true, prio: 67, q: 6, added: 20261119 },

  // --- A pagamento (solo se configurati e i gratuiti sono esauriti) ---
  { provider: 'deepseek',  model: 'deepseek-chat',     tiers: ['fast', 'smart'],   ctx: 64000,  free: false, prio: 80, q: 7 },
  { provider: 'deepseek',  model: 'deepseek-reasoner', tiers: ['smart'],           ctx: 64000,  free: false, prio: 82, q: 8 },
  { provider: 'anthropic', model: 'claude-haiku-5-5',  tiers: ['fast', 'vision'],  ctx: 200000, free: false, prio: 90, q: 7 },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', tiers: ['smart', 'vision'], ctx: 200000, free: false, prio: 92, q: 10 },
];

export const modelKey = (m) => `${m.provider}:${m.model}`;

/** Convalida un elenco personalizzato; ritorna solo le voci utilizzabili. */
export function sanitizeModels(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(m => m && PROVIDERS[m.provider] && typeof m.model === 'string' && m.model.trim()).map(m => ({
    provider: m.provider, model: m.model.trim(),
    tiers: Array.isArray(m.tiers) && m.tiers.length ? m.tiers.filter(t => TIERS.includes(t)) : ['fast'],
    ctx: Number(m.ctx) > 0 ? Number(m.ctx) : 32000,
    rpm: num(m.rpm), rpd: num(m.rpd), tpm: num(m.tpm), tpd: num(m.tpd),
    free: m.free !== false, prio: Number.isFinite(Number(m.prio)) ? Number(m.prio) : 50,
    q: Number(m.q) > 0 ? Math.min(10, Number(m.q)) : qualityOf(m),
    ...(Number(m.added) > 0 ? { added: Number(m.added) } : {}),
  }));
}

export const TIERS = ['fast', 'smart', 'vision', 'deep'];

/** Qualità di un modello senza "q" (elenco personalizzato): quella del catalogo, altrimenti una stima dal nome. */
export function qualityOf(m) {
  const known = DEFAULT_MODELS.find(d => d.provider === m.provider && d.model === String(m.model || '').trim());
  if (known?.q) return known.q;
  const n = String(m.model || '');
  if (/(lite|instant|[-/]8b\b|[-/]20b\b|nano|mini\b|small)/i.test(n)) return 3;
  if (/(kimi-k3|glm-5|pro\b|pro-preview|ultra|opus|sonnet|reasoner|r1\b|large)/i.test(n)) return 8;
  return 5;
}
const num = (v) => (Number(v) > 0 ? Number(v) : undefined);
