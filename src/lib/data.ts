import { duplicatesSchema } from './schema';
import { tagId } from './tags';
import { readFile, readdir } from 'node:fs/promises';
import type { z } from 'zod';
import { join } from 'node:path';

import {
  aliasesSchema,
  catalogSchema,
  episodeSchema,
  overrideSchema,
  peopleSchema,
  titlesSchema,
  transcriptSchema,
  type Aliases,
  type TagTypes,
  type Catalog,
  type CatalogEpisode,
  type Episode,
  type Person,
  type TitleOverride,
  type Transcript,
} from './schema';

const DATA_DIR = join(process.cwd(), 'data');
const EPISODES_DIR = join(DATA_DIR, 'episodes');
const OVERRIDES_DIR = join(DATA_DIR, 'overrides');
const TRANSCRIPTS_DIR = join(DATA_DIR, 'transcripts');

type Entry = CatalogEpisode & {
  enriched: boolean;
  displayTitle: string;
  titleKind: 'official' | 'technical' | 'unofficial';
  titleNote?: string;
};

const TECHNICAL_TITLE = /^Ciężko na sercu .*godz\.? \d{4}$/;

let catalogCache: Catalog | undefined;

export async function getCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache;
  catalogCache = await load(join(DATA_DIR, 'catalog.json'), catalogSchema);
  return catalogCache;
}

// Porównujemy po NFC: ten sam tytuł bywa zapisany raz z literą złożoną, raz rozłożoną
// (ö jako jeden znak albo o + diakrytyk), a to ta sama nazwa.
const normalizeText = (value: string) => value.normalize('NFC').trim().toLowerCase();

// Pole niepodane w poprawce nie zawęża dopasowania — inaczej każda korekta startu
// musiałaby powtarzać album, którego nie chcemy ruszać.
const sameText = (left: string | null, right: string | undefined) =>
  right === undefined || normalizeText(left ?? '') === normalizeText(right);

export async function getEpisodeFiles(): Promise<Map<string, Episode>> {
  const names = (await readdir(EPISODES_DIR)).filter((name) => name.endsWith('.json'));
  const episodes = await Promise.all(names.map((name) => load(join(EPISODES_DIR, name), episodeSchema)));
  const overrides = await getOverrides();
  for (const episode of episodes) {
    const override = overrides.get(episode.id);
    if (!override) continue;
    for (const fix of override.tracks) {
      const track = episode.tracks.find(
        (candidate) => sameText(candidate.artist, fix.artist) && sameText(candidate.title, fix.title) && sameText(candidate.album, fix.album)
      );
      if (!track) continue;
      if (fix.start !== undefined) track.start = fix.start;
      if (fix.durationSec !== undefined) track.durationSec = fix.durationSec;
      if (fix.end !== undefined) track.end = fix.end;
      if (fix.newArtist !== undefined) track.artist = fix.newArtist;
      if (fix.newTitle !== undefined) track.title = fix.newTitle;
      if (fix.newAlbum !== undefined) track.album = fix.newAlbum;
    }

    if (override.tracks.some((fix) => fix.hide)) {
      episode.tracks = episode.tracks.filter(
        (track) =>
          !override.tracks.some(
            (fix) =>
              fix.hide &&
              sameText(track.artist, fix.artist) &&
              sameText(track.title, fix.title) &&
              sameText(track.album, fix.album) &&
              // Ten sam utwór bywa rozpoznany dwa razy (Shazam); `start` zawęża ukrycie
              // do jednego wystąpienia, gdy poprawka go podaje.
              (fix.start === undefined || Math.abs(track.start - fix.start) < 0.01)
          )
      );
    }

    if (override.addTopics.length > 0) {
      episode.topics.push(
        ...override.addTopics.map((topic) => ({ start: topic.start, label: topic.label, ...(topic.end !== undefined ? { end: topic.end } : {}) }))
      );
      episode.topics.sort((left, right) => left.start - right.start);
    }

    for (const fix of override.topics) {
      const topic = episode.topics.find((candidate) => candidate.start === fix.time && sameText(candidate.label, fix.label));
      if (!topic) continue;
      if (fix.start !== undefined) topic.start = fix.start;
      if (fix.end !== undefined) topic.end = fix.end;
      if (fix.newLabel) topic.label = fix.newLabel;
    }
    if (override.addTracks.length > 0) {
      episode.tracks.push(
        ...override.addTracks.map((track) => ({
          artist: track.artist,
          title: track.title,
          album: track.album ?? null,
          start: track.start,
          end: track.end ?? (track.durationSec ? track.start + track.durationSec : undefined),
          durationSec: track.durationSec,
          ...(track.unrecognized ? { unrecognized: true } : {}),
        }))
      );
      episode.tracks.sort((left, right) => left.start - right.start);
    }

    if (override.topics.some((fix) => fix.hide)) {
      episode.topics = episode.topics.filter(
        (topic) => !override.topics.some((fix) => fix.hide && fix.time === topic.start && sameText(topic.label, fix.label))
      );
    }

    const rename = override.credits.rename;
    if (override.credits.replace) {
      episode.credits = override.credits.replace.map((credit) => ({ ...credit }));
    } else if (Object.keys(rename).length > 0) {
      episode.credits = episode.credits.map((credit) => ({ ...credit, name: rename[credit.name] ?? credit.name }));
    }
  }
  const aliases = await getAliases();
  const types = await getTagTypes();
  if (Object.keys(aliases).length > 0 || Object.keys(types).length > 0) {
    for (const episode of episodes) {
      episode.tags = mergeAliases(episode.tags, aliases, types);
      episode.credits = episode.credits.map((credit) => ({ ...credit, name: resolveAlias(credit.name, aliases) }));
    }
  }
  for (const episode of episodes) sanitizeEpisode(episode);
  return new Map(episodes.map((episode) => [episode.id, episode]));
}

