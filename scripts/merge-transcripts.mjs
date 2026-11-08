#!/usr/bin/env node
/**
 * Skleja części transkryptu (artefakty workflow `transcribe`) w jeden plik na odcinek.
 * Każda część to fragment audio z przesunięciem — czasy są już bezwzględne, więc
 * wystarczy posortować części i złożyć listy.
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const incoming = path.resolve(process.argv[2] ?? '.incoming');
const outDir = path.resolve(process.argv[3] ?? 'data/transcripts');

const parts = new Map();
for (const name of readdirSync(incoming)) {
  if (!name.endsWith('.json')) continue;
  const match = name.match(/^(?<id>[^.]+)\.part(?<part>\d+)\.json$/);
  if (!match?.groups) continue;
  const data = JSON.parse(readFileSync(path.join(incoming, name), 'utf8'));
  const list = parts.get(match.groups.id) ?? [];
  list.push({ part: Number.parseInt(match.groups.part, 10), data });
  parts.set(match.groups.id, list);
}

mkdirSync(outDir, { recursive: true });

let written = 0;
for (const [id, list] of parts) {
  list.sort((left, right) => left.part - right.part);
  const transcripts = list.map((entry) => entry.data);
  const segments = transcripts.flatMap((transcript) => transcript.segments).sort((left, right) => left.start - right.start);
  const windows = transcripts.flatMap((transcript) => transcript.windows).sort((left, right) => left.start - right.start);
  const merged = {
    ...transcripts[0],
    episodeId: id,
    windows: windows.map((window, index) => ({ ...window, index })),
    segments,
    stats: {
      windowCount: windows.length,
      transcribedAudioSec: Math.round(windows.reduce((sum, window) => sum + (window.end - window.start), 0) * 100) / 100,
      segmentCount: segments.length,
      characterCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    },
  };
  writeFileSync(path.join(outDir, `${id}.json`), `${JSON.stringify(merged, null, 2)}\n`);
  written += 1;
}

for (const name of readdirSync(incoming)) {
  if (name.endsWith('.json')) unlinkSync(path.join(incoming, name));
}

console.log(`${written} transkryptów złożonych z części`);
