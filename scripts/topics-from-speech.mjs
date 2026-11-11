#!/usr/bin/env node
// Wejścia ("tematy") z bloków mowy: bez transkryptu i bez analizy mówców.
// Między utworami zawsze jest mowa prowadzącego, więc bierzemy każdą lukę w muzyce
// i wycinamy z niej bloki mowy; etykiety dorabia później `enrich` z transkryptu.
//
// Użycie:
//   node scripts/topics-from-speech.mjs --episode <uuid> --spans speech-spans.json [--write] [--min 20]

import { readFile, writeFile } from 'node:fs/promises';

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

const id = args.get('episode');
const spansPath = args.get('spans');
const write = args.has('write');
const minSpeech = Number.parseFloat(args.get('min') ?? '25') || 25;
// Cisza dłuższa niż tyle sekund to najpewniej nieznana muzyka (Shazam jej nie rozpoznał),
// a nie pauza w wypowiedzi — wtedy wejście trzeba rozciąć.
const splitPause = Number.parseFloat(args.get('pause') ?? '25') || 25;

if (!id || !spansPath) {
  console.error('Podaj --episode <uuid> i --spans <speech-spans.json>');
  process.exit(1);
}

const round = (value) => Math.round(value * 100) / 100;

const episodePath = `data/episodes/${id}.json`;
const episode = JSON.parse(await readFile(episodePath, 'utf8'));
const spans = JSON.parse(await readFile(spansPath, 'utf8'));

const duration = episode.durationSec ?? spans.durationSec;
if (!duration) {
  console.error('Nieznana długość nagrania.');
  process.exit(1);
}

const music = [...(episode.tracks ?? [])]
  .map((track) => ({ start: track.start, end: track.end ?? track.start + (track.durationSec ?? 0) }))
  .filter((track) => track.end > track.start)
  .sort((left, right) => left.start - right.start);

// Luki w muzyce: od 0 do pierwszego utworu, między utworami i po ostatnim.
const gaps = [];
let cursor = 0;
for (const track of music) {
  if (track.start - cursor > 0) gaps.push({ start: cursor, end: track.start });
  cursor = Math.max(cursor, track.end);
}
if (duration - cursor > 0) gaps.push({ start: cursor, end: duration });

const spoken = (spans.spans ?? []).filter((span) => span.end > span.start);

const topics = [];
for (const gap of gaps) {
  const inside = spoken.filter((span) => span.end > gap.start && span.start < gap.end);
  if (inside.length === 0) continue;
  const speechSec = inside.reduce(
    (sum, span) => sum + (Math.min(span.end, gap.end) - Math.max(span.start, gap.start)),
    0
  );
  if (speechSec < minSpeech) continue;
  // Grupujemy bloki mowy w wypowiedzi: dłuższa przerwa kończy wejście.
  let group = { start: round(Math.max(gap.start, inside[0].start)), end: round(inside[0].end), label: '' };
  const groups = [];
  for (const span of inside.slice(1)) {
    if (span.start - group.end > splitPause) {
      groups.push(group);
      group = { start: round(span.start), end: round(span.end), label: '' };
      continue;
    }
    group.end = round(Math.min(gap.end, span.end));
  }
  groups.push(group);
  topics.push(...groups.filter((item) => item.end - item.start >= minSpeech));
}

// Wejścia nie mogą na siebie nachodzić ani wychodzić poza nagranie.
const cleaned = [];
for (const topic of topics.sort((left, right) => left.start - right.start)) {
  const previous = cleaned.at(-1);
  if (previous && topic.start < previous.end) previous.end = topic.start;
  if (topic.end - topic.start < minSpeech) continue;
  cleaned.push(topic);
}

console.log(`${id}: ${music.length} utworów, ${gaps.length} luk, ${cleaned.length} wejść`);
for (const topic of cleaned) {
  const minutes = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  console.log(`   ${minutes(topic.start)}–${minutes(topic.end)} (${Math.round(topic.end - topic.start)} s)`);
}

if (!write) {
  console.log('Bez --write nic nie zapisano.');
  process.exit(0);
}

episode.topics = cleaned;
await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
console.log(`zapisane: ${episodePath}`);
