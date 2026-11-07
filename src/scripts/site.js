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
  const covering = spans.filter((span) => span.kind !== 'topic-group' && time >= span.start && time < span.end);
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

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const syncProgress = () => {
  if (!audio) return;
  const bar = document.querySelector('[data-audio-bar]');
  const current = bar?.querySelector('[data-audio-current]');
  const total = bar?.querySelector('[data-audio-total]');
  const progress = bar?.querySelector('[data-progress]');
  const fill = bar?.querySelector('[data-progress-fill]');
  const toggle = bar?.querySelector('[data-play-toggle]');
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const ratio = duration > 0 ? Math.min(1, audio.currentTime / duration) : 0;

  if (current) current.textContent = formatTime(audio.currentTime);
  if (total) total.textContent = formatTime(duration);
  if (fill) fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  if (progress) progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (toggle) {
    toggle.dataset.state = audio.paused ? 'paused' : 'playing';
    toggle.setAttribute('aria-label', audio.paused ? 'Odtwórz' : 'Wstrzymaj odtwarzanie');
  }
};

const seekToRatio = (ratio) => {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  audio.currentTime = Math.min(Math.max(0, ratio), 1) * audio.duration;
  syncProgress();
};

const setupBar = () => {
  const bar = document.querySelector('[data-audio-bar]');
  if (!bar || bar.dataset.bound === 'true') return;
  bar.dataset.bound = 'true';

  bar.querySelector('[data-play-toggle]')?.addEventListener('click', () => {
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
  });

  const volume = bar.querySelector('[data-volume]');
  if (volume && audio) {
    volume.addEventListener('input', () => {
      audio.volume = Number(volume.value);
    });
    audio.volume = Number(volume.value);
  }

  bar.querySelector('[data-audio-close]')?.addEventListener('click', () => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    delete audio.dataset.src;
    delete audio.dataset.slug;
    audio.dataset.closed = '1';
    setNowPlaying('');
    bar.hidden = true;
  });

  const progress = bar.querySelector('[data-progress]');
  if (progress) {
    const ratioFromEvent = (event) => {
      const rect = progress.getBoundingClientRect();
      return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    };
    let dragging = false;
    progress.addEventListener('pointerdown', (event) => {
      dragging = true;
      progress.setPointerCapture(event.pointerId);
      seekToRatio(ratioFromEvent(event));
    });
    progress.addEventListener('pointermove', (event) => {
      if (dragging) seekToRatio(ratioFromEvent(event));
    });
    progress.addEventListener('pointerup', () => {
      dragging = false;
    });
    progress.addEventListener('keydown', (event) => {
      if (!audio || !Number.isFinite(audio.duration)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      }
    });
  }

  if (audio) {
    for (const event of ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'seeked', 'ended']) {
      audio.addEventListener(event, syncProgress);
    }
    syncProgress();
  }
};

const setNowPlaying = (label) => {
  const now = document.querySelector('[data-audio-now]');
  if (!now) return;
  if (!label) {
    now.hidden = true;
    now.textContent = '';
    return;
  }
  now.hidden = false;
  now.textContent = `Teraz: ${label}`;
};

/** Czy strona pokazuje odcinek, który faktycznie jest w playerze. */
const pageMatchesAudio = () => {
  const data = document.querySelector('#audio-data');
  if (!data) return false;
  try {
    const payload = JSON.parse(data.textContent ?? '{}');
    return Boolean(payload.slug) && payload.slug === audio?.dataset.slug;
  } catch {
    return false;
  }
};

