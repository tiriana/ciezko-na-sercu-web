import {
  applyOverrides,
  mergeOverrides,
  normalize,
  validateOverride,
  validateSavePayload,
  validateTrackTimes,
} from './lib/overrides.mjs';
import { currentSession, pollDeviceToken, publishChanges, signInWithToken, signOut, startDeviceFlow } from './github.js';
import { deleteDraft, getDraft, getMeta, putDraft, putMeta } from './store.js';
import { loadJson, loadJsonFresh } from './source.js';
import { config } from './config.js';
import { drawWaveform, loadPeaks } from './peaks.js';

const $ = (selector) => document.querySelector(selector);

const PER_SEC = 20;

const state = {
  catalog: null,
  titles: null,
  episode: null,
  override: null,
  // Poprawki kluczowane indeksem w pliku odcinka: ten sam utwór bywa rozpoznany dwa
  // razy, więc kolejność w pliku jest jedynym stabilnym identyfikatorem wiersza.
  edits: new Map(),
  peaks: null,
  titleDirty: false,
  dirty: false,
  // Znaczniki „przejrzane" żyją per urządzenie (IndexedDB), bo to stan pracy, a nie
  // treść odcinka: `data/reviewed.json` zostaje dla automatywów i edytora lokalnego.
  reviewed: {},
  draftTimer: null,
};

const setStatus = (text, kind = '') => {
  const node = $('#status');
  node.textContent = text;
  node.className = `status ${kind}`;
};

const notify = (text, kind = '') => {
  const hint = $('#hint');
  hint.textContent = text;
  hint.className = `hint ${kind}`;
};

const slugOf = (episode) => episode.slug ?? episode.id;
const officialTitle = (episode) => episode.title ?? slugOf(episode);
const shownTitle = (episode) => state.titles?.titles?.[episode.id]?.title ?? officialTitle(episode);

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const parseTime = (value) => {
  const text = String(value).trim();
  if (!text) return Number.NaN;
  if (!text.includes(':')) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
};

const identityOf = (track) =>
  `${normalize(track.artist)}|${normalize(track.title)}|${normalize(track.album ?? '')}`;

const identityFix = (track) =>
  track.album === null || track.album === undefined
    ? { artist: track.artist, title: track.title }
    : { artist: track.artist, title: track.title, album: track.album };

const overrideFix = (track) =>
  (state.override?.tracks ?? []).find((fix) => identityOf(fix) === identityOf(track)) ?? null;

const fixFor = (index) => {
  const track = state.episode.tracks[index];
  return { ...(overrideFix(track) ?? {}), ...(state.edits.get(index) ?? {}) };
};

const editFor = (index) => {
  const track = state.episode.tracks[index];
  if (!state.edits.has(index)) state.edits.set(index, identityFix(track));
  const fix = state.edits.get(index);
  for (const [key, value] of Object.entries(identityFix(track))) if (fix[key] === undefined) fix[key] = value;
  return fix;
};

const prune = (fix) => {
  for (const [key, value] of Object.entries(fix)) {
    if (value === undefined || value === null || value === '') delete fix[key];
  }
  return fix;
};

const hasChanges = () => state.edits.size > 0 || state.titleDirty;

const reviewedCount = () => Object.keys(state.reviewed ?? {}).length;

const toggleReviewed = async (index) => {
  const id = state.episode.id;
  state.reviewed = { ...state.reviewed };
  if (state.reviewed[index]) delete state.reviewed[index];
  else state.reviewed[index] = new Date().toISOString();
  const all = { ...(state.reviewedAll ?? {}), [id]: state.reviewed };
  state.reviewedAll = all;
  await putMeta('reviewed', all);
  renderTracks();
};

const refreshPublish = () => {
  $('#publish').disabled = !currentSession().canPush || !hasChanges();
};

const saveDraft = async () => {
  if (!state.episode) return;
  const payload = {
    edits: [...state.edits.entries()],
    title: $('#episode-title').value,
    titleDirty: state.titleDirty,
    at: new Date().toISOString(),
  };
  await putDraft(state.episode.id, payload);
};

const scheduleDraftSave = () => {
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(saveDraft, 500);
};

const markDirty = () => {
  state.dirty = true;
  scheduleDraftSave();
  refreshPublish();
  const count = state.edits.size;
  notify(
    count > 0
      ? `szkic: ${count} zmienionych wierszy — publikacja wyśle jeden commit na main`
      : 'zmiana tytułu — publikacja zapisze ją w data/titles.json'
  );
};

