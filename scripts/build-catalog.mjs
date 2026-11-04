import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PROGRAM = {
  slug: 'ciezko-na-sercu',
  name: 'Ciężko na sercu',
  station: 'Trójka',
  pageUrl: 'https://www.polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644',
};

const ODCINEK_URL = `${PROGRAM.pageUrl}/odcinek`;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const PL_MAP = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => PL_MAP[c])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/:/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function episodeId(episode) {
  const match = UUID.exec(episode.mp3Url ?? '');
  return match ? match[1].toLowerCase() : null;
}

export function sourceUrlFor(episode) {
  const uuid = UUID.exec(episode.mp3Url ?? '');
  if (!uuid) return null;
  return `${ODCINEK_URL}/${slugify(episode.title)},${uuid[1]}`;
}

// Sluga z poprzedniego katalogu zostają w historii, żeby stare adresy dalej działały
// po poprawce tytułu. Bez tego każda zmiana tytułu zabijałaby linki do odcinka.
async function previousSlugs(output) {
  try {
    const catalog = JSON.parse(await readFile(resolve(output), 'utf8'));
    const map = new Map();
    for (const episode of catalog.episodes) {
      // Katalogi sprzed zmiany kluczy miały id = slug; uuid z audioUrl łączy oba formaty.
      const id = episodeId({ mp3Url: episode.mp3Url ?? episode.audioUrl }) ?? episode.id;
      map.set(id, episode.slugs ?? [episode.slug ?? episode.id]);
    }
    return map;
  } catch {
    return new Map();
  }
}

const [input, output = 'data/catalog.json'] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/build-catalog.mjs <downloader-episodes.json> [out]');
  process.exit(1);
}

const downloaded = JSON.parse(await readFile(input, 'utf8'));
const known = await previousSlugs(output);

const episodes = downloaded
  .filter((episode) => !episode.duplicateOf)
  .map((episode) => {
    const id = episodeId(episode);
    if (!id) throw new Error(`odcinek bez uuid w mp3Url: ${episode.title}`);
    const slug = `${episode.date}-${slugify(episode.title)}`;
    const history = known.get(id) ?? [];
    return {
      id,
      slug,
      slugs: history.includes(slug) ? history : [slug, ...history],
      date: episode.date,
      title: episode.title,
      articleId: episode.articleId ?? null,
      durationSec: null,
      sourceUrl: sourceUrlFor(episode),
      audioUrl: episode.mp3Url ? episode.mp3Url.replace(/^http:\/\//, 'https://') : null,
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date));

const ids = new Set(episodes.map((episode) => episode.id));
if (ids.size !== episodes.length) throw new Error('duplicate episode ids in catalog');

const slugs = new Set();
for (const episode of episodes) {
  for (const slug of episode.slugs) {
    if (slugs.has(slug)) throw new Error(`slug ${slug} należy do dwóch odcinków`);
    slugs.add(slug);
  }
}

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  program: PROGRAM,
  episodes,
};

await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(resolve(output), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`${episodes.length} odcinków -> ${output}`);
