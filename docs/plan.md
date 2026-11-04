# ciezko-na-sercu-web — plan projektu

Katalog odcinków audycji „Ciężko na sercu" (Trójka) jako strona statyczna, uzupełniana
z czasem opracowaniami: rozpoznane utwory, wykonawcy, streszczenie, tematy.

## 1. Pozycjonowanie

1. Strona jest **katalogiem i indeksem**, nie archiwum audio. Nie hostuje dźwięku ani treści
   audycji — linkuje do Polskiego Radia i podaje metadane.
2. Wartość rośnie z czasem: dziś lista odcinków, docelowo opracowanie każdego z nich.
3. Odbiorca: słuchacz, który pamięta fragment audycji i chce znaleźć „co to był za utwór",
   oraz osoba szukająca odcinka po temacie albo wykonawcy.

Antyteza, której świadomie nie budujemy: odtwarzacz, mirror audio, transkrypt do czytania
w całości (patrz §8).

## 2. Nazwa i repozytorium

1. Katalog: `~/dev/tiriana/ciezko-na-sercu-web`.
2. Repozytorium: `tiriana/ciezko-na-sercu-web`.
3. Nazwa trzyma się konwencji rodzeństwa (`polskie-radio-downloader`, `radio-auditions-tagger`):
   rzeczownik + rola. `-web` mówi, że to warstwa prezentacji, a nie potok danych.
4. Ryzyko: jeśli strona obejmie kiedyś kilka audycji, nazwa stanie się zbyt wąska. Przełączenie
   na neutralną (`trojka-audycje`) jest tanie, dopóki nie ma domeny i publicznych URL-i.

## 3. Ekosystem i kontrakt danych

Trzy repozytoria, jeden kierunek przepływu:

```
polskie-radio-downloader  ──(katalog odcinków)──┐
                                                ├──> ciezko-na-sercu-web ──> surge.sh
radio-auditions-tagger    ──(opracowania)───────┘
```

Stan zastany, istotny dla projektu:

1. `polskie-radio-downloader` ma `state/` w `.gitignore` — `episodes.json` (105 odcinków)
   **nie jest** w repozytorium, więc strona nie może go po prostu pobrać. Repozytorium jest
   kompletne i nie zmieniamy go bez potrzeby.
2. `radio-auditions-tagger` ma `work/` w `.gitignore`, nie ma zdalnego repozytorium, a opracowany
   jest jeden odcinek ze 105. To POC: wolno go przepisać od zera.
3. Oba narzędzia są niezależne od programu — nazwę audycji i katalog audio biorą z konfiguracji.

Konsekwencja: **schemat tej strony jest kontraktem**, a nie odwrotnie. Tagger przepiszemy tak,
żeby emitował `data/episodes/<id>.json` bezpośrednio w formacie z §5 — bez pośredniego
`work/tracks.json` jako warstwy publicznej. Katalog odcinków zostaje przy downloaderze:
nowy workflow w tym repozytorium uruchamia go w trybie bez pobierania audio i zapisuje
`data/catalog.json`.

Ta decyzja ma dwie zalety: schemat ma jednego właściciela (stronę, czyli konsumenta),
a tagger przestaje utrzymywać własny format eksportu, którego nikt poza nim nie czyta.

## 4. Identyfikacja odcinka

Jeden identyfikator, stabilny i czytelny w URL-u:

```
<data>-<slug-tytułu>           2026-10-14-nocne-niebo-nad-estonia-i-litwa
```

1. Data jest niezmienna i sortowalna; slug rozwiązuje kolizje tytułów.
2. Identyfikator jest wspólny dla wszystkich trzech repo.
3. `articleId` zostaje jako pole pomocnicze, nie jako klucz.

## 5. Model danych

`data/catalog.json` — jeden plik na całą audycję:

