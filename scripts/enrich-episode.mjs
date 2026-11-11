#!/usr/bin/env node
/**
 * Streszczenie odcinka i nazwy wejść z modelu językowego (GitHub Models).
 *
 * Wysyła transkrypt z osią czasu i listę wejść, a w zamian dostaje streszczenie
 * oraz krótkie nazwy wejść. Wpisuje tylko to, czego brakuje: streszczenie, gdy
 * jest puste, i etykiety wejść, które są surowym tekstem z transkryptu albo
 * znacznikiem `#TODO`. Ręcznie napisane etykiety zostają nietknięte.
 *
 *   node scripts/enrich-episode.mjs [--episodes <id|slug,...>] [--limit N] [--model <nazwa>] [--force] [--write]
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ENDPOINT = 'https://models.github.ai/inference/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4.1-mini';
const MAX_TRANSCRIPT_CHARS = 60000;
const SUMMARY_MIN = 120;
const SUMMARY_MAX = 1200;
const LABEL_MAX = 90;

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
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
const model = args.get('model') ?? DEFAULT_MODEL;
const wanted = String(args.get('episodes') ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const round = (value) => Math.round(value * 100) / 100;

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? (await tokenFromCli());

async function tokenFromCli() {
  try {
    const { stdout } = await run('gh', ['auth', 'token']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

if (!token) {
  console.error('Brak tokenu: ustaw GITHUB_TOKEN (w Actions) albo zaloguj `gh auth login`.');
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

// Etykieta z transkryptu to surowy tekst (voiceprint bierze pierwsze 90 znaków),
// więc nadaje się do zastąpienia; nazwa redakcyjna bywa dłuższa niż jedno zdanie
// i wtedy zostaje bez zmian.
const isRawLabel = (label) => {
  const text = String(label ?? '').trim();
  if (!text) return true;
  if (/^#TODO/i.test(text)) return true;
  return /[.!?…]$/.test(text) && text.split(/\s+/).length > 12;
};

const transcriptText = (transcript) => {
  const lines = [];
  let used = 0;
  for (const segment of transcript.segments ?? []) {
    const line = `[${stamp(segment.start)}] ${String(segment.text ?? '').trim()}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
};

const promptFor = (episode, transcript, topics) => {
  const entries = topics
    .map((topic) => `${topic.start}–${topic.end ?? topic.start}: ${isRawLabel(topic.label) ? '(bez nazwy)' : topic.label}`)
    .join('\n');

  return [
    `Odcinek audycji „Ciężko na sercu" (Trójka) z ${episode.date}, tytuł: ${episode.title}.`,
    '',
    'WEJŚCIA (start–koniec w sekundach):',
    entries || '(brak)',
    '',
    'TRANSKRYPT:',
    transcriptText(transcript),
    '',
    'Zadania:',
    '1. "summary": 3–5 zdań streszczenia odcinka po polsku — o czym była audycja, jakie płyty i zespoły, co je łączy. Bez wstępów typu „w tym odcinku".',
    '2. "labels": dla każdego wejścia krótka nazwa redakcyjna (4–10 słów), która mówi, czego dotyczy dana wypowiedź — np. „Mantar i płyta Post-Apokaliptic Depression z lutego". Oddaj numer startu wejścia w polu "start".',
    '',
    'Odpowiedz wyłącznie JSON-em: {"summary": "...", "labels": [{"start": 223, "label": "..."}]}',
  ].join('\n');
};

const ask = async (prompt) => {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
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
  if (!response.ok) {
    throw new Error(`models.github.ai ${response.status}: ${body.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`models.github.ai odpowiedział nie-JSON-em: ${body.slice(0, 200)}`);
  }
  const raw = payload?.choices?.[0]?.message?.content ?? '';
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(json);
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
  const relabel = topics.filter((topic) => isRawLabel(topic.label));
  if (!needsSummary && relabel.length === 0) continue;

  const transcript = await readJson(`data/transcripts/${entry.id}.json`).catch(() => null);
  if (!transcript) {
    console.log(`— ${entry.slug}: brak transkryptu`);
    continue;
  }

  let answer;
  try {
    answer = await ask(promptFor(entry, transcript, topics));
  } catch (error) {
    console.error(`— ${entry.slug}: ${error.message}`);
    continue;
  }

  const summary = String(answer.summary ?? '').trim();
  const usableSummary = summary.length >= SUMMARY_MIN && summary.length <= SUMMARY_MAX;
  console.log(`${write ? '+' : '·'} ${entry.slug}`);
  if (usableSummary && needsSummary) console.log(`   streszczenie: ${summary.slice(0, 160)}…`);
  else if (needsSummary) console.log(`   streszczenie odrzucone (${summary.length} znaków)`);

  const labels = new Map();
  for (const item of answer.labels ?? []) {
    const start = Number(item.start);
    const label = String(item.label ?? '').trim();
    if (!Number.isFinite(start) || !label || label.length > LABEL_MAX) continue;
    labels.set(round(start), label);
  }

  const changed = [];
  for (const topic of topics) {
    if (!isRawLabel(topic.label)) continue;
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