// Shazam czasem nie zna wykonawcy ("None") albo dzieli ten sam utwór na dwa bloki.
// Bez tego na stronie widać „None" i dwa razy ten sam tytuł pod rząd.
function sanitizeEpisode(episode: Episode): void {
  episode.tags = episode.tags.filter((tag) => tag.label !== 'None' && tag.label !== 'null');
  episode.tracks = episode.tracks.map((track) => ({
    ...track,
    artist: track.artist && track.artist !== 'None' && track.artist !== 'null' ? track.artist : null,
  }));

  const merged: Episode['tracks'] = [];
  for (const track of episode.tracks) {
    const previous = merged.at(-1);
    const sameTrack =
      previous &&
      previous.artist === track.artist &&
      previous.title === track.title &&
      previous.album === track.album &&
      previous.end !== undefined &&
      Math.abs(previous.end - track.start) <= 1;
    if (sameTrack) {
      previous.end = track.end;
      previous.durationSec = (previous.durationSec ?? 0) + (track.durationSec ?? 0);
      continue;
    }
    merged.push(track);
  }
  episode.tracks = merged;

  // Temat bez długości to punkt: rozciągamy go do następnego tematu, żeby nie renderował „—”.
  episode.topics = episode.topics.filter((topic, index, all) => {
    if (topic.end === undefined || topic.end > topic.start) return true;
    const next = all[index + 1];
    if (next && next.start > topic.start) {
      topic.end = next.start;
      return true;
    }
    return false;
  });
}

// Po podstawieniu kanonicznej etykiety dwa tagi mogą się zlać w jeden: zostaje pierwszy,
// a czas wejścia z drugiego wypełnia lukę, jeśli pierwszy go nie miał.
function mergeAliases(tags: Episode['tags'], aliases: Aliases, types: TagTypes): Episode['tags'] {
  const merged = new Map<string, Episode['tags'][number]>();
  for (const tag of tags) {
    const label = resolveAlias(tag.label, aliases);
    const id = label === tag.label ? tag.id : tagId(label);
    const type = types[label] ?? tag.type;
    const current = merged.get(id);
    if (!current) {
      merged.set(id, { ...tag, id, label, type });
      continue;
    }
    if (current.at === undefined && tag.at !== undefined) current.at = tag.at;
  }
  return [...merged.values()];
}