// Slug ma myślniki, więc „11 listopada” musi trafić w „11-listopada” — sprowadzamy oba
// teksty do tej samej postaci, zamiast wymagać od użytkownika znajomości slugu.
const searchKey = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const renderList = () => {
  const filter = searchKey($('#filter').value);
  const items = (state.catalog?.episodes ?? []).filter(
    (episode) => !filter || searchKey(`${episode.date} ${shownTitle(episode)} ${slugOf(episode)}`).includes(filter)
  );
  const list = $('#episodes');
  list.innerHTML = '';
  for (const episode of items) {
    const li = document.createElement('li');
    if (state.episode?.id === episode.id) li.className = 'active';
    const button = document.createElement('button');
    button.type = 'button';
    const time = document.createElement('time');
    time.textContent = episode.date ?? '';
    const label = document.createElement('span');
    label.textContent = shownTitle(episode);
    button.append(time, label);
    button.addEventListener('click', () => void openEpisode(episode).catch((error) => setStatus(error.message, 'error')));
    li.append(button);
    list.append(li);
  }
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'brak odcinków';
    list.append(empty);
  }
};

const timeInput = (track, field, fix) => {
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.value = fmtTime(fix[field] ?? track[field]);
  input.addEventListener('change', () => {
    const seconds = parseTime(input.value);
    if (!Number.isFinite(seconds)) {
      input.value = fmtTime(fix[field] ?? track[field]);
      notify('czas musi być liczbą sekund albo mm:ss', 'error');
      return;
    }
    const index = state.episode.tracks.indexOf(track);
    const target = editFor(index);
    target[field] = Math.round(seconds * 100) / 100;
    const start = target.start ?? track.start;
    const end = target.end ?? track.end;
    if (Number.isFinite(start) && Number.isFinite(end)) target.durationSec = Math.round((end - start) * 100) / 100;
    markDirty();
  });
  return input;
};

const textInput = (track, display, newField, baseField) => {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = display ?? '';
  input.addEventListener('change', () => {
    const index = state.episode.tracks.indexOf(track);
    const target = editFor(index);
    if (input.value.trim() === String(track[baseField] ?? '').trim()) delete target[newField];
    else target[newField] = input.value.trim();
    prune(target);
    if (Object.keys(target).length <= Object.keys(identityFix(track)).length) {
      const clean = state.edits.get(index);
      for (const key of [newField]) if (clean) delete clean[key];
    }
    markDirty();
  });
  return input;
};

const cell = (content, className = '') => {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.append(content);
  return td;
};

const renderTracks = () => {
  const body = $('#tracks');
  body.innerHTML = '';

  (state.episode?.tracks ?? []).forEach((track, index) => {
    const fix = fixFor(index);
    const tr = document.createElement('tr');
    if (fix.hide) tr.className = 'hidden-track';

    const done = document.createElement('input');
    done.type = 'checkbox';
    done.className = 'done';
    done.checked = Boolean(state.reviewed?.[index]);
    done.title = 'przejrzane na tym urządzeniu';
    done.addEventListener('change', () => void toggleReviewed(index));
    const doneCell = document.createElement('td');
    doneCell.className = 'done-cell';
    doneCell.append(done);

    tr.append(
      doneCell,
      cell(timeInput(track, 'start', fix), 'num'),
      cell(timeInput(track, 'end', fix), 'num'),
      cell(textInput(track, fix.newArtist ?? track.artist, 'newArtist', 'artist')),
      cell(textInput(track, fix.newTitle ?? track.title, 'newTitle', 'title')),
      cell(textInput(track, fix.newAlbum ?? track.album, 'newAlbum', 'album'))
    );

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'ghost small';
    action.textContent = fix.hide ? 'przywróć' : 'ukryj';
    action.addEventListener('click', () => {
      const target = editFor(index);
      if (fix.hide) delete target.hide;
      else target.hide = true;
      prune(target);
      markDirty();
      renderTracks();
    });
    tr.append(cell(action, 'num'));
    body.append(tr);
  });

  const total = (state.episode?.tracks ?? []).length;
  $('#progress').textContent = total > 0 ? `przejrzane ${reviewedCount()}/${total}` : '';
  refreshPublish();
};

const renderWave = () => {
  const audio = $('#audio');
  drawWaveform($('#wave'), state.peaks, PER_SEC, state.episode?.durationSec ?? 0, audio.currentTime ?? 0);
};

