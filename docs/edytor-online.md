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
2. Praca idzie na waveformie: klik w znacznik otwiera pod spodem panel z wszystkimi
   polami fragmentu (start, koniec, wykonawca, tytuł, album, etykieta, ok, nierozpoznany).
   Zmiany trafiają do szkicu w IndexedDB (per urządzenie). Nic nie idzie do sieci, dopóki
   nie klikniesz „Publikuj”.
3. Publikacja scala szkic z istniejącymi poprawkami (`mergeOverrides`) i wysyła **jeden
   commit** na `main` przez Git Data API: blob → tree (`base_tree`) → commit → `PATCH` ref.
   Commit ma typ `fix`, więc semantic-release zrobi patch i `deploy.yml` opublikuje stronę.
4. Commit dotyka `data/overrides/<uuid>.json`, a przy zmianie tytułu `data/titles.json`
   i przy zmianie znaczników `data/reviewed.json`. Zapis aliasów to osobny commit na
   `data/aliases.json` (widok „Tagi i aliasy”).
5. Znaczniki „przejrzane” czytamy z `data/reviewed.json` i tam wracają, kluczowane
   etykietą fragmentu (`t:wykonawca|tytuł` dla utworu, `p:etykieta` dla wejścia), więc
   postęp widać też w lokalnym edytorze i na stronie.
6. Tytuł: oficjalny pochodzi z katalogu, nasz nieoficjalny z `data/titles.json`.
   Nieoficjalny pokazujemy **tylko wtedy**, gdy oficjalny jest techniczny
   („Ciężko na sercu 11 listopada godz. 00:06”). Gdy radio doda własny tytuł, wygrywa
   oficjalny, a nasz zostaje w pliku bez wpływu na stronę. W edytorze widać plakietkę
   „oficjalny/nieoficjalny”; wyczyszczenie pola wraca do oficjalnego.

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

Token jest jedynym kluczem: żyje w pamięci karty i w `sessionStorage` tej karty, więc
przeżywa odświeżenie strony, ale ginie z zamknięciem karty i nie jest widoczny w innych
kartach. Nigdy nie trafia do `localStorage` ani do cookie. Wpis wygasa po 8 godzinach,
a 401 czyści go i pokazuje logowanie. Dwie drogi:

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
   w GitHubie odcina dostęp bez zmian w kodzie. `sessionStorage` jest dostępny tylko
   skryptom z tego samego originu, a CSP dopuszcza wyłącznie `script-src 'self'`.
4. Odpowiedź 401 czyści sesję i pokazuje przycisk logowania; szkic zostaje w IndexedDB,
   więc po ponownym zalogowaniu publikacja wysyła te same zmiany. Nic nie zapisuje się
   po cichu.
5. Historia i cofanie są po stronie Gita: każda publikacja to commit `fix(dane): …`,
   więc `git revert` wystarcza.

## Waveform

`static.prsa.pl` nie wysyła nagłówków CORS, a `AnalyserNode` wymaga odtwarzania w czasie
rzeczywistym — przeglądarka nie policzy więc waveformu sama. Liczy go `ffmpeg` w CI:

1. `scripts/compute-peaks.mjs` pisze `data/peaks/<uuid>.bin` (1 bajt na słupek, 20
   słupków/s, ~135 kB na odcinek) i `data/peaks/index.json`.
2. `.github/workflows/peaks.yml` liczy brakujące pliki i commituje wynik jako `chore:` —
   bez typu wydania nie ma deployu. Zamawia go `refresh-catalog.yml` po commicie katalogu,
   bo push z `GITHUB_TOKEN`-em nie uruchamia workflowów z `on: push`.
3. Edytor czyta `index.json`, żeby nie pytać o nieistniejące pliki, a potem pobiera
   pojedynczy `.bin`.

W oknie waveformu kółko myszy przybliża i oddala wokół kursora (jak w lokalnym
edytorze), przyciski −/+ wokół miejsca odtwarzania, przeciąganie tła przesuwa okno,
klik przeskakuje, dwuklik gra. Znaczniki to granice utworów (niebieskie) i wejść
(turkusowe); zielone z ✓ są oznaczone jako przejrzane, wybrany ma zieloną obwódkę.
Znacznik przeciąga się myszką albo strzałkami po wybraniu; `Shift+Enter` oznacza ok,
`Del` usuwa dodany fragment albo ukrywa bazowy, `N`/`P` skacze po nieprzejrzanych.
`Shift+N` dodaje wejście, `Shift+T` utwór w miejscu odtwarzania, spacja gra/pauzuje,
`,` i `.` skaczą po znacznikach, `+`/`-` zmieniają zoom, strzałki przesuwają okno.

