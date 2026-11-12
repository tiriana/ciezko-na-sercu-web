#!/usr/bin/env node
/**
 * Jedno miejsce wyboru modelu językowego dla całego repo.
 *
 * Katalog modeli pochodzi z API dostawcy, bo darmowe oferty zmieniają się co kilka
 * tygodni. Przed każdym pytaniem lista kandydatów jest mieszana, więc limit jednego
 * modelu nie zjada zawsze tego samego pierwszego wyboru. Model, który zwrócił 429,
 * trafia na karencję do `.cache/llm/cooldowns.json` — kolejne wywołania, także
 * osobne procesy Pythona, nie pukają do niego ponownie w tym samym przebiegu.
 *
 * Najpierw losujemy z półki redakcyjnej (modele, które umieją pisać dane na stronę),
 * a dopiero gdy wszystkie zawiodą — z reszty katalogu. Bez tego losowanie wrzuca do
 * streszczenia model 1.7B i psuje treść, której nikt nie sprawdzi.
 */
import { randomInt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_DIR = process.env.LLM_CACHE_DIR || '.cache/llm';
const MODELS_FILE = join(CACHE_DIR, 'models.json');
const COOLDOWN_FILE = join(CACHE_DIR, 'cooldowns.json');
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 1024;
const MIN_CONTEXT = 16_384;
// Czekanie w CI kosztuje więcej niż przejście do następnego modelu, więc
// honorujemy `retry-after` tylko wtedy, gdy jest krótki.
const MAX_INLINE_WAIT_MS = 3_000;
const QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
const BROKEN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const EDITOR_SYSTEM =
  'Jesteś redaktorem serwisu o muzyce metalowej i rockowej. Piszesz po polsku, rzeczowo i konkretnie, bez patosu i bez powtarzania pytania. Zwracasz wyłącznie poprawny JSON.';

// Modele Cloudflare są darmowe w ramach 10 000 neuronów dziennie; te z cennika
// oznaczone jako paid-only (kimi-k2.x, glm-5.x, deepseek-v4) nie wchodzą.
const CLOUDFLARE_FREE = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/google/gemma-3-12b-it',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
];

// Używane, gdy API katalogu nie odpowie, a nie ma jeszcze cache.
const FALLBACK = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
  google: [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
  openrouter: ['openrouter/free'],
  cloudflare: CLOUDFLARE_FREE,
};

// Półka redakcyjna: modele, po których wolno zapisać streszczenie albo etykietę.
// Reszta katalogu zostaje jako zapas na wypadek wyczerpania wszystkich tych limitów.
const QUALITY = {
  groq: [/^openai\/gpt-oss-120b$/, /^openai\/gpt-oss-20b$/, /^qwen\/qwen3\.8-27b$/],
  google: [/^gemini-3\./, /^gemini-2\.5-(flash|pro)/],
  openrouter: [
    /^openrouter\/free$/,
    /^google\/gemma-4-31b-it(:free)?$/,
    /^google\/gemma-4-26b-a4b-it(:free)?$/,
    /^nvidia\/nemotron-3\.5-super/,
    /^nvidia\/nemotron-3-ultra/,
    /^dots-studio\/dots-3/,
  ],
  cloudflare: [
    /llama-3\.3-70b/,
    /llama-4-scout/,
    /gpt-oss-120b/,
    /qwen3-30b/,
    /gemma-4-26b/,
    /glm-4\.7-flash/,
    /mistral-small-3\.1-24b/,
  ],
};

const NON_CHAT =
  /embed|whisper|tts|orpheus|guard|rerank|lyria|image|flux|stable-diffusion|melotts|clip|vision-only/i;
const NOT_STABLE = /preview|experimental|-exp\b|learnlm|sea-lion/i;

const bearer = (key) => ({ authorization: `Bearer ${key}` });

const getJson = async (url, options = {}, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) => {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
};