```json
{
  "version": 1,
  "generatedAt": "2026-11-03T18:00:00Z",
  "program": {
    "slug": "ciezko-na-sercu",
    "name": "Ciężko na sercu",
    "station": "Trójka",
    "pageUrl": "https://www.polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644"
  },
  "episodes": [
    {
      "id": "2026-10-14-nocne-niebo-nad-estonia-i-litwa",
      "date": "2026-10-14",
      "title": "Nocne niebo nad Estonią i Litwą",
      "articleId": 3741893,
      "durationSec": null,
      "sourceUrl": null
    }
  ]
}
```

`data/episodes/<id>.json` — tylko to, co wolno pokazać:

```json
{
  "version": 1,
  "id": "2026-10-14-nocne-niebo-nad-estonia-i-litwa",
  "analyzedAt": "2026-11-05",
  "durationSec": 6818,
  "summary": "Własne streszczenie, nie opis ze strony radia.",
  "topics": [{ "start": 120, "label": "Roadburn 2026" }],
  "tracks": [
    {
      "start": 456,
      "durationSec": 259,
      "artist": "Chelsea Wolfe",
      "title": "…",
      "album": null,
      "confidence": "wysoka",
      "sources": ["shazam", "zapowiedź"],
      "links": []
    }
  ],
  "quotes": [{ "start": 1234, "text": "…" }]
}
```

Zasady modelu:

1. **Brak pliku = brak opracowania.** Obecność pliku jest jedynym źródłem prawdy o statusie;
   żadnego pola `status` do rozjazdu z rzeczywistością.
2. Każde pole poza `id` jest opcjonalne. Strona renderuje odcinek bez utworów, bez streszczenia
   i bez tematów.
3. `links` jest puste do czasu etapu linkowania (M5).
4. `confidence` i `sources` są widoczne w UI — rozpoznanie z zapowiedzi bywa błędne, a strona
   nie może tego ukrywać.
5. Transkrypt **nie wchodzi** do modelu strony (patrz §8). Zostaje artefaktem narzędzia.
6. `sourceUrl` jest wyliczany z `mp3Url` (UUID pliku) i nie jest przechowywany — patrz §9.5.

`data/schedule.json` — konfiguracja, nie lista dat:

```json
{ "episodesPerWeek": 2, "anchorDate": "2026-11-10", "order": "newest-first", "pinned": {} }
```

Daty planowanego opracowania są **wyliczane w buildzie** z pozycji w kolejce i tempa.
Commitowanie wyliczonych dat oznaczałoby, że plik kłamie po pierwszej zmianie tempa.

## 6. Widoki

### Lista (`/`)

1. Grupowanie po miesiącu, nagłówek roku; każdy wiersz: data, tytuł, czas trwania, badge stanu.
2. Badge: `opracowany` / `zaplanowany na <data>` / `skatalogowany` (bez daty, gdy kolejka
   jeszcze nie objęła odcinka).
3. Licznik postępu: „7 z 105 odcinków opracowanych" — jedyny element, który uzasadnia
   istnienie strony przed pierwszym opracowaniem.
4. Filtr po roku i wyszukiwanie po tytule po stronie klienta (jeden mały JSON indeksu).

### Szczegóły (`/odcinki/<id>`)

Kolejność sekcji odpowiada temu, po co kto tu wchodzi:

1. Nagłówek: data, tytuł, czas trwania, link do odcinka w Polskim Radiu.
2. Tracklista: czas rozpoczęcia, wykonawca, tytuł, album, pewność rozpoznania i źródło.
   Brak tracklisty → jawny komunikat „opracowanie zaplanowane na <data>", nie pusta sekcja.
3. Streszczenie odcinka.
4. Tematy przewodnie z timestampami.
5. Cytaty z zapowiedzi (krótkie, z atrybucją) — opcjonalne, zależne od §8.
6. Stopka: kiedy opracowano, czym (model/ASR), ile utworów rozpoznano z dźwięku, a ile
   z zapowiedzi.

### Wykonawcy (`/wykonawcy`, po M5)

Indeks wykonawcy → odcinki i utwory. Ranking wykonawców jest tani do policzenia w buildzie
z `tracks[].artist`, więc nie wymaga osobnego pliku wejściowego.

