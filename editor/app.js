import {
  compact,
  mergeOverrides,
  normalize,
  same,
  validateOverride,
  validateSavePayload,
  validateTrackTimes,
} from './lib/overrides.mjs';
import {
  currentSession,
  pollDeviceToken,
  publishChanges,
  signInWithToken,
  signOut,
  startDeviceFlow,
  verifySession,
} from './github.js';
import { deleteDraft, getDraft, putDraft } from './store.js';
import { loadJson, loadJsonFresh } from './source.js';
import { config } from './config.js';
import { clampView, drawWaveform, loadPeaks } from './peaks.js';
import {
  aliasCandidates,
  aliasFileKey,
  aliasProblems,
  collectLabels,
  emptyAliasFile,
  normalizeAliasFile,
  resolveAlias,
  TAG_TYPES,
  tagRows,
} from './lib/aliases.mjs';

const $ = (selector) => document.querySelector(selector);

const PER_SEC = 20;
const MIN_FRAGMENT = 1;

const state = {
  catalog: null,
  titles: null,
  episode: null,
  override: null,
  // Model jak w lokalnym edytorze: efektywne listy utworów i wejść (baza + poprawki),
  // osobno dodane pozycje i znaczniki ukrycia. Publikacja liczy różnice względem pliku
  // odcinka, więc nie zapisuje pól, których nikt nie ruszył.
  baseTracks: [],
  baseTopics: [],
  tracks: [],
  topics: [],
  addTracks: [],
  addTopics: [],
  baseline: '',
  selected: null,
  peaks: null,
  titleDirty: false,
  dirty: false,
  // Znaczniki „przejrzane” kluczowane etykietą fragmentu (t:wykonawca|tytuł, p:etykieta),
  // tak jak w `data/reviewed.json`. Repo jest źródłem prawdy, `reviewTouched` trzyma
  // tylko niezapisane zmiany.
  repoReviewed: new Set(),
  reviewTouched: new Map(),
  reviewedFile: null,
  wave: { start: 0, span: 0 },
  draftTimer: null,
  // Etykiety liczone z odcinków pobranych przez klienta odczytu; `aliasBase` to
  // znormalizowany stan z repozytorium, więc porównanie wykrywa cudzą zmianę.
  labels: null,
  aliasDraft: null,
  aliasBaseFile: null,
  aliasBase: null,
  tagsBusy: false,
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

const fmtPrecise = (seconds) => {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = (total % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
};

const parseTime = (value) => {
  const text = String(value).trim();
  if (!text) return Number.NaN;
  if (!text.includes(':')) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
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
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'brak odcinków';
    list.append(li);
  }
};

const trackEnd = (track) => {
  const start = Number(track.start);
  if (Number.isFinite(track.end) && track.end > start) return track.end;
  if (Number(track.durationSec) > 0) return start + Number(track.durationSec);
  return null;
};

const sameTrackIdentity = (left, right) =>
  same(left.artist, right.artist) && same(left.title, right.title) && same(left.album ?? '', right.album ?? '');

/** Efektywne listy: plik odcinka z nałożonymi poprawkami. Ukryte pozycje zostają
 * w listach z `_hidden`, bo edytor musi pozwolić je przywrócić. */
const buildEffective = (file, override) => {
  const tracks = (file.tracks ?? []).map((track) => ({ ...track }));
  const topics = (file.topics ?? []).map((topic) => ({ ...topic }));
  for (const fix of override?.tracks ?? []) {
    const track = tracks.find((candidate) => sameTrackIdentity(candidate, fix));
    if (!track) continue;
    if (fix.start !== undefined) track.start = fix.start;
    if (fix.durationSec !== undefined) track.durationSec = fix.durationSec;
    if (fix.end !== undefined) track.end = fix.end;
    if (fix.newArtist !== undefined) track.artist = fix.newArtist;
    if (fix.newTitle !== undefined) track.title = fix.newTitle;
    if (fix.newAlbum !== undefined) track.album = fix.newAlbum;
    if (fix.hide) track._hidden = true;
  }
  for (const fix of override?.topics ?? []) {
    const topic = topics.find((candidate) => candidate.start === fix.time && same(candidate.label, fix.label));
    if (!topic) continue;
    if (fix.start !== undefined) topic.start = fix.start;
    if (fix.end !== undefined) topic.end = fix.end;
    if (fix.newLabel) topic.label = fix.newLabel;
    if (fix.hide) topic._hidden = true;
  }
  return { tracks, topics };
};

const fragments = () => {
  const list = [];
  const push = (object, kind, source) => {
    if (!Number.isFinite(Number(object.start))) return;
    list.push({ object, kind, source });
  };
  for (const track of state.tracks) push(track, 'track', 'base');
  for (const track of state.addTracks) push(track, 'track', 'added');
  for (const topic of state.topics) push(topic, 'topic', 'base');
  for (const topic of state.addTopics) push(topic, 'topic', 'added');
  return list.sort((left, right) => Number(left.object.start) - Number(right.object.start));
};

const fragmentEnd = (fragment) => {
  const start = Number(fragment.object.start);
  const next = fragments()
    .filter((candidate) => candidate.object !== fragment.object && Number(candidate.object.start) > start + 0.001)
    .sort((left, right) => Number(left.object.start) - Number(right.object.start))[0];
  if (next) return Number(next.object.start);
  const explicit = fragment.kind === 'track' ? trackEnd(fragment.object) : Number(fragment.object.end);
  if (Number.isFinite(explicit) && explicit > start) return explicit;
  return state.episode?.durationSec ?? null;
};

const fragmentName = (fragment) =>
  fragment.kind === 'topic'
    ? fragment.object.label?.trim() || 'wejście bez etykiety'
    : `${fragment.object.artist?.trim() || 'bez wykonawcy'} — ${fragment.object.title?.trim() || 'bez tytułu'}`;

const reviewKeyOf = (fragment) => {
  if (fragment.kind === 'topic') {
    const label = normalize(fragment.object.label);
    return label ? `p:${label}` : `p:${Number(fragment.object.start).toFixed(2)}`;
  }
  const name = [normalize(fragment.object.artist), normalize(fragment.object.title)].filter(Boolean).join('|');
  return name ? `t:${name}` : `t:${Number(fragment.object.start).toFixed(2)}`;
};

const isReviewed = (fragment) => {
  const key = reviewKeyOf(fragment);
  return state.reviewTouched.has(key) ? state.reviewTouched.get(key) : state.repoReviewed.has(key);
};

const snapshot = () =>
  JSON.stringify({
    tracks: state.tracks,
    topics: state.topics,
    addTracks: state.addTracks,
    addTopics: state.addTopics,
  });

const hasChanges = () => snapshot() !== state.baseline || state.titleDirty || state.reviewTouched.size > 0;

const refreshPublish = () => {
  $('#publish').disabled = !currentSession().canPush || !hasChanges();
};

const saveDraft = async () => {
  if (!state.episode) return;
  const payload = {
    tracks: state.tracks,
    topics: state.topics,
    addTracks: state.addTracks,
    addTopics: state.addTopics,
    title: $('#episode-title').value,
    titleDirty: state.titleDirty,
    reviewed: [...state.reviewTouched.entries()],
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
  const changes = snapshot() !== state.baseline;
  if (changes) notify('szkic: zmiany czekają — publikacja wyśle jeden commit na main');
  else if (state.titleDirty) notify('zmiana tytułu — publikacja zapisze ją w data/titles.json');
  else if (state.reviewTouched.size > 0) notify('zmiana znaczników „ok” — publikacja zapisze ją w data/reviewed.json');
};

// ——— Tytuł: oficjalny kontra nasz nieoficjalny ———

const officialTitleOf = () => state.episode?.title ?? '';

const renderTitle = () => {
  const unofficial = state.titles?.titles?.[state.episode?.id]?.title;
  const input = $('#episode-title');
  input.value = unofficial ?? officialTitleOf();
  $('#title-kind').textContent = unofficial ? 'nieoficjalny' : 'oficjalny';
  $('#title-kind').className = `badge ${unofficial ? 'unofficial' : ''}`;
  $('#title-hint').textContent = unofficial
    ? `zastępuje oficjalny: „${officialTitleOf()}” — wyczyść pole, żeby wrócić do oficjalnego`
    : 'tytuł z katalogu; wpisz własny, żeby go zastąpić (puste albo bez zmian = zostaje oficjalny)';
  state.titleDirty = false;
};

// ——— Rysowanie tabel ———

const fieldInput = (object, field, { placeholder = '', numeric = false } = {}) => {
  const input = document.createElement('input');
  input.type = 'text';
  if (numeric) input.inputMode = 'decimal';
  input.value = numeric ? fmtTime(object[field]) : (object[field] ?? '');
  input.placeholder = placeholder;
  input.addEventListener('input', () => {
    if (numeric) {
      const seconds = parseTime(input.value);
      if (!Number.isFinite(seconds)) return;
      if (object[field] === seconds) return;
      // Jak w lokalnym edytorze: „ok” dotyczy początku fragmentu, więc tylko zmiana
      // `start` je zdejmuje; poprawa końca nie unieważnia sprawdzenia.
      const key = field === 'start' ? reviewKeyOf({ object, kind: 'label' in object ? 'topic' : 'track' }) : null;
      object[field] = Math.round(seconds * 100) / 100;
      clearReviewedOnMove(key);
    } else {
      object[field] = input.value;
    }
    markDirty();
    renderWave();
  });
  return input;
};

const takeTimeButton = (object) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small';
  button.textContent = 'weź';
  button.title = 'wpisz czas odtwarzania';
  button.addEventListener('click', () => {
    const key = reviewKeyOf({ object, kind: 'label' in object ? 'topic' : 'track' });
    object.start = Math.round(($('#audio').currentTime ?? 0) * 100) / 100;
    clearReviewedOnMove(key);
    markDirty();
    renderEpisode();
  });
  return button;
};

const playButton = (object) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small';
  button.textContent = '▶';
  button.title = 'przewiń do początku';
  button.addEventListener('click', () => seek(Number(object.start)));
  return button;
};

