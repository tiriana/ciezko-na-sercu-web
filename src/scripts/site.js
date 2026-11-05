// Pasek odtwarzacza jest w layoucie i przeżywa nawigację (ClientRouter + transition:persist),
// więc dźwięk nie przerywa się przy zmianie strony. Ten moduł obsługuje zarówno pierwszą
// stronę, jak i każdą kolejną (astro:page-load).

const audio = document.querySelector('#episode-audio');
const bar = document.querySelector('[data-audio-bar]');

const setupAudio = () => {
  if (!audio || audio.dataset.bound === 'true') return;
  audio.dataset.bound = 'true';
  // Kolejne strony podmieniają tylko zawartość <body>; element audio zostaje ten sam,
  // więc stan odtwarzania i czas są naturalnie zachowane.
  audio.addEventListener('timeupdate', () => syncSpans());
  audio.addEventListener('play', () => syncSpans());
  audio.addEventListener('pause', () => syncSpans());
  audio.addEventListener('ended', () => syncSpans());
  audio.addEventListener('seeked', () => syncSpans());
  // W tle przeglądarka ogranicza timeupdate — po powrocie do karty stan dosynchronizowuje się tutaj.
  document.addEventListener('visibilitychange', () => syncSpans());
};

let spans = [];

const activeSpans = (time) => {
  const covering = spans.filter((span) => time >= span.start && time < span.end);
  if (covering.length <= 1) return covering;
  // Wejścia i utwory mogą się nakładać: aktywna jest pozycja, która zaczęła się najpóźniej.
  const latest = Math.max(...covering.map((span) => span.start));
  return covering.filter((span) => span.start === latest);
};

const setPlayingIcon = (button, playing) => {
  if (!button) return;
  button.dataset.state = playing ? 'playing' : 'paused';
  button.dataset.label ??= button.getAttribute('aria-label') ?? '';
  button.setAttribute('aria-label', playing ? 'Wstrzymaj odtwarzanie' : button.dataset.label);
};

const setNowPlaying = (label) => {
  const now = document.querySelector('[data-audio-now]');
  if (!now || !label) return;
  now.hidden = false;
  now.textContent = `Teraz: ${label}`;
};

const syncSpans = () => {
  if (!audio) return;
  const active = audio.paused ? [] : activeSpans(audio.currentTime);
  const playingTrack = active.find((span) => span.kind === 'track');
  if (playingTrack) setNowPlaying(playingTrack.element.dataset.trackLabel);
  for (const span of spans) {
    const isActive = active.includes(span);
    span.element.classList.toggle('is-active', isActive);
    if (isActive) span.element.setAttribute('aria-current', 'true');
    else span.element.removeAttribute('aria-current');
    setPlayingIcon(span.element.querySelector('.track-play'), isActive);
  }
};

const playFrom = (start) => {
  if (!audio) return;
  const seek = () => {
    audio.currentTime = start;
    audio.play();
  };
  if (audio.readyState >= 1) {
    seek();
    return;
  }
  audio.addEventListener('loadedmetadata', seek, { once: true });
  audio.load();
};

/** Ustawia źródło z danych strony odcinka; ten sam odcinek nie restartuje odtwarzania. */
const applyEpisodeAudio = () => {
  const data = document.querySelector('#audio-data');
  if (!audio || !bar || !data) return;
  let payload;
  try {
    payload = JSON.parse(data.textContent ?? '{}');
  } catch {
    return;
  }
  if (!payload.src) return;

  const same = audio.dataset.src === payload.src;
  bar.hidden = false;
  const title = bar.querySelector('[data-audio-title]');
  if (title) title.textContent = payload.title ?? '';
  const link = bar.querySelector('[data-audio-link]');
  if (link && payload.slug) link.href = `/odcinki/${payload.slug}/`;

  if (!same) {
    audio.dataset.src = payload.src;
    audio.src = payload.src;
    audio.load();
    audio.currentTime = 0;
  }
};

