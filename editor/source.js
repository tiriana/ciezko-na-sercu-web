// Odczyt danych: najpierw pamięć przeglądarki, potem sieć z rewalidacją po ETagu.
// `raw.githubusercontent.com` odpowiada 304, gdy plik się nie zmienił, więc odświeżenie
// katalogu kosztuje kilkaset bajtów, a bez sieci edytor dalej pokazuje ostatni stan.

import { config, rawUrl } from './config.js';
import { getFile, putFile } from './store.js';

const inflight = new Map();

const fetchText = async (path, etag) => {
  const response = await fetch(rawUrl(path), {
    cache: 'no-cache',
    headers: etag ? { 'if-none-match': etag } : {},
  });
  if (response.status === 304) return { text: null, etag, notModified: true };
  if (response.status === 404) return { text: null, etag: null, missing: true };
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return { text: await response.text(), etag: response.headers.get('etag') };
};

/** Zwraca tekst pliku: z pamięci, jeśli jest, i odświeża go w tle; bez pamięci — z sieci. */
export const loadText = async (path) => {
  if (inflight.has(path)) return inflight.get(path);
  const task = (async () => {
    const cached = await getFile(path);
    if (cached) {
      // Odświeżenie nie może blokować pracy: pokazujemy cache, a sieć dogaduje się w tle.
      void (async () => {
        try {
          const fresh = await fetchText(path, cached.etag);
          if (fresh.notModified) return;
          if (fresh.missing) return;
          await putFile(path, fresh.text, fresh.etag);
          window.dispatchEvent(new CustomEvent('edytor:plik-odswiezony', { detail: { path } }));
        } catch {}
      })();
      return cached.body;
    }
    const fresh = await fetchText(path, null);
    if (fresh.missing) return null;
    await putFile(path, fresh.text, fresh.etag);
    return fresh.text;
  })().finally(() => inflight.delete(path));
  inflight.set(path, task);
  return task;
};

export const loadJson = async (path) => {
  const text = await loadText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Bez pamięci: dla plików, które muszą być świeże w chwili publikacji (poprawki,
 * tytuły), bo scalanie ze starym stanem cofałoby zmiany zrobione gdzie indziej. */
export const loadJsonFresh = async (path) => {
  const fresh = await fetchText(path, null);
  if (fresh.text === null) return null;
  await putFile(path, fresh.text, fresh.etag);
  return JSON.parse(fresh.text);
};

/** Binaria (waveform) cache'ujemy w tej samej pamięci co tekst — plik ma ~135 kB,
 * a bez niego edytor nie narysuje głośności offline. */
export const loadBinary = async (path) => {
  const cached = await getFile(path);
  if (cached) return new Uint8Array(cached.body);
  const response = await fetch(rawUrl(path), { cache: 'no-cache' });
  if (!response.ok) return null;
  const body = new Uint8Array(await response.arrayBuffer());
  await putFile(path, body, response.headers.get('etag'));
  return body;
};