const hideButton = (object, rerender) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small';
  button.textContent = object._hidden ? 'przywróć' : 'ukryj';
  button.addEventListener('click', () => {
    object._hidden = !object._hidden;
    markDirty();
    rerender();
    renderWave();
  });
  return button;
};

const deleteButton = (list, object, rerender) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small';
  button.textContent = 'usuń';
  button.addEventListener('click', () => {
    const index = list.indexOf(object);
    if (index >= 0) list.splice(index, 1);
    markDirty();
    rerender();
    renderWave();
  });
  return button;
};

const reviewCell = (fragment, rerender) => {
  const td = document.createElement('td');
  td.className = 'done-cell';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'done';
  box.checked = isReviewed(fragment);
  box.title = 'oznacz jako sprawdzone (ok)';
  box.addEventListener('change', () => {
    toggleReviewed(fragment);
    rerender();
  });
  td.append(box);
  return td;
};

const row = (cells) => {
  const tr = document.createElement('tr');
  tr.append(...cells);
  return tr;
};

const cellOf = (content, className = '') => {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (Array.isArray(content)) td.append(...content);
  else td.append(content);
  return td;
};

const renderTracks = () => {
  const body = $('#tracks');
  body.innerHTML = '';
  state.tracks.forEach((track) => {
    const fragment = { object: track, kind: 'track', source: 'base' };
    const end = fragmentEnd(fragment);
    const tr = row([
      reviewCell(fragment, renderTracks),
      cellOf(fieldInput(track, 'start', { numeric: true }), 'num'),
      cellOf(fieldInput(track, 'end', { numeric: true }), 'num'),
      cellOf(fieldInput(track, 'artist', { placeholder: 'wykonawca' })),
      cellOf(fieldInput(track, 'title', { placeholder: 'tytuł' })),
      cellOf(fieldInput(track, 'album', { placeholder: '(brak)' })),
      cellOf([takeTimeButton(track), playButton(track), hideButton(track, renderTracks)], 'actions'),
    ]);
    if (track._hidden) tr.className = 'hidden-track';
    if (end !== null && Number.isFinite(end) && Number.isFinite(Number(track.start))) {
      tr.dataset.end = String(end);
    }
    body.append(tr);
  });
  if (!state.tracks.length) body.append(row([cellOf('brak utworów w opracowaniu')]));
};

