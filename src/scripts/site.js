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

  for (const button of players) {
    button.addEventListener('click', () => playFrom(Number(button.dataset.trackStart)));
  }
}
