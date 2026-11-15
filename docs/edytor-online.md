# Edytor online

Statyczna aplikacja do poprawiania utworów zdalnie — z telefonu albo z komputera, bez
uruchamiania czegokolwiek lokalnie. Nie ma backendu: przeglądarka czyta dane przez
`raw.githubusercontent.com`, a zapisuje bezpośrednio do repozytorium przez GitHub API.

1. Adres: <https://ciezko-edytor.pages.dev> (projekt Cloudflare Pages `ciezko-edytor`).
2. Kod: `editor/`; wspólna logika poprawek: `lib/overrides.mjs`.
3. Deploy: `.github/workflows/editor.yml` — `node scripts/build-editor.mjs` i upload
   `.cache/editor-dist`. Wersja strony głównej się nie zmienia, bo to osobny projekt.

## Przepływ

1. Edytor pobiera `data/catalog.json`, `data/titles.json` i plik odcinka
   (`data/episodes/<uuid>.json`) oraz jego poprawki (`data/overrides/<uuid>.json`).
2. Zmiany w tabeli utworów trafiają do szkicu w IndexedDB (per urządzenie). Nic nie idzie
   do sieci, dopóki nie klikniesz „Publikuj”.
3. Publikacja scala szkic z istniejącymi poprawkami (`mergeOverrides`) i wysyła **jeden
   commit** na `main` przez Git Data API: blob → tree (`base_tree`) → commit → `PATCH` ref.
   Commit ma typ `fix`, więc semantic-release zrobi patch i `deploy.yml` opublikuje stronę.
4. Commit dotyka `data/overrides/<uuid>.json` i, przy zmianie tytułu, `data/titles.json`.
   Zapis aliasów to osobny commit na `data/aliases.json` (widok „Tagi i aliasy”).

Jeden commit zamiast pliku po pliku jest istotny: każdy push do `main` zmieniający
`data/**` odpala `repair.yml`, a `release.yml` robi wydanie, więc trzy pliki zapisane
osobno to trzy wydania i trzy deploye.

## Tagi i aliasy

1. Lista etykiet powstaje w przeglądarce: edytor pobiera pliki wszystkich odcinków przez
   klienta odczytu (cache w IndexedDB), składa z nich tagi i nazwy z creditsów i dzieli
   zlepione etykiety tym samym `lib/tags.mjs`, którego używa strona — bez kopii reguł.
2. Widok pokazuje warianty (`aliases`), kandydatów na scalenie, pominięte pary
   (`dismissed`) i typy etykiet (`types`). Kandydat = osoba, której krótsza etykieta jest
   całym słowem w dłuższej.
3. Zapis waliduje tylko alias na samego siebie i pętlę łańcucha. Cel aliasu nie musi
   istnieć w danych — kanoniczna nazwa bywa ustalona, zanim pojawi się w odcinku.
4. Przed commitem edytor pobiera świeży `data/aliases.json`. Jeśli różni się od wczytanego,
   publikacja jest wstrzymana: plik to całe listy, więc nadpisanie skasowałoby cudzą pracę.

## Logowanie

Token jest jedynym kluczem i żyje wyłącznie w pamięci karty (nie w `localStorage`,
`sessionStorage` ani cookie). Dwie drogi:

1. **Aplikacja GitHub (device flow)** — wymaga `clientId` w `editor/config.js`. Rejestracja:
   GitHub → Settings → Developer settings → GitHub Apps → New GitHub App; „Device flow”
   włączony, uprawnienia repozytorium: `Contents: Read and write`. **Nie dodawaj
   `Workflows`** — z tym uprawnieniem skradziony token mógłby wstawić workflow, który
   wypisze sekrety repo (`CLOUDFLARE_PAGES_TOKEN`, klucze LLM). Zainstaluj aplikację tylko
   na `tiriana/ciezko-na-sercu-web`.
2. **Wklejony token** (fine-grained PAT) — jedno repo, `Contents: Read and write`, ważność
   maksymalnie 90 dni. Działa bez rejestracji aplikacji.

Kontrola dostępu to uprawnienia GitHuba: po zalogowaniu edytor pyta
`GET /repos/tiriana/ciezko-na-sercu-web` i sprawdza `permissions.push`. Konto bez prawa
zapisu dostaje 403 od GitHuba, a edytor zostaje w trybie tylko do odczytu — nie ma listy
dozwolonych osób do utrzymywania.

