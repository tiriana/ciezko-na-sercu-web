import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, after, test } from 'node:test';

const cacheDir = await mkdtemp(join(tmpdir(), 'llm-test-'));
process.env.LLM_CACHE_DIR = cacheDir;

const { ask, candidates, parseJson } = await import('./llm.mjs');

after(() => rm(cacheDir, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(join(cacheDir, 'models.json'), { force: true });
  await rm(join(cacheDir, 'cooldowns.json'), { force: true });
});

const json = (payload, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(payload),
});

const catalog = (url) => {
  if (url.includes('api.groq.com')) {
    return json({
      data: [
        { id: 'openai/gpt-oss-120b', context_window: 131072 },
        { id: 'openai/gpt-oss-20b', context_window: 131072 },
        { id: 'whisper-large-v3', context_window: 448 },
      ],
    });
  }
  if (url.includes('openrouter.ai')) {
    return json({
      data: [
        {
          id: 'google/gemma-4-31b-it:free',
          pricing: { prompt: '0', completion: '0' },
          context_length: 262144,
          architecture: { output_modalities: ['text'] },
        },
        {
          id: 'liquid/lfm-2.5-2.6b:free',
          pricing: { prompt: '0', completion: '0' },
          context_length: 65536,
          architecture: { output_modalities: ['text'] },
        },
        {
          id: 'vendor/paid-model',
          pricing: { prompt: '0.000001', completion: '0.000002' },
          context_length: 262144,
          architecture: { output_modalities: ['text'] },
        },
      ],
    });
  }
  throw new Error(`nieoczekiwany adres katalogu: ${url}`);
};

const env = { GROQ_API_KEY: 'groq-key', OPENROUTER_API_KEY: 'or-key' };

test('katalog odsiewa modele spoza darmowego czatu i stawia półkę redakcyjną na przodzie', async () => {
  const list = await candidates({ env, fetchImpl: async (url) => catalog(url), random: () => 0 });
  const ids = list.map((candidate) => `${candidate.provider}:${candidate.model}`);

  assert.ok(!ids.some((id) => id.includes('whisper')));
  assert.ok(!ids.some((id) => id.includes('paid-model')));
  assert.ok(ids.indexOf('openrouter:liquid/lfm-2.5-2.6b:free') > ids.indexOf('openrouter:google/gemma-4-31b-it:free'));
  assert.ok(ids.indexOf('openrouter:liquid/lfm-2.5-2.6b:free') > ids.indexOf('groq:openai/gpt-oss-120b'));
});

test('filtr --model zawęża kandydatów do wskazanego dostawcy', async () => {
  const list = await candidates({
    env,
    fetchImpl: async (url) => catalog(url),
    models: 'groq',
    random: () => 0,
  });
  assert.deepEqual(new Set(list.map((candidate) => candidate.provider)), new Set(['groq']));
});

test('po 429 model idzie na karencję, a odpowiedź pochodzi z następnego', async () => {
  const calls = [];
  let firstPost = true;
  const fetchImpl = async (url, options = {}) => {
    if (!options.method) return catalog(url);
    const { model } = JSON.parse(options.body);
    calls.push(model);
    if (firstPost) {
      firstPost = false;
      return json({ error: { message: 'rate limit' } }, 429, { 'retry-after': '0' });
    }
    return json({ choices: [{ message: { content: '{"ok": true}' } }] });
  };

  const first = await ask('pytanie', {
    env,
    fetchImpl,
    models: 'groq',
    random: () => 0,
    wait: async () => {},
    log: () => {},
  });
  assert.equal(first.text, '{"ok": true}');
  assert.equal(calls.length, 2);

  const cooldowns = JSON.parse(await readFile(join(cacheDir, 'cooldowns.json'), 'utf8'));
  const cooled = calls[0];
  assert.ok(cooldowns.cooldowns[`groq:${cooled}`] > Date.now());

  calls.length = 0;
  const second = await ask('drugie pytanie', {
    env,
    fetchImpl,
    models: 'groq',
    random: () => 0,
    wait: async () => {},
    log: () => {},
  });
  assert.deepEqual(calls, [second.model]);
  assert.notEqual(second.model, cooled);
});

test('parseJson naprawia przecinek przed klamrą', () => {
  assert.deepEqual(parseJson('oto wynik: {"label": "Nowa płyta",}'), { label: 'Nowa płyta' });
});

test('brak kluczy kończy się czytelnym błędem', async () => {
  await assert.rejects(
    ask('pytanie', { env: {}, fetchImpl: async () => json({}), log: () => {} }),
    /Brak modeli do użycia/
  );
});
