#!/usr/bin/env node
/**
 * Porównuje listę odcinków ze strony audycji z katalogiem: nowe to te, których
 * w `data/catalog.json` jeszcze nie ma. Wynik trafia do `GITHUB_OUTPUT`.
 *
 * Symulacja (`SIMULATE=true`) zgłasza nowy odcinek także wtedy, gdy katalog jest
 * aktualny — pozwala przejść całą ścieżkę bez czekania na publikację.
 */

const SIMULATE = process.env.SIMULATE === 'true';
const catalogPath = process.argv[2] ?? 'data/catalog.json';
const fetchedPath = process.argv[3] ?? '.cache/episodes.json';

const { readFileSync, appendFileSync } = await import('node:fs');

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const fetched = JSON.parse(readFileSync(fetchedPath, 'utf8'));

if (!Array.isArray(fetched) || fetched.length === 0) {
  console.error('Pobrana lista odcinków jest pusta — nie zgaduję, kończę błędem.');
  process.exit(1);
}

const known = new Set(catalog.episodes.map((episode) => episode.id));
const fresh = fetched.filter((episode) => !known.has(episode.id));
const simulated = SIMULATE && fresh.length === 0;

const count = simulated ? 1 : fresh.length;
const titles = simulated
  ? ['(symulacja)']
  : fresh.map((episode) => `${episode.date} — ${episode.title}`);

const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT ?? '/dev/null', `${key}<<DETECT\n${value}\nDETECT\n`);

output('new', count > 0 ? 'true' : 'false');
output('count', String(count));
output('ids', simulated ? '' : fresh.map((episode) => episode.id).join(','));
output('titles', titles.join('\n'));

if (count === 0) {
  console.log(`Brak nowych odcinków (${fetched.length} na stronie, ${known.size} w katalogu).`);
} else if (simulated) {
  console.log('Symulacja: udaję nowy odcinek.');
} else {
  console.log(`Nowe odcinki: ${titles.join('; ')}`);
}