const PROVIDERS = [
  {
    id: 'groq',
    keyEnv: ['GROQ_API_KEY'],
    chatUrl: () => 'https://api.groq.com/openai/v1/chat/completions',
    async list(key, ctx) {
      const payload = await getJson(
        'https://api.groq.com/openai/v1/models',
        { headers: bearer(key) },
        ctx
      );
      return (payload.data ?? [])
        .map((model) => ({ id: model.id, context: model.context_window ?? 0 }))
        .filter((model) => !NON_CHAT.test(model.id) && !/allam/i.test(model.id));
    },
  },
  {
    id: 'google',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    chatUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    async list(key, ctx) {
      const payload = await getJson(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
        {},
        ctx
      );
      return (payload.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => ({
          id: String(model.name ?? '').replace(/^models\//, ''),
          context: model.inputTokenLimit ?? 0,
        }))
        .filter((model) => model.id && !NON_CHAT.test(model.id) && !NOT_STABLE.test(model.id));
    },
  },
  {
    id: 'openrouter',
    keyEnv: ['OPENROUTER_API_KEY'],
    chatUrl: () => 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'HTTP-Referer': 'https://ciezko-na-sercu.pages.dev',
      'X-Title': 'ciezko-na-sercu-web',
    },
    async list(key, ctx) {
      const payload = await getJson('https://openrouter.ai/api/v1/models', {}, ctx);
      return (payload.data ?? [])
        .filter((model) => Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0)
        .filter((model) => (model.architecture?.output_modalities ?? ['text']).includes('text'))
        .filter((model) => (model.context_length ?? 0) >= MIN_CONTEXT)
        .map((model) => ({ id: model.id, context: model.context_length ?? 0 }))
        .filter((model) => !NON_CHAT.test(model.id));
    },
  },
  {
    id: 'cloudflare',
    keyEnv: ['CLOUDFLARE_API_KEY'],
    requires: (env) => Boolean(env.CLOUDFLARE_ACCOUNT_ID),
    chatUrl: (env) =>
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`,
    async list() {
      return CLOUDFLARE_FREE.map((id) => ({ id, context: 0 }));
    },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shuffled = (items, random) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};

const isQuality = (provider, model) => (QUALITY[provider] ?? []).some((pattern) => pattern.test(model));

const firstEnv = (env, names) => names.map((name) => env[name]).find(Boolean);

const readJsonFile = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

const writeJsonFile = async (path, payload) => {
  await mkdir(CACHE_DIR, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(temporary, path);
};

const discover = async (providers, env, fetchImpl) => {
  const found = {};
  await Promise.all(
    providers.map(async (provider) => {
      const key = firstEnv(env, provider.keyEnv);
      if (!key) return;
      try {
        found[provider.id] = await provider.list(key, { fetchImpl });
      } catch {
        // Katalog jednego dostawcy nie może wyłączyć pozostałych.
      }
    })
  );
  return found;
};

const isFresh = (entry, now) =>
  Boolean(entry?.models?.length) &&
  now - Number(entry.fetchedAt ?? 0) < (entry.fallback ? FALLBACK_TTL_MS : MODELS_TTL_MS);

const modelCatalog = async (env, fetchImpl) => {
  const cached = await readJsonFile(MODELS_FILE);
  const now = Date.now();
  const ready = {};
  const stale = [];
  for (const provider of PROVIDERS) {
    const key = firstEnv(env, provider.keyEnv);
    if (!key || (provider.requires && !provider.requires(env))) continue;
    const entry = cached?.providers?.[provider.id];
    if (isFresh(entry, now)) ready[provider.id] = entry.models;
    else stale.push(provider);
  }
  if (stale.length === 0) return ready;

  const discovered = await discover(stale, env, fetchImpl);
  const stored = { ...(cached?.providers ?? {}) };
  for (const provider of stale) {
    const found = discovered[provider.id];
    const models = found?.length ? found : (FALLBACK[provider.id] ?? []).map((id) => ({ id, context: 0 }));
    ready[provider.id] = models;
    stored[provider.id] = { fetchedAt: now, models, ...(found?.length ? {} : { fallback: true }) };
  }
  await writeJsonFile(MODELS_FILE, { providers: stored });
  return ready;
};

const readCooldowns = async () => {
  const payload = await readJsonFile(COOLDOWN_FILE);
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(payload?.cooldowns ?? {}).filter(([, until]) => Number(until) > now)
  );
};

const saveCooldowns = async (cooldowns) => {
  await writeJsonFile(COOLDOWN_FILE, { cooldowns });
};

// `groq:openai/gpt-oss-120b`, samo `groq` albo puste = wszystko.
const parseFilter = (value) => {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return () => true;
  return (provider, model) =>
    entries.some((entry) => {
      const separator = entry.indexOf(':');
      if (separator < 0) return entry === provider;
      return entry.slice(0, separator) === provider && entry.slice(separator + 1) === model;
    });
};

export const candidates = async ({
  models = '',
  env = process.env,
  fetchImpl = fetch,
  random = Math.random,
  includeCooling = false,
} = {}) => {
  const catalog = await modelCatalog(env, fetchImpl);
  const filter = parseFilter(models);
  const cooldowns = includeCooling ? {} : await readCooldowns();
  const now = Date.now();

  const list = [];
  for (const provider of PROVIDERS) {
    const apiKey = firstEnv(env, provider.keyEnv);
    if (!apiKey) continue;
    if (provider.requires && !provider.requires(env)) continue;
    for (const model of catalog[provider.id] ?? []) {
      if (!filter(provider.id, model.id)) continue;
      if (now < Number(cooldowns[`${provider.id}:${model.id}`] ?? 0)) continue;
      list.push({
        provider: provider.id,
        model: model.id,
        context: Number(model.context ?? 0),
        coolingUntil: Number(cooldowns[`${provider.id}:${model.id}`] ?? 0),
        apiKey,
        chatUrl: provider.chatUrl(env),
        headers: provider.headers ?? {},
      });
    }
  }

  const quality = list.filter((candidate) => isQuality(candidate.provider, candidate.model));
  const basic = list.filter((candidate) => !isQuality(candidate.provider, candidate.model));
  return [...shuffled(quality, random), ...shuffled(basic, random)];
};

const classify = (status, text) => {
  if (status === 429) return 'quota';
  if (status === 401 || status === 403 || status === 404) return 'broken';
  if (/context|too long|too large|maximum.*token/i.test(text)) return 'transient';
  if (status === 400) return 'broken';
  return 'transient';
};

const callModel = async (candidate, { prompt, system, maxTokens, temperature, timeoutMs, fetchImpl }) => {
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];
  const response = await fetchImpl(candidate.chatUrl, {
    method: 'POST',
    headers: {
      ...bearer(candidate.apiKey),
      'content-type': 'application/json',
      'user-agent': 'ciezko-na-sercu/1.0',
      ...candidate.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: candidate.model,
      temperature,
      messages,
      ...(candidate.provider === 'groq'
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${candidate.provider} ${response.status}: ${text.slice(0, 200)}`);
    error.status = response.status;
    error.retryAfterMs = Number(response.headers.get('retry-after') ?? 0) * 1000;
    error.kind = classify(response.status, text);
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error(`${candidate.provider}/${candidate.model}: odpowiedź nie jest JSON-em`);
    error.kind = 'transient';
    throw error;
  }

  const message = payload?.choices?.[0]?.message ?? {};
  const answer = String(message.content ?? message.reasoning_content ?? '').trim();
  if (!answer) {
    const error = new Error(`${candidate.provider}/${candidate.model}: pusta odpowiedź`);
    error.kind = 'transient';
    throw error;
  }
  return answer;
};

