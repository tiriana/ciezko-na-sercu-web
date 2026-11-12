#!/usr/bin/env node
/**
 * Streszczenie odcinka i nazwy wejść z modelu językowego.
 *
 * Wysyła transkrypt z osią czasu i listę wejść, a w zamian dostaje streszczenie
 * oraz krótkie nazwy wejść. Wpisuje tylko to, czego brakuje: streszczenie, gdy
 * jest puste, i etykiety wejść, które są surowym tekstem z transkryptu albo
 * znacznikiem `#TODO`. Ręcznie napisane etykiety zostają nietknięte.
 *
 * Dostawcy to darmowe tiery zgodne z API OpenAI (Groq, OpenRouter, Cerebras,
 * Google AI Studio, Mistral); klucz z ich zmiennej środowiskowej włącza dostawcę,
 * a łańcuch przeskakuje do następnego, gdy limit albo błąd zatrzyma poprzedniego.
 *
 *   node scripts/enrich-episode.mjs [--episodes <id|slug,...>] [--limit N] [--model groq:model,...] [--force] [--write]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';

const ENDPOINT_TIMEOUT_MS = 90000;
const CHUNK_CHARS = 9000;
const RATE_LIMIT_PAUSE_MS = 25000;
const SUMMARY_MIN = 120;
const SUMMARY_MAX = 1200;
const LABEL_MAX = 90;

// Dostawcy zgodni z API OpenAI (chat/completions). Każdy ma darmowy tier, a klucz
// czytamy z osobnej zmiennej: brak klucza po prostu wyłącza dostawcę z łańcucha,
// więc ten sam kod działa z jednym i z pięcioma.
const PROVIDERS = [
  {
    id: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-120b',
    extraBody: { reasoning_effort: 'low' },
  },
  {
    id: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/free',
    headers: { 'HTTP-Referer': 'https://ciezko-na-sercu.pages.dev', 'X-Title': 'ciezko-na-sercu-web' },
  },
  {
    id: 'cerebras',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'gpt-oss-120b',
  },
  {
    id: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'mistral',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    apiKeyEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-small-latest',
  },
];

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    index += 1;
  } else args.set(token.slice(2), 'true');
}

const write = args.has('write');
const force = args.has('force');
const relabelRaw = args.has('relabel-raw');
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
const model = args.get('model') ?? process.env.ENRICH_MODELS ?? '';
const wanted = String(args.get('episodes') ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const round = (value) => Math.round(value * 100) / 100;

// Łańcuch: `--model groq:openai/gpt-oss-120b,openrouter` albo same id dostawców.
// Bez wskazania bierzemy wszystkich, którzy mają klucz, w kolejności z listy.
const targets = () => {
  const entries = model
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const resolved = entries.length > 0 ? entries : PROVIDERS.map((provider) => provider.id);
  const list = [];
  for (const entry of resolved) {
    const [id, ...rest] = entry.split(':');
    const provider = PROVIDERS.find((candidate) => candidate.id === id);
    if (!provider) {
      console.error(`Nieznany dostawca: ${id}`);
      continue;
    }
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) continue;
    list.push({ provider, apiKey, model: rest.join(':') || provider.defaultModel });
  }
  return list;
};

const chain = targets();
if (chain.length === 0) {
  const names = PROVIDERS.map((provider) => provider.apiKeyEnv).join(', ');
  console.error(`Brak klucza dostawcy modeli. Ustaw jeden z: ${names}.`);
  process.exit(1);
}

const catalog = await readJson('data/catalog.json');
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const stamp = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// Bezpieczny sygnał to brak etykiety albo znacznik `#TODO`. Nazwy redakcyjne
// w danych bywają pełnymi zdaniami, więc zgadywanie po interpunkcji nadpisywało
// dobre opisy — surowy tekst z transkryptu ruszamy tylko z `--relabel-raw`.
const needsLabel = (label) => {
  const text = String(label ?? '').trim();
  return !text || /^#TODO/i.test(text);
};

// Surowy tekst z transkryptu poznajemy po długości: nazwa redakcyjna ma 4–10 słów,
// a zdanie z audycji potrafi mieć 80–90 znaków i ucięte zakończenie.
const looksRaw = (label) => {
  const text = String(label ?? '').trim();
  if (text.length > 70) return true;
  return /[.!?…]$/.test(text) && text.split(/\s+/).length > 14;
};

// Model potrafi oddać ogólnik albo powtórzyć własne placeholdery — takie nazwy
// są gorsze niż surowy tekst, więc ich nie przyjmujemy.
const usableLabel = (label) => {
  const text = String(label ?? '').trim();
  if (!text || text.length > LABEL_MAX) return false;
  if (/brak tytułu|\(brak|#TODO/i.test(text)) return false;
  return text.split(/\s+/).length >= 3;
};

// Darmowe tiery liczą tokeny na minutę, a pełny transkrypt bywa większy niż cały
// limit (Groq: 8000 TPM). Dlatego najpierw streszczamy kolejne fragmenty osobno,
// a dopiero z notatek powstaje streszczenie odcinka i nazwy wejść.
const splitChunks = (transcript) => {
  const chunks = [];
  let current = [];
  let used = 0;
  for (const segment of transcript.segments ?? []) {
    const line = `[${stamp(segment.start)}] ${String(segment.text ?? '').trim()}`;
    if (current.length > 0 && used + line.length > CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push({ line, start: segment.start, end: segment.end });
    used += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((entries) => ({
    start: entries[0].start,
    end: entries[entries.length - 1].end,
    text: entries.map((entry) => entry.line).join('\n'),
  }));
};

const notesPrompt = (episode, chunk) =>
  [
    `Audycja „Ciężko na sercu" (Trójka) z ${episode.date}, fragment ${stamp(chunk.start)}–${stamp(chunk.end)}.`,
    '',
    'TRANSKRYPT FRAGMENTU:',
    chunk.text,
    '',
    'Streść ten fragment w 2–3 zdaniach: o czym prowadzący mówi, jakie zespoły, płyty i wydarzenia wymienia. Bez wstępów.',
    'Odpowiedz wyłącznie JSON-em: {"note": "..."}',
  ].join('\n');

const finalPrompt = (episode, notes, topics) => {
  const entries = topics
    .map((topic) => {
      const label = needsLabel(topic.label) || relabelRaw ? '' : String(topic.label).trim();
      return `${topic.start}–${topic.end ?? topic.start}${label ? `: ${label}` : ''}`;
    })
    .join('\n');

  const tracks = (episode.tracks ?? [])
    .filter((track) => track.title)
    .map((track) => `- ${track.artist ?? '?'} — ${track.title}${track.album ? ` (${track.album})` : ''}`)
    .join('\n');

  return [
    `Odcinek audycji „Ciężko na sercu" (Trójka) z ${episode.date}, tytuł: ${episode.title}.`,
    '',
    'WEJŚCIA (start–koniec w sekundach):',
    entries || '(brak)',
    '',
    'UTWORY W ODCINKU (wykonawca — tytuł — album):',
    tracks || '(brak)',
    '',
    'NOTATKI Z KOLEJNYCH FRAGMENTÓW:',
    notes.map((note) => `[${stamp(note.start)}–${stamp(note.end)}] ${note.text}`).join('\n') || '(brak)',
    '',
    'Zadania:',
    '1. "summary": 3–5 zdań streszczenia odcinka po polsku — o czym była audycja, jakie płyty i zespoły, co je łączy. Bez wstępów typu „w tym odcinku".',
    '2. "labels": dla każdego wejścia krótka nazwa redakcyjna (4–10 słów), która mówi, czego dotyczy dana wypowiedź — np. „Mantar i płyta Post-Apokaliptic Depression z lutego". Oddaj numer startu wejścia w polu "start".',
    '',
    'Zasady:',
    '- Wykonawców, tytuły i albumy bierz wyłącznie z listy utworów i notatek; nie zgaduj ani nie poprawiaj pisowni nazw własnych.',
    '- Jeśli czegoś nie ma w materiale, pomiń to zamiast domyślać się.',
    '',
    'Odpowiedz wyłącznie JSON-em: {"summary": "...", "labels": [{"start": 223, "label": "..."}]}',
  ].join('\n');
};

// Modele oddają czasem płotki z markdownem albo przecinek przed klamrą —
// taniej to naprawić niż tracić całe wywołanie.
const parseLooseJson = (raw) => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('brak JSON-a w odpowiedzi');
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    const repaired = slice.replace(/,\s*([}\]])/g, '$1').replace(/\n/g, ' ');
    return JSON.parse(repaired);
  }
};

const askTarget = async (target, prompt) => {
  const response = await fetch(target.provider.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
      ...(target.provider.headers ?? {}),
    },
    signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    body: JSON.stringify({
      model: target.model,
      temperature: 0.2,
      ...(target.provider.extraBody ?? {}),
      messages: [
        {
          role: 'system',
          content:
            'Jesteś redaktorem serwisu o muzyce metalowej i rockowej. Piszesz po polsku, rzeczowo i konkretnie, bez patosu i bez powtarzania pytania. Zwracasz wyłącznie poprawny JSON.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`${target.provider.id} ${response.status}: ${body.slice(0, 200)}`);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${target.provider.id} odpowiedział nie-JSON-em: ${body.slice(0, 120)}`);
  }
  const raw = payload?.choices?.[0]?.message?.content ?? '';
  return parseLooseJson(raw);
};

// Limit na minutę mija po kilkunastu sekundach, więc jedno ponowienie zwykle
// wystarcza; dopiero potem łańcuch przeskakuje do następnego dostawcy.
const retryable = (message) => /\b(429|500|502|503|504)\b|fetch failed|timeout|aborted/i.test(message);

const ask = async (prompt) => {
  const errors = [];
  for (const target of chain) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await askTarget(target, prompt);
      } catch (error) {
        errors.push(`${target.provider.id}: ${error.message}`);
        if (!retryable(error.message) || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_PAUSE_MS));
      }
    }
  }
  throw new Error(errors.join(' | '));
};

const selected = [];
if (wanted.length > 0) {
  for (const key of wanted) {
    const episode = byKey.get(key);
    if (!episode) {
      console.error(`Nieznany odcinek: ${key}`);
      process.exit(1);
    }
    selected.push(episode);
  }
} else {
  for (const name of (await readdir('data/episodes')).filter((file) => file.endsWith('.json'))) {
    const episode = byKey.get(name.replace(/\.json$/, ''));
    if (episode) selected.push(episode);
  }
}

let processed = 0;
let updated = 0;

for (const entry of selected) {
  if (limit > 0 && processed >= limit) break;

  const episodePath = `data/episodes/${entry.id}.json`;
  let episode;
  try {
    episode = await readJson(episodePath);
  } catch {
    continue;
  }

  const topics = episode.topics ?? [];
  const needsSummary = force || !episode.summary;
  const relabel = topics.filter((topic) => needsLabel(topic.label) || (relabelRaw && looksRaw(topic.label)));
  if (!needsSummary && relabel.length === 0) continue;

  const transcript = await readJson(`data/transcripts/${entry.id}.json`).catch(() => null);
  if (!transcript) {
    console.log(`— ${entry.slug}: brak transkryptu`);
    continue;
  }

  const notes = [];
  try {
    for (const chunk of splitChunks(transcript)) {
      const note = await ask(notesPrompt(entry, chunk));
      const text = String(note.note ?? '').trim();
      if (text) notes.push({ start: chunk.start, end: chunk.end, text });
    }
  } catch (error) {
    console.error(`— ${entry.slug}: notatki — ${error.message}`);
    continue;
  }

  let answer;
  try {
    answer = await ask(finalPrompt(entry, notes, topics));
  } catch (error) {
    console.error(`— ${entry.slug}: ${error.message}`);
    continue;
  }

  const summary = String(answer.summary ?? '').trim();
  const usableSummary = summary.length >= SUMMARY_MIN && summary.length <= SUMMARY_MAX;
  console.log(`${write ? '+' : '·'} ${entry.slug}`);
  if (usableSummary && needsSummary) console.log(`   streszczenie: ${summary}`);
  else if (needsSummary) console.log(`   streszczenie odrzucone (${summary.length} znaków)`);

  const labels = new Map();
  for (const item of answer.labels ?? []) {
    const start = Number(item.start);
    const label = String(item.label ?? '').trim();
    if (!Number.isFinite(start) || !usableLabel(label)) continue;
    labels.set(round(start), label);
  }

  const changed = [];
  for (const topic of relabel) {
    const label = labels.get(round(topic.start));
    if (!label) continue;
    changed.push(`${topic.start}: ${label}`);
    if (write) topic.label = label;
  }
  for (const line of changed) console.log(`   ${line}`);

  if (write && (changed.length > 0 || (usableSummary && needsSummary))) {
    if (usableSummary && needsSummary) episode.summary = summary;
    await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
    updated += 1;
  }
  processed += 1;
}

console.log(`\nOdcinków: ${processed}, zapisanych: ${updated}${write ? '' : ' (bez --write nic nie zapisano)'}`);
