// Zgłaszanie błędów bez formularza Google. Jeden przycisk „Zgłoś błąd” na stronie odcinka
// otwiera dymek z gotowymi rodzajami błędu i polem opisu. Zgłoszenie idzie prosto do arkusza
// przez web app Apps Script, podpisane HMAC-em, żeby blind boty nie zasypywały zakładki.
// Gdy sieci nie ma, zgłoszenie czeka w localStorage i idzie przy następnej wizycie.

const ENDPOINT =
  'https://script.google.com/macros/s/AKfycbz-btiVjGXn5gqsya5wTBHTAAVwxqjl-6NOt3aK2gcggZwQlVHsawuiZMv4VZ8LX6o8qg/exec'; // web app Apps Script dopisujący wiersz do zakładki `Zgłoszenia`
// Klucz jest jawny w kodzie strony — podpis odsiewa tylko ślepe boty, nie chroni przed kimś,
// kto przeczytał ten plik. Serwer i tak ogranicza tempo i liczbę zgłoszeń.
const SECRET = 'w2pQ7tKcN3vB8mJx5sLd1RfY6gH0aZ4eU9iO3bX7';

const QUEUE_KEY = 'ciezko:zgloszenia';
const DRAFT_KEY = 'ciezko:szkic';
const REJECTED = 'dziś już dużo zgłoszeń o tym fragmencie — spróbuj później';
const DRAFT_DELAY = 800;
const TOAST_DURATION = 4500;

const TYPES = {
  'brak-wejscia': 'Brakuje wejścia',
  'poczatek-uciety': 'Początek ucięty',
  'zly-tytul': 'Zły tytuł',
  'zly-start': 'Zły start',
  'zle-nazwisko': 'Złe nazwisko',
  'znieksztalcony-tekst': 'Zniekształcony tekst',
  inne: 'Inne',
};

// Zgłoszenie mówi samo, czego dotyczy: element `<slug>|<rodzaj>[:<id>]` wybiera układ dymku.
// Cała audycja to sam tekst i „Wyślij” — chipy pasują do konkretnego fragmentu.
const CHIP_SETS = {
  transkrypt: ['zle-nazwisko', 'znieksztalcony-tekst', 'inne'],
  fragment: ['brak-wejscia', 'zly-tytul', 'zly-start', 'inne'],
};

const chipKind = (element) => {
  const kind = element.split('|')[1]?.split(':')[0] ?? '';
  if (kind === 'transkrypt') return 'transkrypt';
  // Wiersze programu: utwory i wejścia.
  if (kind === 'utwór' || kind === 'wejście') return 'fragment';
  return 'odcinek';
};

const chipsFor = (element) => CHIP_SETS[chipKind(element)] ?? [];

const renderChips = (bubble, element) => {
  const container = bubble.querySelector('.report-bubble__chips');
  container.dataset.kind = chipKind(element);
  container.hidden = chipKind(element) === 'odcinek';
  container.replaceChildren(
    ...chipsFor(element).map((type) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'report-chip';
      chip.dataset.reportType = type;
      chip.setAttribute('aria-pressed', 'false');
      chip.textContent = TYPES[type];
      return chip;
    })
  );
};

