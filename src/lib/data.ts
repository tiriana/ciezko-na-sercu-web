import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { catalogSchema, episodeSchema, type Catalog, type CatalogEpisode, type Episode } from './schema';

const DATA_DIR = join(process.cwd(), 'data');
const EPISODES_DIR = join(DATA_DIR, 'episodes');

type Entry = CatalogEpisode & { enriched: boolean };

let catalogCache: Catalog | undefined;

export async function getCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache;
  catalogCache = await load(join(DATA_DIR, 'catalog.json'), catalogSchema);
  return catalogCache;
}

export async function getEpisodeFiles(): Promise<Map<string, Episode>> {
  const names = (await readdir(EPISODES_DIR)).filter((name) => name.endsWith('.json'));
  const episodes = await Promise.all(names.map((name) => load(join(EPISODES_DIR, name), episodeSchema)));
  return new Map(episodes.map((episode) => [episode.id, episode]));
}

export async function getEntries(): Promise<Entry[]> {
  const [catalog, files] = await Promise.all([getCatalog(), getEpisodeFiles()]);
  return catalog.episodes.map((episode) => ({ ...episode, enriched: files.has(episode.id) }));
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
