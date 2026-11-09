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
let audioEpisodes = [];

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
  syncFragment();
  syncJumpControls();
};

/** Fragment, w którym jesteśmy: utwór albo wejście (z wątkami razem). */
const currentFragment = (time) => {
  const covering = spans.filter(
    (span) => span.end > span.start && time >= span.start && time < span.end
  );
  if (covering.length === 0) return null;
  return covering.reduce((latest, span) => (span.start >= latest.start ? span : latest));
};

/** Pasek postępu w wierszu fragmentu, który właśnie leci — resztę wierszy ukrywa CSS
 * przez `.is-active`, więc tutaj wystarczy wypełnienie jednego paska. */
const syncFragment = () => {
  if (!audio || !pageMatchesAudio()) return;
  const fragment = currentFragment(audio.currentTime);
  writeFragmentToUrl(fragment);
  if (!fragment) return;
  const barElement = spans.find((span) => span.element === fragment.element)?.progress;
  if (!barElement) return;
  const total = fragment.end - fragment.start;
  const elapsed = Math.min(total, Math.max(0, audio.currentTime - fragment.start));
  const ratio = total > 0 ? elapsed / total : 0;
  const fill = barElement.querySelector('[data-fragment-fill]');
  if (fill) fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  barElement.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
};

let lastFragmentId = null;

/** W adresie jest fragment, który leci — nie sekunda. Link skopiowany w środku utworu
 * otwiera jego początek, a adres zmienia się raz na fragment, nie co sekundę. */
const writeFragmentToUrl = (fragment) => {
  const id = fragment?.element.dataset.fragmentId ?? null;
  if (id === lastFragmentId) return;
  const url = new URL(location.href);
  if (!id && !url.searchParams.has('f')) {
    lastFragmentId = id;
    return;
  }
  lastFragmentId = id;
  url.searchParams.delete('t');
  if (id) url.searchParams.set('f', id);
  else url.searchParams.delete('f');
  history.replaceState(null, '', url);
};

/** Wejście z ?t= ustawia pozycję, ale nie odtwarza. */
const seekWhenReady = (seconds) => {
  if (!audio) return;
  const seek = () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.min(seconds, audio.duration);
    syncProgress();
    syncSpans();
  };
  if (audio.readyState >= 1) seek();
  else audio.addEventListener('loadedmetadata', seek, { once: true });
};

/** Wejście z `?f=` ustawia początek fragmentu i podświetla wiersz; nie odtwarza. */
const applyFragmentLink = () => {
  if (!audio) return;
  const params = new URLSearchParams(location.search);
  // Starszy link ze sekundą ma pierwszeństwo: `f` dopisze się dopiero po ustawieniu czasu.
  if (params.has('t')) return;
  const id = params.get('f');
  if (!id) return;
  const row = document.querySelector(`[data-fragment-id="${CSS.escape(id)}"]`);
  const start = Number(row?.dataset.spanStart);
  if (Number.isFinite(start)) {
    seekWhenReady(start);
    return;
  }
  // Adres jest stanem, więc identyfikator spoza tej strony nie ma w nim zostać.
  const url = new URL(location.href);
  url.searchParams.delete('f');
  history.replaceState(null, '', url);
};