const syncSpans = () => {
  if (!audio) return;
  // Na stronie innej audycji nie podświetlamy jej wierszy czasem z granego odcinka.
  if (!pageMatchesAudio()) {
    for (const span of spans) {
      span.element.classList.remove('is-active');
      span.element.removeAttribute('aria-current');
      setPlayingIcon(span.element.querySelector('.track-play'), false);
    }
    return;
  }
  const active = audio.paused ? [] : activeSpans(audio.currentTime);
  const playingTrack = active.find((span) => span.kind === 'track');
  if (playingTrack) {
    setNowPlaying(playingTrack.element.dataset.trackLabel);
  } else if (active.length > 0) {
    // Wejścia numerujemy po kolei: pełna nazwa wątku nie zmieści się w pasku,
    // a „Wejście 7" wystarcza, żeby wiedzieć, co leci.
    const span = active[0];
    const order = spans.filter((item) => item.kind !== 'track' && item.element.compareDocumentPosition(span.element) & Node.DOCUMENT_POSITION_FOLLOWING).length;
    setNowPlaying(`Wejście ${order + 1}`);
  }
  for (const span of spans) {
    const isActive = span.kind === 'topic-group'
      ? active.some((item) => item.kind === 'topic' && item.start >= span.start && item.start < span.end)
      : active.includes(span);
    span.element.classList.toggle('is-active', isActive);
    if (isActive) span.element.setAttribute('aria-current', 'true');
    else span.element.removeAttribute('aria-current');
    setPlayingIcon(span.element.querySelector('.track-play'), isActive);
  }
};

/** Przełącza źródło na odcinek z bieżącej strony, jeśli gra inny. */
const switchToPageEpisode = () => {
  if (!audio) return;
  const data = document.querySelector('#audio-data');
  if (!data) return;
  let payload;
  try {
    payload = JSON.parse(data.textContent ?? '{}');
  } catch {
    return;
  }
  if (!payload.src || audio.dataset.src === payload.src) return;
  delete audio.dataset.closed;
  audio.dataset.src = payload.src;
  audio.dataset.slug = payload.slug ?? '';
  audio.src = payload.src;
  audio.load();
  setNowPlaying('');
  const bar = document.querySelector('[data-audio-bar]');
  if (bar) bar.hidden = false;
  const title = bar?.querySelector('[data-audio-title]');
  if (title) title.textContent = payload.title ?? '';
  const link = bar?.querySelector('[data-audio-link]');
  if (link && payload.slug) link.href = `/odcinki/${payload.slug}/`;
};

const playFrom = (start) => {
  if (!audio) return;
  switchToPageEpisode();
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

  const loadedSlug = audio.dataset.slug;
  // Zamknięty player zostaje zamknięty, dopóki użytkownik nie puści czegoś ponownie.
  if (audio.dataset.closed !== '1') bar.hidden = false;

  // Player gra to, co użytkownik uruchomił: wejście na inną audycję nie przełącza źródła,
  // bo przerwałoby słuchanie. Źródło zmienia dopiero klik w utwór na tej stronie.
  if (loadedSlug && loadedSlug !== payload.slug) return;

  const title = bar.querySelector('[data-audio-title]');
  if (title) title.textContent = payload.title ?? '';
  const link = bar.querySelector('[data-audio-link]');
  if (link && payload.slug) link.href = `/odcinki/${payload.slug}/`;

  if (audio.dataset.src !== payload.src) {
    audio.dataset.src = payload.src;
    audio.dataset.slug = payload.slug ?? '';
    audio.src = payload.src;
    audio.load();
    audio.currentTime = 0;
    setNowPlaying('');
  }
};

// Pasek zwija się do zera, więc lista pod nim podjeżdża, zamiast przeskakiwać.
const collapseNote = (note) => {
  if (!note) return;
  note.style.overflow = 'hidden';
  const animation = note.animate(
    [
      { height: `${note.offsetHeight}px`, opacity: 1 },
      { height: '0px', opacity: 0 },
    ],
    { duration: 180, easing: 'ease-in', fill: 'forwards' }
  );
  animation.finished.then(() => note.remove()).catch(() => note.remove());
};

const clearDeepLink = (note) => {
  for (const row of document.querySelectorAll('.is-tagged')) row.classList.remove('is-tagged');
  collapseNote(note);
  // Adres bez ?tag=, żeby odświeżenie nie zaznaczało ponownie.
  history.replaceState(null, '', location.pathname);
};