const cooldownFor = (error) => {
  if (error.kind === 'quota') {
    return error.retryAfterMs > 0
      ? Math.min(Math.max(error.retryAfterMs, 60_000), QUOTA_COOLDOWN_MS)
      : QUOTA_COOLDOWN_MS;
  }
  if (error.kind === 'broken') return BROKEN_COOLDOWN_MS;
  return TRANSIENT_COOLDOWN_MS;
};

/**
 * Pyta pierwszy dostępny model z przemieszanej listy i zwraca jego odpowiedź.
 * Błąd modelu nie przerywa łańcucha — dopiero wyczerpanie kandydatów rzuca
 * wyjątek z ostatnimi przyczynami.
 */
export const ask = async (
  prompt,
  {
    system = '',
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.2,
    models = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    fetchImpl = fetch,
    random = Math.random,
    wait = sleep,
    log = (line) => process.stderr.write(`${line}\n`),
  } = {}
) => {
  const list = await candidates({ models, env, fetchImpl, random });
  if (list.length === 0) {
    throw new Error(
      'Brak modeli do użycia — ustaw GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY albo CLOUDFLARE_API_KEY (+ CLOUDFLARE_ACCOUNT_ID).'
    );
  }

  const cooldowns = await readCooldowns();
  const errors = [];
  let cooled = false;
  for (const candidate of list) {
    const key = `${candidate.provider}:${candidate.model}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      try {
        const text = await callModel(candidate, {
          prompt,
          system,
          maxTokens,
          temperature,
          timeoutMs,
          fetchImpl,
        });
        log(`[llm] ${key} — ${Date.now() - started} ms`);
        if (cooled) await saveCooldowns(cooldowns).catch(() => {});
        return { text, provider: candidate.provider, model: candidate.model };
      } catch (error) {
        const retryable =
          error.kind === 'quota' && error.retryAfterMs > 0 && error.retryAfterMs <= MAX_INLINE_WAIT_MS;
        if (retryable && attempt === 0) {
          await wait(error.retryAfterMs);
          continue;
        }
        cooldowns[key] = Date.now() + cooldownFor(error);
        cooled = true;
        errors.push(`${key}: ${error.message}`);
        break;
      }
    }
  }

  await saveCooldowns(cooldowns).catch(() => {});
  throw new Error(errors.slice(-6).join(' | ') || 'Wszystkie modele zawiodły');
};

export const parseJson = (raw) => {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('brak JSON-a w odpowiedzi');
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1').replace(/\n/g, ' '));
  }
};

export const askJson = async (prompt, { system = EDITOR_SYSTEM, ...options } = {}) => {
  const answer = await ask(prompt, { system, ...options });
  return { ...answer, data: parseJson(answer.text) };
};

export const describeCandidates = async ({
  models = '',
  env = process.env,
  fetchImpl = fetch,
  includeCooling = false,
} = {}) =>
  (await candidates({ models, env, fetchImpl, includeCooling })).map(
    ({ provider, model, context, coolingUntil }) => ({
      provider,
      model,
      context,
      quality: isQuality(provider, model),
      coolingUntil: coolingUntil || undefined,
    })
  );

export { EDITOR_SYSTEM };