/** Starsze linki z `?t=<sekunda>` nadal działają; nowe adresy niosą `?f=` (Część #44). */
const applyTimeLink = () => {
  if (!audio) return;
  const raw = new URLSearchParams(location.search).get('t');
  if (raw === null) return;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // Adres jest stanem, więc bezsensowny `t` nie ma w nim zostać.
    const url = new URL(location.href);
    url.searchParams.delete('t');
    history.replaceState(null, '', url);
    return;
  }
  seekWhenReady(seconds);
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

  const jump = bar.querySelector('.audio-bar__jump');
  const jumpToggle = bar.querySelector('[data-jump-toggle]');
  const jumpMenu = bar.querySelector('[data-jump-menu]');
  jumpToggle?.addEventListener('click', () => {
    if (!jumpMenu) return;
    const open = jumpMenu.hidden;
    jumpMenu.hidden = !open;
    jumpToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      syncJumpControls();
      jumpMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  });
  jumpMenu?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled) return;
    if (button.dataset.jumpMarker) jumpToMarker(Number(button.dataset.jumpMarker));
    if (button.dataset.jumpEpisode) jumpToEpisode(Number(button.dataset.jumpEpisode));
    closeJumpMenu(true);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!jumpMenu || jumpMenu.hidden || !(event.target instanceof Node) || jump?.contains(event.target)) return;
    closeJumpMenu();
  }, true);

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
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 10);
      }
    });
  }

  if (audio) {
    for (const event of ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'seeked', 'ended', 'emptied', 'loadstart']) {
      audio.addEventListener(event, syncProgress);
      audio.addEventListener(event, syncPlayers);
    }
    // Pozycje znaczników zależą od długości nagrania, więc przeliczamy je, gdy ta się pojawi.
    for (const event of ['durationchange', 'loadedmetadata', 'emptied']) {
      audio.addEventListener(event, renderMarkers);
    }
    syncProgress();
    syncPlayers();
  }
};

const setNowPlaying = (label) => {
  const now = document.querySelector('[data-audio-now]');
  if (!now) return;
  // Linia zostaje w layoucie także bez utworu, więc pasek nie zmienia wysokości po starcie.
  now.textContent = label ? `Teraz: ${label}` : '';
};

// ——— Znaczniki na szynie postępu ———
// Bierzemy je z wierszy programu, które strona odcinka już wyrenderowała; lista odcinków
// takich wierszy nie ma, więc start z listy nie rysuje żadnych znaczników.

const markersHost = bar?.querySelector('[data-markers]');
let markerSpecs = [];

const readMarkers = () => {
  markerSpecs = [];
  if (!markersHost || !pageMatchesAudio()) return;
  for (const row of document.querySelectorAll('[data-span-start]')) {
    const kind = row.dataset.kind;
    if (kind !== 'track' && kind !== 'topic') continue;
    const time = Number(row.dataset.spanStart);
    if (!Number.isFinite(time)) continue;
    const cell = row.children[1];
    // Etykieta wejścia siedzi w drugiej komórce razem z nagłówkiem „Wejście” i linkiem
    // „Zgłoś”, więc bierzemy z klonu tylko tekst bez tych dwóch rzeczy.
    const clone = cell?.cloneNode(true);
    clone?.querySelectorAll('.tracks__kind, [data-report-link]').forEach((node) => node.remove());
    const label =
      row.dataset.trackLabel?.trim() ||
      clone?.querySelector('.tracks__entry-label')?.textContent?.trim() ||
      clone?.textContent?.replace(/\s+/g, ' ').trim() ||
      '';
    markerSpecs.push({ time, kind, label });
  }
};

const renderMarkers = () => {
  if (!markersHost) return;
  markersHost.textContent = '';
  const duration = Number.isFinite(audio?.duration) ? audio.duration : 0;
  if (markerSpecs.length === 0 || duration <= 0) return;
  const fragment = document.createDocumentFragment();
  for (const spec of markerSpecs) {
    const node = document.createElement('span');
    node.className = 'audio-bar__marker';
    node.dataset.kind = spec.kind;
    node.dataset.start = String(spec.time);
    node.title = `${spec.kind === 'track' ? 'utwór' : 'wejście'} — ${spec.label}, ${formatTime(spec.time)}`;
    node.style.left = `${(spec.time / duration) * 100}%`;
    fragment.append(node);
  }
  markersHost.append(fragment);
};

const seekToMarker = (node) => {
  if (!audio) return;
  const start = Number(node.dataset.start);
  if (!Number.isFinite(start)) return;
  const limit = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : start;
  audio.currentTime = Math.max(0, Math.min(start, limit));
  syncProgress();
  syncSpans();
};

