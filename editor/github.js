// Cała komunikacja z GitHubem: logowanie (device flow aplikacji albo wklejony token),
// odczyt surowych plików i publikacja jednym commitem. Token żyje wyłącznie w pamięci
// karty — nigdy w localStorage, sessionStorage ani cookie.

import { config } from './config.js';

let token = '';
let session = { login: '', canPush: false };

export const currentSession = () => session;

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
export const publishChanges = async (message, files) => {
  if (!session.canPush) throw new Error('brak uprawnień do zapisu');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