async function getOverrides(): Promise<Map<string, z.infer<typeof overrideSchema>>> {
  let names: string[];
  try {
    names = (await readdir(OVERRIDES_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return new Map();
  }
  const loaded = await Promise.all(
    names.map(async (name) => [name.replace(/\.json$/, ''), await load(join(OVERRIDES_DIR, name), overrideSchema)] as const)
  );
  return new Map(loaded);
}

let transcriptsCache: Map<string, Transcript> | undefined;

export async function getTranscripts(): Promise<Map<string, Transcript>> {
  if (transcriptsCache) return transcriptsCache;
  const names = (await readdir(TRANSCRIPTS_DIR)).filter((name) => name.endsWith('.json'));
  const loaded = await Promise.all(
    names.map(async (name) => [name.replace(/\.json$/, ''), await load(join(TRANSCRIPTS_DIR, name), transcriptSchema)] as const)
  );
  transcriptsCache = new Map(loaded);
  return transcriptsCache;
}

let aliasesCache: Aliases | undefined;
let tagTypesCache: TagTypes | undefined;

export async function getTagTypes(): Promise<TagTypes> {
  if (tagTypesCache) return tagTypesCache;
  try {
    tagTypesCache = (await load(join(DATA_DIR, 'aliases.json'), aliasesSchema)).types;
  } catch {
    tagTypesCache = {};
  }
  return tagTypesCache;
}

export async function getAliases(): Promise<Aliases> {
  if (aliasesCache) return aliasesCache;
  try {
    aliasesCache = (await load(join(DATA_DIR, 'aliases.json'), aliasesSchema)).aliases;
  } catch {
    aliasesCache = {};
  }
  return aliasesCache;
}

// Warianty mogą wskazywać jeden na drugi („Vogg” -> „Vogg (Wojciech Kiełtyka)” -> pełne
// imię), więc idziemy łańcuchem. Limit chroni przed pętlą w danych.
const resolveAlias = (label: string, aliases: Aliases) => {
  let current = label;
  for (let step = 0; step < 5; step++) {
    const next = aliases[current];
    if (!next || next === current) break;
    current = next;
  }
  return current;
};

let peopleCache: Record<string, Person> | undefined;

export async function getPeople(): Promise<Record<string, Person>> {
  if (peopleCache) return peopleCache;
  try {
    const data = await load(join(DATA_DIR, 'people.json'), peopleSchema);
    peopleCache = data.people;
  } catch {
    // Brak pliku to nie błąd: bez niego creditsy renderują się jak dotąd, bez linków.
    peopleCache = {};
  }
  return peopleCache;
}

export async function getTitles(): Promise<Record<string, TitleOverride>> {
  const data = await load(join(DATA_DIR, 'titles.json'), titlesSchema);
  return data.titles;
}

let duplicatesCache: z.infer<typeof duplicatesSchema>['duplicates'] | undefined;

/** Odcinki ukryte: to samo nagranie w dwóch wpisach katalogu. */
export async function getDuplicates(): Promise<z.infer<typeof duplicatesSchema>['duplicates']> {
  if (duplicatesCache) return duplicatesCache;
  try {
    duplicatesCache = (await load(join(DATA_DIR, 'duplicates.json'), duplicatesSchema)).duplicates;
  } catch {
    duplicatesCache = {};
  }
  return duplicatesCache;
}

export async function getEntries(options: { includeHidden?: boolean } = {}): Promise<Entry[]> {
  const [catalog, files, titles, duplicates] = await Promise.all([
    getCatalog(),
    getEpisodeFiles(),
    getTitles(),
    getDuplicates(),
  ]);
  const visible = options.includeHidden
    ? catalog.episodes
    : catalog.episodes.filter((episode) => !duplicates[episode.id]);
  return visible.map((episode) => {
    const override = titles[episode.id];
    const technical = TECHNICAL_TITLE.test(episode.title);
    return {
      ...episode,
      enriched: files.has(episode.id),
      displayTitle: override?.title ?? episode.title,
      titleKind: override ? 'unofficial' : technical ? 'technical' : 'official',
      titleNote: override?.note,
    };
  });
}

async function load<T>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`brak pliku danych: ${path}`);
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`niepoprawne dane w ${path}: ${(error as Error).message}`);
  }
}
