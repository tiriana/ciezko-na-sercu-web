// Musi odpowiadać TAG_TYPES/TAG_SOURCES w src/lib/schema.ts.
const TAG_TYPES = ['artist', 'person', 'work', 'event', 'concert', 'place', 'theme', 'editorial'];
const TAG_SOURCES = ['tracks', 'credits', 'transcript', 'profile'];

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { aliasesSchema, catalogSchema, episodeSchema, peopleSchema, titlesSchema } from '../src/lib/schema.ts';

const DATA = 'data';
const EPISODES = join(DATA, 'episodes');

const problems = [];
const staleTimeline = [];

const foldName = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Ta sama logika co w taggerze: dopuszczamy dwa znaki różnicy, ale tylko przy nazwach
// o podobnej długości, żeby krótkie słowa nie łapały się przypadkiem.
const similarNames = (left, right) => {
  const a = foldName(left);
  const b = foldName(right);
  if (Math.abs(a.length - b.length) > 2) return false;
  return distance(a, b) <= 2;
};

const distance = (left, right) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const saved = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return previous[right.length];
};

const catalog = catalogSchema.parse(JSON.parse(await readFile(join(DATA, 'catalog.json'), 'utf8')));
const titles = titlesSchema.parse(JSON.parse(await readFile(join(DATA, 'titles.json'), 'utf8')));
const { aliases, types: tagTypes, dismissed } = aliasesSchema.parse(JSON.parse(await readFile(join(DATA, 'aliases.json'), 'utf8')));

const resolveAlias = (label) => {
  let current = label;
  for (let step = 0; step < 5; step++) {
    const next = aliases[current];
    if (!next || next === current) break;
    current = next;
  }
  return current;
};

// Etykiety spotkane w danych: tagi i nazwy w creditsach. Alias musi wskazywać na jedną z nich,
// inaczej literówka w aliasie cicho rozjedzie tag na dwa.
const knownLabels = new Set();
const TAG_TYPE_OF = new Map();

const ids = new Set();
const slugs = new Map();
for (const episode of catalog.episodes) {
  if (ids.has(episode.id)) problems.push(`duplikat id: ${episode.id}`);
  ids.add(episode.id);
  if (!episode.slugs.includes(episode.slug)) {
    problems.push(`${episode.id}: slug ${episode.slug} nie występuje w slugs[]`);
  }
  for (const slug of episode.slugs) {
    if (slugs.has(slug)) problems.push(`slug ${slug} należy do ${slugs.get(slug)} i ${episode.id}`);
    slugs.set(slug, episode.id);
  }
}

for (const name of await readdir(EPISODES)) {
  if (!name.endsWith('.json')) continue;
  const id = name.slice(0, -5);
  const episode = episodeSchema.parse(JSON.parse(await readFile(join(EPISODES, name), 'utf8')));
  if (episode.id !== id) problems.push(`${name}: pole id to ${episode.id}`);
  if (!ids.has(id)) problems.push(`${name}: opracowanie bez odcinka w katalogu`);

  // Dwie formy tego samego nazwiska w jednej roli to zwykle błąd transkrypcji;
  // tagger scala je sam, więc tutaj tylko ostrzegamy o danych sprzed poprawki.
  for (const credit of episode.credits) knownLabels.add(credit.name);
  for (const tag of episode.tags) {
    knownLabels.add(tag.label);
    TAG_TYPE_OF.set(tag.label, tag.type);
  }

  const seenPairs = new Set();
  for (const credit of episode.credits) {
    for (const other of episode.credits) {
      if (credit === other || credit.role !== other.role || credit.name === other.name) continue;
      if (resolveAlias(credit.name) === resolveAlias(other.name)) continue;
      if (!similarNames(credit.name, other.name)) continue;
      const pair = [credit.name, other.name].sort().join('|');
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      problems.push(`${name}: prawdopodobnie ta sama osoba w roli ${credit.role}: „${credit.name}" i „${other.name}"`);
    }
  }

  const tagIds = new Set();
  for (const tag of episode.tags) {
    if (!/^[a-z0-9-]+$/.test(tag.id)) problems.push(`${name}: tag o nieprawidłowym id: ${tag.id}`);
    if (!TAG_TYPES.includes(tag.type)) problems.push(`${name}: tag ${tag.id} ma nieznany typ: ${tag.type}`);
    if (!TAG_SOURCES.includes(tag.source)) problems.push(`${name}: tag ${tag.id} ma nieznane źródło: ${tag.source}`);
    if (tagIds.has(tag.id)) problems.push(`${name}: duplikat tagu ${tag.id}`);
    tagIds.add(tag.id);
  }

  // Pozycje programu muszą być rozłączne — ale tylko w danych po uzgadnianiu osi
  // (issue #10). Starsze opracowania nie mają pól `end`, więc ich nakładanie jest
  // znanym skutkiem i liczymy je zbiorczo, zamiast blokować build.
  const reconciled = episode.topics.length === 0 || episode.topics.every((topic) => topic.end !== undefined);
  if (!reconciled) staleTimeline.push(name);

  const positions = reconciled
    ? [
        ...episode.tracks.map((track) => ({ start: track.start, end: track.end ?? track.start + track.durationSec })),
        ...episode.topics.map((topic) => ({ start: topic.start, end: topic.end ?? topic.start })),
      ].sort((left, right) => left.start - right.start)
    : [];

  for (let index = 1; index < positions.length; index++) {
    const previous = positions[index - 1];
    const current = positions[index];
    if (current.start < previous.end - 1) {
      problems.push(
        `${name}: pozycje programu nachodzą na siebie (${previous.start}-${previous.end} vs ${current.start}-${current.end})`
      );
    }
  }
}