Prawy przycisk na waveformie otwiera menu: na tle dodaje wejście albo utwór w miejscu
kliknięcia, na znaczniku pozwala oznaczyć ok, edytować wszystkie pola, scalić z poprzednim
znacznikiem tego samego rodzaju albo usunąć. Panel pod waveformem ma te same akcje.

Utwór z bazy nie ma w poprawkach pola `unrecognized`, więc „oznacz jako nierozpoznany”
ukrywa rozpoznany wiersz i dodaje w tym miejscu nierozpoznany — na osi zostaje jeden
fragment, a strona pokazuje, że to zgadywanka.

Skala waveformu jest skalą odtwarzacza (`scripts/lib/timeline.mjs`), bo nagłówek mp3 bywa
krótszy niż realne audio — bez tego kreska rozjeżdża się ku końcowi audycji. Oś liczymy
z `data/peaks/index.json` (`durationSec`), nie z `durationSec` pliku odcinka: część
opracowań ma tam długość z dekodera (o ~0,23% dłuższą, do ~16 s na audycji). Gdy wartości
się różnią, nagłówek odcinka pokazuje obie.

Lista odcinków dostaje ✓, gdy każdy znacznik audycji (utwory, wejścia, dodane) ma wpis
w `data/reviewed.json`. Liczy się to w tle z plików odcinków i poprawek; po publikacji
bieżący odcinek przelicza się od razu.

## Testy

`npm run test:editor` (Playwright) nie dotyka sieci: `api.github.com` i
`raw.githubusercontent.com` są podmienione atrapami, a pliki danych czyta z lokalnego
repozytorium. Scenariusze: brak tokenu blokuje publikację, edycja wysyła jeden commit
z oczekiwaną treścią, strażnik czasu nie wpuszcza złego pliku, szkic przeżywa przeładowanie
karty, po utracie sieci lista wraca z pamięci, konflikt `409` kończy się ponowną próbą
rebazującą na nowy koniec gałęzi,
`401` wraca do logowania bez commita, alias zapisuje się jednym commitem, a żadne żądanie
nie wychodzi poza atrapę. Job `test` w `editor.yml` uruchamia te testy przed deployem.

Po publikacji `deploy.yml` uruchamia `npm run smoke:release`: sprawdza `<meta name="version">`
i stopkę na stronie głównej, a potem przechodzi przez **wszystkie** zbudowane strony
(odcinki, tagi, o projekcie) i porównuje tytuł z `site/dist`. Nieudane adresy powtarza,
bo świeży deployment potrzebuje chwili, zanim zacznie być serwowany — stary test dymny
przechodził mimo 404 na większości stron, bo pytał trzy adresy i trafiał w cache.

## Ograniczenia

1. Szkice (niezapisane poprawki) żyją w IndexedDB — per urządzenie, dopóki ich nie
   opublikujesz. Znaczniki „przejrzane” są w repozytorium, więc widać je wszędzie.
2. Edytor obsługuje utwory, wejścia, tytuł odcinka oraz tagi i aliasy; streszczenie
   i creditsy zostają w edytorze lokalnym (`npm run edytor`).
3. Audio pobiera się dopiero po kliknięciu play albo waveformu — 110-minutowy plik nie
   schodzi przy samym otwarciu odcinka.
4. Edytor publikuje prosto do `main` — bez PR. Cudza osoba z prawem zapisu mogłaby to
   zrobić tak samo; to świadoma decyzja z epica #80 (wersja jednoosobowa).

## Uruchomienie lokalne

```
npm run editor:build && npm run editor:serve   # http://localhost:4331
npm run test:editor                            # atrapa GitHub API + Playwright
```

`build-editor.mjs` składa `.cache/editor-dist` z `editor/` i `lib/overrides.mjs`, bo
przeglądarka potrzebuje importu względnego, a moduł poprawek nie może być kopiowany do repo.
