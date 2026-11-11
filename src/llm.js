// Gemini client built for reliability: structured JSON output, throttling, retry/backoff, model fallback,
// response caching, key redaction and a connection test. Falls back to Anthropic (text only) or offline.
const crypto = require('crypto');
const db = require('./db');

const provider = () => (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'offline');
const baseUrl = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const geminiModels = () => [process.env.GEMINI_MODEL || 'gemini-2.5-flash', ...(process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-2.5-flash-lite').split(',').map((s) => s.trim()).filter(Boolean)];
const modelName = () => (provider() === 'gemini' ? geminiModels()[0] : provider() === 'anthropic' ? process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' : 'rules-engine');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LLMError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
const redact = (s) => String(s || '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]').replace(/key=[^&\s"]+/g, 'key=[redacted]').replace(/sk-[A-Za-z0-9_-]{20,}/g, '[key]').slice(0, 300);

// Space out calls so free-tier rate limits are respected (shared by all submissions).
let last = 0, chain = Promise.resolve();
function throttle() {
  const gap = process.env.GEMINI_MIN_INTERVAL_MS !== undefined ? +process.env.GEMINI_MIN_INTERVAL_MS : 3000;
  const p = chain.then(async () => { const wait = Math.max(0, last + gap - Date.now()); if (wait) await sleep(wait); last = Date.now(); });
  chain = p.catch(() => {});
  return p;
}

function cacheGet(key) {
  if (!key) return null;
  const r = db.prepare('SELECT value FROM llm_cache WHERE key=?').get(key);
  return r ? JSON.parse(r.value) : null;
}
function cachePut(key, v) { if (key) db.prepare('INSERT OR REPLACE INTO llm_cache (key, value, created_at) VALUES (?,?,?)').run(key, JSON.stringify(v), new Date().toISOString()); }
const hash = (...xs) => crypto.createHash('sha256').update(xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\u0001')).digest('hex');

async function geminiOnce(model, body) {
  let res;
  try {
    res = await fetch(`${baseUrl()}/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body), signal: AbortSignal.timeout(+process.env.GEMINI_TIMEOUT_MS || 90000)
    });
  } catch (e) {
    throw new LLMError(e.name === 'TimeoutError' ? 'timeout' : 'network', e.name === 'TimeoutError' ? 'Gemini request timed out' : 'Could not reach the Gemini API (check your internet connection)', { retryable: true });
  }
  if (res.ok) return res.json();
  const txt = await res.text(); let msg = txt;
  try { msg = JSON.parse(txt).error?.message || txt; } catch (e) { /* plain text */ }
  const retryAfter = +res.headers.get('retry-after') || 0;
  if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(txt)) throw new LLMError('invalid_key', 'Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.');
  if (res.status === 401 || res.status === 403) throw new LLMError('permission', `Gemini denied access (${res.status}). Check the key, its project and API restrictions. ${redact(msg)}`);
  if (res.status === 404) throw new LLMError('model_unavailable', `Model "${model}" is not available for this key`, { fallback: true });
  if (res.status === 429) throw new LLMError('quota', `Gemini rate limit or quota reached: ${redact(msg)}`, { retryable: true, retryAfter, fallback: true });
  if (res.status >= 500) throw new LLMError('server', `Gemini server error ${res.status}`, { retryable: true, retryAfter });
  throw new LLMError('bad_request', `Gemini rejected the request (${res.status}): ${redact(msg)}`);
}

function extractText(data) {
  const c = data.candidates?.[0];
  if (!c) throw new LLMError('blocked', `Gemini returned no result${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}`);
  const text = (c.content?.parts || []).map((p) => p.text || '').join('');
  if (c.finishReason === 'MAX_TOKENS') throw new LLMError('truncated', 'Gemini output was cut off (too long)');
  if (!text.trim()) throw new LLMError('empty', `Gemini returned an empty response${c.finishReason ? ` (${c.finishReason})` : ''}`);
  return { text, usage: data.usageMetadata || null };
}

async function geminiGenerate({ system, parts, schema, json, maxOutputTokens = 8192 }) {
  let lastErr;
  for (const model of geminiModels()) {
    const generationConfig = { temperature: 0, maxOutputTokens, ...(json ? { responseMimeType: 'application/json' } : {}), ...(schema ? { responseSchema: schema } : {}) };
    if (/flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 }; // fast, cheap extraction
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig };
    for (let attempt = 0; attempt < 4; attempt++) {
      await throttle();
      try { const { text, usage } = extractText(await geminiOnce(model, body)); return { text, model, usage }; }
      catch (e) {
        lastErr = e;
        if (!(e instanceof LLMError)) throw e;
        if (e.retryable && attempt < 3) { await sleep(Math.max(e.retryAfter * 1000, 2000 * 2 ** attempt + Math.random() * 500)); continue; }
        if (e.fallback || e.retryable) break; // try the next model
        throw e;
      }
    }
  }
  throw lastErr;
}

async function anthropicGenerate({ system, parts, maxOutputTokens = 4096 }) {
  if (parts.some((p) => p.inlineData)) throw new LLMError('no_vision', 'Scanned documents and images need a Gemini API key (GEMINI_API_KEY).');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelName(), max_tokens: maxOutputTokens, temperature: 0, system, messages: [{ role: 'user', content: parts.map((p) => p.text).join('\n') }] }),
    signal: AbortSignal.timeout(90000)
  }).catch(() => { throw new LLMError('network', 'Could not reach the Anthropic API'); });
  if (!res.ok) throw new LLMError('bad_request', `Anthropic error ${res.status}: ${redact(await res.text())}`);
  const d = await res.json();
  return { text: (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model: modelName(), usage: d.usage || null };
}

function parseJSON(text) {
  const t = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new LLMError('bad_json', 'Model did not return JSON');
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new LLMError('bad_json', 'Model returned malformed JSON'); }
}

// Returns { data, model, usage, cached }. `validate(obj)` may throw to request one automatic repair attempt.
async function generateJSON({ system, parts, schema, validate, cacheKey, maxOutputTokens }) {
  const p = provider();
  if (p === 'offline') throw new LLMError('offline', 'No AI key configured');
  const key = cacheKey ? hash(p, modelName(), system, parts, schema) : null;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const run = (extra) => (p === 'gemini'
    ? geminiGenerate({ system, parts: extra ? [...parts, { text: extra }] : parts, schema, json: true, maxOutputTokens })
    : anthropicGenerate({ system: system + '\nReturn ONLY JSON.', parts: extra ? [...parts, { text: extra }] : parts, maxOutputTokens }));
  let out = await run(), data;
  try { data = parseJSON(out.text); if (validate) validate(data); }
  catch (e) {
    out = await run(`Your previous answer was invalid (${redact(e.message)}). Return corrected JSON only, following the schema exactly.`);
    data = parseJSON(out.text); if (validate) validate(data);
  }
  const result = { data, model: out.model, usage: out.usage };
  cachePut(key, result);
  return result;
}

async function testConnection() {
  const p = provider(), t0 = Date.now();
  if (p === 'offline') return { ok: false, provider: p, error: 'No API key found. Add GEMINI_API_KEY to your .env file and restart the server.' };
  try {
    const r = await generateJSON({ system: 'You are a health check. Reply with JSON only.', parts: [{ text: 'Return {"status":"ok"}' }],
      schema: p === 'gemini' ? { type: 'OBJECT', properties: { status: { type: 'STRING' } }, required: ['status'] } : undefined,
      validate: (d) => { if (d.status !== 'ok') throw new Error('unexpected reply'); } });
    return { ok: true, provider: p, model: r.model, latencyMs: Date.now() - t0, usage: r.usage };
  } catch (e) { return { ok: false, provider: p, model: modelName(), error: redact(e.message), code: e.code || 'error' }; }
}

module.exports = { provider, modelName, generateJSON, testConnection, parseJSON, LLMError, hash, redact };
