#!/usr/bin/env node
// Producent artefaktu `metadata.json`: z uuid odcinka czyta stronę Polskiego Radia.
// Adres nie zależy od sluga — obcy slug plus poprawny uuid przekierowuje na właściwy odcinek,
// a tytuł bywa poprawiany po publikacji, więc nie może być częścią klucza.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const PROGRAM_URL = 'https://www.polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const args = process.argv.slice(2);
const write = args.includes('--write');
// `--verify` nic nie zapisuje: porównuje odczyt ze strony z katalogiem i podaje różnice.
const verify = args.includes('--verify');
const uuids = args.filter((arg) => !arg.startsWith('--'));

const fetchText = async (url) => {
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} dla ${url}`);
  return { body: await response.text(), url: response.url };
};

const sliceJsonLd = (html) => {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
};

// Strona podaje czas lokalny z doklejonym „Z”, więc konwersja strefą przesunęłaby datę.
const dateOf = (value) => (typeof value === 'string' ? value.slice(0, 10) : null);

const stripProgramPrefix = (headline, program) => {
  for (const prefix of [`${program} - `, 'Ciężko na Sercu - ']) {
    if (headline.startsWith(prefix)) return headline.slice(prefix.length).trim();
  }
  return headline.trim();
};

const titleFromTitleTag = (html, program) => {
  const match = html.match(/<title>([\s\S]*?)<\/title>/);
  if (!match) return null;
  const parts = match[1].split(' - ');
  const last = parts.at(-1)?.trim();
  return last && last !== program ? last : null;
};

const titleFromHeading = (html) => {
  const match = html.match(/<span class="w-\[58%\] truncate">([\s\S]*?)<\/span>/);
  return match ? match[1].trim() : null;
};

const audioUrlFrom = (html, uuid) => {
  const sounds = html.match(/"sounds":\["([^"]+)"/);
  if (sounds) return sounds[1].replace(/^http:/, 'https:');
  return `https://static.prsa.pl/${uuid}.mp3`;
};

const durationFrom = (html) => {
  for (const match of html.matchAll(/duration\\?":(\d+)/g)) {
    const value = Number(match[1]);
    if (value > 600) return value;
  }
  return null;
};

export const readMetadata = async (uuid) => {
  const { body: html, url } = await fetchText(`${PROGRAM_URL}/odcinek/x,${uuid}`);
  const ld = sliceJsonLd(html) ?? {};
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? url;
  const program = html.match(/<meta name="author" content="([^"]+)"/)?.[1] ?? 'Ciężko na Sercu';
  const headline = typeof ld.headline === 'string' ? stripProgramPrefix(ld.headline, program) : null;
  const title = headline ?? titleFromTitleTag(html, program) ?? titleFromHeading(html);
  const date = dateOf(ld.datePublished);
  if (!title || !date) throw new Error(`${uuid}: brak tytułu albo daty na stronie`);

  return {
    version: 1,
    uuid,
    date,
    title,
    program,
    programUrl: PROGRAM_URL,
    articleId: /articleId\\?":(\d+)/.exec(html)?.[1] ? Number(/articleId\\?":(\d+)/.exec(html)[1]) : null,
    sourceUrl: canonical,
    audioUrl: audioUrlFrom(html, uuid),
    image: typeof ld.image === 'string' ? ld.image : null,
    durationSec: durationFrom(html),
    author: Array.isArray(ld.author) ? (ld.author[0]?.name ?? null) : null,
  };
};

const dirName = (metadata) => `${metadata.date}_${metadata.uuid}`;

const catalog = JSON.parse(await readFile(join(ROOT, 'data', 'catalog.json'), 'utf8'));
const byId = new Map(catalog.episodes.map((entry) => [entry.id, entry]));

const targets = uuids.length > 0 ? uuids : [...byId.keys()];

let problems = 0;
for (const uuid of targets) {
  let metadata;
  try {
    metadata = await readMetadata(uuid);
  } catch (error) {
    problems++;
    console.error(`— ${uuid}: ${error.message}`);
    continue;
  }

  const entry = byId.get(uuid);
  if (entry) {
    const differs = [
      entry.date !== metadata.date && `data ${entry.date} → ${metadata.date}`,
      entry.audioUrl !== metadata.audioUrl && `audio ${entry.audioUrl} → ${metadata.audioUrl}`,
      String(entry.articleId ?? '') !== String(metadata.articleId ?? '') && `articleId ${entry.articleId} → ${metadata.articleId}`,
    ].filter(Boolean);
    if (differs.length > 0) {
      problems++;
      console.log(`✗ ${uuid}: katalog — ${differs.join(', ')}`);
    }
  }

  if (verify) {
    console.log(`✓ ${metadata.date} ${uuid} — ${metadata.title}`);
    continue;
  }
  if (!write) {
    console.log(JSON.stringify(metadata, null, 2));
    continue;
  }
  const path = join(ROOT, 'data', 'episodes', dirName(metadata), 'metadata.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`✓ ${metadata.date} ${metadata.uuid} — ${metadata.title}`);
}

if (problems > 0) process.exitCode = 1;
