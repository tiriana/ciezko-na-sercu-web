#!/usr/bin/env node
/**
 * Uzupełnia to, co da się wyliczyć bez modelu: wejścia z luk między utworami
 * (`topics-from-speech.mjs`) i tagi `artist` oraz `person`. Idempotentny: rusza tylko
 * odcinki bez wejść albo bez tagów, a odcinków z oznaczeniem „ok” nie dotyka.
 *
 *   node scripts/derive-gaps.mjs [--write] [--fallback]
 *
 * `--fallback` (po enrich) nadaje wejściom bez nazwy „Wejście N”; enrich i repair
 * traktują taką nazwę jak brak i próbują ją zastąpić opisem z kontekstu.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { tagId } from '../lib/tags.mjs';
import { frozenEpisodes } from './frozen.mjs';
import { introWindowStart, isIntro } from './lib/intro.mjs';

const write = process.argv.includes('--write');
const fallback = process.argv.includes('--fallback');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const catalog = readJson('data/catalog.json');
const frozen = frozenEpisodes();

const tagsOf = (episode) => {
  const found = new Map();
  for (const track of episode.tracks ?? []) {
    const label = String(track.artist ?? '').trim();
    if (!label || /#TODO|unrecognized/i.test(label)) continue;
    const id = tagId(label);
    if (id && !found.has(id)) found.set(id, { id, label, type: 'artist', source: 'tracks', at: track.start });
  }
  for (const credit of episode.credits ?? []) {
    const label = String(credit.name ?? '').trim();
    const id = tagId(label);
    if (id && !found.has(id)) found.set(id, { id, label, type: 'person', source: 'credits', at: credit.time });
  }
  return [...found.values()];
};

let changed = 0;
for (const entry of catalog.episodes) {
  const path = `data/episodes/${entry.id}.json`;
  if (frozen.has(entry.id) || !existsSync(path)) continue;

  let episode = readJson(path);
  if ((episode.tracks ?? []).length === 0) continue;

  const spans = `data/artifacts/${entry.id}/speech-spans.json`;
  if ((episode.topics ?? []).length === 0 && existsSync(spans)) {
    console.log(`+ ${entry.slug}: wejścia z luk między utworami`);
    if (write) {
      execFileSync('node', ['scripts/topics-from-speech.mjs', '--episode', entry.id, '--spans', spans, '--write'], { stdio: 'inherit' });
      episode = readJson(path);
      // Wejścia dopisane wcześniej przez profil głosu pokrywają się z wyliczonymi.
      const overridePath = `data/overrides/${entry.id}.json`;
      if (existsSync(overridePath)) {
        const override = readJson(overridePath);
        const overlaps = (item) => episode.topics.some((topic) => item.start < topic.end && item.end > topic.start);
        const kept = (override.addTopics ?? []).filter((item) => !overlaps(item));
        if (kept.length !== (override.addTopics ?? []).length) {
          override.addTopics = kept;
          writeJson(overridePath, override);
        }
      }
    }
    changed += 1;
  }

  // Wejście zaczyna się po intrze, nie na nim; ręcznie przesunięte wejścia (poprawka po `start`) zostają.
  const overridePath = `data/overrides/${entry.id}.json`;
  const override = existsSync(overridePath) ? readJson(overridePath) : {};
  const intro = (override.addTracks ?? []).find(isIntro);
  // Tylko świeże odcinki: starsze mają ręcznie ułożone wejścia, także krótkie fragmenty przy intrze.
  if (intro && entry.date >= introWindowStart()) {
    const introEnd = Math.round((intro.start + intro.durationSec) * 100) / 100;
    const edited = (topic) => (override.topics ?? []).some((fix) => Math.abs(Number(fix.start) - topic.start) < 0.5);
    const moved = (episode.topics ?? []).filter((topic) => topic.start < introEnd && !edited(topic));
    if (moved.length > 0) {
      console.log(`+ ${entry.slug}: ${moved.length} wejść przesuniętych za intro`);
      if (write) {
        episode.topics = episode.topics
          .map((topic) => (moved.includes(topic) ? { ...topic, start: introEnd } : topic))
          .filter((topic) => !(topic.end <= topic.start));
        writeJson(path, episode);
      }
      changed += 1;
    }
  }

  if (fallback) {
    const blank = (episode.topics ?? []).filter((topic) => !String(topic.label ?? '').trim());
    if (blank.length > 0) {
      console.log(`+ ${entry.slug}: ${blank.length} wejść z nazwą zastępczą`);
      if (write) {
        episode.topics.forEach((topic, index) => {
          if (blank.includes(topic)) topic.label = `Wejście ${index + 1}`;
        });
        writeJson(path, episode);
      }
      changed += 1;
    }
  }

  const tags = tagsOf(episode);
  const known = new Set((episode.tags ?? []).map((tag) => tag.id));
  const fresh = tags.filter((tag) => !known.has(tag.id));
  if (fresh.length > 0) {
    console.log(`+ ${entry.slug}: ${fresh.length} tagów`);
    if (write) {
      episode.tags = [...(episode.tags ?? []), ...fresh];
      writeJson(path, episode);
    }
    changed += 1;
  }
}

console.log(`Odcinków do uzupełnienia: ${changed}${write ? '' : ' (bez --write nic nie zapisano)'}`);
