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
  nvidia:     { env: 'NVIDIA_API_KEY',      url: 'https://integrate.api.nvidia.com/v1/chat/completions', kind: 'openai' },
  openrouter: { env: 'OPENROUTER_API_KEY',  url: 'https://openrouter.ai/api/v1/chat/completions', kind: 'openai' },
  mistral:    { env: 'MISTRAL_API_KEY',     url: 'https://api.mistral.ai/v1/chat/completions', kind: 'openai' },
  github:     { env: 'GITHUB_MODELS_TOKEN', url: 'https://models.github.ai/inference/chat/completions', kind: 'openai' },
  deepseek:   { env: 'DEEPSEEK_API_KEY',    url: 'https://api.deepseek.com/chat/completions', kind: 'openai' },
  anthropic:  { env: 'ANTHROPIC_API_KEY',   url: 'https://api.anthropic.com/v1/messages', kind: 'anthropic' },
};

export const DEFAULT_MODELS = [
  { provider: 'gemini', model: 'gemini-flash-latest',      tiers: ['fast', 'smart', 'vision'], ctx: 1000000, rpm: 10, rpd: 250,  tpm: 250000, free: true, prio: 10 },
  { provider: 'gemini', model: 'gemini-flash-lite-latest', tiers: ['fast', 'vision'],          ctx: 1000000, rpm: 15, rpd: 1000, tpm: 250000, free: true, prio: 12 },
  { provider: 'groq', model: 'llama-3.3-70b-versatile',    tiers: ['fast', 'smart'], ctx: 128000, rpm: 30, rpd: 1000,  tpm: 12000, tpd: 100000, free: true, prio: 20 },
  { provider: 'groq', model: 'openai/gpt-oss-120b',        tiers: ['smart'],         ctx: 128000, rpm: 30, rpd: 1000,  tpm: 8000,  tpd: 200000, free: true, prio: 22 },
  { provider: 'groq', model: 'llama-3.1-8b-instant',       tiers: ['fast'],          ctx: 128000, rpm: 30, rpd: 14400, tpm: 6000,  tpd: 500000, free: true, prio: 28 },
  { provider: 'cerebras', model: 'gpt-oss-120b',           tiers: ['fast', 'smart'], ctx: 64000,  rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000, free: true, prio: 30 },
  { provider: 'cerebras', model: 'llama3.1-8b',            tiers: ['fast'],          ctx: 8000,   rpm: 30, rpd: 14400, tpm: 60000, tpd: 1000000, free: true, prio: 38 },
  { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct',    tiers: ['fast', 'smart'], ctx: 128000, rpm: 40, free: true, prio: 40 },
  { provider: 'nvidia', model: 'deepseek-ai/deepseek-v3.1',      tiers: ['smart'],         ctx: 128000, rpm: 40, free: true, prio: 42 },
  { provider: 'nvidia', model: 'meta/llama-3.2-90b-vision-instruct', tiers: ['vision'],    ctx: 128000, rpm: 40, free: true, prio: 44 },
  { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1:free',        tiers: ['fast', 'smart'], ctx: 64000,  rpm: 20, rpd: 50, free: true, prio: 50 },
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free',  tiers: ['fast', 'smart'], ctx: 64000,  rpm: 20, rpd: 50, free: true, prio: 52 },
  { provider: 'openrouter', model: 'openrouter/free',                         tiers: ['fast', 'smart', 'vision'], ctx: 32000, rpm: 20, rpd: 50, free: true, prio: 58 },
  { provider: 'mistral', model: 'mistral-small-latest', tiers: ['fast', 'vision'], ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 60 },
  { provider: 'mistral', model: 'mistral-large-latest', tiers: ['smart'],          ctx: 128000, rpm: 60, tpm: 500000, free: true, prio: 62 },
  { provider: 'github', model: 'openai/gpt-4.1-mini',   tiers: ['fast', 'vision'], ctx: 8000, rpm: 15, rpd: 150, free: true, prio: 70 },
  { provider: 'github', model: 'openai/gpt-4.1',        tiers: ['smart', 'vision'], ctx: 8000, rpm: 10, rpd: 50, free: true, prio: 72 },
  // A pagamento: entrano in gioco solo se le relative chiavi sono impostate e i gratuiti non bastano.
  { provider: 'deepseek',  model: 'deepseek-chat',     tiers: ['fast', 'smart'],           ctx: 64000,  free: false, prio: 80 },
  { provider: 'anthropic', model: 'claude-haiku-5-5',  tiers: ['fast', 'vision'],          ctx: 200000, free: false, prio: 90 },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', tiers: ['smart', 'vision'],         ctx: 200000, free: false, prio: 92 },
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