## 7. Architektura

1. **Generator: Astro, output statyczny.** Routing plikowy daje `/odcinki/<id>` bez własnego
   routera, strona domyślnie nie wysyła JS-u, a wyspy dołożymy tylko tam, gdzie trzeba
   (wyszukiwanie, filtry). Alternatywy odrzucone: SPA na Vite (traci osobne URL-e i SEO),
   Next z eksportem statycznym (cięższy runtime za nic), Eleventy (słabsze typowanie danych).
2. **Dane są w repozytorium**, w `data/`. Build nie sięga do sieci — powtarzalny i szybki.
   Świeżość zapewnia osobny workflow, nie build.
3. **Typowanie na wejściu**: schematy `zod` dla `catalog.json`, `episodes/*.json` i konfiguracji
   harmonogramu, walidowane w buildzie. Błąd w danych wywala build z nazwą pliku, zamiast
   renderować puste pola.
4. **Deploy: surge.sh.** Produkcja `ciezko-na-sercu.surge.sh`, podglądy `pr-<n>.ciezko-na-sercu.surge.sh`.
   Sekret `SURGE_TOKEN` wystarcza — CLI z tokenem w env wysyła `email: "token"` i pobiera konto
   po samym tokenie, więc `SURGE_LOGIN` nie jest potrzebny. Surge jest darmowy dla tego użycia.
5. **Workflow**: `build` (walidacja + build na każdym pushu i PR), `preview` (deploy podglądu
   z PR-a), `deploy` (produkcja z `main`).
6. Język strony: polski, `<html lang="pl">`; treści bez tłumaczeń.

## 8. Prawa autorskie i granice publikacji

To nie jest opinia prawna, tylko lista decyzji do potwierdzenia przed publikacją tracklisty.

1. **Audio — zdecydowane (2026-11-04)**: nie hostujemy i nie proxujemy dźwięku, ale hotlinkujemy
   plik z `static.prsa.pl` we własnym `<audio>` i startujemy od znacznika czasu utworu
   (`currentTime = track.start`). Plik pobiera przeglądarka użytkownika wprost z serwera Polskiego
   Radia, więc nie powstaje nowa emisja ani kopia. Odrzucone: re-streaming przez nasz serwer
   (wymaga licencji) i iframe z MP3 (nieostylowalny, nie działa na iOS).
2. **Opis odcinka ze strony radia**: nie kopiujemy. Streszczenie piszemy własnymi słowami.
   Wynik modelu jest szkicem do redakcji, nie gotowym tekstem.
3. **Transkrypt**: pełna transkrypcja audycji to opracowanie cudzego utworu. Nie publikujemy
   jej na stronie; zostaje w katalogu roboczym taggera.
4. **Cytaty**: krótkie fragmenty wypowiedzi z podaniem audycji i daty — polega na prawie cytatu
   (art. 29 ustawy o prawie autorskim). Limit „krótkości" jest ocenny; do potwierdzenia.
5. **Metadane utworów** (wykonawca, tytuł, czas) są faktami — bezpieczne.
6. **Linki do YouTube/Spotify**: linkowanie jest dozwolone; nie osadzamy odtwarzaczy
   i nie kopiujemy okładek bez sprawdzenia licencji.

## 9. Ryzyka i pytania otwarte

1. **Minuty GitHub Actions.** Dla prywatnego repo na planie Free jest 2000 min/mies. (do
   potwierdzenia na koncie). Transkrypcja whisper.cpp na 16 wątkach to 14:45 na odcinek; na
   2-vCPU runnerze będzie ~8× wolniej, czyli ~2 h na odcinek — 105 odcinków to ~210 h, około
   sześciu miesięcznych limitów. Wniosek: ciężkie etapy nie mogą iść na hostowanym runnerze
   w prywatnym repo. Opcje: repo publiczne (darmowe minuty), self-hosted runner, albo uruchamianie
   lokalnie i publikowanie tylko wyników.
