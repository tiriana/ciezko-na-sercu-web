import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { estimateSchedule, planQueue, MINUTES_PER_EPISODE, NIGHT_MINUTES } from '../src/lib/schedule.ts';

/**
 * Stan kolejki opracowań: dla redakcji, nie dla widzów. Zapisuje data/queue.json,
 * żeby tempo i daty dało się śledzić w repo (diff pokazuje, jak zmienia się szacunek).
 */
const DATA = 'data';
const catalog = JSON.parse(await readFile(join(DATA, 'catalog.json'), 'utf8'));
const done = new Set((await readdir(join(DATA, 'episodes'))).map((name) => name.replace(/\.json$/, '')));

const entries = catalog.episodes.map((episode) => ({
  slug: episode.slug,
  date: episode.date,
  enriched: done.has(episode.id),
}));

const queue = estimateSchedule(entries.filter((entry) => entry.enriched).length, entries.length);
const plan = planQueue(entries);

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  total: entries.length,
  enriched: entries.length - queue.remaining,
  remaining: queue.remaining,
  minutesPerEpisode: MINUTES_PER_EPISODE,
  episodesPerNight: queue.perNight,
  nightMinutes: NIGHT_MINUTES,
  estimatedFinish: queue.finishDate,
  planned: Object.fromEntries(plan),
};

await writeFile(join(DATA, 'queue.json'), `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `Kolejka: ${payload.enriched}/${payload.total} opracowanych, zostało ${payload.remaining}, ` +
    `${payload.episodesPerNight} na noc, szacowany koniec ${payload.estimatedFinish ?? '—'}`
);