const renderTopics = () => {
  const body = $('#topics');
  body.innerHTML = '';
  state.topics.forEach((topic) => {
    const fragment = { object: topic, kind: 'topic', source: 'base' };
    const tr = row([
      reviewCell(fragment, renderTopics),
      cellOf(fieldInput(topic, 'start', { numeric: true }), 'num'),
      cellOf(fieldInput(topic, 'label', { placeholder: 'etykieta wejścia' })),
      cellOf([takeTimeButton(topic), playButton(topic), hideButton(topic, renderTopics)], 'actions'),
    ]);
    if (topic._hidden) tr.className = 'hidden-track';
    body.append(tr);
  });
  if (!state.topics.length) body.append(row([cellOf('brak wejść w opracowaniu')]));
};

const renderAdded = () => {
  const trackBody = $('#add-tracks');
  trackBody.innerHTML = '';
  state.addTracks.forEach((track) => {
    const fragment = { object: track, kind: 'track', source: 'added' };
    trackBody.append(
      row([
        reviewCell(fragment, renderAdded),
        cellOf(fieldInput(track, 'start', { numeric: true }), 'num'),
        cellOf(fieldInput(track, 'end', { numeric: true }), 'num'),
        cellOf(fieldInput(track, 'artist', { placeholder: 'wykonawca' })),
        cellOf(fieldInput(track, 'title', { placeholder: 'tytuł' })),
        cellOf(fieldInput(track, 'album', { placeholder: '(brak)' })),
        cellOf([takeTimeButton(track), playButton(track), deleteButton(state.addTracks, track, renderAdded)], 'actions'),
      ])
    );
  });
  if (!state.addTracks.length) {
    trackBody.append(row([cellOf('brak dodanych utworów', 'muted')]));
  }

  const topicBody = $('#add-topics');
  topicBody.innerHTML = '';
  state.addTopics.forEach((topic) => {
    const fragment = { object: topic, kind: 'topic', source: 'added' };
    topicBody.append(
      row([
        reviewCell(fragment, renderAdded),
        cellOf(fieldInput(topic, 'start', { numeric: true }), 'num'),
        cellOf(fieldInput(topic, 'label', { placeholder: 'etykieta wejścia' })),
        cellOf([takeTimeButton(topic), playButton(topic), deleteButton(state.addTopics, topic, renderAdded)], 'actions'),
      ])
    );
  });
  if (!state.addTopics.length) {
    topicBody.append(row([cellOf('brak dodanych wejść', 'muted')]));
  }
};

const renderProgress = () => {
  const all = fragments();
  const ok = all.filter(isReviewed).length;
  $('#progress').textContent = all.length > 0 ? `przejrzane ${ok}/${all.length}` : '';
  $('#wave-count').textContent = all.length > 0 ? `${ok} z ${all.length} ok` : '';
};

const markerNodes = [];

const positionMarkers = () => {
  const stage = $('#wave-stage');
  const width = stage.clientWidth || 1;
  for (const { fragment, node } of markerNodes) {
    const time = Number(fragment.object.start);
    const x = ((time - state.wave.start) / state.wave.span) * width;
    node.hidden = x < -20 || x > width + 20;
    node.style.left = `${x}px`;
    node.classList.toggle('is-topic', fragment.kind === 'topic');
    node.classList.toggle('is-reviewed', isReviewed(fragment));
    node.classList.toggle('is-selected', state.selected?.object === fragment.object);
    const label = `${fragmentName(fragment)}, ${fmtPrecise(time)} — przeciągnij, żeby przesunąć; klik = przewiń`;
    node.title = label;
    node.setAttribute('aria-label', label);
  }
};

const renderMarkers = () => {
  const layer = $('#wave-markers');
  layer.innerHTML = '';
  markerNodes.length = 0;
  for (const fragment of fragments()) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'wave-marker';
    const line = document.createElement('span');
    line.className = 'wave-marker-line';
    const dot = document.createElement('span');
    dot.className = 'wave-marker-dot';
    node.append(line, dot);
    node.addEventListener('pointerdown', (event) => startMarkerDrag(event, fragment, node));
    layer.append(node);
    markerNodes.push({ fragment, node });
  }
  positionMarkers();
};

const startMarkerDrag = (event, fragment, node) => {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();
  selectFragment(fragment);
  const stage = $('#wave-stage');
  const rect = stage.getBoundingClientRect();
  const startX = event.clientX;
  const startValue = Number(fragment.object.start);
  let moved = false;
  node.setPointerCapture(event.pointerId);
  node.classList.add('is-dragging');
  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    if (!moved && Math.abs(dx) > 2) moved = true;
    if (!moved) return;
    moveFragmentStart(fragment, startValue + (dx / rect.width) * state.wave.span);
  };
  const onUp = () => {
    node.classList.remove('is-dragging');
    node.removeEventListener('pointermove', onMove);
    node.removeEventListener('pointerup', onUp);
    if (!moved) seek(Number(fragment.object.start));
  };
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
};

const renderWave = () => {
  const audio = $('#audio');
  const duration = state.episode?.durationSec ?? 0;
  state.wave = clampView(state.wave, duration);
  drawWaveform($('#wave'), {
    peaks: state.peaks,
    perSec: PER_SEC,
    durationSec: duration,
    view: state.wave,
    positionSec: audio.currentTime ?? 0,
  });
  positionMarkers();
  $('#wave-window').textContent = state.peaks
    ? `${fmtTime(state.wave.start)} – ${fmtTime(state.wave.start + state.wave.span)}`
    : '';
  renderProgress();
};

const renderEpisode = () => {
  renderTracks();
  renderTopics();
  renderAdded();
  renderMarkers();
  renderWave();
  refreshPublish();
};

// ——— Zaznaczanie i przesuwanie znaczników ———

const selectFragment = (fragment) => {
  state.selected = fragment;
  if (fragment) {
    state.wave = clampView(
      { start: Number(fragment.object.start) - state.wave.span / 2, span: state.wave.span },
      state.episode?.durationSec ?? 0
    );
    notify(`wybrany: ${fragmentName(fragment)} — Shift+Enter = ok, Del = usuń, ←/→ = przesuń`);
  }
  renderWave();
};

const moveFragmentStart = (fragment, requested) => {
  const list = fragments().sort((left, right) => Number(left.object.start) - Number(right.object.start));
  const index = list.findIndex((candidate) => candidate.object === fragment.object);
  const previous = index > 0 ? list[index - 1] : null;
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null;
  const low = previous ? Number(previous.object.start) + MIN_FRAGMENT : 0;
  const high = next ? Number(next.object.start) - MIN_FRAGMENT : (state.episode?.durationSec ?? requested);
  const value = Math.round(Math.min(Math.max(requested, low), Math.max(low, high)) * 100) / 100;
  if (value === Number(fragment.object.start)) return;
  const key = reviewKeyOf(fragment);
  fragment.object.start = value;
  clearReviewedOnMove(key);
  markDirty();
  renderWave();
};

