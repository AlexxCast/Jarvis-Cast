// Catalogo dei modelli. Si può cambiare senza toccare il codice: dalla web app
// (Impostazioni → Modelli) si salva un elenco personalizzato che sostituisce questo.
//
// tiers:  fast = risposte rapide · smart = ragionamenti e piani · vision = legge immagini
// rpm/rpd/tpm/tpd: limiti indicativi del piano gratuito (richieste e token al minuto e al giorno).
//   Sono volutamente prudenti: i limiti reali cambiano spesso, quindi il router impara anche
//   dalle intestazioni di risposta e dagli errori 429 di ogni provider.
// prio: più basso = provato prima. free: false = a pagamento, usato solo se i gratuiti sono esauriti.

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
};

export const DEFAULT_MODELS = [
  // Aggiornato il 18/11/2026 dai cataloghi ufficiali (Gemini, Groq, Cerebras, NVIDIA, OpenRouter).
  // Se un provider ritira un modello risponde 404: il router lo mette in pausa per 24 ore e passa al successivo.

  // --- Google Gemini (gratuiti, finestra 1M, visione e ragionamento) ---
  { provider: 'gemini', model: 'gemini-flash-latest',      tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 10 },
  { provider: 'gemini', model: 'gemini-3.8-flash',         tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 11 },
  { provider: 'gemini', model: 'gemini-flash-lite-latest', tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 12 },
  { provider: 'gemini', model: 'gemini-3.6-flash',         tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 13 },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview',   tiers: ['smart', 'vision'],         ctx: 1000000, rpm: 5,  rpd: 50,   tpm: 250000, free: true, prio: 14 },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite',    tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 15 },
  { provider: 'gemini', model: 'gemini-2.5-pro',           tiers: ['smart', 'vision'],         ctx: 1000000, rpm: 5,  rpd: 100,  tpm: 250000, free: true, prio: 16 },
  { provider: 'gemini', model: 'gemini-2.5-flash',         tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 17 },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite',    tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 18 },

  // --- Groq (velocissimi, gratuiti) ---
  { provider: 'groq', model: 'qwen/qwen3.8-27b',           tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 6000,  tpd: 500000, free: true, prio: 20 },
  { provider: 'groq', model: 'llama-3.3-70b-versatile',    tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000, free: true, prio: 21 },
  { provider: 'groq', model: 'openai/gpt-oss-120b',        tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 7500,  tpd: 200000, free: true, prio: 22 },
  { provider: 'groq', model: 'minimaxai/minimax-m2.7',     tiers: ['smart'],         ctx: 196608, rpm: 30, rpd: 1000, tpm: 6000,  tpd: 200000, free: true, prio: 23 },
  { provider: 'groq', model: 'openai/gpt-oss-20b',         tiers: ['fast'],          ctx: 131072, rpm: 30, rpd: 2000, tpm: 7500,  tpd: 300000, free: true, prio: 24 },
  { provider: 'groq', model: 'meta-models/muse-spark-open', tiers: ['fast', 'smart'], ctx: 131072, rpm: 30, rpd: 1000, tpm: 6000, tpd: 200000, free: true, prio: 25 },
  { provider: 'groq', model: 'llama-3.1-8b-instant',       tiers: ['fast'],          ctx: 131072, rpm: 30, rpd: 14400, tpm: 6000, tpd: 500000, free: true, prio: 28 },

  // --- Cerebras (ultra-veloci, gratuiti, 1M token al giorno) ---
  { provider: 'cerebras', model: 'gpt-oss-120b',  tiers: ['fast', 'smart'], ctx: 64000, rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000, free: true, prio: 30 },
  { provider: 'cerebras', model: 'qwen-3.8-27b',  tiers: ['fast', 'smart'], ctx: 64000, rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000, free: true, prio: 31 },

  // --- SambaNova Cloud (crediti gratuiti) ---
  { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct', tiers: ['fast', 'smart'], ctx: 128000, rpm: 30, free: true, prio: 39 },

  // --- NVIDIA NIM (gratuito a crediti: i più grandi per i ragionamenti) ---
  { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', tiers: ['smart'],         ctx: 1000000, rpm: 40, free: true, prio: 35 },
  { provider: 'nvidia', model: 'z-ai/glm-5.3',                      tiers: ['smart'],         ctx: 128000,  rpm: 40, free: true, prio: 36 },
  { provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', tiers: ['fast', 'smart'], ctx: 256000,  rpm: 40, free: true, prio: 40 },
  { provider: 'nvidia', model: 'openai/gpt-oss-20b',                tiers: ['fast'],          ctx: 128000,  rpm: 40, free: true, prio: 44 },

  // --- OpenRouter Free (50 richieste al giorno in tutto senza credito) ---
  { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', tiers: ['smart'],                   ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 50 },
  { provider: 'openrouter', model: 'thinkingmachines/inkling-2-small:free',  tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 51 },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free',      tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 52 },
  { provider: 'openrouter', model: 'baidu/ernie-5.5-flash-preview:free',     tiers: ['fast', 'smart'],           ctx: 1000000, rpm: 20, rpd: 50, free: true, prio: 53 },
  { provider: 'openrouter', model: 'google/gemma-4-31b-it:free',             tiers: ['fast', 'smart', 'vision'], ctx: 262000,  rpm: 20, rpd: 50, free: true, prio: 54 },
  { provider: 'openrouter', model: 'openrouter/free',                        tiers: ['fast', 'smart', 'vision'], ctx: 64000,   rpm: 20, rpd: 50, free: true, prio: 58 },

  // --- Mistral AI ---
  { provider: 'mistral', model: 'mistral-small-latest', tiers: ['fast', 'vision'], ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 60 },
  { provider: 'mistral', model: 'codestral-latest',     tiers: ['fast', 'smart'],  ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 61 },
  { provider: 'mistral', model: 'mistral-large-latest', tiers: ['smart'],          ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 62 },

  // --- GitHub Models ---
  { provider: 'github', model: 'openai/gpt-4.1-mini',       tiers: ['fast', 'smart', 'vision'], ctx: 32000, rpm: 15, rpd: 150, free: true, prio: 70 },
  { provider: 'github', model: 'openai/gpt-4.1',            tiers: ['smart', 'vision'],         ctx: 32000, rpm: 10, rpd: 50,  free: true, prio: 72 },
  { provider: 'github', model: 'openai/gpt-4o-mini',        tiers: ['fast', 'vision'],          ctx: 32000, rpm: 15, rpd: 150, free: true, prio: 73 },
  { provider: 'github', model: 'deepseek/DeepSeek-V3-0324', tiers: ['smart'],                   ctx: 32000, rpm: 10, rpd: 50,  free: true, prio: 74 },

  // --- A pagamento (solo se configurati e i gratuiti sono esauriti) ---
  { provider: 'deepseek',  model: 'deepseek-chat',     tiers: ['fast', 'smart'],   ctx: 64000,  free: false, prio: 80 },
  { provider: 'deepseek',  model: 'deepseek-reasoner', tiers: ['smart'],           ctx: 64000,  free: false, prio: 82 },
  { provider: 'anthropic', model: 'claude-haiku-5-5',  tiers: ['fast', 'vision'],  ctx: 200000, free: false, prio: 90 },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', tiers: ['smart', 'vision'], ctx: 200000, free: false, prio: 92 },
];

export const modelKey = (m) => `${m.provider}:${m.model}`;

/** Convalida un elenco personalizzato; ritorna solo le voci utilizzabili. */
export function sanitizeModels(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(m => m && PROVIDERS[m.provider] && typeof m.model === 'string' && m.model.trim()).map(m => ({
    provider: m.provider, model: m.model.trim(),
    tiers: Array.isArray(m.tiers) && m.tiers.length ? m.tiers.filter(t => ['fast', 'smart', 'vision'].includes(t)) : ['fast'],
    ctx: Number(m.ctx) > 0 ? Number(m.ctx) : 32000,
    rpm: num(m.rpm), rpd: num(m.rpd), tpm: num(m.tpm), tpd: num(m.tpd),
    free: m.free !== false, prio: Number.isFinite(Number(m.prio)) ? Number(m.prio) : 50,
  }));
}
const num = (v) => (Number(v) > 0 ? Number(v) : undefined);