if (markersHost) {
  // Przeciąganie po szynie i klik w znacznik to dwie różne intencje: znacznik wygrywa,
  // a zdarzenie nie leci dalej do obsługi szyny. Pauza zostaje pauzą.
  markersHost.addEventListener(
    'pointerdown',
    (event) => {
      const node = event.target instanceof Element ? event.target.closest('.audio-bar__marker') : null;
      if (!node) return;
      event.stopPropagation();
      event.preventDefault();
      seekToMarker(node);
    },
    true
  );
}

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
  // Pozycję pokazujemy także po pauzie i po wejściu z `?t=`, ale nie na starcie od zera:
  // wtedy nie wybrano jeszcze żadnego miejsca.
  const active = audio.currentTime > 0 ? activeSpans(audio.currentTime) : [];
  const playing = !audio.paused;
  const playingTrack = playing ? active.find((span) => span.kind === 'track') : null;
  if (playingTrack) {
    setNowPlaying(playingTrack.element.dataset.trackLabel);
  } else if (playing && active.length > 0) {
    // Wejścia numerujemy po kolei: pełna nazwa wątku nie zmieści się w pasku,
    // a „Wejście 7" wystarcza, żeby wiedzieć, co leci.
    const span = active[0];
    const order = spans.filter((item) => item.kind !== 'track' && item.element.compareDocumentPosition(span.element) & Node.DOCUMENT_POSITION_FOLLOWING).length;
    setNowPlaying(`Wejście ${order + 1}`);
  } else {
    setNowPlaying('');
  }
  for (const span of spans) {
    const isActive = active.includes(span);
    span.element.classList.toggle('is-active', isActive);
    if (isActive) span.element.setAttribute('aria-current', 'true');
    else span.element.removeAttribute('aria-current');
    // Ikona pauzy tylko wtedy, gdy naprawdę gra — po deeplinku wiersz jest tylko wskazany.
    setPlayingIcon(span.element.querySelector('.track-play'), isActive && playing);
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

/** Ładuje do paska dowolną audycję — z listy albo z przycisku przy tytule. */
const loadEpisode = (payload) => {
  if (!audio || !bar) return false;
  const changed = audio.dataset.src !== payload.src;
  delete audio.dataset.closed;
  audio.dataset.src = payload.src;
  audio.dataset.slug = payload.slug ?? '';
  if (changed) {
    audio.src = payload.src;
    audio.load();
    audio.currentTime = 0;
  }
  bar.hidden = false;
  const title = bar.querySelector('[data-audio-title]');
  if (title) title.textContent = payload.title ?? '';
  const link = bar.querySelector('[data-audio-link]');
  if (link && payload.slug) link.href = `/odcinki/${payload.slug}/`;
  syncJumpControls();
  return changed;
};

const playEpisode = (payload, start = 0) => {
  if (!audio || !payload.src) return;
  const changed = loadEpisode(payload);
  const seek = () => {
    audio.currentTime = start;
    audio.play().catch(() => {});
  };
  if (changed || audio.readyState < 1) audio.addEventListener('loadedmetadata', seek, { once: true });
  else seek();
};

/** Ten sam odcinek przełącza pauzę; inny zaczyna od zera. */
const toggleEpisode = (payload) => {
  if (!audio || !payload.src) return;
  if (audio.dataset.src === payload.src && audio.dataset.slug === (payload.slug ?? '')) {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
    return;
  }
  playEpisode(payload, 0);
};

const payloadOf = (element) => ({
  src: element.dataset.audioSrc ?? '',
  slug: element.dataset.audioSlug ?? '',
  title: element.dataset.audioTitle ?? '',
});

const readAudioEpisodes = () => {
  const data = document.querySelector('#audio-catalog-data');
  if (data) {
    try {
      const episodes = JSON.parse(data.textContent ?? '[]');
      if (Array.isArray(episodes)) {
        const entries = episodes.filter((episode) => episode?.src && episode?.slug);
        if (entries.length > 0) {
          audioEpisodes = entries;
          return;
        }
      }
    } catch {
      return;
    }
  }
  const entries = [...document.querySelectorAll('.episode-row [data-episode-play]')]
    .map(payloadOf)
    .filter((episode) => episode.src && episode.slug);
  if (entries.length > 0) audioEpisodes = entries;
};

const pageMarkerStarts = () => {
  if (!document.querySelector('#audio-data')) return [];
  return spans
    .filter((span) => span.kind === 'track' || span.kind === 'topic')
    .map((span) => span.start)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
};

const episodeIndex = () => audioEpisodes.findIndex((episode) => episode.slug === audio?.dataset.slug);

const setJumpState = (button, enabled, label, reason = label) => {
  if (!button) return;
  button.disabled = !enabled;
  button.setAttribute('aria-label', label);
  button.title = enabled ? label : reason;
};

const syncJumpControls = () => {
  if (!bar) return;
  const current = pageMatchesAudio() && Number.isFinite(audio?.currentTime) ? audio.currentTime : 0;
  const starts = pageMarkerStarts();
  let previousMarker = null;
  let nextMarker = null;
  for (const start of starts) {
    if (start < current - 0.05) previousMarker = start;
    else if (start > current + 0.05) {
      nextMarker = start;
      break;
    }
  }
  const markerUnavailable = starts.length === 0;
  const episodePage = Boolean(document.querySelector('.programme'));
  const markerReason = !episodePage
    ? 'Znaczniki dostępne na stronie odcinka'
    : document.querySelector('[data-span-start]')
      ? 'Skoki wymagają nagrania dostępnego na stronie odcinka'
      : 'W tym odcinku nie ma znaczników programu';
  setJumpState(
    bar.querySelector('[data-jump-marker="-1"]'),
    !markerUnavailable && previousMarker !== null,
    'Poprzedni znacznik',
    markerUnavailable ? markerReason : 'Nie ma wcześniejszego znacznika w tym odcinku'
  );
  setJumpState(
    bar.querySelector('[data-jump-marker="1"]'),
    !markerUnavailable && nextMarker !== null,
    'Następny znacznik',
    markerUnavailable ? markerReason : 'Nie ma następnego znacznika w tym odcinku'
  );

  const index = episodeIndex();
  const canFindEpisode = index >= 0;
  setJumpState(
    bar.querySelector('[data-jump-episode="-1"]'),
    canFindEpisode && index > 0,
    'Poprzednia audycja',
    canFindEpisode ? 'Brak nowszej audycji w katalogu' : 'Najpierw uruchom audycję z katalogu'
  );
  setJumpState(
    bar.querySelector('[data-jump-episode="1"]'),
    canFindEpisode && index < audioEpisodes.length - 1,
    'Następna audycja',
    canFindEpisode ? 'Brak starszej audycji w katalogu' : 'Najpierw uruchom audycję z katalogu'
  );
};

const closeJumpMenu = (restoreFocus = false) => {
  const toggle = bar?.querySelector('[data-jump-toggle]');
  const menu = bar?.querySelector('[data-jump-menu]');
  if (!toggle || !menu || menu.hidden) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) toggle.focus({ preventScroll: true });
};