const openEpisode = async (episode) => {
  state.episode = episode;
  state.edits = new Map();
  state.override = null;
  state.peaks = null;
  state.titleDirty = false;
  state.dirty = false;
  $('#editor').hidden = false;
  renderList();
  $('#episode-title').value = shownTitle(episode);
  $('#episode-meta').textContent = `${slugOf(episode)} · ${fmtTime(episode.durationSec)} · ${episode.audioUrl ? 'audio gotowe' : 'brak audio'}`;
  notify('wczytuję odcinek…');

  const [file, override, peaks, draft] = await Promise.all([
    loadJson(`data/episodes/${episode.id}.json`),
    loadJson(`data/overrides/${episode.id}.json`).catch(() => null),
    loadPeaks(episode.id).catch(() => null),
    getDraft(episode.id),
  ]);
  if (!file) throw new Error('nie ma pliku odcinka');

  state.episode = { ...file, ...episode };
  state.override = override;
  state.peaks = peaks;
  state.reviewedAll = (await getMeta('reviewed'))?.value ?? {};
  state.reviewed = state.reviewedAll[episode.id] ?? {};

  if (draft?.payload?.edits?.length) {
    state.edits = new Map(draft.payload.edits);
    if (draft.payload.title) $('#episode-title').value = draft.payload.title;
    state.titleDirty = Boolean(draft.payload.titleDirty);
    notify(`przywrócony szkic z ${new Date(draft.at).toLocaleString('pl-PL')} — publikacja albo „odrzuć szkic”`);
  }

  const audio = $('#audio');
  audio.src = episode.audioUrl ?? '';
  audio.load();
  renderTracks();
  renderWave();
  notify(peaks ? 'waveform z repozytorium' : 'brak pliku waveformu — czasy wpisujemy ręcznie');
};

const publish = async () => {
  if (!state.episode || !hasChanges()) return;
  const title = $('#episode-title').value.trim();
  const payload = {
    id: state.episode.id,
    title,
    tracks: [...state.edits.values()].map((fix) => prune({ ...fix })),
    topics: [],
    addTracks: [],
    addTopics: [],
  };
  const invalid = validateSavePayload(payload);
  if (invalid) return notify(invalid, 'error');

  // Poprawki czytamy fresh: scalanie ze stanem z otwarcia odcinka cofałoby zmiany
  // zrobione w międzyczasie gdzie indziej.
  const [freshOverride, freshTitles] = await Promise.all([
    loadJsonFresh(`data/overrides/${state.episode.id}.json`).catch(() => state.override),
    loadJsonFresh('data/titles.json').catch(() => state.titles),
  ]);
  state.override = freshOverride ?? null;
  state.titles = freshTitles ?? state.titles;

  const next = mergeOverrides(state.override, payload);
  // Strażnik przed produkcją: plik, którego nie przyjmie schemat strony, wywaliłby build.
  const problems = validateOverride(next, { durationSec: state.episode.durationSec ?? 0 });
  if (problems.length) return notify(`nie publikuję — ${problems.slice(0, 3).join('; ')}`, 'error');

  const effective = state.episode && applyOverrides(state.episode, next);
  const timeProblems = effective ? validateTrackTimes(effective.tracks, { durationSec: state.episode.durationSec ?? 0 }) : [];
  if (timeProblems.length) return notify(`nie publikuję — ${timeProblems.slice(0, 3).join('; ')}`, 'error');
  const files = {};
  files[`data/overrides/${state.episode.id}.json`] = `${JSON.stringify(next, null, 2)}\n`;

  const titles = structuredClone(state.titles ?? { version: 1, titles: {} });
  titles.titles = titles.titles ?? {};
  if (title && title !== officialTitle(state.episode)) {
    titles.titles[state.episode.id] = {
      title,
      kind: 'unofficial',
      originalTitle: officialTitle(state.episode),
      note: 'Tytuł redakcyjny ustawiony ręcznie w edytorze.',
    };
  } else {
    delete titles.titles[state.episode.id];
  }
  files['data/titles.json'] = `${JSON.stringify(titles, null, 2)}\n`;

  $('#publish').disabled = true;
  notify('publikuję…');
  try {
    const result = await publishChanges(`fix(dane): ${slugOf(state.episode)} — edycja z edytora online`, files);
    state.override = next;
    state.titles = titles;
    state.edits = new Map();
    state.titleDirty = false;
    state.dirty = false;
    clearTimeout(state.draftTimer); // odroczony zapis nie może wskrzesić usuniętego szkicu
    await deleteDraft(state.episode.id);
    renderList();
    renderTracks();
    notify(`zapisane: ${result.url}`);
    setStatus(`zalogowany jako ${currentSession().login}`, 'ok');
  } catch (error) {
    notify(error.message, 'error');
    refreshPublish();
  }
};