const clearReviewedOnMove = (key) => {
  if (!key) return;
  if (state.repoReviewed.has(key)) state.repoReviewed.delete(key);
  if (state.reviewTouched.get(key) === true) state.reviewTouched.set(key, false);
  else if (!state.repoReviewed.has(key) && !state.reviewTouched.has(key)) return;
};

const toggleReviewed = (fragment) => {
  const key = reviewKeyOf(fragment);
  state.reviewTouched.set(key, !isReviewed(fragment));
  markDirty();
  renderWave();
};

const removeSelected = () => {
  const fragment = state.selected;
  if (!fragment) return;
  if (fragment.source === 'added') {
    const list = fragment.kind === 'track' ? state.addTracks : state.addTopics;
    const index = list.indexOf(fragment.object);
    if (index >= 0) list.splice(index, 1);
  } else {
    fragment.object._hidden = true;
  }
  state.selected = null;
  markDirty();
  renderEpisode();
};

const addTrackAt = (time) => {
  const track = { artist: '', title: '', album: null, start: Math.round(time * 100) / 100, durationSec: 0 };
  state.addTracks.push(track);
  state.selected = { object: track, kind: 'track', source: 'added' };
  markDirty();
  renderEpisode();
  const inputs = document.querySelectorAll('#add-tracks tr:last-child input');
  inputs[3]?.focus();
};

const addTopicAt = (time) => {
  const topic = { label: '', start: Math.round(time * 100) / 100 };
  state.addTopics.push(topic);
  state.selected = { object: topic, kind: 'topic', source: 'added' };
  markDirty();
  renderEpisode();
  const inputs = document.querySelectorAll('#add-topics tr:last-child input');
  inputs[2]?.focus();
};

const playheadTime = () => $('#audio').currentTime ?? 0;

const nextUnreviewed = (direction) => {
  const list = fragments()
    .filter((fragment) => !isReviewed(fragment))
    .sort((left, right) => Number(left.object.start) - Number(right.object.start));
  if (!list.length) return notify('wszystkie znaczniki mają ok');
  const now = Number(state.selected?.object.start ?? playheadTime());
  const next =
    direction > 0
      ? list.find((fragment) => Number(fragment.object.start) > now + 0.01) ?? list[0]
      : [...list].reverse().find((fragment) => Number(fragment.object.start) < now - 0.01) ?? list.at(-1);
  selectFragment(next);
};

// ——— Publikacja ———

const buildPayload = () => {
  const tracks = [];
  state.tracks.forEach((track, index) => {
    const base = state.baseTracks[index];
    if (!base) return;
    const fix = { artist: base.artist, title: base.title };
    if (base.album !== undefined && base.album !== null) fix.album = base.album;
    let changed = false;
    if (track.start !== base.start) {
      fix.start = track.start;
      changed = true;
    }
    if (track.durationSec !== base.durationSec) {
      fix.durationSec = track.durationSec;
      changed = true;
    }
    if (track.end !== base.end) {
      fix.end = track.end;
      changed = true;
    }
    if (track.artist !== base.artist) {
      fix.newArtist = track.artist;
      changed = true;
    }
    if (track.title !== base.title) {
      fix.newTitle = track.title;
      changed = true;
    }
    if ((track.album ?? null) !== (base.album ?? null)) {
      fix.newAlbum = track.album ?? null;
      changed = true;
    }
    if (track._hidden) {
      fix.hide = true;
      changed = true;
    }
    if (changed) tracks.push(compact(fix));
  });

  const topics = [];
  state.topics.forEach((topic, index) => {
    const base = state.baseTopics[index];
    if (!base) return;
    const fix = { time: base.start, label: base.label };
    let changed = false;
    if (topic.start !== base.start) {
      fix.start = topic.start;
      changed = true;
    }
    if (topic.end !== base.end) {
      fix.end = topic.end;
      changed = true;
    }
    if (topic.label !== base.label) {
      fix.newLabel = topic.label;
      changed = true;
    }
    if (topic._hidden) {
      fix.hide = true;
      changed = true;
    }
    if (changed) topics.push(compact(fix));
  });

  return {
    id: state.episode.id,
    title: $('#episode-title').value.trim(),
    tracks,
    topics,
    addTracks: state.addTracks.map((track) => {
      const end = Number(track.end);
      const durationSec = Number.isFinite(end) && end > Number(track.start) ? end - Number(track.start) : Number(track.durationSec) || 0;
      return compact({
        artist: track.artist.trim(),
        title: track.title.trim(),
        album: track.album?.trim() || undefined,
        start: Number(track.start),
        durationSec: Math.round(durationSec * 100) / 100,
      });
    }),
    addTopics: state.addTopics.map((topic) =>
      compact({
        label: topic.label.trim(),
        start: Number(topic.start),
        end: Number.isFinite(Number(topic.end)) ? Number(topic.end) : undefined,
      })
    ),
  };
};

const validateModel = (payload) => {
  const invalid = validateSavePayload(payload);
  if (invalid) return invalid;
  for (const track of payload.addTracks) {
    if (!track.artist || !track.title) return 'dodany utwór wymaga wykonawcy i tytułu';
    if (!Number.isFinite(track.start)) return 'dodany utwór wymaga początku';
  }
  for (const topic of payload.addTopics) {
    if (!topic.label) return 'dodane wejście wymaga etykiety';
    if (!Number.isFinite(topic.start)) return 'dodane wejście wymaga początku';
  }
  const effective = [
    ...state.tracks
      .filter((track) => !track._hidden)
      .map((track) => ({
        start: track.start,
        // Ręcznie wpisany koniec sprawdzamy nawet wtedy, gdy jest przed początkiem —
        // wtedy `trackEnd` po cichu wracałby do długości i przepuścił zły plik.
        end: Number.isFinite(track.end) ? track.end : track.durationSec > 0 ? Number(track.start) + Number(track.durationSec) : undefined,
        durationSec: track.durationSec,
      })),
    ...payload.addTracks.map((track) => ({ start: track.start, end: track.durationSec ? track.start + track.durationSec : undefined })),
  ];
  return validateTrackTimes(effective, { durationSec: state.episode.durationSec ?? 0 }).slice(0, 3).join('; ') || null;
};

