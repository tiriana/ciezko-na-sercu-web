#!/usr/bin/env node
/**
 * Ustawia istniejące wejścia na właściwych blokach mowy.
 *
 * Stare odcinki mają etykiety z taggera, ale czasy z innej osi (klaster na początku
 * nagrania albo przesunięcie o kilka minut). Zamiast pisać etykiety od nowa, model
 * dostaje listę bloków mowy i listę etykiet i przypisuje każdą do bloku — treść
 * zostaje redakcyjna, zmienia się tylko czas. Końce przeliczamy jak w taggerze:
 * do najbliższego późniejszego startu utworu albo wejścia.
 *
 *   node scripts/align-topics.mjs --episodes <id|slug,...> [--limit N] [--pause ms] [--write]
 */
import { readFile, writeFile } from 'node:fs/promises';

import { askJson } from './lib/llm.mjs';

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
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
const pause = Number.parseInt(args.get('pause') ?? '0', 10) || 0;
const model = args.get('model') ?? process.env.ENRICH_MODELS ?? '';
const wanted = String(args.get('episodes') ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// Blok mowy: ciąg segmentów bez pauzy dłuższej niż 6 s; początek bloku to początek
// wypowiedzi, a nie muzyki, więc nadaje się na start wejścia.
const speechBlocks = (transcript) => {
  const blocks = [];
  let current = null;
  for (const segment of transcript?.segments ?? []) {
    if (!current || segment.start - current.end > 6) {
      if (current) blocks.push(current);
      current = { start: segment.start, end: segment.end, text: String(segment.text ?? '').trim() };
    } else {
      current.end = segment.end;
      current.text = `${current.text} ${String(segment.text ?? '').trim()}`;
    }
  }
  if (current) blocks.push(current);
  return blocks.map((block) => ({ start: block.start, end: block.end, text: block.text.replace(/\s+/g, ' ') }));
};

// Gdy mówionych bloków jest mniej niż etykiet, dzielimy mowę na okna po ~2 minuty:
// jeden blok to często cała rozmowa, a wejścia opisują jej kolejne wątki.
const speechChunks = (transcript, maxSec = 120) => {
  const chunks = [];
  let current = null;
  for (const segment of transcript?.segments ?? []) {
    const text = String(segment.text ?? '').trim();
    if (!current || segment.start - current.end > 6 || segment.end - current.start > maxSec) {
      if (current) chunks.push(current);
      current = { start: segment.start, end: segment.end, text };
    } else {
      current.end = segment.end;
      current.text = `${current.text} ${text}`;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => ({ start: chunk.start, end: chunk.end, text: chunk.text.replace(/\s+/g, ' ') }));
};

// Zapas, gdy model przypisze dwa wejścia do jednego fragmentu albo pominie etykietę:
// bierzemy pierwszy wolny blok, którego treść dzieli najwięcej rdzeni wyrazów.
const STOPWORDS = new Set([
  'oraz', 'albo', 'czyli', 'tego', 'tych', 'tym', 'takze', 'ktore', 'ktory', 'ktora', 'bylo', 'byla', 'byli',
  'jest', 'jego', 'jej', 'ich', 'niz', 'przez', 'przy', 'czy', 'tak', 'nie', 'sie', 'dla', 'aby', 'gdy', 'gdzie',
  'jak', 'kiedy', 'potem', 'teraz', 'tez', 'juz', 'jeszcze', 'bardzo', 'mniej', 'wiecej', 'miedzy', 'przed',
]);
const fold = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase();
const stems = (value) =>
  [...new Set(fold(value).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((word) => word.length >= 4 && !STOPWORDS.has(word)).map((word) => (word.length > 5 ? word.slice(0, 5) : word)))];

const pickBlock = (label, blocks, used) => {
  const wanted = stems(label);
  let best = null;
  blocks.forEach((block, index) => {
    // Czołówka audycji (krótki tekst przy zerze) nie jest wejściem.
    if (used.has(index) || block.start < 30 || block.text.length < 50) return;
    const words = new Set(stems(block.text));
    const score = wanted.filter((stem) => words.has(stem)).length;
    if (score >= 2 && (!best || score > best.score)) best = { index, score };
  });
  return best?.index ?? null;
};

const prompt = (blocks, labels) =>
  [
    'Fragmenty audycji z czasem startu i początkiem wypowiedzi:',
    ...blocks.map((block, index) => `${index + 1}. [${Math.round(block.start)} s] ${block.text.slice(0, 180)}`),
    '',
    'Wejścia do przypisania (numer i etykieta):',
    ...labels.map((label, index) => `${index + 1}. ${label}`),
    '',
    'Zadanie: każdemu wejściu przypisz numer fragmentu, w którym prowadzący mówi o tej rzeczy.',
    'Każde wejście musi dostać dokładnie jeden fragment, a jeden fragment może obsłużyć najwyżej jedno wejście.',
    'Wybieraj fragment, w którym temat się zaczyna; nie zmieniaj etykiet ani nie twórz nowych.',
    '',
    'Odpowiedz wyłącznie JSON-em: {"assignments": [{"topic": 1, "block": 3}]}',
  ].join('\n');

const catalog = await readJson('data/catalog.json');
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const resolveId = (key) => {
  if (byKey.has(key)) return byKey.get(key).id;
  const matches = catalog.episodes.filter((entry) => entry.id.startsWith(key));
  if (matches.length === 1) return matches[0].id;
  throw new Error(matches.length > 1 ? `Niejednoznaczny prefiks ${key}` : `Nieznany odcinek ${key}`);
};

const reviewed = await readJson('data/reviewed.json').catch(() => ({ episodes: {} }));
const frozen = new Set(Object.keys(reviewed.episodes ?? {}));

let processed = 0;
let changed = 0;

for (const key of wanted) {
  if (limit > 0 && processed >= limit) break;
  const id = resolveId(key);
  if (frozen.has(id)) {
    console.error(`— ${id.slice(0, 8)}: odcinek z oznaczeniami „ok” — pomijam`);
    continue;
  }

  const episodePath = `data/episodes/${id}.json`;
  const episode = await readJson(episodePath);
  const transcript = await readJson(`data/transcripts/${id}.json`).catch(() => null);
  if (!transcript?.segments?.length) {
    console.error(`— ${id.slice(0, 8)}: brak transkryptu`);
    continue;
  }
  const topics = episode.topics ?? [];
  // Whisper transkrybuje też muzykę (halucynacje), więc bloki liczymy tylko
  // z segmentów poza blokami utworów — tak samo robi snap-topics.
  const trackSpans = (episode.tracks ?? []).map((track) => ({
    start: track.start,
    end: track.end ?? track.start + (track.durationSec ?? 0),
  }));
  const inTrack = (time) => trackSpans.some((span) => time >= span.start - 1 && time < span.end - 1);
  const speech = (transcript.segments ?? []).filter((segment) => !inTrack(segment.start));
  const transcriptSpeech = { ...transcript, segments: speech };
  const talks = speechBlocks(transcriptSpeech);
  // Jeden blok na kilka etykiet to za grubo — wtedy okna po ~2 minuty.
  const blocks = talks.length >= topics.length ? talks : speechChunks(transcriptSpeech);
  if (topics.length === 0 || blocks.length === 0) continue;

  processed += 1;
  const answer = await askJson(prompt(blocks, topics.map((topic) => topic.label)), {
    models: model,
    maxTokens: 800,
    temperature: 0,
  });

  const usedBlocks = new Set();
  const byTopic = new Map();
  for (const item of answer.data?.assignments ?? []) {
    const index = Number(item.topic) - 1;
    const block = Number(item.block) - 1;
    if (!topics[index] || !blocks[block] || byTopic.has(index) || usedBlocks.has(block)) continue;
    byTopic.set(index, block);
    usedBlocks.add(block);
  }
  for (let index = 0; index < topics.length; index += 1) {
    if (byTopic.has(index)) continue;
    const block = pickBlock(topics[index].label, blocks, usedBlocks);
    if (block === null) {
      console.log(`   bez dopasowania: ${topics[index].label}`);
      continue;
    }
    byTopic.set(index, block);
    usedBlocks.add(block);
  }

  const next = topics.map((topic, index) => ({
    ...topic,
    start: byTopic.has(index) ? blocks[byTopic.get(index)].start : topic.start,
  }));
  const starts = [...(episode.tracks ?? []).map((track) => track.start), ...next.map((topic) => topic.start)].sort(
    (left, right) => left - right
  );
  const endAfter = (start) => starts.find((value) => value > start) ?? episode.durationSec ?? start;
  const result = next
    .map((topic) => ({ ...topic, end: endAfter(topic.start) }))
    .sort((left, right) => left.start - right.start);

  let moved = 0;
  for (const topic of result) {
    const before = topics.find((old) => old.label === topic.label);
    if (!before || Math.abs(before.start - topic.start) < 0.5) continue;
    moved += 1;
    console.log(`   ${Math.round(before.start)} → ${Math.round(topic.start)} | ${topic.label}`);
  }
  console.log(`${write ? '+' : '·'} ${id.slice(0, 8)}: ${moved}/${topics.length} wejść na nowym miejscu`);

  if (!write || moved === 0) continue;
  episode.topics = result;
  await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
  changed += 1;
  if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
}

console.log(`\nOdcinków: ${processed}, zapisanych: ${changed}${write ? '' : ' (bez --write nic nie zapisano)'}`);
