#!/usr/bin/env node
// Radio publikuje odcinek z tytułem technicznym, a redakcja podmienia go na własny
// kilka dni albo tygodni później. Ten krok sprawdza świeże odcinki i przenosi tytuł
// redakcyjny do katalogu, żeby dało się go pokazać na stronie.
//
//   node scripts/refresh-titles.mjs [--days 31] [--dry-run]
//
// Starych odcinków nie ruszamy: ich tytuły się nie zmieniają, a każda zmiana
// przestawiłaby slug.

import { readFile, writeFile } from 'node:fs/promises';

import { isTechnicalTitle } from '../src/lib/titles.ts';
import { readMetadata } from './fetch-episode-metadata.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    index += 1;
  } else args.set(token.slice(2), 'true');
}

const days = Number.parseInt(args.get('days') ?? '31', 10) || 31;
const dryRun = args.has('dry-run');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const catalog = await readJson('data/catalog.json');
const editorial = await readJson('data/catalog-titles.json').catch(() => ({ version: 1, titles: {} }));
editorial.titles = editorial.titles ?? {};
const unofficial = await readJson('data/titles.json').catch(() => ({ version: 1, titles: {} }));

const since = new Date();
since.setDate(since.getDate() - days);
const threshold = since.toISOString().slice(0, 10);

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (letter) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' })[letter])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const targets = catalog.episodes.filter(
  (entry) => entry.date >= threshold && isTechnicalTitle(entry.title) && !editorial.titles[entry.id]
);

console.log(`Odcinków do sprawdzenia: ${targets.length} (od ${threshold})`);
let changed = 0;

for (const entry of targets) {
  let metadata;
  try {
    metadata = await readMetadata(entry.id);
  } catch (error) {
    console.log(`— ${entry.slug}: ${error.message}`);
    continue;
  }
  if (!metadata.title || isTechnicalTitle(metadata.title) || metadata.title === entry.title) {
    console.log(`· ${entry.slug}: radio nadal bez tytułu redakcyjnego`);
    continue;
  }
  if (unofficial.titles?.[entry.id]) {
    console.log(`· ${entry.slug}: mamy już tytuł nieoficjalny — katalog zostaje`);
    continue;
  }

  const slug = `${entry.date}-${slugify(metadata.title)}`;
  entry.title = metadata.title;
  entry.slug = slug;
  entry.slugs = entry.slugs.includes(slug) ? entry.slugs : [slug, ...entry.slugs];
  entry.sourceUrl = metadata.sourceUrl ?? entry.sourceUrl;
  editorial.titles[entry.id] = metadata.title;
  changed += 1;
  console.log(`+ ${entry.date}: „${metadata.title}”`);
}

if (changed === 0) {
  console.log('Bez zmian.');
  process.exit(0);
}
if (dryRun) {
  console.log(`(próba) zmieniono by ${changed} tytułów`);
  process.exit(0);
}

await writeJson('data/catalog-titles.json', editorial);
await writeJson('data/catalog.json', catalog);
console.log(`Zmienionych tytułów: ${changed}`);
