// Zgłaszanie błędów bez formularza Google. Jeden przycisk „Zgłoś błąd” na stronie odcinka
// otwiera dymek z gotowymi rodzajami błędu i polem opisu. Zgłoszenie idzie prosto do arkusza
// przez web app Apps Script, podpisane HMAC-em, żeby blind boty nie zasypywały zakładki.
// Gdy sieci nie ma, zgłoszenie czeka w localStorage i idzie przy następnej wizycie.

const ENDPOINT =
  'https://script.google.com/macros/s/AKfycbzdWhI4hQOJzrh4m73G05vcdSxnVQPE1caRIdsfbiYcOnwgljPccyvGakTWfOuebFL7mw/exec'; // web app Apps Script dopisujący wiersz do zakładki `Zgłoszenia`
// Klucz jest jawny w kodzie strony — podpis odsiewa tylko ślepe boty, nie chroni przed kimś,
// kto przeczytał ten plik. Serwer i tak ogranicza tempo i liczbę zgłoszeń.
const SECRET = 'w2pQ7tKcN3vB8mJx5sLd1RfY6gH0aZ4eU9iO3bX7';

const QUEUE_KEY = 'ciezko:zgloszenia';
const DRAFT_DELAY = 800;
const TOAST_DURATION = 4500;

const TYPES = {
  'brak-wejscia': 'Brakuje wejścia',
  'poczatek-uciety': 'Początek ucięty',
  inne: 'Inne',
};