## Bezpieczeństwo

1. `editor/_headers` ustawia CSP bez skryptów zewnętrznych (`script-src 'self'`), więc
   wstrzyknięcie skryptu z zewnątrz jest zablokowane, a token nie ma jak wyciec do obcej
   domeny (`connect-src` wymienia tylko `api.github.com`, `raw.githubusercontent.com`,
   `github.com` i `static.prsa.pl`).
2. Strona jest osobnym originem od produkcji i ma `X-Robots-Tag: noindex`.
3. Znika po zamknięciu karty; wylogowanie czyści go natychmiast. Unieważnienie tokenu
   w GitHubie odcina dostęp bez zmian w kodzie.
4. Odpowiedź 401 czyści sesję i pokazuje przycisk logowania; szkic zostaje w IndexedDB,
   więc po ponownym zalogowaniu publikacja wysyła te same zmiany. Nic nie zapisuje się
   po cichu.
4. Historia i cofanie są po stronie Gita: każda publikacja to commit `fix(dane): …`,
   więc `git revert` wystarcza.

## Waveform

`static.prsa.pl` nie wysyła nagłówków CORS, a `AnalyserNode` wymaga odtwarzania w czasie
rzeczywistym — przeglądarka nie policzy więc waveformu sama. Liczy go `ffmpeg` w CI:

1. `scripts/compute-peaks.mjs` pisze `data/peaks/<uuid>.bin` (1 bajt na słupek, 20
   słupków/s, ~135 kB na odcinek) i `data/peaks/index.json`.
2. `.github/workflows/peaks.yml` uruchamia się po zmianie `data/catalog.json` (czyli po
   nowym odcinku) i commituje wynik jako `chore:` — bez typu wydania nie ma deployu.
3. Edytor czyta `index.json`, żeby nie pytać o nieistniejące pliki, a potem pobiera
   pojedynczy `.bin`.

Skala waveformu jest skalą odtwarzacza (`scripts/lib/timeline.mjs`), bo nagłówek mp3 bywa
krótszy niż realne audio — bez tego kreska rozjeżdża się ku końcowi audycji.

## Testy

`npm run test:editor` (Playwright) nie dotyka sieci: `api.github.com` i
`raw.githubusercontent.com` są podmienione atrapami, a pliki danych czyta z lokalnego
repozytorium. Scenariusze: brak tokenu blokuje publikację, edycja wysyła jeden commit
z oczekiwaną treścią, strażnik czasu nie wpuszcza złego pliku, szkic przeżywa przeładowanie
karty, drugi odczyt idzie po `ETag` (304), konflikt `409` kończy się ponowną próbą,
`401` wraca do logowania bez commita, alias zapisuje się jednym commitem, a żadne żądanie
nie wychodzi poza atrapę. Job `test` w `editor.yml` uruchamia te testy przed deployem.

## Ograniczenia

1. Szkice, „przejrzane” i postęp żyją w IndexedDB — per urządzenie. Źródłem prawdy jest
   repozytorium, więc nic nie przepada trwale, ale telefon i komputer nie widzą tych samych
   szkiców; wyczyszczenie danych przeglądarki też je kasuje.
2. Edytor obsługuje utwory, tytuł odcinka oraz tagi i aliasy; wejścia, streszczenie
   i creditsy zostają w edytorze lokalnym (`npm run edytor`).
3. Audio pobiera się dopiero po kliknięciu play albo waveformu — 110-minutowy plik nie
   schodzi przy samym otwarciu odcinka.
3. Edytor publikuje prosto do `main` — bez PR. Cudza osoba z prawem zapisu mogłaby to
   zrobić tak samo; to świadoma decyzja z epica #80 (wersja jednoosobowa).

## Uruchomienie lokalne

```
npm run editor:build && npm run editor:serve   # http://localhost:4331
npm run test:editor                            # atrapa GitHub API + Playwright
```

`build-editor.mjs` składa `.cache/editor-dist` z `editor/` i `lib/overrides.mjs`, bo
przeglądarka potrzebuje importu względnego, a moduł poprawek nie może być kopiowany do repo.
