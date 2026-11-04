import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { catalogSchema, episodeSchema, titlesSchema } from '../src/lib/schema.ts';

const DATA = 'data';
const EPISODES = join(DATA, 'episodes');

const problems = [];

const catalog = catalogSchema.parse(JSON.parse(await readFile(join(DATA, 'catalog.json'), 'utf8')));
const titles = titlesSchema.parse(JSON.parse(await readFile(join(DATA, 'titles.json'), 'utf8')));

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
}

for (const id of Object.keys(titles.titles)) {
  if (!ids.has(id)) problems.push(`titles.json: tytuł dla nieznanego odcinka ${id}`);
}

if (problems.length > 0) {
  console.error(`Dane niespójne (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Dane spójne: ${catalog.episodes.length} odcinków, ${slugs.size} slugów, ${Object.keys(titles.titles).length} tytułów redakcyjnych`);
