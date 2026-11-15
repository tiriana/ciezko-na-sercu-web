import {
  applyOverrides,
  mergeOverrides,
  normalize,
  validateOverride,
  validateSavePayload,
  validateTrackTimes,
} from './lib/overrides.mjs';
import { currentSession, pollDeviceToken, publishChanges, signInWithToken, signOut, startDeviceFlow } from './github.js';
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
  // Znaczniki „przejrzane” kluczowane etykietą utworu (t:wykonawca|tytuł), tak jak
  // w `data/reviewed.json`: klucz przeżywa zmianę kolejności i indeksów w pliku odcinka.
  // Repo jest źródłem prawdy, a `reviewTouched` trzyma tylko niezapisane zmiany.
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

const hasChanges = () => state.edits.size > 0 || state.titleDirty || state.reviewTouched.size > 0;

const reviewKey = (track) => `t:${normalize(track.artist)}|${normalize(track.title)}`;

const isReviewed = (track) => {
  const key = reviewKey(track);
  return state.reviewTouched.has(key) ? state.reviewTouched.get(key) : state.repoReviewed.has(key);
};

const toggleReviewed = (track) => {
  state.reviewTouched.set(reviewKey(track), !isReviewed(track));
  markDirty();
  renderTracks();
  renderWave();
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
  const count = state.edits.size;
  if (count > 0) notify(`szkic: ${count} zmienionych wierszy — publikacja wyśle jeden commit na main`);
  else if (state.titleDirty) notify('zmiana tytułu — publikacja zapisze ją w data/titles.json');
  else if (state.reviewTouched.size > 0) notify('zmiana znaczników „przejrzane” — publikacja zapisze ją w data/reviewed.json');
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
    done.checked = isReviewed(track);
    done.title = 'przejrzane';
    done.addEventListener('change', () => toggleReviewed(track));
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

  const tracks = state.episode?.tracks ?? [];
  const done = tracks.filter(isReviewed).length;
  $('#progress').textContent = tracks.length > 0 ? `przejrzane ${done}/${tracks.length}` : '';
  refreshPublish();
};