const bootAuth = () => {
  const session = currentSession();
  const signedIn = session.canPush;
  setStatus(signedIn ? `zalogowany jako ${session.login}` : 'niezalogowany — tylko odczyt', signedIn ? 'ok' : '');
  $('#sign-in').hidden = signedIn;
  $('#sign-out').hidden = !signedIn;
  refreshPublish();
};

const openLogin = () => {
  $('#login-error').textContent = '';
  $('#device').hidden = true;
  $('#login-token').hidden = false;
  $('#token').value = '';
  const hasApp = Boolean(config.clientId);
  $('#login-device').hidden = !hasApp;
  $('#login-intro').textContent = hasApp
    ? 'Zaloguj przez GitHub albo wklej token ograniczony do tego repozytorium (contents: read and write).'
    : 'Aplikacja GitHub nie jest zarejestrowana (brak client_id w config.js) — wklej token z prawem zapisu do tego repozytorium.';
  $('#login').showModal();
};

const waitForDevice = async (device) => {
  $('#device').hidden = false;
  $('#login-token').hidden = true;
  $('#device-code').textContent = device.user_code;
  $('#device-link').href = device.verification_uri;
  $('#device-wait').textContent = 'czekam na zatwierdzenie…';
  const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
  let interval = (device.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    try {
      if (await pollDeviceToken(device.device_code)) {
        $('#login').close();
        bootAuth();
        return;
      }
    } catch (error) {
      if (/slow_down/i.test(error.message)) {
        interval += 5000;
        continue;
      }
      $('#login-error').textContent = error.message;
      return;
    }
  }
  $('#login-error').textContent = 'kod wygasł — spróbuj ponownie';
};

const bind = () => {
  $('#filter').addEventListener('input', renderList);
  $('#sign-in').addEventListener('click', openLogin);
  $('#sign-out').addEventListener('click', () => {
    signOut();
    bootAuth();
  });
  $('#publish').addEventListener('click', () => void publish());
  $('#login-token').addEventListener('click', async () => {
    try {
      await signInWithToken($('#token').value);
      $('#login').close();
      bootAuth();
      if (hasChanges()) notify('zalogowany — szkic czeka na publikację');
    } catch (error) {
      $('#login-error').textContent = error.message;
    }
  });
  $('#login-device').addEventListener('click', async () => {
    try {
      void waitForDevice(await startDeviceFlow());
    } catch (error) {
      $('#login-error').textContent = error.message;
    }
  });
  $('#episode-title').addEventListener('change', () => {
    state.titleDirty = $('#episode-title').value.trim() !== shownTitle(state.episode ?? {});
    state.dirty = true;
    refreshPublish();
    if (state.titleDirty) notify('tytuł zmieniony — publikacja zapisze go w data/titles.json');
  });

  const audio = $('#audio');
  audio.addEventListener('timeupdate', renderWave);
  audio.addEventListener('seeked', renderWave);
  audio.addEventListener('loadedmetadata', renderWave);
  $('#wave').addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const duration = audio.duration || state.episode?.durationSec || 0;
    if (duration > 0) audio.currentTime = Math.max(0, Math.min(duration, ratio * duration));
  });

  $('#discard').addEventListener('click', async () => {
    if (!state.episode) return;
    clearTimeout(state.draftTimer);
    await deleteDraft(state.episode.id);
    const episode = state.episode;
    await openEpisode(episode);
    notify('szkic odrzucony');
  });

  window.addEventListener('edytor:plik-odswiezony', (event) => {
    const path = event.detail?.path;
    if (path === 'data/catalog.json') {
      void loadJson(path).then((catalog) => {
        if (!catalog) return;
        state.catalog = catalog;
        renderList();
        notify('katalog odświeżony w tle');
      });
    }
  });

  window.addEventListener('resize', renderWave);
  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) event.preventDefault();
  });
};

const load = async () => {
  bind();
  bootAuth();
  const [catalog, titles, pkg] = await Promise.all([
    loadJson('data/catalog.json'),
    loadJson('data/titles.json').catch(() => null),
    loadJsonFresh('package.json').catch(() => null),
  ]);
  if (!catalog) throw new Error('nie mogę wczytać katalogu odcinków');
  state.catalog = catalog;
  state.titles = titles;
  if (pkg?.version) $('#version').textContent = `v${pkg.version}`;
  renderList();
};

void load().catch((error) => setStatus(`błąd: ${error.message}`, 'error'));
