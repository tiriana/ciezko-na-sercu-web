const root = document.documentElement;

document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  button.setAttribute('aria-pressed', String((root.dataset.theme ?? (systemDark ? 'dark' : 'light')) === 'dark'));

  button.addEventListener('click', () => {
    const current = root.dataset.theme ?? (systemDark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem('cns-theme', next);
    button.setAttribute('aria-pressed', String(next === 'dark'));
  });
});

const search = document.querySelector('[data-filter-title]');
if (search) {
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
      for (const other of yearChips) {
        other.setAttribute('aria-pressed', String(other === chip));
      }
      apply();
    });
  }
}

const audio = document.querySelector('[data-episode-audio]');
if (audio) {
  const players = [...document.querySelectorAll('[data-track-start]')];
  // Pozycje, które mają świecić w trakcie odtwarzania: utwory, tematy i cytaty.
  const spans = [...document.querySelectorAll('[data-span-start]')].map((element) => ({
    element,
    start: Number(element.dataset.spanStart),
    end: Number(element.dataset.spanEnd),
    kind: element.dataset.kind,
  }));

  let pendingSeek = null;

  const playFrom = (start) => {
    const seek = () => {
      audio.currentTime = start;
      audio.play();
    };

    if (audio.readyState >= 1) {
      seek();
      return;
    }

    if (pendingSeek) audio.removeEventListener('loadedmetadata', pendingSeek);
    pendingSeek = seek;
    audio.addEventListener('loadedmetadata', pendingSeek, { once: true });
    audio.load();
  };

  // Stan liczymy zawsze z currentTime, a nie z własnego zegara: po powrocie do karty,
  // po przewinięciu i po zmianie prędkości odtwarzania wyróżnienie zgadza się samo.
  const activeSpan = (time) => spans.find((span) => time >= span.start && time < span.end) ?? null;

  const setPlayingIcon = (button, playing) => {
    if (!button) return;
    button.dataset.state = playing ? 'playing' : 'paused';
    button.dataset.label ??= button.getAttribute('aria-label') ?? '';
    button.setAttribute('aria-label', playing ? 'Wstrzymaj odtwarzanie' : button.dataset.label);
  };

  const sync = () => {
    const active = audio.paused ? null : activeSpan(audio.currentTime);
    for (const span of spans) {
      const isActive = active === span;
      span.element.classList.toggle('is-active', isActive);
      if (isActive) span.element.setAttribute('aria-current', 'true');
      else span.element.removeAttribute('aria-current');

      if (span.kind === 'track') {
        setPlayingIcon(span.element.querySelector('.track-play'), isActive);
      }
    }
  };

  audio.addEventListener('timeupdate', sync);
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
  audio.addEventListener('seeked', sync);
  // W tle przeglądarka ogranicza timeupdate — po powrocie do karty stan dosynchronizowuje się tutaj.
  document.addEventListener('visibilitychange', sync);

  for (const button of players) {
    const start = Number(button.dataset.trackStart);
    button.addEventListener('click', () => {
      const row = button.closest('[data-span-start]');
      const isCurrent = row
        ? audio.currentTime >= Number(row.dataset.spanStart) && audio.currentTime < Number(row.dataset.spanEnd)
        : false;
      if (isCurrent && !audio.paused) {
        audio.pause();
        sync();
        return;
      }
      playFrom(start);
    });
  }
}