const publish = async () => {
  if (!state.episode || !hasChanges()) return;
  const payload = buildPayload();
  const invalid = validateModel(payload);
  if (invalid) return notify(`nie publikuję — ${invalid}`, 'error');

  // Poprawki czytamy fresh: scalanie ze stanem z otwarcia odcinka cofałoby zmiany
  // zrobione w międzyczasie gdzie indziej.
  const [freshOverride, freshTitles, freshReviewed] = await Promise.all([
    loadJsonFresh(`data/overrides/${state.episode.id}.json`).catch(() => state.override),
    loadJsonFresh('data/titles.json').catch(() => state.titles),
    loadJsonFresh('data/reviewed.json').catch(() => state.reviewedFile),
  ]);
  state.override = freshOverride ?? null;
  state.titles = freshTitles ?? state.titles;

  const next = mergeOverrides(state.override, payload);
  // Strażnik przed produkcją: plik, którego nie przyjmie schemat strony, wywaliłby build.
  const problems = validateOverride(next, { durationSec: state.episode.durationSec ?? 0 });
  if (problems.length) return notify(`nie publikuję — ${problems.slice(0, 3).join('; ')}`, 'error');

  const files = {};
  files[`data/overrides/${state.episode.id}.json`] = `${JSON.stringify(next, null, 2)}\n`;

  const official = officialTitleOf();
  const titles = structuredClone(state.titles ?? { version: 1, titles: {} });
  titles.titles = titles.titles ?? {};
  if (payload.title && payload.title !== official) {
    titles.titles[state.episode.id] = {
      title: payload.title,
      kind: 'unofficial',
      originalTitle: official,
      note: 'Tytuł redakcyjny ustawiony ręcznie w edytorze.',
    };
  } else {
    delete titles.titles[state.episode.id];
  }
  files['data/titles.json'] = `${JSON.stringify(titles, null, 2)}\n`;

  if (state.reviewTouched.size > 0) {
    const reviewed = structuredClone(freshReviewed ?? { version: 1, episodes: {} });
    reviewed.version = 1;
    reviewed.episodes = reviewed.episodes ?? {};
    const marks = { ...(reviewed.episodes[state.episode.id] ?? {}) };
    for (const [key, on] of state.reviewTouched) {
      if (on) marks[key] = true;
      else delete marks[key];
    }
    if (Object.keys(marks).length > 0) reviewed.episodes[state.episode.id] = marks;
    else delete reviewed.episodes[state.episode.id];
    files['data/reviewed.json'] = `${JSON.stringify(reviewed, null, 2)}\n`;
    state.reviewedFile = reviewed;
  }

  $('#publish').disabled = true;
  notify('publikuję…');
  try {
    const result = await publishChanges(`fix(dane): ${slugOf(state.episode)} — edycja z edytora online`, files);
    state.override = next;
    state.titles = titles;
    state.repoReviewed = new Set(Object.keys(state.reviewedFile?.episodes?.[state.episode.id] ?? {}));
    state.reviewTouched = new Map();
    state.baseline = snapshot();
    state.titleDirty = false;
    state.dirty = false;
    clearTimeout(state.draftTimer); // odroczony zapis nie może wskrzesić usuniętego szkicu
    await deleteDraft(state.episode.id);
    renderTitle();
    renderList();
    renderEpisode();
    notify(`zapisane: ${result.url}`);
    setStatus(`zalogowany jako ${currentSession().login}`, 'ok');
  } catch (error) {
    if (!currentSession().canPush) bootAuth();
    notify(error.message, 'error');
    refreshPublish();
  }
};

const openEpisode = async (episode) => {
  state.episode = episode;
  state.selected = null;
  state.override = null;
  state.peaks = null;
  state.dirty = false;
  state.reviewTouched = new Map();
  $('#editor').hidden = false;
  renderList();
  $('#episode-meta').textContent = `${slugOf(episode)} · ${fmtTime(episode.durationSec)} · ${episode.audioUrl ? 'audio gotowe' : 'brak audio'}`;
  notify('wczytuję odcinek…');

  // Pliki odcinka czytamy bez pamięci: po własnej publikacji karta musi pokazać nowy
  // stan, a nie kopię sprzed commita. Cache zostaje jako ratunek bez sieci.
  const [file, override, peaks, reviewedFile, titles, draft] = await Promise.all([
    loadJsonFresh(`data/episodes/${episode.id}.json`).catch(() => loadJson(`data/episodes/${episode.id}.json`)),
    loadJsonFresh(`data/overrides/${episode.id}.json`).catch(() => loadJson(`data/overrides/${episode.id}.json`).catch(() => null)),
    loadPeaks(episode.id).catch(() => null),
    loadJsonFresh('data/reviewed.json').catch(() => loadJson('data/reviewed.json').catch(() => null)),
    loadJsonFresh('data/titles.json').catch(() => state.titles),
    getDraft(episode.id),
  ]);
  if (!file) throw new Error('nie ma pliku odcinka');

  // Plik opracowania jest źródłem prawdy (ma czasy i utwory), a katalog dokłada to,
  // czego w nim nie ma: slug, tytuł, `audioUrl`.
  state.episode = { ...episode, ...file };
  state.override = override;
  state.peaks = peaks;
  state.reviewedFile = reviewedFile;
  state.titles = titles ?? state.titles;
  state.repoReviewed = new Set(Object.keys(reviewedFile?.episodes?.[episode.id] ?? {}));
  state.baseTracks = (file.tracks ?? []).map((track) => ({ ...track }));
  state.baseTopics = (file.topics ?? []).map((topic) => ({ ...topic }));
  const effective = buildEffective(file, override);
  state.tracks = effective.tracks;
  state.topics = effective.topics;
  state.addTracks = (override?.addTracks ?? []).map((track) => ({ ...track }));
  state.addTopics = (override?.addTopics ?? []).map((topic) => ({ ...topic }));
  state.baseline = snapshot();
  state.wave = { start: 0, span: file.durationSec ?? episode.durationSec ?? 0 };

  renderTitle();
  if (draft?.payload) {
    const payload = draft.payload;
    if (Array.isArray(payload.tracks)) {
      state.tracks = payload.tracks;
      state.topics = payload.topics ?? [];
      state.addTracks = payload.addTracks ?? [];
      state.addTopics = payload.addTopics ?? [];
      if (payload.title) $('#episode-title').value = payload.title;
      state.titleDirty = Boolean(payload.titleDirty);
      state.reviewTouched = new Map(payload.reviewed ?? []);
      notify(`przywrócony szkic z ${new Date(draft.at).toLocaleString('pl-PL')} — publikacja albo „odrzuć szkic”`);
    }
  }

  // Adres tylko w `data-src`: 110-minutowy plik zaczyna się pobierać dopiero, gdy
  // użytkownik naprawdę kliknie play albo waveform.
  const audio = $('#audio');
  audio.removeAttribute('src');
  audio.dataset.src = episode.audioUrl ?? '';
  renderEpisode();
  notify(peaks ? 'waveform z repozytorium' : 'brak pliku waveformu — czasy wpisujemy ręcznie');
};

