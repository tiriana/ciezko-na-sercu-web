#!/usr/bin/env node
/**
 * Sprawdza, czy plik audio odcinka jest już udostępniony przez Polskie Radio.
 *
 * HEAD na `static.prsa.pl` odpowiada 200 z pełnym `content-length` (zmierzone
 * 2026-11-09: 109 701 332 B), a nieopublikowany plik daje 404 z zerem. Gdy
 * serwer nie poda długości, pytamy ffprobe o pierwszy strumień — czyta tylko
 * początek pliku, więc nie ściąga całej audycji.
 *
 * Exit 0 = plik jest; exit 1 = jeszcze go nie ma; exit 2 = nie umiem sprawdzić
 * (nieznany odcinek albo brak adresu) — tego nie naprawi kolejne sondowanie.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HEAD_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0 (compatible; ciezko-na-sercu-web catalog)';

const fail = (reason, code = 1) => {
  console.error(reason);
  process.exit(code);
};

const key = process.argv[2];
if (!key) fail('użycie: node scripts/check-audio.mjs <id-lub-slug> [lista-odcinków]', 2);

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

// Nowego odcinka nie ma jeszcze w katalogu — dopisuje go dopiero refresh-catalog,
// więc adres audio bierzemy z pobranej listy, na której opiera się wykrywanie.
const fromFetched = () => {
  try {
    const fetched = JSON.parse(readFileSync(process.argv[3] ?? '.cache/episodes.json', 'utf8'));
    const hit = (Array.isArray(fetched) ? fetched : []).find((episode) => episode.id === key);
    return hit ? { ...hit, audioUrl: hit.audioUrl ?? hit.mp3Url } : null;
  } catch {
    return null;
  }
};

const episode = byKey.get(key) ?? fromFetched();
if (!episode) fail(`nieznany odcinek: ${key}`, 2);
if (!episode.audioUrl) fail(`odcinek ${episode.id} nie ma audioUrl`, 2);

const probeAudio = async (url) => {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-rw_timeout', '15000000',
        '-probesize', '32768',
        '-analyzeduration', '0',
        '-show_entries', 'stream=codec_type',
        '-of', 'default=nw=1:nk=1',
        url,
      ],
      { timeout: PROBE_TIMEOUT_MS }
    );
    return stdout.split('\n').some((line) => line.trim() === 'audio');
  } catch {
    return false;
  }
};

const ok = (detail) => {
  console.log(`OK ${episode.slug ?? episode.id}: ${detail}`);
  process.exit(0);
};

let status = null;
let length = 0;
try {
  const response = await fetch(episode.audioUrl, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
  });
  status = response.status;
  length = Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0;
} catch (error) {
  if (await probeAudio(episode.audioUrl)) ok('ffprobe potwierdził audio (HEAD nie odpowiedział)');
  fail(`HEAD nie odpowiedział: ${error.message}`);
}

if (status !== 200) fail(`HTTP ${status}`);
if (length > 0) ok(`HTTP 200, content-length ${length}`);

if (await probeAudio(episode.audioUrl)) ok('ffprobe potwierdził audio (brak content-length)');
fail(`HTTP 200, content-length ${length} — plik jeszcze niedostępny`);
