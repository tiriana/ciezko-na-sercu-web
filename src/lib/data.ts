import { readFile, readdir } from 'node:fs/promises';
import type { z } from 'zod';
import { join } from 'node:path';

import {
  catalogSchema,
  episodeSchema,
  overrideSchema,
  titlesSchema,
  type Catalog,
  type CatalogEpisode,
  type Episode,
  type TitleOverride,
} from './schema';

const DATA_DIR = join(process.cwd(), 'data');
const EPISODES_DIR = join(DATA_DIR, 'episodes');
const OVERRIDES_DIR = join(DATA_DIR, 'overrides');

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
    }
  }
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

export async function getTitles(): Promise<Record<string, TitleOverride>> {
  const data = await load(join(DATA_DIR, 'titles.json'), titlesSchema);
  return data.titles;
}

export async function getEntries(): Promise<Entry[]> {
  const [catalog, files, titles] = await Promise.all([getCatalog(), getEpisodeFiles(), getTitles()]);
  return catalog.episodes.map((episode) => {
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
