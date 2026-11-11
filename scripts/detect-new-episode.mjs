#!/usr/bin/env node
/**
 * Porównuje listę odcinków ze strony audycji z katalogiem: nowe to te, których
 * w `data/catalog.json` jeszcze nie ma. Wynik trafia do `GITHUB_OUTPUT` jako
 * `state`: `new` (jest nowy odcinek), `known` (najnowszy wpis ze strony już jest
 * w katalogu) albo `waiting` (na stronie nic się nie zmieniło).
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

const newestDate = (list) => list.reduce((newest, episode) => (episode.date > newest ? episode.date : newest), '');
const siteNewest = newestDate(fetched);
const catalogNewest = newestDate(catalog.episodes);
const state = count > 0 ? 'new' : siteNewest > catalogNewest ? 'waiting' : 'known';

const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT ?? '/dev/null', `${key}<<DETECT\n${value}\nDETECT\n`);

output('state', state);
output('count', String(count));
output('ids', simulated ? '' : fresh.map((episode) => episode.id).join(','));
output('titles', titles.join('\n'));

if (state === 'new') {
  console.log(simulated ? 'Symulacja: udaję nowy odcinek.' : `Nowe odcinki: ${titles.join('; ')}`);
} else if (state === 'known') {
  console.log(`Najnowszy odcinek (${catalogNewest}) jest już w katalogu.`);
} else {
  console.log(`Strona ma wpis z ${siteNewest}, ale jego identyfikator jest już znany — czekam.`);
}
