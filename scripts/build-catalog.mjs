import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PROGRAM = {
  slug: 'ciezko-na-sercu',
  name: 'Ciężko na sercu',
  station: 'Trójka',
  pageUrl: 'https://www.polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644',
};

const ODCINEK_URL = `${PROGRAM.pageUrl}/odcinek`;

const PL_MAP = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => PL_MAP[c])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function sourceUrlFor(episode) {
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(episode.mp3Url ?? '');
  if (!uuid) return null;
  return `${ODCINEK_URL}/${slugify(episode.title)},${uuid[1]}`;
}

const [input, output = 'data/catalog.json'] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/build-catalog.mjs <downloader-episodes.json> [out]');
  process.exit(1);
}

const downloaded = JSON.parse(await readFile(input, 'utf8'));
const episodes = downloaded
  .filter((episode) => !episode.duplicateOf)
  .map((episode) => ({
    id: `${episode.date}-${slugify(episode.title)}`,
    date: episode.date,
    title: episode.title,
    articleId: episode.articleId ?? null,
    durationSec: null,
    sourceUrl: sourceUrlFor(episode),
    audioUrl: episode.mp3Url ? episode.mp3Url.replace(/^http:\/\//, 'https://') : null,
  }))
  .sort((a, b) => b.date.localeCompare(a.date));

const ids = new Set(episodes.map((episode) => episode.id));
if (ids.size !== episodes.length) throw new Error('duplicate episode ids in catalog');

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  program: PROGRAM,
  episodes,
};

await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(resolve(output), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`${episodes.length} odcinków -> ${output}`);
