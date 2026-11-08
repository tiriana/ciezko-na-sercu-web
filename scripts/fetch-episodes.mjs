#!/usr/bin/env node
/**
 * Lista odcinków audycji prosto z polskieradio.pl.
 *
 * Serwis renderuje listę po stronie klienta, ale wysyła ją w payloadzie RSC
 * (`self.__next_f.push`) — wystarczy go odczytać. Kolejne strony to `?page=N`.
 * Wynik ma format wejściowy `build-catalog.mjs`, więc katalog powstaje bez
 * pośredniego `episodes.json` i bez rclone.
 */

const SHOW_URL = 'https://www.polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644';
const PAGE_LIMIT = 60;
const UA = 'Mozilla/5.0 (compatible; ciezko-na-sercu-web catalog)';

const decodePayload = (html) => {
  const marker = 'self.__next_f.push([1,"';
  const chunks = [];
  let index = html.indexOf(marker);
  while (index !== -1) {
    const start = index + marker.length;
    const end = html.indexOf('"])', start);
    if (end === -1) break;
    try {
      chunks.push(JSON.parse(`"${html.slice(start, end)}"`));
    } catch {
      // Nieczytelny fragment pomijamy: kolejne mogą zawierać listę.
    }
    index = html.indexOf(marker, end);
  }
  return chunks.join('\n');
};

const arraysAfter = (text, key) => {
  const arrays = [];
  let at = text.indexOf(`"${key}":`);
  while (at !== -1) {
    const found = arrayAt(text, at);
    if (found) arrays.push(found);
    at = text.indexOf(`"${key}":`, at + key.length + 3);
  }
  return arrays;
};

const arrayAt = (text, at) => {
  const open = text.indexOf('[', at);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
};

const PL_MAP = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (char) => PL_MAP[char])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/:/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const fetchPage = async (base, page) => {
  const response = await fetch(`${base}?page=${page}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pl-PL,pl;q=0.9' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`strona ${page}: HTTP ${response.status}`);
  return response.text();
};

const canonicalBase = (html) => {
  const match = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
  if (!match) return null;
  const url = new URL(match[1]);
  return `${url.origin}${url.pathname}`;
};

const episodesFrom = (html) => {
  const text = decodePayload(html);
  // Payload zawiera kilka ramek; pierwsza lista bywa pusta (szkielet SSR).
  const candidates = arraysAfter(text, 'showEpisodes')
    .map((array) => {
      try {
        return JSON.parse(array);
      } catch {
        return [];
      }
    })
    .filter((list) => Array.isArray(list) && list.length > 0)
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? [];
};

const toCatalogEntry = (episode) => {
  const audio = (episode.sounds ?? []).find((sound) => UUID.test(sound));
  if (!audio) return null;
  const uuid = UUID.exec(audio)[1].toLowerCase();
  const date = String(episode.date ?? '').slice(0, 10);
  const title = String(episode.title ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!date || !title) return null;
  return {
    date,
    title,
    articleId: episode.articleId ?? null,
    mp3Url: audio.replace(/^http:\/\//, 'https://'),
    id: uuid,
    sourceUrl: `${SHOW_URL}/odcinek/${slugify(title)},${uuid}`,
  };
};

const main = async () => {
  const output = process.argv[2];
  const episodes = [];
  const seen = new Set();
  let base = SHOW_URL;

  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const html = await fetchPage(base, page);
    if (page === 1) base = canonicalBase(html) ?? base;
    const parsed = episodesFrom(html);
    if (parsed.length === 0) {
      if (page === 1) throw new Error('strona audycji nie zawiera listy odcinków — format serwisu się zmienił');
      break;
    }
    let added = 0;
    for (const raw of parsed) {
      const entry = toCatalogEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      episodes.push(entry);
      added += 1;
    }
    if (added === 0) break;
  }

  if (episodes.length === 0) throw new Error('nie znaleziono żadnego odcinka');
  episodes.sort((left, right) => right.date.localeCompare(left.date));

  const json = `${JSON.stringify(episodes, null, 2)}\n`;
  if (output) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(resolve(output), json);
    console.log(`${episodes.length} odcinków -> ${output}`);
    return;
  }
  process.stdout.write(json);
};

main().catch((error) => {
  console.error(`Błąd pobierania listy odcinków: ${error.message}`);
  process.exit(1);
});
