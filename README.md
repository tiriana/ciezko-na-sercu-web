# ciezko-na-sercu-web

1. Produkcja: **https://ciezko-na-sercu.pages.dev** — gałąź `main`, Cloudflare Pages.
2. Staging: **https://develop.ciezko-na-sercu.pages.dev** — gałąź `develop`, z `noindex`.
3. Podglądy: **https://<gałąź>.ciezko-na-sercu.pages.dev** — dla gałęzi `feat/**`.

Strona z katalogiem odcinków audycji „Ciężko na sercu" (Trójka): lista odcinków, strona
każdego odcinka i — uzupełniane z czasem — opracowanie: rozpoznane utwory, wykonawcy,
streszczenie i tematy.

Strona nie publikuje dźwięku ani treści audycji. Indeksuje odcinki i linkuje do nich.

## Przepływ

1. `detect-episode.yml` — w środę od 00:05 do 02:00 czasu polskiego (crony UTC na
   wtorkowy wieczór i środowy ranek plus strażnik strefy, więc działa i w CET, i w CEST)
   co 10 minut pobiera listę odcinków ze strony audycji i porównuje ją z `data/catalog.json`.
   Brak nowego wpisu albo jeszcze nieudostępniony plik audio kończy przebieg sukcesem —
   kolejne sondowanie za 10 minut ponowi próbę.
2. `refresh-catalog.yml` — gdy wykrycie znajdzie odcinek spoza katalogu (albo ręcznie):
   `scripts/fetch-episodes.mjs` czyta paginację serwisu, `scripts/build-catalog.mjs` liczy
   katalog, `scripts/stub-episodes.mjs` zakłada puste opracowanie, commit trafia do `main`,
   deploy publikuje wpis bez tracklisty, a `spans.yml` liczy dla niego bloki mowy.
3. `spans.yml` — VAD (Silero ONNX, model 2 MB) wyznacza bloki mowy i zapisuje
   `data/artifacts/<uuid>/speech-spans.json`. Trwa ~2 minuty na odcinek; wynik jest
   wejściem dla transkrypcji (whisper dostaje ~20% nagrania) i dla Shazama.
4. `transcribe.yml` — macierz 4–6 jobów, każdy transkrybuje po ~6 bloków mowy; części
   jadą do artefaktów, `commit` sprawdza komplet i składa transkrypt. Plik audio nie
   trafia na dysk runnera ani do artefaktów. Pomija odcinki z choć jednym znacznikiem
   „ok” przy wyborze z kolejki (ręczne wskazanie odcinka albo `force` to obchodzi).
5. Opracowanie odcinka leży w `data/episodes/<uuid>.json`; build czyta wyłącznie `data/`.
6. Zmiana formatu strony audycji nie wyłącza wykrywania po cichu: przebieg kończy się
   błędem i otwiera (albo komentuje) issue „Środowe wykrycie odcinka nie działa”.

Środowa ścieżka jest w pełni automatyczna: sondowanie co 10 minut → katalog, zaślepka
opracowania i deploy wpisu → bloki mowy → transkrypcja → rozpoznanie utworów i profil
głosu → streszczenie AI i etykiety wejść → deploy z uzupełnionym programem.
Ręcznie zostaje tylko redakcja znaczników w edytorze (`npm run edytor`).

## Uruchomienie

```
mise install       # Node w wersji z mise.toml
mise run build     # waliduje data/ i buduje dist/
mise run dev       # podgląd na http://localhost:4321
```

1. `mise run build` — `scripts/check-data.mjs` i `astro build`.
2. `mise run e2e` — testy Playwright na zbudowanym `dist/` (build musi być aktualny).
3. `npm run check` — sama walidacja `data/`, bez budowania.
4. `npm run edytor` — lokalny edytor osi czasu na http://localhost:4330.
5. `npm run queue` — przelicza `data/queue.json` (tempo i plan opracowań).
6. `npm run episodes` — pobiera listę odcinków ze strony audycji (domyślnie na stdout).
7. `npm run catalog -- .cache/episodes.json data/catalog.json` — przelicza katalog
   z pobranej listy.

## Fonty

`scripts/subset-fonts.sh` odtwarza `public/fonts/*.woff2` przez `pyftsubset` (fontTools +
brotli) do zakresu znaków używanego na stronie i sprawdza, że każdy znak z `dist/**/*.html`
obecny w źródle trafił do podzbioru:

```
python3 -m venv .venv-fonts
.venv-fonts/bin/pip install fonttools brotli
PATH="$PWD/.venv-fonts/bin:$PATH" scripts/subset-fonts.sh
```

## Edytor osi czasu

`npm run edytor` otwiera listę odcinków, waveform, player, edycję tytułu, utworów
(wykonawca, tytuł, album, start, czas, ukrycie) i wejść. Zapis trafia do
`data/overrides/<id>.json` i `data/titles.json`, więc kolejne przeliczenie katalogu ani
transkrypcja niczego nie kasują. Po zapisie: `mise run build`.

