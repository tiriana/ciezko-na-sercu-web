# v2 — artefakty, kompilator, nowe adresy

Dokument roboczy dla brancha `v2`. Deploy: `https://v2.ciezko-na-sercu.pages.dev/odcinki`
(alias brancha w Cloudflare Pages, bez nowego projektu).

## 1. Tożsamość odcinka

1. Kluczem jest uuid Polskiego Radia — ten sam ciąg w adresie odcinka, w nazwie mp3
   (`static.prsa.pl/<uuid>.mp3`) i w `catalog.json`.
2. Data nie jest kluczem: `2025-07-23` ma dwa odcinki (Ozzy `5961aa85`, zwykły `b27a7c0f`).
3. Katalog danych: `data/episodes/<iso>_<uuid>/`. Segment daty jest wyłącznie dla człowieka
   i musi zgadzać się z `metadata.json`; `npm run check` pilnuje zgodności nazwy z treścią.
4. Slug z adresu Polskiego Radia jest nieistotny: obcy slug + poprawny uuid → `307`
   na właściwy adres (sprawdzone).

## 2. Producenci artefaktów

Wszyscy uruchamiani lokalnie, niezależnie od siebie, w dowolnej kolejności, powtarzalnie.
Każdy pisze jeden plik i zapisuje odcisk wejścia (hash transkryptu, audioUrl + długość,
wersja wzorca intro), żeby nieaktualność wykrywać z danych, a nie z kolejności uruchomień.
Żaden etap nie wywołuje następnego.

| etap | artefakt | zawartość | wejście |
| --- | --- | --- | --- |
| `fetch-episode-metadata` | `metadata.json` | uuid, data, tytuł, articleId, sourceUrl, audioUrl, durationSec, program, autor, obraz | strona odcinka |
| `speech-spans` | `speech-spans.json` | `spans[]` (gdzie jest mowa) i `chunks[]` (bloki do ASR) | mp3 |
| `transcribe` | `speech.json` | segmenty whispera, okna mowy | mp3 + `speech-spans.json` |
| `identify` | `audio-id.json` | bloki muzyki, kandydaci per próbka | mp3 + `speech.json` |
| `voiceprint` | `voice.json` | bloki mówienia, wejścia w lukach | mp3 + `speech.json` |
| `enrich` | `text.json` | streszczenie, etykiety wejść | `speech.json` + `audio-id.json` |
| `intro` | `intro.json` | start, score, duration, referencja wzorca | mp3 + wzorzec intro |

Ustalenia szczegółowe:

1. `metadata.json`: data z JSON-LD `datePublished`, ale **bez konwersji strefy** — strona
   podaje czas lokalny z doklejonym `Z`. Tytuł z `headline` po odcięciu `"Ciężko na Sercu - "`;
   fallback `<title>` (rozbić po ` - `), ostateczny fallback `span.truncate`.
2. `npm run metadata <uuid…>` czyta stronę i wypisuje artefakt; `--write` tworzy
   `data/episodes/<iso>_<uuid>/metadata.json`, `--verify` porównuje odczyt z `catalog.json`
   bez zapisu. Stan na dziś: `--verify` przechodzi na **109/109** odcinkach (data, audioUrl,
   articleId zgodne z katalogiem). Katalog nadal jest źródłem tytułu wyświetlanego —
   `titles.json` i tak wygrywa — więc migracja nie zmieni podpisów odcinków.
3. `speech.json` zastępuje dzisiejsze `data/transcripts/<id>.json`; transkrypcja przestaje
   działać w CI (drugi przebieg pod rząd przerwany — zbyt wymagające i niestabilne).
4. `identify` zwraca kandydatów per próbka, nie per blok — to rozwiązuje dzisiejsze
   sklejanie dwóch piosenek bez zapowiedzi w jeden utwór.
5. `intro`: dziś `tools/find-intro.py` (NCC 8 kHz w oknie pierwszych minut) + `tools/apply-intro.py`,
   który wpisuje wykryte intro do `data/overrides`. W v2 wykrywanie staje się producentem
   `intro.json` (`start`, `score`, `duration`, `template`), a `apply-intro.py` znika.
   Plik wzorcowy `intro.mp3` zostaje poza repo.