const TRANSCRIPTS = join(DATA, 'transcripts');
const transcriptFiles = await readdir(TRANSCRIPTS).catch(() => []);
const transcriptIds = new Set();
for (const name of transcriptFiles) {
  if (!name.endsWith('.json')) continue;
  const id = name.slice(0, -5);
  transcriptIds.add(id);
  if (!ids.has(id)) problems.push(`transcripts/${name}: transkrypt bez odcinka w katalogu`);
  const transcript = JSON.parse(await readFile(join(TRANSCRIPTS, name), 'utf8'));
  if (transcript.episodeId !== id) problems.push(`transcripts/${name}: pole episodeId to ${transcript.episodeId}`);
  if (!Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    problems.push(`transcripts/${name}: brak segmentów`);
  }
}

for (const name of transcriptFiles) {
  if (!name.endsWith('.txt')) continue;
  const id = name.slice(0, -4);
  if (!transcriptIds.has(id)) problems.push(`transcripts/${name}: .txt bez odpowiadającego .json`);
}

const people = await readFile(join(DATA, 'people.json'), 'utf8')
  .then((raw) => peopleSchema.parse(JSON.parse(raw)).people)
  .catch(() => ({}));

const usedNames = new Set();
for (const name of await readdir(EPISODES)) {
  if (!name.endsWith('.json')) continue;
  const episode = JSON.parse(await readFile(join(EPISODES, name), 'utf8'));
  for (const credit of episode.credits ?? []) usedNames.add(credit.name);
}

for (const name of Object.keys(people)) {
  if (!usedNames.has(name)) problems.push(`people.json: wpis dla osoby bez creditsów: ${name}`);
}

for (const id of Object.keys(titles.titles)) {
  if (!ids.has(id)) problems.push(`titles.json: tytuł dla nieznanego odcinka ${id}`);
}

const duplicates = await readFile(join(DATA, 'duplicates.json'), 'utf8')
  .then((raw) => JSON.parse(raw).duplicates ?? {})
  .catch(() => ({}));

for (const [id, entry] of Object.entries(duplicates)) {
  if (!ids.has(id)) problems.push(`duplicates.json: ukryty odcinek ${id} nie istnieje w katalogu`);
  if (!ids.has(entry.of)) problems.push(`duplicates.json: ${id} wskazuje na nieistniejący odcinek ${entry.of}`);
  if (duplicates[entry.of]) problems.push(`duplicates.json: ${id} wskazuje na inny ukryty odcinek ${entry.of}`);
  if (id === entry.of) problems.push(`duplicates.json: ${id} wskazuje sam na siebie`);
}

// Ten sam byt bywa zapisany raz krótko, raz z pełnym imieniem („Vogg" / „Wacław Vogg Kiełtyka").
// Zgadujemy tylko wśród osób i tylko po całym słowie — inaczej „Master" trafia w „Devil Master".
const words = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const personLabels = [...knownLabels].filter((label) => TAG_TYPE_OF.get(label) === 'person' && resolveAlias(label) === label);
const isDismissed = (from, to) => dismissed.some((pair) => pair.from === from && pair.to === to);
const aliasCandidates = [];
for (const shorter of personLabels) {
  for (const longer of personLabels) {
    if (longer.length <= shorter.length + 3) continue;
    if (!` ${words(longer)} `.includes(` ${words(shorter)} `)) continue;
    if (isDismissed(shorter, longer)) continue;
    aliasCandidates.push(`„${shorter}” ⊂ „${longer}”`);
  }
}

const unknownTargets = [];
for (const [alias, target] of Object.entries(aliases)) {
  if (alias === target) problems.push(`alias ${alias} wskazuje sam na siebie`);
  if (!knownLabels.has(target)) unknownTargets.push(`${alias} -> ${target}`);
}
for (const label of Object.keys(tagTypes)) {
  if (!knownLabels.has(label)) problems.push(`types: nie ma etykiety ${label}`);
}

if (unknownTargets.length > 0) {
  console.log(`${unknownTargets.length} aliasów tworzy nową etykietę (zamierzona zmiana nazwy, nie literówka?):`);
  for (const item of unknownTargets) console.log(`  - ${item}`);
}

if (problems.length > 0) {
  console.error(`Dane niespójne (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (staleTimeline.length > 0) {
  console.log(
    `${staleTimeline.length} opracowań ma dane sprzed uzgadniania osi programu — przelicz \`rat tag\`, ` +
      'żeby czasy wejść i utworów przestały się nakładać.'
  );
}

if (aliasCandidates.length > 0) {
  console.log(`${aliasCandidates.length} par etykiet wygląda na ten sam byt (do rozważenia w data/aliases.json):`);
  for (const candidate of aliasCandidates.slice(0, 10)) console.log(`  - ${candidate}`);
}

console.log(
  `Dane spójne: ${catalog.episodes.length} odcinków, ${slugs.size} slugów, ` +
    `${Object.keys(titles.titles).length} tytułów redakcyjnych, ${transcriptIds.size} transkryptów`
);