Nad playerem jest waveform z `GET /api/peaks?id=`: 100 słupków na sekundę, liczonych
przez `ffmpeg` prosto z `audioUrl` (nagranie nigdy nie leży w repo), z cache
w `.cache/peaks/`. Kółko przybliża, przeciągnięcie tła przesuwa okno, klik przewija bez
grania, dwuklik gra. Znaczniki to same początki (utwór, wejście) — koniec fragmentu jest
tam, gdzie zaczyna się następny, więc przesunięcie początku domyka poprzedni fragment
i zapisuje jego `end`. Znaczniki przeciąga się myszką albo strzałkami po dojściu Tabem;
dokładność to 10 ms (Alt + strzałka), bo tyle wynosi słupek waveformu i mniej więcej
ramka MP3. Pasek zapisu przykleja się do dołu: kropka oznacza niezapisane zmiany,
`Ctrl+S` zapisuje, a przełącznik `auto-zapis` robi to 1,2 s po ostatniej zmianie.
Bez `ffmpeg` albo bez sieci w miejscu waveformu jest komunikat z powodem i przycisk
ponowienia, a reszta edytora działa normalnie.

## Dane

1. `data/catalog.json` — katalog odcinków: data, tytuł, slug(i), `articleId`, `audioUrl`.
2. `data/episodes/<uuid>.json` — opracowania: utwory, wejścia, streszczenie, creditsy.
3. `data/transcripts/<uuid>.json|.txt` — pełne transkrypty i segmenty.
4. `data/titles.json` — tytuły redakcyjne dla odcinków o tytule technicznym
   („Ciężko na sercu 1 maja godz. 0005”). Każdy wpis trzyma `originalTitle`, a strona
   pokazuje oba i oznacza nasz tytuł jako nieoficjalny.
5. `data/catalog-titles.json` — tytuły wyjątków wstawiane już przy budowie katalogu.
6. `data/overrides/<uuid>.json` — ręczne poprawki utworów i creditsów, odporne na
   ponowne przeliczenia.
7. `data/aliases.json` — warianty nazw sprowadzone do jednej osoby lub zespołu.
8. `data/people.json`, `data/duplicates.json`, `data/queue.json` — profile osób,
   odcinki-duplikaty, plan kolejki opracowań.

`npm run check` waliduje całość przed buildem.

## Deploy

Gałąź wybiera środowisko:

1. `main` → produkcja, wydanie z semantic-release (numer wersji w stopce).
2. `develop` → staging na `develop.ciezko-na-sercu.pages.dev`, z `noindex`.
3. `feat/**` → podgląd pod własnym adresem gałęzi (`preview.yml`).

Workflow:

1. `deploy.yml` — build i `wrangler pages deploy`; wymaga sekretu `CLOUDFLARE_PAGES_TOKEN`
   (uprawnienie Account → Cloudflare Pages → Edit) i zmiennej `CLOUDFLARE_ACCOUNT_ID`
   (przy jej braku numer konta jest pobierany z API). Po publikacji na `main` test dymny
   sprawdza stronę główną, wersję w stopce, stronę odcinka i plik `/_astro/`; nieudany
   przebieg otwiera (albo komentuje) issue „Wdrożenie na produkcję nie działa”.
2. `detect-episode.yml` — środowe wykrycie nowego odcinka; `workflow_dispatch`
   z „Symuluj nowy odcinek” przechodzi całą ścieżkę bez czekania na publikację
   (transkrypcji wtedy nie zamawia).
3. `refresh-catalog.yml` — odświeżenie katalogu ze strony audycji.
4. `spans.yml` / `transcribe.yml` / `transcribe-daily.yml` — bloki mowy, transkrypcja
   wskazanych odcinków i wybór jednej zaległości dziennie.
5. `refresh-titles.yml` — raz w tygodniu sprawdza odcinki z ostatniego miesiąca, czy
   radio nadało im tytuł redakcyjny, i przenosi go do katalogu.
6. `release.yml` — wersja i changelog z typów commitów.
7. `rollback.yml` — cofnięcie produkcji do wskazanego wdrożenia Cloudflare
   (`workflow_dispatch` z id wdrożenia); po cofnięciu ten sam test dymny i wersja
   odczytana ze stopki w podsumowaniu.

## Dokumentacja

1. [docs/plan.md](docs/plan.md) — zakres, model danych, harmonogram, ryzyka.
2. [docs/design.md](docs/design.md) — co przenosimy z wyglądu Trójki, a czego nie.
3. [docs/stack.md](docs/stack.md) — wybór generatora i odrzucone alternatywy.
4. [docs/llm.md](docs/llm.md) — wybór modelu językowego: darmowe limity dostawców,
   losowanie, karencje i diagnoza.
5. `mockup/` — statyczny mockup, z którego powstał layout (nie jest deployowany).

Odcinki, w których choć jeden znacznik oznaczono w edytorze jako „ok”, są nietykalne
dla automatów: `snap-boundaries`, `snap-topics` i `import-tagger` pomijają je i mówią
o tym w podsumowaniu (`import-tagger` nadpisze tylko z `--force`). Stan „ok” leży
w `data/reviewed.json` i jedzie z repo.
