#!/usr/bin/env node
/**
 * Rozbija zlepione tagi na pojedyncze byty.
 *
 * Import z taggera zapisuje kolaboracje („A & B”), składy koncertów („A + B / C”)
 * i nazwy festiwali („X / Y”) jako jedną etykietę, więc indeks tagów pokazuje
 * zespoły-zbiorczości. Skrypt przechodzi po `data/episodes` i zapisuje wynik tej
 * samej funkcji, której używa strona (`splitTags`), więc dane i render się zgadzają.
 *
 *   node scripts/fix-tags.mjs [--write] [--episodes <id|slug,...>] [--limit N]
 */
import { readFile, writeFile } from 'node:fs/promises';

import { splitTags } from '../src/lib/tags.ts';

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

const write = args.has('write');
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
const wanted = String(args.get('episodes') ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const catalog = await readJson('data/catalog.json');
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const ids = wanted.length
  ? wanted.map((key) => {
      if (byKey.has(key)) return byKey.get(key).id;
      const matches = catalog.episodes.filter((entry) => entry.id.startsWith(key));
      if (matches.length === 1) return matches[0].id;
      throw new Error(matches.length > 1 ? `Niejednoznaczny prefiks ${key}` : `Nieznany odcinek ${key}`);
    })
  : catalog.episodes.map((entry) => entry.id);

let processed = 0;
let changed = 0;
let removed = 0;
let added = 0;

for (const id of ids) {
  if (limit > 0 && processed >= limit) break;
  const path = `data/episodes/${id}.json`;
  const episode = await readJson(path);
  const before = episode.tags ?? [];
  const after = splitTags(before);
  processed += 1;

  const same = before.length === after.length && before.every((tag, index) => tag.id === after[index].id && tag.label === after[index].label);
  if (same) continue;

  changed += 1;
  added += Math.max(0, after.length - before.length);
  removed += Math.max(0, before.length - after.length);
  console.log(`${write ? '+' : '·'} ${id.slice(0, 8)}: ${before.length} → ${after.length} tagów`);
  for (const tag of after) {
    if (before.some((old) => old.id === tag.id && old.label === tag.label)) continue;
    console.log(`   ${tag.label}`);
  }
  if (!write) continue;
  episode.tags = after;
  await writeFile(path, `${JSON.stringify(episode, null, 2)}\n`);
}

console.log(
  `\nOdcinków: ${processed}, zmienionych: ${changed}` +
    (added || removed ? `, tagów +${added}/-${removed}` : '') +
    (write ? '' : ' (bez --write nic nie zapisano)')
);