6. `speech-spans`: Silero VAD w wersji ONNX (`onnxruntime`, model 2 MB, bez torch) — ten sam
   model co w voiceprincie, więc progi (400 ms mowy, 350 ms ciszy, 80 ms dopełnienia) są wspólne.
   `npm run spans -- --id <uuid> --url <mp3> --out <artefakt>`. Zmierzone na tym sprzęcie:
   **21 s na 2-godzinny odcinek**, mowa 16–30% audycji w 181–336 blokach, bloki do ASR
   to 20–31% odcinka. Koszt whispera licząc okna 30 s: 6930 s → 1410 s, czyli **80% mniej pracy**.
   Recall sprawdzony na trzech odcinkach z gotowym transkryptem: tekst pokryty przez `spans`
   w 81–89%, przez `chunks` w 89–98%; braki to głównie granice segmentów whispera (segment
   zaczyna się w ciszy) oraz halucynacje na muzyce („Muzyka", „Dziękuje za oglądanie."), które
   właśnie chcemy odsiać. Fragmenty z prawdopodobieństwem mowy < 0,2 to halucynacje, nie mowa,
   więc progów nie obniżamy.
7. `enrich` nie rusza etykiet redakcyjnych: pisze wyłącznie tam, gdzie etykieta jest pusta
   albo `#TODO`, i odrzuca odpowiedzi typu „brak tytułu".

## 3. Warstwa ręczna

1. `manual.json` — łatki redakcyjne w dzisiejszym formacie `data/overrides/<id>.json`:
   `tracks[]` (korekty po `artist/title/album`: `start`, `durationSec`, `end`, `newArtist`,
   `newTitle`, `newAlbum`, `hide`), `addTracks[]`, `topics[]` (`time`, `label`, `start`,
   `end`, `newLabel`, `hide`), `addTopics[]`, `credits.rename` / `credits.replace`.
   Do tego tytuł redakcyjny z `titles.json`.
2. `tags[]` i `quotes[]` — dziś bez producenta; tymczasowo w `manual.json`
   (otwarta decyzja: czy dostać producenta `tags.json` z LLM).
