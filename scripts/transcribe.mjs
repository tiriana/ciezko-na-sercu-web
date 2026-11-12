#!/usr/bin/env node
/**
 * Transkrypcja jednego odcinka whisper.cpp — wersja na GitHub Actions.
 *
 * Ten sam model co w taggerze, ale `-ml 20 -sow` tnie wypowiedź na zdania po kilka
 * słów, żeby czasy wejść trafiały w konkretne słowo, nie w początek 8-sekundowego
 * kawałka. VAD whispera jest domyślnie wyłączony: obcina ~40% tekstu, a tagger ma
 * własny, lepiej nastrojony.
 *
 * Użycie:
 *   node scripts/transcribe.mjs --id <uuid> --audio <plik.wav|mp3> [--out data/transcripts]
 *   node scripts/transcribe.mjs --id <uuid> --url <https://...mp3> [--start 2700 --length 2700 --part 1]
 *
 * Zmienne: WHISPER_BIN, WHISPER_MODEL, VAD_MODEL, THREADS, MAX_LEN, SPLIT_ON_WORD.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const argv = process.argv.slice(2);
const args = {};
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('--')) continue;
  const next = argv[index + 1];
  if (next && !next.startsWith('--')) {
    args[token.slice(2)] = next;
    index += 1;
  } else {
    args[token.slice(2)] = 'true';
  }
}
const flag = (name, fallback) => args[name] ?? fallback;

const id = flag('id');
if (!id) {
  console.error('Brak --id (uuid odcinka).');
  process.exit(1);
}

const whisperBin = process.env.WHISPER_BIN ?? 'whisper-cli';
const whisperModel = process.env.WHISPER_MODEL ?? 'models/ggml-large-v3-turbo-q5_0.bin';
const useVad = process.env.VAD === 'true';
const vadModel = process.env.VAD_MODEL ?? 'models/ggml-silero-v5.1.2.bin';
const threads = process.env.THREADS ?? String(4);
const maxLen = process.env.MAX_LEN ?? '20';
const splitOnWord = process.env.SPLIT_ON_WORD !== 'false';
const outDir = path.resolve(flag('out', 'data/transcripts'));
const chunkStart = Number.parseFloat(flag('start', '0')) || 0;
const chunkLength = Number.parseFloat(flag('length', '0')) || 0;
// Tryb bloków: zamiast całego nagrania albo jednej części bierzemy listę bloków mowy
// z `speech-spans.json`. Whisper płaci pełne okno 30 s za każdy fragment, więc mowa
// stanowi ~1/5 audycji, a pracy jest kilka razy mniej.
const chunksPath = flag('chunks');

const work = await mkdtemp(path.join(tmpdir(), 'cns-asr-'));
const source = path.join(work, 'source');
const wav = path.join(work, 'audio.wav');

const audioArg = flag('audio');
const urlArg = flag('url');
let input;
let downloadedStat = null;
if (audioArg) {
  await copyFile(path.resolve(audioArg), source);
  input = source;
  downloadedStat = await stat(source);
} else if (urlArg) {
  // ffmpeg czyta po HTTP z range requests, więc nie ma po co ściągać całego
  // dwugodzinnego pliku: na dysk trafia tylko wycięty 45-minutowy kawałek.
  input = urlArg;
} else {
  console.error('Podaj --audio albo --url.');
  process.exit(1);
}

const asrBase = path.join(work, 'asr');

const transcribeSlice = async (start, length, label) => {
  const trim = [];
  if (start > 0) trim.push('-ss', String(start));
  if (length > 0) trim.push('-t', String(length));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...trim, '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  const out = label ? `${asrBase}-${label}` : asrBase;
  await run(
    whisperBin,
    [
      '-m', whisperModel,
      '-f', wav,
      '-l', 'pl',
      '-t', threads,
      '-ml', maxLen,
      ...(splitOnWord ? ['-sow'] : []),
      ...(useVad ? ['--vad', '-vm', vadModel] : []),
      '-oj',
      '-of', out,
      '-np',
    ],
    { env: { ...process.env, LD_LIBRARY_PATH: [path.dirname(whisperBin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } }
  );
  const raw = JSON.parse(await readFile(`${out}.json`, 'utf8'));
  return (raw.transcription ?? [])
    .map((entry) => ({
      start: Math.round((start + (entry.offsets?.from ?? 0) / 1000) * 100) / 100,
      end: Math.round((start + (entry.offsets?.to ?? 0) / 1000) * 100) / 100,
      text: String(entry.text ?? '').trim(),
    }))
    .filter((segment) => segment.text.length > 0 && segment.end > segment.start);
};

let segments;
if (chunksPath) {
  // Wycinanie z adresu HTTP kosztuje: mp3 nie ma indeksu, więc ffmpeg za każdym razem
  // dekoduje od początku do punktu cięcia. Przy dwudziestu blokach to więcej czasu niż
  // sama transkrypcja, więc pobieramy nagranie raz i tniemy z dysku.
  if (input !== source) {
    await run('curl', ['-fsSL', '-o', wav.replace(/audio\.wav$/, 'source.mp3'), input]);
    input = wav.replace(/audio\.wav$/, 'source.mp3');
  }
  const plan = JSON.parse(await readFile(path.resolve(chunksPath), 'utf8'));
  // Macierz dzieli bloki między joby: każdy liczy swój wycinek, a scalanie składa
  // całość z części, więc zakres jest połową prawdy o tym, co jest policzone.
  const allChunks = plan.chunks ?? [];
  const from = Number.parseInt(flag('chunk-from', '0'), 10) || 0;
  const to = Number.parseInt(flag('chunk-to', String(allChunks.length)), 10) || allChunks.length;
  const chunks = allChunks.slice(from, to);
  if (chunks.length === 0) {
    console.error(`${chunksPath}: brak bloków do transkrypcji`);
    process.exit(1);
  }
  segments = [];
  let done = 0;
  for (const [index, chunk] of chunks.entries()) {
    const length = Math.max(0.5, chunk.end - chunk.start);
    const part = await transcribeSlice(chunk.start, length, String(index).padStart(3, '0'));
    segments.push(...part);
    done += length;
    console.log(`blok ${index + 1}/${chunks.length} (${Math.round(chunk.start)}–${Math.round(chunk.end)} s): ${part.length} segmentów`);
  }
  console.log(`przetworzone audio: ${Math.round(done)} s z ${Math.round(plan.durationSec ?? 0)} s nagrania`);
} else {
  segments = await transcribeSlice(chunkStart, chunkLength, '');
}

// Na styku bloków whisper powtarza ostatnie zdanie z poprzedniego kawałka; zostawiamy
// pierwszy wiersz, bo drugi to duplikat z przesuniętym czasem.
const deduped = [];
for (const segment of segments.sort((left, right) => left.start - right.start)) {
  const previous = deduped.at(-1);
  if (previous && previous.text === segment.text && segment.start - previous.end < 3) {
    previous.end = segment.end;
    continue;
  }
  deduped.push({ ...segment });
}
segments = deduped;

// Okna to bloki mowy; przy VAD whispera bierzemy je z samych segmentów, sklejając
// wszystko, co dzieli mniej niż 3 s — dłuższe przerwy to muzyka, nie pauza w zdaniu.
const WINDOW_GAP_SEC = 3;
const windows = [];
for (const segment of segments) {
  const last = windows[windows.length - 1];
  if (last && segment.start - last.end <= WINDOW_GAP_SEC) {
    last.end = segment.end;
    continue;
  }
  windows.push({ index: windows.length, start: segment.start, end: segment.end });
}

const transcript = {
  version: 1,
  episodeId: id,
  provider: 'whisper-cpp',
  model: path.basename(whisperModel).replace(/^ggml-/, '').replace(/\.bin$/, ''),
  language: 'pl',
  // Parametry zapisane w pliku są znacznikiem „ten odcinek jest już zrobiony w tej
  // wersji": plan-transcribe pomija transkrypty z innymi wartościami.
  params: { maxLen: Number(maxLen), splitOnWord, vad: useVad, chunks: chunksPath ? path.basename(chunksPath) : null },
  fileSizeBytes: downloadedStat?.size ?? null,
  fileMtimeMs: downloadedStat?.mtimeMs ?? null,
  windows,
  segments,
  stats: {
    windowCount: windows.length,
    transcribedAudioSec: Math.round(windows.reduce((sum, window) => sum + (window.end - window.start), 0) * 100) / 100,
    segmentCount: segments.length,
    characterCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
  },
};

await mkdir(outDir, { recursive: true });
const part = flag('part', '0');
const target = path.join(outDir, `${id}.part${String(part).padStart(3, '0')}.json`);
await writeFile(target, `${JSON.stringify(transcript, null, 2)}\n`);
console.log(`${target}: ${segments.length} segmentów, ${windows.length} okien, ${transcript.stats.transcribedAudioSec} s mowy`);
