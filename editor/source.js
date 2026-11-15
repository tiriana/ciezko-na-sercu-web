// Odczyt danych: najpierw pamięć przeglądarki, potem sieć z rewalidacją. `cache:
// 'no-cache'` każe przeglądarce odpytać serwer własnym `ETag`iem, a `raw.githubusercontent.com`
// nie udostępnia tego nagłówka skryptom (brak `access-control-expose-headers`), więc
// warunkowe żądanie robi przeglądarka — my dostajemy świeżą treść albo nic do roboty.

import { config, rawUrl } from './config.js';
import { getFile, putFile } from './store.js';

const inflight = new Map();

const fetchText = async (path) => {
  const response = await fetch(rawUrl(path), { cache: 'no-cache' });
  if (response.status === 404) return { text: null, missing: true };
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return { text: await response.text() };
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
          const fresh = await fetchText(path);
          if (fresh.text === null || fresh.text === cached.body) return;
          await putFile(path, fresh.text);
          window.dispatchEvent(new CustomEvent('edytor:plik-odswiezony', { detail: { path, text: fresh.text } }));
        } catch {}
      })();
      return cached.body;
    }
    const fresh = await fetchText(path);
    if (fresh.missing) return null;
    await putFile(path, fresh.text);
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
 * tytuły, aliasy), bo scalanie ze starym stanem cofałoby zmiany zrobione gdzie indziej. */
export const loadJsonFresh = async (path) => {
  const fresh = await fetchText(path);
  if (fresh.text === null) return null;
  await putFile(path, fresh.text);
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
  await putFile(path, body);
  return body;
};
