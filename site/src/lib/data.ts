import { duplicatesSchema } from './schema';
import { mergeEpisode } from './merge';
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

export async function getEpisodeFiles(): Promise<Map<string, Episode>> {
  const names = (await readdir(EPISODES_DIR)).filter((name) => name.endsWith('.json'));
  const episodes = await Promise.all(names.map((name) => load(join(EPISODES_DIR, name), episodeSchema)));
  const [overrides, aliases, types] = await Promise.all([getOverrides(), getAliases(), getTagTypes()]);
  for (const episode of episodes) mergeEpisode(episode, { override: overrides.get(episode.id), aliases, types });
  return new Map(episodes.map((episode) => [episode.id, episode]));
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
