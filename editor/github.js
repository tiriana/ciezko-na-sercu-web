// Cała komunikacja z GitHubem: logowanie (device flow aplikacji albo wklejony token),
// odczyt surowych plików i publikacja jednym commitem. Token żyje w pamięci karty
// i w `sessionStorage` tej karty (przeżywa odświeżenie, ginie z zamknięciem) — nigdy
// w `localStorage` ani w cookie.

import { config } from './config.js';

// Sesja przeżywa odświeżenie karty (sessionStorage), ale nie zamknięcie karty i nie
// inne karty. Token nadal nie trafia do `localStorage` ani do cookie.
const STORAGE_KEY = 'ciezko-edytor-session';
const SESSION_MS = 8 * 60 * 60 * 1000;

let token = '';
let session = { login: '', canPush: false };

const clearStored = () => {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
};

const storeSession = () => {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token, session, expiresAt: Date.now() + SESSION_MS })
    );
  } catch {}
};

const restoreSession = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    if (!stored?.token || !stored?.expiresAt || Date.now() > stored.expiresAt) {
      clearStored();
      return;
    }
    token = stored.token;
    session = stored.session ?? { login: '', canPush: false };
  } catch {
    clearStored();
  }
};

restoreSession();

export const currentSession = () => session;

/** Sprawdzenie zapisanej sesji po odświeżeniu: 401 czyści token i wraca do logowania. */
export const verifySession = async () => {
  if (!token) return false;
  try {
    const user = await apiJson('/user');
    const repo = await apiJson(`/repos/${config.owner}/${config.repo}`);
    session = { login: user.login, canPush: Boolean(repo.permissions?.push || repo.permissions?.admin) };
    storeSession();
    return session.canPush;
  } catch {
    return false;
  }
};

const api = async (path, options = {}) => {
  const response = await fetch(`${config.api}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401) {
    token = '';
    session = { login: '', canPush: false };
    clearStored();
    throw new Error('sesja wygasła — zaloguj się ponownie');
  }
  return response;
};

const apiJson = async (path, options) => {
  const response = await api(path, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${detail.slice(0, 300)}`);
  }
  return response.json();
};

export const signInWithToken = async (value) => {
  token = value.trim();
  try {
    const user = await apiJson('/user');
    const repo = await apiJson(`/repos/${config.owner}/${config.repo}`);
    session = { login: user.login, canPush: Boolean(repo.permissions?.push || repo.permissions?.admin) };
    if (!session.canPush) throw new Error(`konto ${user.login} nie ma prawa zapisu w ${config.owner}/${config.repo}`);
    storeSession();
    return session;
  } catch (error) {
    token = '';
    session = { login: '', canPush: false };
    throw error;
  }
};

export const signOut = () => {
  token = '';
  session = { login: '', canPush: false };
  clearStored();
};

/** Device flow aplikacji GitHub: użytkownik wpisuje kod na github.com, my czekamy
 * na token. Sekretu nie ma — aplikacja jest publicznym klientem. */
export const startDeviceFlow = async () => {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId }),
  });
  if (!response.ok) throw new Error(`GitHub odrzucił start logowania (${response.status})`);
  return response.json();
};

export const pollDeviceToken = async (deviceCode) => {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await response.json();
  if (data.access_token) return signInWithToken(data.access_token);
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return null;
  throw new Error(data.error_description || data.error || 'nie udało się zalogować');
};

const blobOf = async (content) =>
  apiJson(`/repos/${config.owner}/${config.repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });

/** Jeden commit na całą publikację: Contents API zapisuje plik po pliku, a my chcemy
 * jedno zdarzenie w historii i jedno uruchomienie workflowów. */
export const publishChanges = async (message, files, { beforeRetry } = {}) => {
  if (!session.canPush) throw new Error('brak uprawnień do zapisu');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Ponowna próba rebazuje commit na nowy koniec gałęzi, więc wołający może sprawdzić,
    // czy plik, który nadpisuje w całości, nie zmienił się w międzyczasie.
    if (attempt > 1 && beforeRetry) await beforeRetry();
    const ref = await apiJson(`/repos/${config.owner}/${config.repo}/git/ref/heads/${config.branch}`);
    const parent = ref.object.sha;
    const base = await apiJson(`/repos/${config.owner}/${config.repo}/git/commits/${parent}`);

    const tree = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        tree.push({ path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const { sha } = await blobOf(content);
      tree.push({ path, mode: '100644', type: 'blob', sha });
    }

    const nextTree = await apiJson(`/repos/${config.owner}/${config.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: base.tree.sha, tree }),
    });
    const commit = await apiJson(`/repos/${config.owner}/${config.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: nextTree.sha, parents: [parent] }),
    });

    const patched = await api(
      `/repos/${config.owner}/${config.repo}/git/refs/heads/${config.branch}`,
      { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) }
    );
    if (patched.ok) return { sha: commit.sha, url: `https://github.com/${config.owner}/${config.repo}/commit/${commit.sha}` };
    if (patched.status !== 422 && patched.status !== 409) {
      throw new Error(`nie udało się zapisać: HTTP ${patched.status}`);
    }
  }
  throw new Error('gałąź main zmieniła się w trakcie publikacji — spróbuj ponownie');
};