const seek = (seconds) => {
  const audio = $('#audio');
  if (!audio.getAttribute('src') && audio.dataset.src) {
    audio.src = audio.dataset.src;
    audio.load();
  }
  const duration = audio.duration || state.episode?.durationSec || 0;
  if (duration > 0) audio.currentTime = Math.max(0, Math.min(duration, seconds));
  renderWave();
};

const fetchEpisodes = async (entries, onProgress) => {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const episode = await loadJson(`data/episodes/${entry.id}.json`).catch(() => null);
      if (episode) out.push(episode);
      onProgress(out.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, () => worker()));
  return out;
};

const aliasDirty = () => state.aliasDraft !== null && aliasFileKey(state.aliasDraft) !== state.aliasBase;

const notifyAliases = (text, kind = '') => {
  const hint = $('#aliases-hint');
  hint.textContent = text;
  hint.className = `hint ${kind}`;
};

const refreshAliasSave = () => {
  $('#aliases-save').disabled = !currentSession().canPush || !aliasDirty();
};

const openTags = async () => {
  if (state.labels) return renderTags();
  if (state.tagsBusy) return;
  state.tagsBusy = true;
  const status = $('#tags-status');
  const entries = state.catalog?.episodes ?? [];
  try {
    // Aliasy czytamy bez pamięci: plik jest mały, a szkic oparty na nieaktualnej kopii
    // blokowałby zapis zaraz po własnej publikacji (i po przeładowaniu karty).
    const file = await loadJsonFresh('data/aliases.json').catch(() => loadJson('data/aliases.json').catch(() => null));
    const episodes = await fetchEpisodes(entries, (done) => {
      status.textContent = `pobieram odcinki… ${done}/${entries.length}`;
    });
    state.labels = collectLabels(episodes);
    state.aliasBaseFile = normalizeAliasFile(file ?? emptyAliasFile());
    state.aliasDraft = structuredClone(state.aliasBaseFile);
    state.aliasBase = aliasFileKey(state.aliasBaseFile);
    const missing = entries.length - episodes.length;
    status.textContent = `${episodes.length}/${entries.length} odcinków, ${state.labels.size} etykiet — dane z pamięci tej karty`;
    if (missing > 0) status.textContent += `; ${missing} plików się nie pobrało — odśwież stronę`;
    renderTags();
  } catch (error) {
    status.textContent = `nie udało się wczytać etykiet: ${error.message}`;
  } finally {
    state.tagsBusy = false;
  }
};

const showView = (view) => {
  const tags = view === 'tags';
  $('#view-episodes').hidden = tags;
  $('#view-tags').hidden = !tags;
  $('#tab-episodes').setAttribute('aria-selected', String(!tags));
  $('#tab-tags').setAttribute('aria-selected', String(tags));
  if (tags) void openTags();
};

const setAlias = (from, to) => {
  const draft = state.aliasDraft;
  draft.aliases[from] = to;
  renderTags();
};

const removeAlias = (from) => {
  delete state.aliasDraft.aliases[from];
  renderTags();
};

const dismissCandidate = (pair) => {
  const draft = state.aliasDraft;
  if (!draft.dismissed.some((item) => item.from === pair.from && item.to === pair.to)) draft.dismissed.push({ ...pair });
  renderTags();
};

const restoreCandidate = (pair) => {
  state.aliasDraft.dismissed = state.aliasDraft.dismissed.filter((item) => item.from !== pair.from || item.to !== pair.to);
  renderTags();
};

const setType = (label, type) => {
  const draft = state.aliasDraft;
  const canonical = resolveAlias(label, draft.aliases);
  if ((state.labels.get(canonical)?.type ?? '') === type) delete draft.types[canonical];
  else draft.types[canonical] = type;
  renderTags();
};

const renderAliases = () => {
  const draft = state.aliasDraft;
  const body = $('#alias-rows');
  body.innerHTML = '';
  for (const [from, to] of Object.entries(draft.aliases).sort(([left], [right]) => left.localeCompare(right, 'pl'))) {
    const tr = document.createElement('tr');
    const fromCell = document.createElement('td');
    fromCell.textContent = from;
    const toInput = document.createElement('input');
    toInput.type = 'text';
    toInput.value = to;
    toInput.setAttribute('list', 'tag-labels');
    toInput.addEventListener('change', () => {
      const value = toInput.value.trim();
      if (value) setAlias(from, value);
      else removeAlias(from);
    });
    const toCell = document.createElement('td');
    toCell.append(toInput);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost small';
    remove.textContent = 'usuń';
    remove.addEventListener('click', () => removeAlias(from));
    const actionCell = document.createElement('td');
    actionCell.className = 'num';
    actionCell.append(remove);
    tr.append(fromCell, toCell, actionCell);
    body.append(tr);
  }
  if (!body.children.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'muted';
    td.textContent = 'brak aliasów';
    tr.append(td);
    body.append(tr);
  }
};

