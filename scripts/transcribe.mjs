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

const trim = [];
if (chunkStart > 0) trim.push('-ss', String(chunkStart));
if (chunkLength > 0) trim.push('-t', String(chunkLength));
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...trim, '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);

const asrBase = path.join(work, 'asr');
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
    '-of', asrBase,
    '-np',
  ],
  { env: { ...process.env, LD_LIBRARY_PATH: [path.dirname(whisperBin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } }
);

const raw = JSON.parse(await readFile(`${asrBase}.json`, 'utf8'));
const segments = (raw.transcription ?? [])
  .map((entry) => ({
    start: Math.round((chunkStart + (entry.offsets?.from ?? 0) / 1000) * 100) / 100,
    end: Math.round((chunkStart + (entry.offsets?.to ?? 0) / 1000) * 100) / 100,
    text: String(entry.text ?? '').trim(),
  }))
  .filter((segment) => segment.text.length > 0 && segment.end > segment.start);

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
  params: { maxLen: Number(maxLen), splitOnWord, vad: useVad },
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
