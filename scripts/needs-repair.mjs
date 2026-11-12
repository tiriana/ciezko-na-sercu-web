#!/usr/bin/env node
/**
 * Odcinki z brakami do naprawy: utwór bez tytułu (albo `#TODO`/`unrecognized`)
 * lub wejście bez opisu. Kolejność i zakres bierzemy z tego, co realnie widać
 * w danych — po nałożeniu poprawek ręcznych, żeby nie naprawiać tego, co już
 * jest rozpoznane w `data/overrides`.
 *
 * Użycie: node scripts/needs-repair.mjs [--count]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const isBlank = (value) => !String(value ?? '').trim();
// `#TODO` bywa dopisane na końcu gotowego opisu („… / Azarath – album … #TODO popraw ten opis”),
// więc szukamy znacznika w całym tekście, nie tylko na początku.
const isTodo = (value) => /#TODO/i.test(String(value ?? '')) || isBlank(value);

const args = new Set(process.argv.slice(2));
const countOnly = args.has('--count');

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

const ids = [...readdirSync('data/episodes').filter((name) => name.endsWith('.json'))]
  .map((name) => name.replace(/\.json$/, ''))
  .sort()
  .filter((id) => {
    const episode = read(`data/episodes/${id}.json`);
    const overridePath = `data/overrides/${id}.json`;
    const override = existsSync(overridePath) ? read(overridePath) : null;

    const fixes = new Map();
    for (const fix of override?.tracks ?? []) {
      if (fix.start === undefined) continue;
      if (fix.newTitle) fixes.set(Math.round(Number(fix.start) * 100), fix.newTitle);
    }

    const tracks = [
      ...(episode.tracks ?? []),
      ...(override?.addTracks ?? []),
    ];
    const brokenTrack = tracks.some((track) => {
      // Kontekst już pytany i nic nie dał — nie licz tego odcinka ponownie.
      if (track.contextMiss) return false;
      if (track.unrecognized) return true;
      const fixed = fixes.get(Math.round(Number(track.start) * 100));
      return isTodo(fixed ?? track.title) || isTodo(track.artist);
    });

    const topics = [...(episode.topics ?? []), ...(override?.addTopics ?? [])];
    const brokenTopic = topics.some((topic) => isTodo(topic.label));

    return brokenTrack || brokenTopic;
  });

if (countOnly) console.log(ids.length);
else console.log(ids.join('\n'));