const jumpToMarker = (direction) => {
  if (!audio) return;
  const starts = pageMarkerStarts();
  const current = pageMatchesAudio() && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const target = direction < 0
    ? [...starts].reverse().find((start) => start < current - 0.05)
    : starts.find((start) => start > current + 0.05);
  if (target === undefined) return;

  const data = document.querySelector('#audio-data');
  let page;
  try {
    page = JSON.parse(data?.textContent ?? '{}');
  } catch {
    return;
  }
  if (!page.src || !page.slug) return;

  const resume = !audio.paused;
  if (!pageMatchesAudio()) {
    const changed = loadEpisode({ src: page.src, slug: page.slug, title: page.title ?? '' });
    const seek = () => {
      audio.currentTime = Math.min(target, Number.isFinite(audio.duration) ? audio.duration : target);
      if (resume) audio.play().catch(() => {});
      syncProgress();
      syncSpans();
    };
    if (changed || audio.readyState < 1) audio.addEventListener('loadedmetadata', seek, { once: true });
    else seek();
  } else {
    audio.currentTime = Math.min(target, Number.isFinite(audio.duration) ? audio.duration : target);
    syncProgress();
    syncSpans();
  }
  syncJumpControls();
};

const jumpToEpisode = (direction) => {
  const index = episodeIndex();
  const episode = audioEpisodes[index + direction];
  if (!episode) return;
  playEpisode(episode, 0);
  syncJumpControls();
};