const applyDeepLink = () => {
  if (!audio) return;
  const tagParam = new URLSearchParams(location.search).get('tag');
  if (!tagParam) return;
  const tagged = [...document.querySelectorAll('[data-tag-id]')].filter((row) => row.dataset.tagId === tagParam);
  if (tagged.length === 0) return;

  for (const row of tagged) row.classList.add('is-tagged');
  tagged[0].scrollIntoView({ block: 'center', behavior: 'instant' });
  const start = Number(tagged[0].dataset.spanStart);
  if (Number.isFinite(start)) {
    audio.currentTime = start;
    syncSpans();
  }
  const last = tagged.length % 10;
  const teen = tagged.length % 100;
  const plural =
    tagged.length === 1 ? 'wystąpienie' : last >= 2 && last <= 4 && (teen < 12 || teen > 14) ? 'wystąpienia' : 'wystąpień';
  const clock = new Date(start * 1000).toISOString().slice(11, 19);
  const note = document.createElement('p');
  note.className = 'tag-deeplink';
  note.textContent = `${tagged[0].querySelector('.tracks__artist')?.textContent?.trim() ?? 'Tag'} — ${tagged.length} ${plural}. Ustawiono ${clock}.`;
  document.querySelector('.tracks')?.before(note);
};

const initIndexFilter = () => {
  const search = document.querySelector('[data-filter-title]');
  if (!search || search.dataset.bound === 'true') return;
  search.dataset.bound = 'true';
  const rows = [...document.querySelectorAll('[data-episode]')];
  const months = [...document.querySelectorAll('[data-month]')];
  const counter = document.querySelector('[data-result-count]');
  const empty = document.querySelector('[data-empty]');
  const yearChips = [...document.querySelectorAll('[data-year]')];
  let year = 'all';

  const apply = () => {
    const needle = search.value.trim().toLowerCase();
    for (const row of rows) {
      const matchesYear = year === 'all' || row.dataset.date.startsWith(year);
      const matchesText = row.dataset.episode.toLowerCase().includes(needle);
      row.hidden = !(matchesYear && matchesText);
    }
    for (const month of months) {
      const group = month.dataset.month;
      month.hidden = !rows.some((row) => !row.hidden && row.dataset.month === group);
    }
    const visible = rows.filter((row) => !row.hidden).length;
    if (counter) counter.textContent = String(visible);
    if (empty) empty.hidden = visible > 0;
  };

  search.addEventListener('input', apply);
  for (const chip of yearChips) {
    chip.addEventListener('click', () => {
      year = chip.dataset.year;
      for (const other of yearChips) other.setAttribute('aria-pressed', String(other === chip));
      apply();
    });
  }
};

const initPage = () => {
  spans = [...document.querySelectorAll('[data-span-start]')].map((element) => ({
    element,
    start: Number(element.dataset.spanStart),
    end: Number(element.dataset.spanEnd),
    kind: element.dataset.kind,
  }));

  setupAudio();
  applyEpisodeAudio();
  initIndexFilter();

  for (const button of document.querySelectorAll('[data-skip]')) {
    if (button.dataset.bound === 'true') continue;
    button.dataset.bound = 'true';
    const delta = Number(button.dataset.skip);
    button.addEventListener('click', () => {
      if (!audio) return;
      const limit = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + delta;
      audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), limit);
      syncSpans();
    });
  }

  for (const button of document.querySelectorAll('[data-track-start]')) {
    if (button.dataset.bound === 'true') continue;
    button.dataset.bound = 'true';
    const start = Number(button.dataset.trackStart);
    button.addEventListener('click', () => {
      if (!audio) return;
      const row = button.closest('[data-span-start]');
      const isCurrent = row
        ? audio.currentTime >= Number(row.dataset.spanStart) && audio.currentTime < Number(row.dataset.spanEnd)
        : false;
      if (isCurrent && !audio.paused) {
        audio.pause();
        syncSpans();
        return;
      }
      playFrom(start);
    });
  }

  applyDeepLink();
  syncSpans();
};

initPage();
document.addEventListener('astro:page-load', initPage);
