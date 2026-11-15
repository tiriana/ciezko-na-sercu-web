// Pamięć przeglądarki: pobrane pliki (żeby edytor działał bez sieci i nie pobierał
// katalogu przy każdym wejściu), szkice i znaczniki „przejrzane”. Wszystko per
// urządzenie — źródłem prawdy pozostaje repozytorium.

const DB_NAME = 'ciezko-edytor';
const VERSION = 1;
let dbPromise = null;

const open = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
};

const run = async (store, mode, action) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
};

export const getFile = (path) => run('files', 'readonly', (store) => store.get(path)).catch(() => null);

export const putFile = (path, body) =>
  run('files', 'readwrite', (store) => store.put({ path, body, at: Date.now() })).catch(() => null);

export const getDraft = (id) => run('drafts', 'readonly', (store) => store.get(id)).catch(() => null);

export const putDraft = (id, payload) =>
  run('drafts', 'readwrite', (store) => store.put({ id, payload, at: Date.now() })).catch(() => null);

export const deleteDraft = (id) => run('drafts', 'readwrite', (store) => store.delete(id)).catch(() => null);

export const getMeta = (key) => run('meta', 'readonly', (store) => store.get(key)).catch(() => null);

export const putMeta = (key, value) => run('meta', 'readwrite', (store) => store.put({ key, value })).catch(() => null);
