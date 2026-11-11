// Odcinki Polskiego Radia mają nagłówek Xing z czasem krótszym niż realna liczba ramek
// (np. 6893,21 s vs 6909,05 s), a przeglądarka wierzy nagłówkowi i w tej skali odmierza
// pozycję. Dane trzymamy w tej samej skali, żeby odtwarzacz nie musiał nic przeliczać:
// konwersja dzieje się tutaj, przy produkcji znaczników.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CACHE = '.cache/timeline';

const round = (value) => Math.round(value * 100) / 100;

const probe = async (audioUrl) => {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    audioUrl,
  ]);
  return Number(JSON.parse(stdout)?.format?.duration) || 0;
};

const decodeLength = async (audioUrl) => {
  // Liczba próbek z dekodera to jedyny wiarygodny czas nagrania; 8 kHz mono wystarcza,
  // bo interesuje nas długość, nie dźwięk.
  const { stdout } = await run('bash', [
    '-c',
    `ffmpeg -v error -i "${audioUrl}" -vn -f s16le -ac 1 -ar 8000 - | wc -c`,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const bytes = Number(String(stdout).trim()) || 0;
  return bytes / 2 / 8000;
};

/** Czas nagrania w skali odtwarzacza (z nagłówka); ułamki sekundy są tu bez znaczenia. */
export const mediaDurationOf = async (audioUrl) => probe(audioUrl);

/**
 * Skala odtwarzacza dla nagrania: `mediaDuration / realDuration` (poniżej 1).
 * Wszystkie czasy w danych mnożymy przez nią, bo player mierzy czas nagłówkiem.
 */
export const timelineFor = async (audioUrl, id) => {
  if (id) {
    try {
      const cached = JSON.parse(await readFile(join(CACHE, `${id}.json`), 'utf8'));
      if (cached.audioUrl === audioUrl && cached.scale > 0) return cached;
    } catch {
      // brak wpisu w cache — liczymy
    }
  }

  const mediaDuration = await probe(audioUrl);
  const realDuration = await decodeLength(audioUrl);
  if (!(mediaDuration > 0) || !(realDuration > 0)) {
    return { audioUrl, mediaDuration, realDuration, scale: 1 };
  }

  const result = {
    audioUrl,
    mediaDuration: Math.round(mediaDuration * 1000) / 1000,
    realDuration: Math.round(realDuration * 1000) / 1000,
    scale: Math.round((mediaDuration / realDuration) * 1e6) / 1e6,
  };
  if (id) {
    await mkdir(CACHE, { recursive: true });
    await writeFile(join(CACHE, `${id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
};

/** Czas z dekodowanego audio → czas odtwarzacza. */
export const toPlayer = (seconds, scale) => (scale > 0 ? round(seconds * scale) : round(seconds));