2. **Koszt modeli.** Etap ekstrakcji (Groq, `gpt-oss-120b`) to ~192 s na odcinek przy limicie
   8000 TPM; ASR przez Groq to 7200 s audio na godzinę zegara, czyli ~1 odcinek na ~1 h, jeśli
   dzienny limit pozwoli. Przy zerowym budżecie wąskim gardłem jest limit, nie pieniądze —
   dlatego harmonogram jest wyliczany, a nie obiecywany.
3. **Rozjazd danych.** Katalog zmienia się przy każdym przebiegu downloadera (nowe odcinki,
   uzupełnione sumy kontrolne). Strona musi być odporna na odcinki pojawiające się i znikające
   między buildami; usuwanie opracowania razem z odcinkiem nie może być automatyczne.
4. **Jakość rozpoznawania.** Shazam zawodzi na koncertach i niszowych nagraniach; strona pokazuje
   pewność i źródło, ale i tak potrzebna będzie ręczna korekta wpisów (M4).
5. **Link do odcinka w Polskim Radiu — rozwiązany.** Adres ma postać
   `https://www.polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644/odcinek/<slug>,<uuid>`.
   Ostatni segment to UUID pliku MP3, więc daje się wyprowadzić z `mp3Url` w `episodes.json`.
   Slug jest kosmetyczny: sprawdzone, że dowolny slug przy poprawnym UUID zwraca właściwy
   odcinek. `sourceUrl` liczymy w buildzie, nie przechowujemy.

## 10. Kamienie milowe

1. **M0 — szkielet**: repozytorium, plan, README, pusty Astro z jednym testem.
2. **M1 — katalog**: `catalog.json` z 105 odcinkami, lista i szczegóły bez wzbogaceń,
   deploy na surge przy każdym pushu do `main`.
3. **M2 — dopływ danych**: workflow generujący `catalog.json` z downloadera, przebudowa strony
   po zmianie katalogu.
4. **M3 — pierwsze opracowanie**: przepisany tagger emitujący `data/episodes/<id>.json` dla
   odcinka, który już policzył; schemat `zod`; widok szczegółów z tracklistą i pewnością.
5. **M4 — kolejka i harmonogram**: `schedule.json`, wyliczane daty, statusy, ręczne korekty wpisów.
6. **M5 — linki do źródeł**: resolver YouTube/Spotify/Bandcamp z ręczną weryfikacją, `links` w UI.
7. **M6 — wyszukiwanie i wykonawcy**: indeks wykonawców, filtr po latach, wyszukiwanie pełnotekstowe.

Kolejność 1→3 jest sztywna (każdy krok jest użyteczny samodzielnie). M4 nie może wyprzedzić M3,
bo nie ma czego planować bez schematu opracowania.

## 11. Decyzje

### Rozstrzygnięte

1. Tagger jest POC — wolno go przepisać, a schemat tej strony jest kontraktem (§3).
2. Downloader jest kompletny — nie zmieniamy go; katalog generujemy przez uruchomienie go
   w trybie bez pobierania audio.
3. Linki do odcinków w Polskim Radiu: rozwiązane, adres wyprowadzamy z UUID pliku MP3 (§9.5).

### Do podjęcia

1. **Repo prywatne czy publiczne?** Prywatne = płatne minuty Actions przy ciężkich etapach;
   publiczne = darmowe, ale cała historia i dane są jawne (dane i tak są publiczne).
2. **Gdzie liczą się opracowania** — hostowany runner, self-hosted, czy lokalnie z publikacją
   wyników.
3. **Nazwa stanu.** Propozycja: `opracowanie` jako pojęcie nadrzędne („odcinek opracowany"),
   `rozpoznanie utworu` dla pojedynczego utworu. Alternatywy: `analiza` (brzmi technicznie),
   `introspekcja` (nie mówi nic o zawartości).
4. **Czy publikujemy cytaty z zapowiedzi**, czy tylko streszczenie i tracklistę.
5. **Potwierdzenie Astro** jako generatora.