const HORNS = `<svg class="report-toast__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
  <rect x="5" y="13.4" width="14" height="7.9" rx="2.5"/>
  <rect x="6.2" y="2.6" width="3.6" height="10.8" rx="1.8"/>
  <rect x="14.2" y="5.2" width="3.6" height="8.2" rx="1.8"/>
  <rect x="10.2" y="10.2" width="3.6" height="3.2" rx="1.6"/>
  <rect x="3.2" y="13.8" width="4.6" height="3" rx="1.5" transform="rotate(-18 5.5 15.3)"/>
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

// Arkusz składa podpis z pól zakodowanych jak w adresie URL, sklejonych pionową kreską.
const sign = async (ts, report) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = [ts, report.element, report.type, report.text]
    .map((value) => encodeURIComponent(String(value)))
    .join('|');
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Szkic z całej audycji nie jest wysyłany w tle — trzymamy go lokalnie, żeby
// zamknięcie dymku nie kasowało tego, co użytkownik zdążył napisać.
const readDraft = (element) => {
  try {
    return localStorage.getItem(`${DRAFT_KEY}:${element}`) ?? '';
  } catch {
    return '';
  }
};

const saveDraft = (element, text) => {
  try {
    if (text) localStorage.setItem(`${DRAFT_KEY}:${element}`, text);
    else localStorage.removeItem(`${DRAFT_KEY}:${element}`);
  } catch {}
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

const isRejected = (error) => /za dużo zgłoszeń/i.test(String(error?.message ?? ''));

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
    <div class="report-bubble__chips" role="group" aria-label="Rodzaj błędu"></div>
    <label class="visually-hidden" for="report-bubble-text">Co jeszcze warto wiedzieć?</label>
    <textarea id="report-bubble-text" class="report-bubble__text" rows="2" placeholder="Możesz dopisać szczegóły…"></textarea>
    <div class="report-bubble__actions" hidden>
      <button type="button" class="report-send" disabled>Wyślij</button>
    </div>
    <p class="report-bubble__status" role="status" aria-live="polite"></p>
  `;

  const text = bubble.querySelector('.report-bubble__text');

  // Chipy są przerysowywane przy każdym otwarciu (odcinek i transkrypt mają inne),
  // więc klik łapiemy na kontenerze, a nie na pojedynczych przyciskach.
  bubble.querySelector('.report-bubble__chips').addEventListener('click', (event) => {
    const chip = event.target instanceof Element ? event.target.closest('[data-report-type]') : null;
    const session = state.session;
    if (!chip || !session) return;
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

  text.addEventListener('input', () => {
    const session = state.session;
    if (!session) return;
    clearTimeout(session.timer);

    // Cała audycja: tekst to całe zgłoszenie, więc idzie dopiero po „Wyślij”.
    if (session.mode === 'episode') {
      saveDraft(session.element, text.value);
      updateSendState(session);
      return;
    }

    const type = session.type ?? 'inne';
    session.timer = setTimeout(() => {
      if (state.session !== session) return;
      if (type === 'inne' && text.value.trim() === '') return;
      // Wolny tekst bez wybranego chipa to rodzaj „Inne” — niech zaznaczenie to pokaże.
      if (session.type === null) selectChip(session, 'inne');
      submit(session, type);
    }, DRAFT_DELAY);
  });

  bubble.querySelector('.report-send').addEventListener('click', () => sendEpisode(state.session));

  text.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    const session = state.session;
    if (!session || session.mode !== 'episode') return;
    event.preventDefault();
    sendEpisode(session);
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

const updateSendState = (session) => {
  if (state.session !== session) return;
  state.bubble.querySelector('.report-send').disabled = bubbleText().value.trim() === '';
};

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
    mode: chipKind(link.dataset.reportElement ?? '') === 'odcinek' ? 'episode' : 'chips',
    id: uuid(),
    type: null,
    seq: 0,
    saved: false,
    timer: 0,
  };
  state.session = session;

  bubble.querySelector('#report-bubble-target').textContent = session.target;
  renderChips(bubble, session.element);
  bubble.querySelector('.report-bubble__actions').hidden = session.mode !== 'episode';
  bubbleText().value = session.mode === 'episode' ? readDraft(session.element) : '';
  updateSendState(session);
  bubble.querySelector('.report-bubble__status').textContent = '';

  link.setAttribute('aria-expanded', 'true');
  bubble.hidden = false;
  placeBubble();
  // W trybie audycji nie ma chipa, który mógłby dostać focus — wchodzimy w pole tekstu.
  if (session.mode === 'episode') bubbleText().focus({ preventScroll: true });
  else bubble.querySelector('[data-report-type]')?.focus({ preventScroll: true });
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
    .catch((error) => {
      if (seq !== session.seq) return;
      // Limit na jeden element nie mija po odświeżeniu — kolejka tylko by go powtarzała.
      if (isRejected(error)) {
        setStatus(session, REJECTED);
        return;
      }
      enqueue(report);
      setStatus(
        session,
        navigator.onLine ? 'spróbujemy później' : 'zapisane lokalnie, wyślemy później'
      );
    });
};

/** Cała audycja: jedno zgłoszenie z wpisanego tekstu, bez podpowiedzi i bez autozapisu. */
const sendEpisode = async (session) => {
  if (!session || session.mode !== 'episode') return;
  const text = bubbleText().value.trim();
  if (!text) return;

  const report = {
    element: session.element,
    type: 'inne',
    text,
    page: location.pathname + location.search,
    id: session.id,
  };
  const seq = ++session.seq;
  const button = state.bubble.querySelector('.report-send');
  button.disabled = true;
  setStatus(session, 'zapisywanie…');

  try {
    await attempt(report);
    if (seq !== session.seq) return;
    saveDraft(session.element, '');
    bubbleText().value = '';
    setStatus(session, 'zapisano');
    closeBubble();
    showToast();
  } catch (error) {
    if (seq !== session.seq) return;
    setStatus(session, isRejected(error) ? REJECTED : 'nie udało się wysłać — spróbuj jeszcze raz');
    button.disabled = false;
  }
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
// Dymek trzyma się linku także wtedy, gdy strona przewija się pod nim.
window.addEventListener('scroll', () => state.session && placeBubble(), { passive: true });
window.addEventListener('online', flushQueue);

document.addEventListener('astro:before-swap', () => closeBubble({ focus: false }));

const init = () => {
  initLinks();
  flushQueue();
};

init();
document.addEventListener('astro:page-load', init);