3. `reviewed.json` zostaje osobno: to stan przeglądu (znaczki „ok"), nie treść.
4. Edytor pisze wyłącznie `manual.json` i `reviewed.json`, nigdy `episode.json`.

## 4. Kompilator

`scripts/build-episode.mjs` — czyta artefakty z katalogu i pisze `episode.json`:

```
npm run episode <uuid>       # kompiluje jeden odcinek
npm run episode --all        # wszystkie katalogi z metadata.json
npm run episode <uuid> --preview   # pokazuje różnice, nic nie zapisuje
npm run episode <uuid> --check     # kod 2, gdy wynik różni się od zapisanego
npm run verify:migration     # harness: stare dane → artefakty → kompilat, diff z dzisiejszym renderem
```

Stan: `verify:migration` daje 109/109 zgodnych, a dla odcinka z poprawkami ręcznymi
(`82d57411…`, addTracks + zmiana tytułu) kompilat z katalogu artefaktów jest bajt w bajt
równy temu, co dziś renderuje strona (stare dane + overrides + warianty nazw).

1. Pierwszeństwo: `manual` > `text` > `audio-id`/`voice`/`intro` > reguły ze `speech`.
2. Reguły granic żyją tylko tutaj: snap do pierwszej wypowiedzi po `start + durationSec - 5 s`,
   brak nakładek, margines 1 s w edytorze.
3. `manual.patches` ma dzisiejszy format `data/overrides/<id>.json`, więc migracja przenosi
   poprawki bez tłumaczenia; `manual.title` wygrywa z tytułem z katalogu.
4. To jedyne miejsce scalania — dziś ta sama logika istnieje w dwóch kopiach
   (`src/lib/data.ts` i `applyOverrides` w `scripts/edytor.mjs`). Strona przestaje aplikować
   overrides, bo robi to kompilator.
5. `episode.json` jest wynikiem i kontraktem: czyta go strona i edytor, kształt bez zmian.
6. Katalog odcinka jest źródłem prawdy: brak artefaktu znaczy „nie policzone", nie „puste".

## 5. Adresy strony

Dziś `/odcinki/<slug>/`, gdzie slug = `<data>-<tytuł>`; zmiana tytułu psuje adres,
a `catalog.slugs[]` nie jest w ogóle emitowane jako trasy (`getStaticPaths` bierze tylko `slug`).

1. Kanoniczny adres: `/odcinki/<uuid8>/<slug>/`, gdzie `uuid8` = pierwsze 8 znaków uuid.
   Routing zależy wyłącznie od `uuid8`, slug jest ozdobnikiem dla ludzi i wyszukiwarek.
2. Unikalność `uuid8` pilnuje `npm run check` (przy 109 odcinkach kolizja jest realnie zerowa,
   ale check ma to potwierdzać, nie zakładać).
3. Każdy historyczny slug (`slugs[]`, w tym poprzednie tytuły) dostaje `301` na adres kanoniczny
   przez `public/_redirects` (Cloudflare Pages).
4. Fragment w adresie `?f=<slug utworu>` też zależy od tytułu; w v2 klucz fragmentu to sekunda
   startu (`?f=1234`), a `?f=<slug>` zostaje czytany dla starych linków.
5. Kanoniczny link (`<link rel=canonical>`) i mapa strony zawsze wskazują wersję z `uuid8`.

## 6. Migracja 109 odcinków

1. Stary `data/episodes/<id>.json` jest rozkładany na artefakty: `tracks` → `audio-id.json`
   (z `sources: shazam|zapowiedź`), `summary` → `text.json`, `tags`/`quotes`/`credits` →
   `manual.json`; `overrides` i `titles.json` → `manual.json`.
2. `legacy.json` nie powstaje — nie ma czego kasować.
3. Test akceptacyjny: dla wszystkich 109 odcinków skompilowany `episode.json` musi być
   identyczny z dzisiejszym renderem (`apply(episode, overrides, titles, aliases)`), diff zero.
   Harness: `npm run verify:migration` (czyli `episode --from-legacy --check`) — 109/109, różnic 0.
4. Ustalenie z harnessu: `topics` **nie** da się odtworzyć ze `speech.json`, bo granice
   pochodzą z taggera i wcześniejszych przebiegów snap, a stare odcinki mają je już
   poprawione; zostają więc w osobnym artefakcie `topics.json` (producent: tagger/snap),
   do którego `voice.json` i `text.json` mogą dopisywać. Dopiero nowe odcinki pójdą
   torem „granice ze speech, etykiety z text".
5. Intro w starych danych nie występuje w `episode.json` — trafiało wyłącznie do
   `overrides.addTracks` przez `tools/apply-intro.py`, więc w migracji 0 odcinków ma
   własny `intro.json`; producent intro zadziała od pierwszego nowego odcinka.
4. Migracja jest mechaniczna i jednorazowa, ale opracowywanie nowych odcinków idzie po kolei.

## 7. CI, branch, deploy

1. Lokalnie: metadane, transkrypcja, identify, voiceprint, enrich, intro.
2. W CI: walidacja (`npm run check`), kompilacja, deploy. Bez whispera i bez etapów audio.
3. Praca na branchu `v2`; Cloudflare Pages wystawia go jako `v2.ciezko-na-sercu.pages.dev`
   (alias brancha), więc podgląd jest pod `https://v2.ciezko-na-sercu.pages.dev/odcinki`.
   `.github/workflows/deploy.yml` ma `v2` dopisane do listy gałęzi i deployuje każdy push
   z `--branch=v2`; środowisko liczy się jako staging (bez indeksowania).
4. `deploy.yml` dla `main` zostaje bez zmian; merge do `main` dopiero po dopracowaniu
   obu torów (stare i nowe odcinki).
5. Kolejność wdrożenia: harness migracji z testem 1:1 → `fetch-episode-metadata` → kompilator
   z priorytetami → producenci po kolei → edytor na `manual.json` → nowe adresy i redirecty →
   wyłączenie whispera w CI.

## 8. Decyzje otwarte

1. `tags` i `quotes`: zostają w `manual.json` czy dostają producenta `tags.json` z LLM?
2. Pełne przełączenie adresów od razu na `v2` czy najpierw emisja obu wariantów obok siebie?
