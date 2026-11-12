#!/usr/bin/env node
/**
 * Streszczenie odcinka i nazwy wejść z modelu językowego.
 *
 * Wysyła transkrypt z osią czasu i listę wejść, a w zamian dostaje streszczenie
 * oraz krótkie nazwy wejść. Wpisuje tylko to, czego brakuje: streszczenie, gdy
 * jest puste, i etykiety wejść, które są surowym tekstem z transkryptu albo
 * znacznikiem `#TODO`. Ręcznie napisane etykiety zostają nietknięte. Wejścia
 * dodane w edytorze leżą w `data/overrides` — ich `#TODO` naprawiamy w miejscu,
 * a nie przez usunięcie wpisu.
 *
 * Dostawcy to darmowe tiery zgodne z API OpenAI (Groq, OpenRouter, Cerebras,
 * Google AI Studio, Mistral); klucz z ich zmiennej środowiskowej włącza dostawcę,
 * a łańcuch przeskakuje do następnego, gdy limit albo błąd zatrzyma poprzedniego.
 *
 *   node scripts/enrich-episode.mjs [--episodes <id|slug,...>] [--limit N] [--model groq:model,...] [--force] [--write]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';

import { isTechnicalTitle } from '../src/lib/titles.ts';

const ENDPOINT_TIMEOUT_MS = 90000;
const CHUNK_CHARS = 9000;
const SUMMARY_MIN = 120;
const SUMMARY_MAX = 1200;
// Dwa wydawnictwa w jednej etykiecie to nie błąd — poprawiony opis bywa długi.
const LABEL_MAX = 140;

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
// Ten sam klucz znacznika „ok”, którego używa edytor: NFC, bez spacji na brzegach, małe litery.
const normalizeLabel = (value) => String(value ?? '').normalize('NFC').trim().toLowerCase();

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
  return !text || /#TODO/i.test(text);
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

const finalPrompt = (episode, notes, topics, needsTitle = false) => {
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
    ...(needsTitle
      ? ['3. "title": tytuł odcinka na stronę (4–8 słów), oddający główny temat — bez cudzysłowów, bez daty i godziny, bez „Ciężko na sercu”.']
      : []),
    '',
    'Zasady:',
    '- Wykonawców, tytuły i albumy bierz wyłącznie z listy utworów i notatek; nie zgaduj ani nie poprawiaj pisowni nazw własnych.',
    '- Jeśli czegoś nie ma w materiale, pomiń to zamiast domyślać się.',
    '',
    needsTitle
      ? 'Odpowiedz wyłącznie JSON-em: {"summary": "...", "labels": [{"start": 223, "label": "..."}], "title": "..."}'
      : 'Odpowiedz wyłącznie JSON-em: {"summary": "...", "labels": [{"start": 223, "label": "..."}]}',
  ].join('\n');
};

// Etykieta dla jednego wejścia: model zbiorczy odpowiada tylko za te, które
// dostał z opisem, więc miejsca z `#TODO` pytamy osobno, z transkryptem wokół.
// `#TODO` z edytora dopisuje się do gotowego opisu, gdy redakcja chce go poprawić —
// w takim wypadku model dostaje szkic, a nie puste miejsce.
const draftLabel = (label) =>
  String(label ?? '')
    .replace(/#TODO[^\n]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const labelPrompt = (episode, topic, context) => {
  const draft = needsLabel(topic.label) ? draftLabel(topic.label) : '';
  return [
    `Audycja „Ciężko na sercu" (Trójka) z ${episode.date}.`,
    '',
    `FRAGMENT TRANSKRYPTU WOKÓŁ WEJŚCIA ZACZYNAJĄCEGO SIĘ O ${stamp(topic.start)}:`,
    context,
    ...(draft
      ? [
          '',
          'OBECNY OPIS (szkic do poprawy):',
          draft,
          '',
          'Zadanie: popraw ten opis — usuń znacznik #TODO, uporządkuj składnię i nie dodawaj faktów,',
          'których nie ma w szkicu. Tytułów ani nazw nie skracaj: zostaw je dokładnie tak, jak są zapisane.',
        ]
      : [
          '',
          'Zadanie: nazwij to wejście krótko po polsku (4–10 słów) — czego dotyczy wypowiedź prowadzącego.',
        ]),
    'Bez wstępów, bez cudzysłowów, bez powtarzania numeru czasu.',
    '',
    'Odpowiedz wyłącznie JSON-em: {"label": "..."}',
  ].join('\n');
};

const topicContext = (transcript, start, end) =>
  (transcript.segments ?? [])
    .filter((segment) => segment.end >= start - 30 && segment.start <= end + 30)
    .map((segment) => `[${stamp(segment.start)}] ${String(segment.text ?? '').trim()}`)
    .join('\n');

const askLabel = async (episode, transcript, topic) => {
  const context = topicContext(transcript, topic.start, topic.end ?? topic.start + 120);
  if (!context) return null;
  const answer = await ask(labelPrompt(episode, topic, context));
  const label = String(answer?.label ?? '').trim();
  return usableLabel(label) ? label : null;
};

// Kredyty bierzemy z tych fragmentów, w których pada przedstawienie się, wydawca,
// gość albo realizacja — reszta transkryptu to muzyka i tematy.
const CREDITS_ROLES = new Set(['prowadzący', 'wydawca', 'producent', 'gość', 'realizacja', 'autor']);
const creditsPrompt = (episode, transcript) => {
  const hints = /(prowadz|wydaj|wydawc|producent|realizac|zaprosi|gości|gość|wita|kłania|montaż|reżyser)/i;
  const excerpts = (transcript.segments ?? [])
    .filter((segment) => hints.test(segment.text ?? ''))
    .slice(0, 40)
    .map((segment) => `[${Math.round(segment.start)}] ${String(segment.text).trim()}`)
    .join('\n');
  return [
    `Audycja „Ciężko na sercu" (Trójka) z ${episode.date}.`,
    '',
    'FRAGMENTY TRANSKRYPTU, W KTÓRYCH MOWA O OSOBACH (czas w sekundach):',
    excerpts || '(brak)',
    '',
    'Zadanie: wypisz osoby odpowiedzialne za audycję i gości, których prowadzący wymienia.',
    'Rola musi być jedną z: prowadzący, wydawca, producent, gość, realizacja, autor.',
    '"time" to sekunda, w której pada ta informacja; "quote" to krótki cytat z transkryptu (do 160 znaków).',
    'Bierz wyłącznie osoby wprost wymienione; nie zgaduj imion ani nazwisk.',
    '',
    'Odpowiedz wyłącznie JSON-em: {"credits": [{"role": "prowadzący", "name": "...", "time": 0, "quote": "..."}]}',
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

// Limit na minutę mija po kilkudziesięciu sekundach, a przy jednym kluczu
// (Groq: 8000 TPM) map-reduce i tak wyczerpuje okno — dlatego czekamy coraz dłużej,
// zamiast po jednej próbie rezygnować z całego odcinka.
const retryable = (message) => /\b(429|500|502|503|504)\b|fetch failed|timeout|aborted/i.test(message);
const RETRY_PAUSES_MS = [15_000, 45_000, 90_000];

const ask = async (prompt) => {
  const errors = [];
  for (const target of chain) {
    for (let attempt = 0; attempt <= RETRY_PAUSES_MS.length; attempt += 1) {
      try {
        return await askTarget(target, prompt);
      } catch (error) {
        errors.push(`${target.provider.id}: ${error.message}`);
        if (!retryable(error.message) || attempt === RETRY_PAUSES_MS.length) break;
        await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSES_MS[attempt]));
      }
    }
  }
  throw new Error(errors.join(' | '));
};

const selected = [];
if (wanted.length > 0) {
  for (const key of wanted) {
    const episode = byKey.get(key);
    if (episode) {
      selected.push(episode);
      continue;
    }
    // Ręcznie wygodniej podać krótki uuid; przy niejednoznacznym prefiksie
    // lepiej się zatrzymać niż zgadnąć odcinek.
    const matches = catalog.episodes.filter((item) => item.id.startsWith(key));
    if (matches.length === 1) {
      selected.push(matches[0]);
      continue;
    }
    console.error(
      matches.length > 1
        ? `Niejednoznaczny prefiks ${key}: ${matches.map((item) => item.id.slice(0, 8)).join(', ')}`
        : `Nieznany odcinek: ${key}`
    );
    process.exit(1);
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
  const overridePath = `data/overrides/${entry.id}.json`;
  const override = await readJson(overridePath).catch(() => null);
  const addedTopics = override?.addTopics ?? [];
  // Edytor zapisuje poprawki jako `newLabel` w `override.topics` — tam `#TODO`
  // dopisuje się na końcu gotowego opisu („… #TODO popraw ten opis”).
  const labelFixes = (override?.topics ?? []).filter((fix) => fix.newLabel !== undefined);
  const currentLabel = (topic, kind) => (kind === 'newLabel' ? topic.newLabel : topic.label);
  const needsSummary = force || !episode.summary;
  const relabel = [
    ...topics.map((topic) => ({ topic, kind: 'episode' })),
    ...addedTopics.map((topic) => ({ topic, kind: 'added' })),
    ...labelFixes.map((topic) => ({ topic, kind: 'newLabel' })),
  ].filter(({ topic, kind }) => {
    const text = currentLabel(topic, kind);
    return needsLabel(text) || (relabelRaw && looksRaw(text));
  });
  const promptTopics = [...topics, ...addedTopics].filter(
    (topic, index, all) => all.findIndex((other) => other.start === topic.start) === index
  );
  const needsCredits = (episode.credits ?? []).length === 0;
  // Tytuł techniczny bez nieoficjalnego to znak, że redakcja go jeszcze nie nadała —
  // wtedy proponujemy własny, żeby odcinek nie nazywał się „godz. 00:06”.
  const unofficial = (await readJson('data/titles.json').catch(() => ({ titles: {} }))).titles?.[entry.id];
  const needsTitle = !unofficial && isTechnicalTitle(entry.title);
  if (!needsSummary && relabel.length === 0 && !needsCredits && !needsTitle) continue;

  const transcript = await readJson(`data/transcripts/${entry.id}.json`).catch(() => null);
  if (!transcript) {
    console.log(`— ${entry.slug}: brak transkryptu`);
    continue;
  }

  // Notatki z całego transkryptu są potrzebne tylko do streszczenia i etykiet —
  // gdy brakuje wyłącznie kredytów, nie palimy limitu na map-reduce.
  const notes = [];
  if (needsSummary || relabel.length > 0 || needsTitle) {
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
  }

  let answer;
  try {
    answer = await ask(finalPrompt(entry, notes, promptTopics, needsTitle));
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
  const reviewedMoves = [];
  let episodeLabelChanged = false;
  let overrideLabelChanged = false;
  for (const { topic, kind } of relabel) {
    const current = currentLabel(topic, kind);
    // Poprawka z `newLabel` ma szkic w treści, więc pytamy celowo — model zbiorczy
    // dostałby tylko czystą wersję z odcinka i zwróciłby ją bez zmian.
    let label = kind === 'newLabel' ? null : labels.get(round(topic.start));
    if (!label) {
      try {
        label = await askLabel(entry, transcript, { ...topic, label: current });
      } catch (error) {
        console.error(`   etykieta ${topic.start}: ${error.message}`);
      }
    }
    if (!label || label === current) continue;
    changed.push(`${topic.start}: ${label}`);
    // Wspólny placeholder bywa kluczem wielu wejść naraz — przeniesienie go
    // przypisałoby „ok” do pierwszego z brzegu, więc zostawiamy taki wpis w spokoju.
    if (!/^#TODO - wygeneruj opis znacznika$/i.test(String(current).trim())) {
      reviewedMoves.push({ from: `p:${normalizeLabel(current)}`, to: `p:${normalizeLabel(label)}` });
    }
    if (!write) continue;
    if (kind === 'newLabel') {
      topic.newLabel = label;
      overrideLabelChanged = true;
    } else if (kind === 'added') {
      topic.label = label;
      overrideLabelChanged = true;
    } else {
      topic.label = label;
      episodeLabelChanged = true;
    }
  }
  for (const line of changed) console.log(`   ${line}`);

  // Kredyty uzupełniamy tylko w odcinku, który ich nie ma — ręcznej listy nie ruszamy.
  let credits = null;
  if (needsCredits) {
    try {
      const transcript = await readJson(`data/transcripts/${entry.id}.json`).catch(() => null);
      if (transcript?.segments?.length) {
        const response = await ask(creditsPrompt(episode, transcript));
        const seen = new Set();
        credits = (response.credits ?? [])
          .map((item) => ({
            role: String(item.role ?? '').trim().toLowerCase(),
            name: String(item.name ?? '').trim(),
            time: Number(item.time),
            quote: String(item.quote ?? '').trim().slice(0, 200),
          }))
          .filter((item) => CREDITS_ROLES.has(item.role) && item.name.length >= 3 && Number.isFinite(item.time))
          .filter((item) => {
            const key = `${item.role}|${item.name.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        // Model bywa niekonsekwentny przy stałych osobach audycji, a te są znane:
        // jeśli w transkrypcie jest nazwisko, kredyt musi się pojawić.
        const known = [
          // Tylko nazwisko: transkrypt dzieli zdania w środku imienia i nazwiska.
          { role: 'prowadzący', pattern: /Szubrych\w*/i, name: 'Jarek Szubrycht' },
          { role: 'wydawca', pattern: /Owczar\w*/i, name: 'Mariusz Owczarek' },
        ];
        for (const person of known) {
          const segment = (transcript.segments ?? []).find((item) => person.pattern.test(item.text ?? ''));
          if (!segment) continue;
          credits = credits ?? [];
          const existing = credits.find((item) => item.role === person.role);
          // Model oddaje przypadki gramatyczne („Owczarka”), więc przy znanych osobach
          // mianownik z projektu ma pierwszeństwo przed tym, co zwróci odpowiedź.
          if (existing) {
            existing.name = person.name;
            existing.time = Math.round(segment.start);
            existing.quote = String(segment.text).trim().slice(0, 200);
          } else {
            credits.push({
              role: person.role,
              name: person.name,
              time: Math.round(segment.start),
              quote: String(segment.text).trim().slice(0, 200),
            });
          }
        }

        if (credits.length > 0) {
          for (const item of credits) console.log(`   ${item.role}: ${item.name} (${item.time} s)`);
        } else {
          credits = null;
        }
      }
    } catch (error) {
      console.error(`   kredyty: ${error.message}`);
      credits = null;
    }
  }

  // Tytuł nieoficjalny zapisujemy obok odcinka, w `titles.json` — tam trzyma je edytor.
  let proposedTitle = null;
  if (needsTitle) {
    const candidate = String(answer.title ?? '').trim().replace(/^["„”]+|["„”]+$/g, '');
    const words = candidate.split(/\s+/).filter(Boolean).length;
    if (candidate.length >= 12 && words >= 3 && words <= 10 && !isTechnicalTitle(candidate)) {
      proposedTitle = candidate;
      console.log(`   tytuł: ${candidate}`);
    } else {
      console.log(`   tytuł odrzucony: „${candidate.slice(0, 60)}”`);
    }
  }

  if (write && proposedTitle) {
    const titles = await readJson('data/titles.json').catch(() => ({ version: 1, titles: {} }));
    titles.titles = titles.titles ?? {};
    if (!titles.titles[entry.id]) {
      titles.titles[entry.id] = {
        title: proposedTitle,
        kind: 'unofficial',
        originalTitle: entry.title,
        note: 'Tytuł nieoficjalny wygenerowany z transkryptu (AI).',
      };
      await writeFile('data/titles.json', `${JSON.stringify(titles, null, 2)}\n`);
      updated += 1;
    }
  }

  if (write && overrideLabelChanged && override) {
    await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`);
    updated += 1;
  }

  // Zmiana etykiety zmienia klucz znacznika „ok” — przenosimy go, żeby po
  // naprawie #TODO odcinek nie wyglądał na pozbawiony recenzji.
  if (write && reviewedMoves.length > 0) {
    const reviewed = await readJson('data/reviewed.json').catch(() => ({ version: 1, episodes: {} }));
    const marks = reviewed.episodes?.[entry.id];
    let touched = false;
    for (const move of reviewedMoves) {
      if (!marks || move.from === move.to || !(move.from in marks)) continue;
      marks[move.to] = true;
      delete marks[move.from];
      touched = true;
    }
    if (touched) await writeFile('data/reviewed.json', `${JSON.stringify(reviewed, null, 2)}\n`);
  }

  if (write && (episodeLabelChanged || (usableSummary && needsSummary) || credits)) {
    if (usableSummary && needsSummary) episode.summary = summary;
    if (credits) episode.credits = credits;
    await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
    updated += 1;
  }
  processed += 1;
}

console.log(`\nOdcinków: ${processed}, zapisanych: ${updated}${write ? '' : ' (bez --write nic nie zapisano)'}`);
