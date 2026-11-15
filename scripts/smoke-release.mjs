#!/usr/bin/env node
/**
 * Test po publikacji: sprawdza, czy produkcja serwuje ten build, który właśnie powstał.
 * Wersja jest w `<meta name="version">` i w stopce, a każda zbudowana strona (odcinki,
 * tagi, o projekcie, strona główna) musi odpowiadać 200 z tytułem z `site/dist`.
 *
 * Powód istnienia: dotychczasowy test dymny sprawdzał trzy adresy i przechodził nawet
 * wtedy, gdy większość stron zwracała 404 — świeżo wgrany deployment potrzebuje czasu,
 * zanim adres produkcyjny zacznie go serwować, a cache brzegowy trzyma stare odpowiedzi.
 * Dlatego nieudane sprawdzenia są powtarzane, a porównanie idzie z plikiem z builda,
 * więc brak strony albo stara wersja to błąd.
 *
 * Użycie: node scripts/smoke-release.mjs [--base https://…] [--limit N] [--rounds N]
 * Kody wyjścia: 0 = produkcja zgodna z buildem, 1 = nadal się nie zgadza.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = argOf('base', process.env.BASE_URL ?? 'https://ciezko-na-sercu.pages.dev').replace(/\/+$/, '');
const DIST = argOf('dist', 'site/dist');
const LIMIT = Number(argOf('limit', '0')) || Infinity;
const ROUNDS = Number(argOf('rounds', process.env.SMOKE_ROUNDS ?? '10')) || 10;
const PAUSE_MS = Number(argOf('pause', process.env.SMOKE_PAUSE ?? '15000')) || 15000;
const CONCURRENCY = 8;

const failures = new Map();

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
};

const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';

// Nagłówek zamiast parametru w adresie: parametr zmienia klucz cache, a część konfiguracji
// brzegowej odpowiada na taki adres inaczej niż na samą stronę.
const get = async (path) => {
  const response = await fetch(`${BASE}${path}`, { headers: { 'cache-control': 'no-cache' } });
  return { status: response.status, body: await response.text() };
};

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;

const checkHome = async () => {
  const problems = [];
  let home;
  try {
    home = await get('/');
  } catch (error) {
    return [`/: sieć: ${error.message}`];
  }
  if (home.status !== 200) return [`/: HTTP ${home.status}`];

  const meta = home.body.match(/<meta name="version" content="([^"]*)"/i)?.[1];
  if (meta !== version) problems.push(`/: meta version ${meta ?? 'brak'}, oczekiwano ${version}`);
  const footer = home.body.match(/releases\/tag\/v([0-9][^"]*)"/i)?.[1];
  if (footer !== version) problems.push(`/: stopka pokazuje ${footer ?? 'brak'}, oczekiwano ${version}`);
  const links = new Set([...home.body.matchAll(/href="(\/odcinki\/[^"#?]+)"/g)].map((match) => match[1]));
  if (links.size === 0) problems.push('/: brak linków do odcinków');
  return problems;
};

const files = await walk(DIST);
const pages = files
  .filter((file) => file.endsWith('index.html'))
  .map((file) => ({ path: `/${file.slice(DIST.length + 1, -'index.html'.length)}`, file }))
  .filter((page) => page.path !== '/')
  .sort((left, right) => left.path.localeCompare(right.path))
  .slice(0, LIMIT);

console.log(`Sprawdzam ${pages.length} stron na ${BASE} (build ${version}, do ${ROUNDS} podejść)`);

const titles = new Map();
for (const page of pages) titles.set(page.path, titleOf(await readFile(page.file, 'utf8')));

const checkPage = async (page) => {
  let result;
  try {
    result = await get(page.path);
  } catch (error) {
    return `sieć: ${error.message}`;
  }
  if (result.status !== 200) return `HTTP ${result.status}`;
  const expected = titles.get(page.path);
  const actual = titleOf(result.body);
  if (expected && actual !== expected) return `tytuł „${actual}”, oczekiwano „${expected}”`;
  return null;
};

const crawl = async (queue) => {
  const worker = async () => {
    for (;;) {
      const page = queue.shift();
      if (!page) return;
      const problem = await checkPage(page);
      if (problem) failures.set(page.path, problem);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
};

let pending = pages;
for (let round = 1; round <= ROUNDS; round += 1) {
  failures.clear();
  for (const problem of await checkHome()) failures.set('/', problem);
  await crawl([...pending]);
  if (failures.size === 0) {
    console.log(`Produkcja zgodna z buildem ${version} (podejście ${round}).`);
    process.exit(0);
  }
  // Kolejne podejście pyta tylko o strony, które się nie zgodziły — reszta już przeszła.
  pending = pages.filter((page) => failures.has(page.path));
  console.log(
    `Podejście ${round}/${ROUNDS}: ${failures.size} stron się nie zgadza — czekam ${Math.round(PAUSE_MS / 1000)} s`
  );
  if (round < ROUNDS) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
}

console.error(`Produkcja NIE zgadza się z buildem ${version} (${failures.size} błędów):`);
for (const failure of [...failures.values()].slice(0, 40)) console.error(`  - ${failure}`);
if (failures.size > 40) console.error(`  … i ${failures.size - 40} więcej`);
process.exit(1);
