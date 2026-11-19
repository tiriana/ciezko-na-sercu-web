#!/usr/bin/env node
/**
 * Dopisuje intro audycji odcinkom, które go jeszcze nie mają. Wzorzec wycinamy
 * w locie z odcinka referencyjnego (jego czas intra jest w `data/overrides`), więc
 * żadne audio nie trafia do repo. Samo szukanie robi `tools/find-intro.py`, a wpis
 * do `addTracks` — `tools/apply-intro.py`.
 *
 *   node scripts/detect-intro.mjs [--limit 10] [--episodes <id,...>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { frozenEpisodes } from './frozen.mjs';
import { hasIntro, introWindowStart, isIntro } from './lib/intro.mjs';

const REFERENCE_ID = '9856e0b6-5223-4f1e-8172-96ddcfc3d199';
const SCAN_SEC = 180;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const limit = Number.parseInt(option('limit', process.env.LIMIT || '10'), 10) || 10;
const wanted = String(option('episodes', process.env.EPISODES || ''))
  .split(/[\s,]+/)
  .filter(Boolean);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const catalog = readJson('data/catalog.json');
const byId = new Map(catalog.episodes.map((entry) => [entry.id, entry]));
const frozen = frozenEpisodes();

const reference = byId.get(REFERENCE_ID);
const referenceIntro = readJson(`data/overrides/${REFERENCE_ID}.json`).addTracks.find(isIntro);
if (!reference || !referenceIntro) {
  console.error('Brak odcinka referencyjnego z intrem — nie mam wzorca.');
  process.exit(1);
}

const since = introWindowStart();
const targets = (wanted.length > 0 ? wanted.map((key) => byId.get(key)).filter(Boolean) : catalog.episodes.filter((entry) => entry.date >= since))
  .filter((entry) => existsSync(`data/episodes/${entry.id}.json`) && !frozen.has(entry.id) && !hasIntro(entry.id))
  .sort((left, right) => right.date.localeCompare(left.date))
  .slice(0, limit);

if (targets.length === 0) {
  console.log('Każdy odcinek ma już intro.');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'cns-intro-'));
try {
  const ffmpeg = (extra, url, out) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...extra, '-i', url, ...out], { timeout: 180_000 });

  const template = join(work, 'intro.wav');
  ffmpeg(['-ss', String(referenceIntro.start), '-t', String(referenceIntro.durationSec)], reference.audioUrl, [template]);

  const clips = join(work, 'clips');
  execFileSync('mkdir', ['-p', clips]);
  for (const entry of targets) {
    console.log(`· ${entry.slug}`);
    ffmpeg(['-t', String(SCAN_SEC)], entry.audioUrl, ['-c', 'copy', join(clips, `${entry.date}_${entry.id.slice(0, 8)}.mp3`)]);
  }

  const results = join(work, 'intro.json');
  execFileSync('python3', ['tools/find-intro.py', template, clips, '--scan', String(SCAN_SEC), '--json', results], { stdio: 'inherit' });
  execFileSync('python3', ['tools/apply-intro.py', results], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