const renderCandidates = () => {
  const draft = state.aliasDraft;
  const list = $('#alias-candidates');
  list.innerHTML = '';
  const candidates = aliasCandidates(state.labels, draft.aliases, draft.dismissed);
  for (const pair of candidates) {
    const li = document.createElement('li');
    const from = document.createElement('span');
    from.textContent = pair.from;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const to = document.createElement('span');
    to.textContent = pair.to;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ghost small';
    add.textContent = 'dodaj alias';
    add.addEventListener('click', () => setAlias(pair.from, pair.to));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost small';
    dismiss.textContent = 'pomiń';
    dismiss.addEventListener('click', () => dismissCandidate(pair));
    li.append(from, arrow, to, add, dismiss);
    list.append(li);
  }
  if (!candidates.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'brak kandydatów';
    list.append(li);
  }
  const dismissed = $('#alias-dismissed');
  dismissed.textContent = '';
  for (const pair of draft.dismissed) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost small';
    button.textContent = `${pair.from} → ${pair.to}: przywróć`;
    button.addEventListener('click', () => restoreCandidate(pair));
    dismissed.append(button, document.createTextNode(' '));
  }
};

const renderTagRows = () => {
  const draft = state.aliasDraft;
  const rows = tagRows(state.labels, draft);
  const filter = searchKey($('#tag-search').value);
  const matched = rows.filter((row) => !filter || searchKey(row.label).includes(filter));
  // 1750 etykiet to za dużo węzłów na telefonie; filtr zawęża listę, więc pokazujemy
  // pierwsze dwieście i mówimy, ile zostało poza widokiem.
  const shown = matched.slice(0, 200);
  const body = $('#tag-rows');
  body.innerHTML = '';
  for (const row of shown) {
    const tr = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.textContent = row.label;
    if (row.canonical !== row.label) {
      const note = document.createElement('span');
      note.className = 'alias-of';
      note.textContent = ` → ${row.canonical}`;
      labelCell.append(note);
    }
    const typeCell = document.createElement('td');
    const select = document.createElement('select');
    for (const type of TAG_TYPES) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      option.selected = type === row.type;
      select.append(option);
    }
    select.addEventListener('change', () => setType(row.label, select.value));
    typeCell.append(select);
    const countCell = document.createElement('td');
    countCell.className = 'num';
    countCell.textContent = String(row.count);
    tr.append(labelCell, typeCell, countCell);
    body.append(tr);
  }
  $('#tag-count').textContent =
    matched.length > shown.length
      ? `${shown.length} z ${matched.length} pasujących (${rows.length} łącznie) — zawęź filtrem`
      : `${matched.length} z ${rows.length} etykiet`;
};

const renderTags = () => {
  if (!state.aliasDraft) return;
  renderAliases();
  renderCandidates();
  renderTagRows();
  const options = $('#tag-labels');
  options.innerHTML = '';
  for (const label of [...state.labels.keys()].sort((left, right) => left.localeCompare(right, 'pl'))) {
    const option = document.createElement('option');
    option.value = label;
    options.append(option);
  }
  refreshAliasSave();
};

const publishAliases = async () => {
  if (!state.aliasDraft || !currentSession().canPush) return notifyAliases('zaloguj się, żeby zapisać aliasy', 'error');
  const next = normalizeAliasFile(state.aliasDraft);
  const problems = aliasProblems(next.aliases);
  if (problems.length) return notifyAliases(`nie publikuję — ${problems.slice(0, 3).join('; ')}`, 'error');

  // Plik aliasów to całe listy, więc scalanie po polach nie ma sensu: jeśli ktoś zmienił
  // go w międzyczasie, nadpisanie skasowałoby jego pracę. Błąd sieci też zatrzymuje
  // publikację — brak odpowiedzi nie może znaczyć „wolno nadpisać”.
  let fresh;
  try {
    fresh = await loadJsonFresh('data/aliases.json');
  } catch (error) {
    return notifyAliases(`nie mogę sprawdzić pliku aliasów w repozytorium: ${error.message}`, 'error');
  }
  const freshKey = aliasFileKey(fresh ?? {});
  if (freshKey !== state.aliasBase) {
    state.aliasBaseFile = normalizeAliasFile(fresh ?? {});
    state.aliasDraft = structuredClone(state.aliasBaseFile);
    state.aliasBase = freshKey;
    renderTags();
    return notifyAliases('ktoś zmienił aliasy w repozytorium — wczytałem świeży plik, popraw zmiany i zapisz ponownie', 'error');
  }

  $('#aliases-save').disabled = true;
  notifyAliases('publikuję…');
  try {
    const result = await publishChanges(
      'fix(dane): aliasy z edytora online',
      { 'data/aliases.json': `${JSON.stringify(next, null, 2)}\n` },
      {
        // Ponowna próba po konflikcie rebazuje commit na nowy koniec gałęzi; przy
        // całym pliku to znaczyłoby nadpisanie cudzej zmiany, więc sprawdzamy ją jeszcze raz.
        beforeRetry: async () => {
          const again = await loadJsonFresh('data/aliases.json');
          if (aliasFileKey(again ?? {}) !== state.aliasBase) {
            throw new Error('ktoś zmienił aliasy w trakcie publikacji — spróbuj ponownie');
          }
        },
      }
    );
    state.aliasDraft = next;
    state.aliasBaseFile = structuredClone(next);
    state.aliasBase = aliasFileKey(next);
    notifyAliases(`zapisane: ${result.url}`, 'ok');
    renderTags();
  } catch (error) {
    if (!currentSession().canPush) bootAuth();
    notifyAliases(error.message, 'error');
    refreshAliasSave();
  }
};