const HORNS = `<svg class="report-toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M6 11.2h12a2 2 0 0 1 2 2v5.3a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-5.3a2 2 0 0 1 2-2Z"/>
  <path d="M7.2 11.2V4.7a1.7 1.7 0 0 1 3.4 0v6.5"/>
  <path d="M15.4 11.2V7.6a1.7 1.7 0 0 1 3.4 0v3.6"/>
  <path d="M10.6 11.2V9.9a1.5 1.5 0 0 1 3 0v1.3"/>
  <path d="M5.2 15.6c1.8-1.6 3.7-2.2 5.6-2.2"/>
</svg>`;

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `zgl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const readQueue = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

const writeQueue = (items) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
};

// Arkusz liczy podpis z tekstu zamienionego na ASCII (polskie znaki widzi jako `?`),
// więc podpisujemy dokładnie to, co on porównuje — treść w zgłoszeniu zostaje pełna.
const asciiOnly = (value) => value.replace(/[^\x00-\x7f]/g, '?');

const sign = async (ts, report) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(asciiOnly(`${ts}|${report.element}|${report.type}|${report.text}`))
  );
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const send = async (report) => {
  if (!navigator.onLine) throw new Error('offline');
  // Apps Script odpowiada 302 i dopiero pod tym adresem leży wynik, więc przeglądarka
  // dochodzi do JSON-a sama; podpis liczymy od nowa przy każdej próbie, bo stary `ts`
  // po dłuższym pobycie w kolejce byłby odrzucony jako nieaktualny.
  const ts = Date.now();
  const sig = await sign(ts, report);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ ...report, ts, sig }),
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  const result = await response.json().catch(() => ({ ok: true }));
  if (result && result.ok === false) throw new Error(result.error ?? 'odrzucone');
  return result;
};

const isRetryable = (error) => /nieaktualne|limit dzienny/i.test(String(error?.message ?? ''));

const attempt = async (report) => {
  try {
    return await send(report);
  } catch (error) {
    if (!isRetryable(error)) throw error;
    return send(report);
  }
};

const enqueue = (report) => {
  // Ten sam `id` w kolejce zostaje tylko raz — z najnowszym tekstem.
  writeQueue([
    ...readQueue().filter((item) => item.id !== report.id),
    { element: report.element, type: report.type, text: report.text, page: report.page, id: report.id },
  ]);
};

let flushing = false;

/** Kolejka idzie raz na wejście na stronę — bez pętli ponowień w tle. */
const flushQueue = async () => {
  if (flushing) return;
  const queue = readQueue();
  if (queue.length === 0) return;
  flushing = true;
  const rest = [];
  for (const report of queue) {
    try {
      await send(report);
    } catch {
      rest.push(report);
    }
  }
  writeQueue(rest);
  flushing = false;
};

const state = { bubble: null, toast: null, session: null, toastTimer: 0 };

const ensureBubble = () => {
  // Po nawigacji klienckiej zawartość <body> jest wymieniana, więc dymek trzeba
  // przypiąć ponownie — inaczej zostałby odłączony od dokumentu.
  if (state.bubble?.isConnected) return state.bubble;

  const bubble = document.createElement('div');
  bubble.className = 'report-bubble';
  bubble.hidden = true;
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-modal', 'false');
  bubble.setAttribute('aria-labelledby', 'report-bubble-title report-bubble-target');
  bubble.innerHTML = `
    <p class="report-bubble__eyebrow" id="report-bubble-title">Co jest nie tak?</p>
    <p class="report-bubble__target" id="report-bubble-target"></p>
    <div class="report-bubble__chips" role="group" aria-label="Rodzaj błędu">
      <button type="button" class="report-chip" data-report-type="brak-wejscia" aria-pressed="false">Brakuje wejścia</button>
      <button type="button" class="report-chip" data-report-type="poczatek-uciety" aria-pressed="false">Początek ucięty</button>
      <button type="button" class="report-chip" data-report-type="inne" aria-pressed="false">Inne</button>
    </div>
    <label class="visually-hidden" for="report-bubble-text">Co jeszcze warto wiedzieć?</label>
    <textarea id="report-bubble-text" class="report-bubble__text" rows="2" placeholder="Możesz dopisać szczegóły…"></textarea>
    <p class="report-bubble__status" role="status" aria-live="polite"></p>
  `;

  const text = bubble.querySelector('.report-bubble__text');

  for (const chip of bubble.querySelectorAll('[data-report-type]')) {
    chip.addEventListener('click', () => {
      const session = state.session;
      if (!session) return;
      const type = chip.dataset.reportType ?? 'inne';
      selectChip(session, type);
      clearTimeout(session.timer);
      // „Inne” bez zdania nie mówi nic — dopiero tekst robi z niego zgłoszenie.
      if (type === 'inne' && text.value.trim() === '') {
        setStatus(session, 'Dopisz zdanie opisu, wtedy wyślemy.');
        text.focus({ preventScroll: true });
        return;
      }
      submit(session, type);
    });
  }

  text.addEventListener('input', () => {
    const session = state.session;
    if (!session) return;
    const type = session.type ?? 'inne';
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (state.session !== session) return;
      if (type === 'inne' && text.value.trim() === '') return;
      // Wolny tekst bez wybranego chipa to rodzaj „Inne” — niech zaznaczenie to pokaże.
      if (session.type === null) selectChip(session, 'inne');
      submit(session, type);
    }, DRAFT_DELAY);
  });

  document.body.append(bubble);
  state.bubble = bubble;
  return bubble;
};

const selectChip = (session, type) => {
  session.type = type;
  for (const chip of state.bubble.querySelectorAll('[data-report-type]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.reportType === type));
  }
};

const bubbleText = () => state.bubble.querySelector('.report-bubble__text');

const setStatus = (session, message) => {
  if (state.session !== session) return;
  state.bubble.querySelector('.report-bubble__status').textContent = message;
};

/** Wiersz w arkuszu ma być zrozumiały sam, bez kolumny z typem. */
const composeText = (type, raw) => {
  const label = TYPES[type] ?? TYPES.inne;
  return raw ? `[${label}] ${raw}` : `[${label}]`;
};

const placeBubble = () => {
  const { bubble, session } = state;
  if (!bubble || !session) return;
  const rect = session.link.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  const margin = 8;
  const viewport = document.documentElement.clientWidth;

  const left = Math.min(
    Math.max(rect.left + window.scrollX, window.scrollX + margin),
    window.scrollX + viewport - width - margin
  );
  const below = rect.bottom + window.scrollY + 6;
  const above = rect.top + window.scrollY - height - 6;
  // Nad linkiem tylko wtedy, gdy dymek mieści się w widoku — inaczej zostałby ucięty.
  const top = rect.bottom + 6 + height > window.innerHeight && above > window.scrollY + margin
    ? above
    : below;

  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
};

const openBubble = (link) => {
  closeBubble({ focus: false });
  const bubble = ensureBubble();
  const session = {
    link,
    element: link.dataset.reportElement ?? '',
    target: link.dataset.reportTarget ?? '',
    id: uuid(),
    type: null,
    seq: 0,
    saved: false,
    timer: 0,
  };
  state.session = session;

  bubble.querySelector('#report-bubble-target').textContent = session.target;
  for (const chip of bubble.querySelectorAll('[data-report-type]')) {
    chip.setAttribute('aria-pressed', 'false');
  }
  bubbleText().value = '';
  bubble.querySelector('.report-bubble__status').textContent = '';

  link.setAttribute('aria-expanded', 'true');
  bubble.hidden = false;
  placeBubble();
  bubble.querySelector('[data-report-type]')?.focus({ preventScroll: true });
};

const closeBubble = ({ focus = true } = {}) => {
  const { bubble, session } = state;
  if (!bubble || bubble.hidden || !session) return;
  clearTimeout(session.timer);
  bubble.hidden = true;
  session.link.setAttribute('aria-expanded', 'false');
  state.session = null;
  if (focus) session.link.focus({ preventScroll: true });
};

const submit = (session, type) => {
  const report = {
    element: session.element,
    type,
    text: composeText(type, bubbleText().value.trim()),
    page: location.pathname + location.search,
    id: session.id,
  };
  const seq = ++session.seq;
  setStatus(session, 'zapisywanie…');

  attempt(report)
    .then(() => {
      if (seq !== session.seq) return;
      setStatus(session, 'zapisano');
      if (session.saved) return;
      session.saved = true;
      showToast();
    })
    .catch(() => {
      enqueue(report);
      if (seq !== session.seq) return;
      setStatus(
        session,
        navigator.onLine ? 'spróbujemy później' : 'zapisane lokalnie, wyślemy później'
      );
    });
};

const ensureToast = () => {
  if (state.toast?.isConnected) return state.toast;
  const toast = document.createElement('div');
  toast.className = 'report-toast';
  toast.hidden = true;
  toast.innerHTML = `${HORNS}<p class="report-toast__text">Dzięki! Zgłoszenie do nas dotarło.</p><button type="button" class="report-toast__close" aria-label="Zamknij podziękowanie">×</button>`;
  toast.querySelector('.report-toast__close').addEventListener('click', () => hideToast(true));
  document.body.append(toast);
  state.toast = toast;
  return toast;
};

const showToast = () => {
  const toast = ensureToast();
  toast.hidden = false;
  // Animacja wejścia startuje od nowa, także gdy toast już wisiał.
  toast.classList.remove('is-visible');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => hideToast(false), TOAST_DURATION);
};

const hideToast = (restoreFocus) => {
  clearTimeout(state.toastTimer);
  const toast = state.toast;
  if (!toast) return;
  toast.classList.remove('is-visible');
  toast.hidden = true;
  if (restoreFocus && state.session) state.session.link.focus({ preventScroll: true });
};

const initLinks = () => {
  for (const link of document.querySelectorAll('[data-report-link]')) {
    link.setAttribute('aria-haspopup', 'dialog');
    if (!link.hasAttribute('aria-expanded')) link.setAttribute('aria-expanded', 'false');
  }
};

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const link = target.closest('[data-report-link]');
  if (link) {
    // Bez JS link otwiera formularz; z JS nigdzie nie nawigujemy.
    event.preventDefault();
    openBubble(link);
    return;
  }

  if (!state.session) return;
  if (target.closest('.report-bubble') || target.closest('.report-toast')) return;
  closeBubble();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.session) return;
  event.preventDefault();
  closeBubble();
});

window.addEventListener('resize', placeBubble);
window.addEventListener('online', flushQueue);

document.addEventListener('astro:before-swap', () => closeBubble({ focus: false }));

const init = () => {
  initLinks();
  flushQueue();
};

init();
document.addEventListener('astro:page-load', init);
