# Wygląd: co przenosimy z Trójki, a czego nie

Analiza strony audycji `polskieradio.pl/trojka/audycje/ciezko-na-sercu,10644`, wykonana
przez przeglądarkę (Playwright) na żywej stronie, w motywie jasnym i ciemnym. Zrzuty
w `docs/reference/` są materiałem roboczym — nie są publikowane.

## 1. Zmierzone fakty

### Typografia oryginału

1. Tekst: **Roboto** (self-hosted przez `next/font`, woff2, wagi 300–700).
2. Rozmiary: `body` 16 px / 24 px, `letter-spacing: 0.16px`; nagłówek audycji 45 px / 60 px,
   waga 700; tytuły odcinków na liście 16 px, waga 400.
3. Okładka audycji to **obraz** (`static.prsa.pl/images/90f2ed43-…file?format=700`, 700×385).
   Liternictwo „CIĘŻKO NA SERCU” jest częścią grafiki, nie fontem. **Na stronie nie ma żadnego
   fontu Iron Maiden ani jemu podobnego** — nie ma więc czego licencjonować z serwisu,
   a sam logotyp Iron Maiden jest znakiem towarowym zespołu.

### Kolory (zmierzone z DOM i z pikseli zrzutu)

| Token | Jasny | Ciemny |
|---|---|---|
| tło strony | `#DFDFDF` | `#2A2A2A` |
| powierzchnia / karta | `#FDFCFC` | `#202020` |
| panel listy | `#FDFCFC` | `#1A1A1A` |
| tekst | `#373737` | `#D5D5D5` |
| nagłówki | `#141E23` | `#FDFCFC` |
| przygaszony | `#6B6B6B` | `#8E8E8E` |
| linie | `#E5E7EB` | `#373737` |
| akcent (czerwień Trójki) | `#E31936` | `#E31936` |
| hero | gradient `rgba(27,27,27,.7) → #1B1B1B` | `#171717 → #0C0C0C` |

Kontrast policzony dla par z mockupu:

1. `#373737` na `#FDFCFC` — 11,6:1.
2. `#6B6B6B` na `#FDFCFC` — 5,2:1.
3. `#E31936` na `#FDFCFC` — 4,6:1 (mieści się w AA).
4. `#E31936` na `#202020` — 3,5:1, czyli **czerwieni nie używamy do tekstu w trybie ciemnym**,
   tylko do linii, znaczników i wypełnień.
5. `#8E8E8E` na `#202020` — 5,0:1.

### Układ

1. Szerokość treści 1260 px przy 1440 px okna (margines 90 px).
2. Hero pełnej szerokości, ciemny, z okładką po lewej i opisem po prawej; dolna krawędź
   przechodzi w szare tło.
3. Lista odcinków na białej powierzchni: wiersz ~95 px, data i godzina po lewej, tytuł,
   po prawej trzy okrągłe przyciski; separatory 1 px.
4. Nagłówek sekcji z krótką czerwoną kreską pod spodem.

## 2. Czego nie kopiujemy

1. **Okładki i liternictwa** — grafika jest utworem. Robimy własny znak słowny.
2. **Logo Trójki** i elementów identyfikacji stacji — to znaki towarowe nadawcy.
3. **Zdjęć** (muzyków, sprzętu) — prawa autorskie i wizerunkowe.
4. **Opisu audycji** ze strony — tekst jest chroniony; w mockupie jest własne, krótkie
   wprowadzenie. Streszczenia odcinków piszemy własnymi słowami.
5. **Fontu Iron Maiden** — nie istnieje w serwisie, a logotyp zespołu jest zastrzeżony.
   Zamiast tego własny znak słowny z darmowego kroju (patrz §3).

Nie podlegają ochronie i są bezpieczne: kolory, układ, siatka, rozmiary, wzorce interakcji
oraz fakty (daty, tytuły, wykonawcy, czasy trwania).

## 3. Typografia zastępcza

Sprawdzone pod kątem polskich znaków diakrytycznych (fontTools, `cmap`):

| Krój | Licencja | Znaki PL | Wynik |
|---|---|---|---|
| **Anton** | OFL | pełne (Ą Ć Ę Ł Ń Ó Ś Ź Ż) | wybrany na znak słowny |
| Inter | OFL | pełne | tekst UI |
| Roboto | Apache-2.0 | pełne | dopuszczalny, bliższy oryginałowi |
| Metal Mania | OFL | **brak** Ą Ć Ę Ś Ź Ż | odrzucony — „CIĘŻKO” by się rozsypało |
| Caesar Dressing | OFL | **brak** wszystkich | odrzucony |
| Pirata One | OFL | pełne | zapasowy; blackletter, inny kierunek niż okładka |
| Grenze Gotisch | OFL | pełne | zapasowy; blackletter |

Anton jest ciężki i kondensowany, więc liternictwo z okładki (kanciaste, spiczaste) zastępujemy
jego masą i metalicznym wykończeniem: gradient `background-clip: text`, jasna krawędź u góry,
ciemny spód, delikatny cień. To własna interpretacja stylu, nie kopia znaku.

Kroje ładujemy na razie z Google Fonts; przed publikacją self-hostujemy je z paczek
`@fontsource` (`anton`, `inter`), żeby strona nie odpytywała obcego serwera.

## 4. Co mockup robi inaczej niż oryginał

1. Brak paska stacji, jej nawigacji i stopki — mamy własną nawigację i stopkę.
2. Brak przycisków odtwarzania — nie hostujemy dźwięku; zamiast tego odnośnik do odcinka
   w Polskim Radiu.
3. Wiersze mają **status opracowania** („opracowany”, „zaplanowane 19.11.2026”,
   „skatalogowany”) — tego oryginał nie ma, a u nas jest najważniejszą informacją.
4. Własny znak słowny zamiast okładki; zamiast zdjęcia — gradient i ziarno wygenerowane
   w CSS.
5. Hero ma ściętą dolną krawędź (`clip-path`), jako echo kanciastego liternictwa.

## 5. Motyw ciemny

1. Domyślnie `prefers-color-scheme`; przełącznik w nagłówku nadpisuje system i zapisuje wybór
   w `localStorage` (klucz `cns-theme`).
2. Paleta ciemna jest przeniesiona z oryginału: `#1A1A1A` / `#202020` / `#373737`.
3. Hero zostaje ciemne w obu motywach — to element identyfikacyjny, nie powierzchnia.

## 6. Pliki

1. `mockup/index.html` — lista odcinków z filtrem po tytule i roku.
2. `mockup/episode.html` — odcinek opracowany (prawdziwe dane z taggera, 15 utworów).
3. `mockup/episode-planned.html` — odcinek w kolejce, stan „zaplanowane”.
4. `mockup/style.css` — tokeny i komponenty; `mockup/app.js` — motyw i filtr.
5. `docs/design/*.png` — zrzuty mockupu (jasny i ciemny, lista i odcinek).
6. `docs/reference/*.png` — zrzuty oryginału, materiał porównawczy.