const bootAuth = () => {
  const session = currentSession();
  const signedIn = session.canPush;
  setStatus(signedIn ? `zalogowany jako ${session.login}` : 'niezalogowany — tylko odczyt', signedIn ? 'ok' : '');
  $('#sign-in').hidden = signedIn;
  $('#sign-out').hidden = !signedIn;
  refreshPublish();
  refreshAliasSave();
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
  $('#tab-episodes').addEventListener('click', () => showView('episodes'));
  $('#tab-tags').addEventListener('click', () => showView('tags'));
  $('#filter').addEventListener('input', renderList);
  $('#tag-search').addEventListener('input', renderTagRows);
  $('#alias-add').addEventListener('click', () => {
    const from = $('#alias-from').value.trim();
    const to = $('#alias-to').value.trim();
    if (!from || !to || from === to) return notifyAliases('wariant i etykieta kanoniczna muszą być różne', 'error');
    setAlias(from, to);
    $('#alias-from').value = '';
    $('#alias-to').value = '';
    notifyAliases('dodane — zapis wyśle jeden commit');
  });
  $('#aliases-save').addEventListener('click', () => void publishAliases());
  $('#aliases-reset').addEventListener('click', () => {
    if (!state.aliasBaseFile) return;
    state.aliasDraft = structuredClone(state.aliasBaseFile);
    renderTags();
    notifyAliases('cofnięte do stanu z repozytorium');
  });

  $('#sign-in').addEventListener('click', openLogin);
  $('#sign-out').addEventListener('click', () => {
    signOut();
    bootAuth();
  });
  $('#publish').addEventListener('click', () => void publish());
  $('#login-token').addEventListener('click', async () => {
    try {
      await signInWithToken($('#token').value);
      $('#token').value = '';
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

  $('#episode-title').addEventListener('input', () => {
    const unofficial = state.titles?.titles?.[state.episode?.id]?.title ?? '';
    const value = $('#episode-title').value.trim();
    state.titleDirty = value !== (unofficial || officialTitleOf());
    $('#title-kind').textContent = value && value !== officialTitleOf() ? 'nieoficjalny' : 'oficjalny';
    $('#title-kind').className = `badge ${value && value !== officialTitleOf() ? 'unofficial' : ''}`;
    markDirty();
  });

  const audio = $('#audio');
  const ensureAudio = () => {
    if (!audio.getAttribute('src') && audio.dataset.src) {
      audio.src = audio.dataset.src;
      audio.load();
    }
  };
  audio.addEventListener('play', ensureAudio);
  audio.addEventListener('timeupdate', renderWave);
  audio.addEventListener('seeked', renderWave);
  audio.addEventListener('loadedmetadata', renderWave);

  const stage = $('#wave-stage');
  const durationOf = () => audio.duration || state.episode?.durationSec || 0;
  // Zoom jak w lokalnym edytorze: kółko trzyma punkt pod kursorem, przyciski —
  // miejsce odtwarzania, a gdy jest poza oknem, środek.
  const zoomWave = (factor) => {
    if (!state.peaks) return;
    const time = audio.currentTime;
    const inside = Number.isFinite(time) && time > state.wave.start && time < state.wave.start + state.wave.span;
    const ratio = inside ? (time - state.wave.start) / state.wave.span : 0.5;
    const anchor = state.wave.start + state.wave.span * ratio;
    const span = state.wave.span * factor;
    state.wave = clampView({ start: anchor - span * ratio, span }, durationOf());
    renderWave();
  };
  const timeAt = (clientX) => {
    const rect = stage.getBoundingClientRect();
    return state.wave.start + ((clientX - rect.left) / rect.width) * state.wave.span;
  };

  stage.addEventListener(
    'wheel',
    (event) => {
      if (!state.peaks) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const anchor = state.wave.start + state.wave.span * ratio;
      const factor = Math.exp(Math.min(120, Math.max(-120, event.deltaY)) * 0.002);
      const span = state.wave.span * factor;
      state.wave = clampView({ start: anchor - span * ratio, span }, durationOf());
      renderWave();
    },
    { passive: false }
  );

  let pan = null;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state.peaks || event.target.closest('.wave-marker')) return;
    pan = { x: event.clientX, start: state.wave.start, moved: false };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pan) return;
    const dx = event.clientX - pan.x;
    if (!pan.moved && Math.abs(dx) > 2) pan.moved = true;
    if (!pan.moved) return;
    stage.classList.add('is-panning');
    state.wave = clampView({ start: pan.start - (dx / stage.clientWidth) * state.wave.span, span: state.wave.span }, durationOf());
    renderWave();
  });
  const endPan = (event) => {
    if (!pan) return;
    const moved = pan.moved;
    pan = null;
    stage.classList.remove('is-panning');
    if (!moved) seek(timeAt(event.clientX));
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', () => {
    pan = null;
    stage.classList.remove('is-panning');
  });
  stage.addEventListener('dblclick', () => {
    ensureAudio();
    void audio.play();
  });

  $('#wave-all').addEventListener('click', () => {
    state.wave = { start: 0, span: durationOf() };
    renderWave();
  });
  $('#wave-in').addEventListener('click', () => zoomWave(0.6));
  $('#wave-out').addEventListener('click', () => zoomWave(1.7));
  $('#wave-next-unreviewed').addEventListener('click', () => nextUnreviewed(1));
  $('#wave-prev-unreviewed').addEventListener('click', () => nextUnreviewed(-1));
  $('#wave-add-topic').addEventListener('click', () => addTopicAt(playheadTime()));
  $('#wave-add-track').addEventListener('click', () => addTrackAt(playheadTime()));

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if (event.key === 'Escape' && state.selected) {
      state.selected = null;
      renderWave();
      return;
    }
    if (typing) return;
    if (event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      addTopicAt(playheadTime());
      return;
    }
    if (event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      addTrackAt(playheadTime());
      return;
    }
    if (event.key === 'Enter' && event.shiftKey && state.selected) {
      event.preventDefault();
      toggleReviewed(state.selected);
      renderEpisode();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected) {
      event.preventDefault();
      removeSelected();
      return;
    }
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      nextUnreviewed(1);
      return;
    }
    if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      nextUnreviewed(-1);
      return;
    }
    if (state.selected && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const step = event.shiftKey ? 1 : 0.1;
      const delta = event.key === 'ArrowRight' ? step : -step;
      moveFragmentStart(state.selected, Number(state.selected.object.start) + delta);
    }
  });

  $('#discard').addEventListener('click', async () => {
    if (!state.episode) return;
    clearTimeout(state.draftTimer);
    await deleteDraft(state.episode.id);
    const episode = state.episode;
    await openEpisode(episode);
    notify('szkic odrzucony');
  });

  // Treść przychodzi w zdarzeniu: ponowne `loadJson` uruchomiłoby kolejne odświeżenie
  // w tle i tak w kółko, bo każda zmiana pliku ogłasza się tym samym zdarzeniem.
  window.addEventListener('edytor:plik-odswiezony', (event) => {
    if (event.detail?.path !== 'data/catalog.json' || !event.detail.text) return;
    try {
      state.catalog = JSON.parse(event.detail.text);
      renderList();
      notify('katalog odświeżony w tle');
    } catch {}
  });

  window.addEventListener('resize', renderWave);
  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) event.preventDefault();
  });
};

const load = async () => {
  bind();
  bootAuth();
  // Zapisana sesja jest od razu widoczna; w tle sprawdzamy, czy GitHub jej nie unieważnił.
  void verifySession().then(() => bootAuth());
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