const applyDeepLink = () => {
  if (!audio) return;
  const tagParam = new URLSearchParams(location.search).get('tag');
  if (!tagParam) return;
  // astro:page-load odpala się też przy pierwszym wejściu, więc bez tej straży
  // komunikat pojawiał się dwa razy.
  if (document.querySelector('.tag-deeplink')) return;
  // Tag w karcie obok: podświetlamy też link, żeby było widać, skąd przyszliśmy.
  for (const link of document.querySelectorAll('.side__tags a')) {
    if (link.getAttribute('href')?.endsWith(`/tagi/${tagParam}/`)) link.classList.add('is-tagged');
  }

  const tagged = [...document.querySelectorAll('[data-tag-ids]')].filter((row) =>
    (row.dataset.tagIds ?? '').split(/\s+/).includes(tagParam)
  );
  if (tagged.length === 0) return;

  for (const row of tagged) row.classList.add('is-tagged');
  tagged[0].scrollIntoView({ block: 'center', behavior: 'instant' });
  // Wejście z tagu tylko pokazuje, gdzie to jest: bez ustawiania czasu i bez grania.
  const last = tagged.length % 10;
  const teen = tagged.length % 100;
  const plural =
    tagged.length === 1 ? 'wystąpienie' : last >= 2 && last <= 4 && (teen < 12 || teen > 14) ? 'wystąpienia' : 'wystąpień';
  const note = document.createElement('p');
  note.className = 'tag-deeplink';
  const label = document.createElement('span');
  const tagLabel =
    document.querySelector('.side__tags a.is-tagged')?.textContent?.trim() ??
    tagged[0].querySelector('.tracks__artist')?.textContent?.trim() ??
    'Tag';
  label.textContent = `${tagLabel} — ${tagged.length} ${plural}. Odtwarzanie zaczyna się po kliknięciu w wiersz.`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tag-deeplink__close';
  close.setAttribute('aria-label', 'Odznacz podświetlone wiersze');
  close.textContent = '×';
  close.addEventListener('click', () => clearDeepLink(note));
  note.append(label, close);
  document.querySelector('.tracks')?.before(note);
};

// Filtr listy odcinków wisi na dokumencie, nie na polu: po nawigacji klienckiej pole
// jest nowym elementem, a raz związany handler zostawał przy starym i przestawał filtrować.
let indexFilterYear = 'all';

const applyIndexFilter = (search) => {
  const rows = [...document.querySelectorAll('[data-episode]')];
  // Tylko nagłówki: data-month mają też wiersze i pętla miesięcy nadpisywała ich hidden.
  const months = [...document.querySelectorAll('.list__month[data-month]')];
  const counter = document.querySelector('[data-result-count]');
  const empty = document.querySelector('[data-empty]');
  const needle = search.value.trim().toLowerCase();
  for (const row of rows) {
    const matchesYear = indexFilterYear === 'all' || row.dataset.date.startsWith(indexFilterYear);
    const matchesText = row.dataset.episode.toLowerCase().includes(needle);
    row.hidden = !(matchesYear && matchesText);
  }
  for (const month of months) {
    month.hidden = !rows.some((row) => !row.hidden && row.dataset.month === month.dataset.month);
  }
  const visible = rows.filter((row) => !row.hidden).length;
  if (counter) counter.textContent = String(visible);
  if (empty) empty.hidden = visible > 0;
};

const initIndexFilter = () => {
  if (document.body.dataset.indexFilter === 'on') return;
  document.body.dataset.indexFilter = 'on';
  document.addEventListener('input', (event) => {
    const search = event.target instanceof Element ? event.target.closest('[data-filter-title]') : null;
    if (search) applyIndexFilter(search);
  });
  document.addEventListener('click', (event) => {
    const chip = event.target instanceof Element ? event.target.closest('[data-year]') : null;
    if (!chip) return;
    indexFilterYear = chip.dataset.year;
    for (const other of document.querySelectorAll('[data-year]')) {
      other.setAttribute('aria-pressed', String(other === chip));
    }
    const search = document.querySelector('[data-filter-title]');
    if (search) applyIndexFilter(search);
  });
};

const initPage = () => {
  spans = [...document.querySelectorAll('[data-span-start]')].map((element) => ({
    element,
    start: Number(element.dataset.spanStart),
    end: Number(element.dataset.spanEnd),
    kind: element.dataset.kind,
  }));

  setupAudio();
  setupBar();
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
      // Czas z innej audycji nie mówi nic o tym, co gra — wtedy zawsze przełączamy i gramy.
      const isCurrent =
        row && pageMatchesAudio()
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