document.addEventListener('keydown', (event) => {
  const jumpMenu = bar?.querySelector('[data-jump-menu]');
  if (event.key === 'Escape' && jumpMenu && !jumpMenu.hidden) {
    event.preventDefault();
    closeJumpMenu(true);
    return;
  }
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]')
  ) return;
  if (!audio?.dataset.src) return;

  if (event.key === ',' || event.key === '.') {
    event.preventDefault();
    jumpToMarker(event.key === ',' ? -1 : 1);
  } else if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    jumpToEpisode(event.key === '[' ? -1 : 1);
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -10 : 10;
    const limit = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : audio.currentTime + delta;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), limit);
    syncProgress();
    syncSpans();
    syncJumpControls();
  }
});

/** Stan „gra ten odcinek” dla listy i dla przycisku przy tytule. */
const syncPlayers = () => {
  if (!audio) return;
  const slug = audio.dataset.slug ?? '';
  const playing = !audio.paused;
  for (const button of document.querySelectorAll('[data-episode-play]')) {
    const playingThis = Boolean(slug) && button.dataset.audioSlug === slug && playing;
    button.dataset.state = playingThis ? 'playing' : 'paused';
    button.setAttribute('aria-pressed', String(playingThis));
    const label = playingThis
      ? button.dataset.stopLabel ?? 'Zatrzymaj audycję'
      : button.dataset.label ?? 'Odtwórz audycję';
    button.setAttribute('aria-label', label);
    const text = button.querySelector('[data-play-text]');
    if (text) text.textContent = label;
  }
  for (const row of document.querySelectorAll('.episode-row[data-audio-slug]')) {
    row.classList.toggle('is-playing', Boolean(slug) && row.dataset.audioSlug === slug && playing);
  }
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

// Pasek zwija się do zera razem z paddingiem i marginesem — bez tego po usunięciu
// elementu treść pod nim przeskakuje o te kilkanaście pikseli.
const collapseNote = (note) => {
  if (!note) return;
  const style = getComputedStyle(note);
  const from = {
    height: `${note.offsetHeight}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    opacity: 1,
  };
  note.style.overflow = 'hidden';
  const animation = note.animate([from, { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }], {
    duration: 220,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    fill: 'forwards',
  });
  animation.finished.then(() => note.remove()).catch(() => note.remove());
};

// Menu na telefonie. Delegacja na dokumencie, bo po nawigacji klienckiej nagłówek
// jest nowym elementem, a handler przypięty do przycisku zostałby przy starym.
const closeMenu = () => {
  const nav = document.querySelector('.site-nav');
  const toggle = document.querySelector('[data-menu-toggle]');
  if (nav) delete nav.dataset.open;
  toggle?.setAttribute('aria-expanded', 'false');
};

document.addEventListener('click', (event) => {
  const toggle = event.target instanceof Element ? event.target.closest('[data-menu-toggle]') : null;
  if (toggle) {
    const nav = document.querySelector('.site-nav');
    const open = nav?.dataset.open === 'true';
    if (nav) nav.dataset.open = String(!open);
    toggle.setAttribute('aria-expanded', String(!open));
    return;
  }
  const insideNav = event.target instanceof Element && event.target.closest('.site-nav');
  if (insideNav) closeMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});

document.addEventListener('astro:page-load', closeMenu);

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

// `astro:page-load` odpala się także przy pierwszym wejściu, a adres po zapisie `?f=`
// wygląda jak nowy link — bez tej flagi drugie przejście ustawiałoby początek fragmentu
// zamiast sekundy z `?t=`.
let applyLinksOnNextPage = true;
document.addEventListener('astro:before-swap', () => {
  applyLinksOnNextPage = true;
});

// Delegacja na dokumencie: po nawigacji klienckiej lista jest nowym elementem.
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-episode-play]') : null;
  if (!button) return;
  event.preventDefault();
  toggleEpisode(payloadOf(button));
  syncPlayers();
});
// Szerokość osi zmienia się przy zmianie okna i przy zwijaniu paska — znaczniki trzymają
// się procentów, więc wystarczy je przerysować po zmianie rozmiaru.
const markersRail = bar?.querySelector('[data-progress]');
if (markersRail && 'ResizeObserver' in window) {
  new ResizeObserver(() => renderMarkers()).observe(markersRail);
} else {
  window.addEventListener('resize', () => renderMarkers());
}

const initPage = () => {
  readAudioEpisodes();
  spans = [...document.querySelectorAll('[data-span-start]')].map((element) => ({
    element,
    start: Number(element.dataset.spanStart),
    end: Number(element.dataset.spanEnd),
    kind: element.dataset.kind,
    progress: element.querySelector('[data-fragment-progress]'),
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

  for (const element of document.querySelectorAll('[data-fragment-progress]')) {
    if (element.dataset.bound === 'true') continue;
    element.dataset.bound = 'true';
    const row = element.closest('[data-span-start]');
    const start = Number(row?.dataset.spanStart ?? 0);
    const end = Number(row?.dataset.spanEnd ?? 0);
    if (!(end > start)) continue;

    // Przewijanie w obrębie fragmentu: ten sam czas trafia do nagrania, ale nigdy
    // poza jego koniec, bo fragment bywa dłuższy niż samo nagranie.
    const seekInside = (ratio) => {
      if (!audio) return;
      const target = start + Math.min(1, Math.max(0, ratio)) * (end - start);
      const limit = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : target;
      audio.currentTime = Math.max(0, Math.min(target, limit));
      syncProgress();
      syncSpans();
    };
    const ratioFromEvent = (event) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    };
    let dragging = false;
    element.addEventListener('pointerdown', (event) => {
      dragging = true;
      element.setPointerCapture(event.pointerId);
      seekInside(ratioFromEvent(event));
    });
    element.addEventListener('pointermove', (event) => {
      if (dragging) seekInside(ratioFromEvent(event));
    });
    element.addEventListener('pointerup', () => {
      dragging = false;
    });
    element.addEventListener('keydown', (event) => {
      if (!audio) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 5 : -5;
        seekInside((audio.currentTime - start + step) / (end - start));
      }
    });
  }

  if (applyLinksOnNextPage) {
    applyLinksOnNextPage = false;
    applyDeepLink();
    applyFragmentLink();
    applyTimeLink();
  }
  applyEntriesLink();
  readMarkers();
  renderMarkers();
  syncSpans();
  syncPlayers();
  syncFragment();
  syncJumpControls();
};

/** Przełącznik wejść jest stanem strony, więc trafia do adresu jako `?wejscia=0`.
 * Dzięki temu skopiowany adres odtwarza to, co widzi nadawca. */
const applyEntriesLink = () => {
  const toggle = document.querySelector('#show-entries');
  if (!toggle) return;
  const value = new URLSearchParams(location.search).get('wejscia');
  if (value !== null) toggle.checked = value !== '0';
  if (toggle.dataset.bound === 'true') return;
  toggle.dataset.bound = 'true';
  toggle.addEventListener('change', () => {
    const url = new URL(location.href);
    if (toggle.checked) url.searchParams.delete('wejscia');
    else url.searchParams.set('wejscia', '0');
    history.replaceState(null, '', url);
  });
};

initPage();
document.addEventListener('astro:page-load', initPage);