const markersOf = () =>
  (state.episode?.tracks ?? []).flatMap((track) => {
    const reviewed = isReviewed(track);
    const start = Number(track.start ?? 0);
    const end = Number(track.end ?? start + Number(track.durationSec ?? 0));
    return [
      { time: start, kind: 'start', reviewed },
      ...(end > start ? [{ time: end, kind: 'end', reviewed }] : []),
    ];
  });

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
    markers: markersOf(),
  });
  $('#wave-window').textContent = state.peaks ? `${fmtTime(state.wave.start)} – ${fmtTime(state.wave.start + state.wave.span)}` : '';
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

  const [file, override, peaks, reviewedFile, draft] = await Promise.all([
    loadJson(`data/episodes/${episode.id}.json`),
    loadJson(`data/overrides/${episode.id}.json`).catch(() => null),
    loadPeaks(episode.id).catch(() => null),
    loadJson('data/reviewed.json').catch(() => null),
    getDraft(episode.id),
  ]);
  if (!file) throw new Error('nie ma pliku odcinka');

  // Plik opracowania jest źródłem prawdy (ma czasy i utwory), a katalog dokłada to,
  // czego w nim nie ma: slug, tytuł, `audioUrl`. Odwrotna kolejność kasowała długość
  // nagrania, bo katalog trzyma tam `null`, i waveform nie miał czego skalować.
  state.episode = { ...episode, ...file };
  state.override = override;
  state.peaks = peaks;
  state.reviewedFile = reviewedFile;
  state.repoReviewed = new Set(Object.keys(reviewedFile?.episodes?.[episode.id] ?? {}));
  state.reviewTouched = new Map();
  state.wave = { start: 0, span: file.durationSec ?? episode.durationSec ?? 0 };

  if (draft?.payload?.edits?.length || draft?.payload?.reviewed?.length) {
    state.edits = new Map(draft.payload.edits ?? []);
    if (draft.payload.title) $('#episode-title').value = draft.payload.title;
    state.titleDirty = Boolean(draft.payload.titleDirty);
    state.reviewTouched = new Map(draft.payload.reviewed ?? []);
    notify(`przywrócony szkic z ${new Date(draft.at).toLocaleString('pl-PL')} — publikacja albo „odrzuć szkic”`);
  }

  // Adres tylko w `data-src`: 110-minutowy plik zaczyna się pobierać dopiero, gdy
  // użytkownik naprawdę kliknie play albo waveform.
  const audio = $('#audio');
  audio.removeAttribute('src');
  audio.dataset.src = episode.audioUrl ?? '';
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

  // Znaczniki „przejrzane” jadą tym samym commitem: repo jest źródłem prawdy także dla
  // nich, więc strona i lokalny edytor widzą postęp zrobiony w przeglądarce.
  if (state.reviewTouched.size > 0) {
    const freshReviewed = await loadJsonFresh('data/reviewed.json').catch(() => state.reviewedFile);
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
    state.edits = new Map();
    state.titleDirty = false;
    state.repoReviewed = new Set(Object.keys(state.reviewedFile?.episodes?.[state.episode.id] ?? {}));
    state.reviewTouched = new Map();
    state.dirty = false;
    clearTimeout(state.draftTimer); // odroczony zapis nie może wskrzesić usuniętego szkicu
    await deleteDraft(state.episode.id);
    renderList();
    renderTracks();
    notify(`zapisane: ${result.url}`);
    setStatus(`zalogowany jako ${currentSession().login}`, 'ok');
  } catch (error) {
    if (!currentSession().canPush) bootAuth();
    notify(error.message, 'error');
    refreshPublish();
  }
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
  $('#episode-title').addEventListener('change', () => {
    state.titleDirty = $('#episode-title').value.trim() !== shownTitle(state.episode ?? {});
    state.dirty = true;
    refreshPublish();
    if (state.titleDirty) notify('tytuł zmieniony — publikacja zapisze go w data/titles.json');
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

  const wave = $('#wave');
  const durationOf = () => audio.duration || state.episode?.durationSec || 0;
  const seek = (seconds) => {
    ensureAudio();
    const duration = durationOf();
    if (duration > 0) audio.currentTime = Math.max(0, Math.min(duration, seconds));
    renderWave();
  };
  const zoomWave = (factor, anchor = 0.5) => {
    const duration = durationOf();
    if (duration <= 0) return;
    const at = state.wave.start + state.wave.span * anchor;
    const span = Math.min(duration, Math.max(2, state.wave.span * factor));
    state.wave = clampView({ start: at - span * anchor, span }, duration);
    renderWave();
  };
  const timeAt = (clientX) => {
    const rect = wave.getBoundingClientRect();
    return state.wave.start + ((clientX - rect.left) / rect.width) * state.wave.span;
  };

  wave.addEventListener(
    'wheel',
    (event) => {
      if (!state.peaks) return;
      event.preventDefault();
      const rect = wave.getBoundingClientRect();
      zoomWave(event.deltaY > 0 ? 1.25 : 0.8, (event.clientX - rect.left) / rect.width);
    },
    { passive: false }
  );

  let drag = null;
  wave.addEventListener('pointerdown', (event) => {
    if (!state.peaks) return;
    drag = { x: event.clientX, start: state.wave.start, moved: false };
    wave.setPointerCapture(event.pointerId);
  });
  wave.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 2) drag.moved = true;
    const seconds = (dx / wave.clientWidth) * state.wave.span;
    state.wave = clampView({ start: drag.start - seconds, span: state.wave.span }, durationOf());
    renderWave();
  });
  wave.addEventListener('pointerup', (event) => {
    const wasDrag = drag?.moved;
    drag = null;
    if (!wasDrag) seek(timeAt(event.clientX));
  });
  wave.addEventListener('pointercancel', () => {
    drag = null;
  });

  $('#wave-all').addEventListener('click', () => {
    state.wave = { start: 0, span: durationOf() };
    renderWave();
  });
  $('#wave-in').addEventListener('click', () => zoomWave(0.6));
  $('#wave-out').addEventListener('click', () => zoomWave(1.7));
  $('#wave-next-unreviewed').addEventListener('click', () => {
    const next = (state.episode?.tracks ?? []).find((track) => !isReviewed(track) && Number(track.start) > (audio.currentTime ?? 0));
    if (!next) return notify('wszystkie utwory po tym miejscu są przejrzane');
    seek(Number(next.start));
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
