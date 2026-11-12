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
  nierozpoznany: 'Nierozpoznany utwór',
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

const renderChips = (bubble, element, mode) => {
  const container = bubble.querySelector('.report-bubble__chips');
  container.dataset.kind = chipKind(element);
  container.hidden = mode === 'unknown-track' || chipKind(element) === 'odcinek';
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

const HORNS = `<svg class="report-toast__icon" viewBox="11 0 42 64" fill="currentColor" aria-hidden="true" focusable="false">
  <path d="M51,44 C51,53.925 42.925,62 33,62 L31,62 C21.075,62 13,53.925 13,44 L13,40 L13,40 C13,37.8 14.8,36 17,36 L21,36 L21,36 L23,36 L27,36 C27.347,36 27.679,36.059 28,36.142 L28,37.5 C28,37.776 27.776,38 27.5,38 L23.5,38 C23.224,38 23,38.224 23,38.5 C23,38.776 23.224,39 23.5,39 L28,39 C28.552,39 29,38.552 29,38 L29,36.557 C30.14,37.221 30.918,38.422 30.982,39.818 C31.081,42.108 29.271,44 27.003,44 L22.003,44 C21.451,44 21.003,44.448 21.003,45 C21.003,45.552 21.451,46 22.003,46 L26.751,46 C28.885,46 30.837,44.928 31.973,43.279 C33.119,45.006 35.106,46 37,46 C40.308,46 43,43.308 43,40 L43,12 C43,9.794 44.794,8 47,8 C49.206,8 51,9.794 51,12 L51,44 Z M13,6 C13,3.794 14.794,2 17,2 C19.206,2 21,3.794 21,6 L21,34 L17,34 C15.465,34 14.064,34.589 13,35.547 L13,6 Z M23,23 C23,20.8 24.8,19 27,19 C29.2,19 31,20.8 31,23 L31,35.537 C29.938,34.585 28.539,34 27,34 L23,34 L23,23 Z M33,23 C33,20.8 34.8,19 37,19 C39.2,19 41,20.8 41,23 L41,40 C41,42.209 39.209,44 37,44 C35.024,44 33,42.399 33,40 L33,23 Z M47,6 C43.686,6 41,8.686 41,12 L41,18.547 C39.936,17.589 38.535,17 37,17 C34.918,17 33.077,18.076 32,19.698 C30.923,18.076 29.082,17 27,17 C25.465,17 24.064,17.589 23,18.547 L23,6 C23,2.686 20.314,0 17,0 C13.7,0 11,2.7 11,6 L11,44 C11,55 20,64 31,64 L33,64 C44,64 53,55 53,44 L53,12 C53,8.7 50.3,6 47,6 L47,6 Z M38.5,38 C38.776,38 39,38.224 39,38.5 L39,40 C39,41.105 38.105,42 37,42 C36.724,42 36.5,42.224 36.5,42.5 C36.5,42.776 36.724,43 37,43 C38.657,43 40,41.657 40,40 L40,38 C40,37.448 39.552,37 39,37 L34.5,37 L34.5,37 C34.224,37 34,37.224 34,37.5 C34,37.776 34.224,38 34.5,38 L38.5,38 Z M19,27.5 C19,27.224 18.776,27 18.5,27 L15.5,27 C15.224,27 15,27.224 15,27.5 C15,27.776 15.224,28 15.5,28 L18.5,28 C18.776,28 19,27.776 19,27.5 L19,27.5 Z M29,31.5 C29,31.224 28.776,31 28.5,31 L25.5,31 C25.224,31 25,31.224 25,31.5 C25,31.776 25.224,32 25.5,32 L28.5,32 C28.776,32 29,31.776 29,31.5 L29,31.5 Z M35.5,32 L38.5,32 C38.776,32 39,31.776 39,31.5 C39,31.224 38.776,31 38.5,31 L35.5,31 C35.224,31 35,31.224 35,31.5 C35,31.776 35.224,32 35.5,32 L35.5,32 Z M48.5,33 L45.5,33 C45.224,33 45,33.224 45,33.5 C45,33.776 45.224,34 45.5,34 L48.5,34 C48.776,34 49,33.776 49,33.5 C49,33.224 48.776,33 48.5,33 L48.5,33 Z M48.5,20 L45.5,20 C45.224,20 45,20.224 45,20.5 C45,20.776 45.224,21 45.5,21 L48.5,21 C48.776,21 49,20.776 49,20.5 C49,20.224 48.776,20 48.5,20 L48.5,20 Z M15.5,15 L18.5,15 C18.776,15 19,14.776 19,14.5 C19,14.224 18.776,14 18.5,14 L15.5,14 C15.224,14 15,14.224 15,14.5 C15,14.776 15.224,15 15.5,15 L15.5,15 Z"/>
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
    if (session.mode === 'episode' || session.mode === 'unknown-track') {
      if (session.mode === 'episode') saveDraft(session.element, text.value);
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

  bubble.querySelector('.report-send').addEventListener('click', () => {
    const session = state.session;
    if (session?.mode === 'unknown-track') submit(session, 'nierozpoznany');
    else sendEpisode(session);
  });

  text.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    const session = state.session;
    if (!session || !['episode', 'unknown-track'].includes(session.mode)) return;
    event.preventDefault();
    if (session.mode === 'unknown-track') submit(session, 'nierozpoznany');
    else sendEpisode(session);
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
  state.bubble.querySelector('.report-send').disabled = bubbleText().value.trim() === '' || session.sending;
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
    mode: link.dataset.reportVariant === 'unknown-track'
      ? 'unknown-track'
      : chipKind(link.dataset.reportElement ?? '') === 'odcinek' ? 'episode' : 'chips',
    id: uuid(),
    type: null,
    seq: 0,
    saved: false,
    attempted: false,
    signalled: false,
    sending: false,
    timer: 0,
  };
  state.session = session;

  const title = bubble.querySelector('.report-bubble__eyebrow');
  const target = bubble.querySelector('#report-bubble-target');
  const textLabel = bubble.querySelector('label[for="report-bubble-text"]');
  title.textContent = session.mode === 'unknown-track' ? 'Wiesz co to za utwór?' : 'Co jest nie tak?';
  target.textContent = session.target;
  target.hidden = session.mode === 'unknown-track';
  bubble.setAttribute(
    'aria-labelledby',
    session.mode === 'unknown-track' ? 'report-bubble-title' : 'report-bubble-title report-bubble-target'
  );
  textLabel.textContent = session.mode === 'unknown-track'
    ? 'Wykonawca, tytuł lub album'
    : 'Co jeszcze warto wiedzieć?';
  bubbleText().placeholder = session.mode === 'unknown-track'
    ? 'Podaj wykonawcę, tytuł lub album…'
    : 'Możesz dopisać szczegóły…';
  renderChips(bubble, session.element, session.mode);
  bubble.querySelector('.report-bubble__actions').hidden = !['episode', 'unknown-track'].includes(session.mode);
  bubbleText().value = session.mode === 'episode' ? readDraft(session.element) : '';
  updateSendState(session);
  bubble.querySelector('.report-bubble__status').textContent = '';

  link.setAttribute('aria-expanded', 'true');
  bubble.hidden = false;
  placeBubble();
  // W trybie audycji nie ma chipa, który mógłby dostać focus — wchodzimy w pole tekstu.
  if (['episode', 'unknown-track'].includes(session.mode)) bubbleText().focus({ preventScroll: true });
  else bubble.querySelector('[data-report-type]')?.focus({ preventScroll: true });
};

// Samo otwarcie dymku przy fragmencie jest sygnałem, że coś tu nie gra — nawet gdy
// ktoś nie dopisze ani słowa. Cała audycja i cały transkrypt są na to za ogólne.
const wantsSignal = (session) => {
  const [kind = '', id] = (session.element.split('|')[1] ?? '').split(':');
  if (kind === 'utwór' || kind === 'wejście') return true;
  return kind === 'transkrypt' && id !== undefined;
};

const sendSignal = (session, text) => {
  session.signalled = true;
  const report = {
    element: session.element,
    type: 'sygnal',
    text,
    page: location.pathname + location.search,
    id: uuid(),
  };
  // Cicho: bez statusu, bez podziękowania i bez kolejki — nieudany sygnał po prostu przepada.
  send(report).catch(() => {});
};

const closeBubble = ({ focus = true, signal = true } = {}) => {
  const { bubble, session } = state;
  if (!bubble || bubble.hidden || !session) return;
  clearTimeout(session.timer);
  // Nic nie wysłano i nic nie wybrano: zostaje po cichu zgłoszony sam fakt kliknięcia,
  // a wpisany tekst (jeśli zdążył powstać) jedzie razem z nim, zamiast przepaść.
  if (signal && !session.attempted && !session.signalled && wantsSignal(session)) {
    sendSignal(session, bubbleText().value.trim());
  }
  bubble.hidden = true;
  session.link.setAttribute('aria-expanded', 'false');
  state.session = null;
  if (focus) session.link.focus({ preventScroll: true });
};

const submit = (session, type) => {
  if (session.mode === 'unknown-track' && !bubbleText().value.trim()) return;
  const report = {
    element: session.element,
    type,
    text: composeText(type, bubbleText().value.trim()),
    page: location.pathname + location.search,
    id: session.id,
  };
  const seq = ++session.seq;
  session.attempted = true;
  if (session.mode === 'unknown-track') {
    session.sending = true;
    updateSendState(session);
  }
  setStatus(session, 'zapisywanie…');

  attempt(report)
    .then(() => {
      if (seq !== session.seq) return;
      setStatus(session, 'zapisano');
      if (session.saved) return;
      session.saved = true;
      showToast();
      if (session.mode === 'unknown-track') closeBubble({ signal: false });
    })
    .catch((error) => {
      if (seq !== session.seq) return;
      // Limit na jeden element nie mija po odświeżeniu — kolejka tylko by go powtarzała.
      if (isRejected(error)) {
        setStatus(session, REJECTED);
        if (session.mode === 'unknown-track') {
          session.sending = false;
          updateSendState(session);
        }
        return;
      }
      enqueue(report);
      setStatus(
        session,
        navigator.onLine ? 'spróbujemy później' : 'zapisane lokalnie, wyślemy później'
      );
      if (session.mode === 'unknown-track') {
        session.sending = false;
        updateSendState(session);
      }
    });
};

/** Cała audycja: jedno zgłoszenie z wpisanego tekstu, bez podpowiedzi i bez autozapisu. */
const sendEpisode = async (session) => {
  if (!session || session.mode !== 'episode') return;
  session.attempted = true;
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

document.addEventListener('astro:before-swap', () => closeBubble({ focus: false, signal: false }));

const init = () => {
  initLinks();
  flushQueue();
};

init();
document.addEventListener('astro:page-load', init);
