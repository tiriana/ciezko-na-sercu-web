# Skala czasu nagrań (ramki bez paddingu)

## Co to jest

Pliki mp3 Polskiego Radia **nie mają** znacznika Xing/Info, więc odtwarzacz liczy długość
z rozmiaru pliku i nominalnego bitrate: `size × 8 / 128000` = 6893,21 s. Realne audio ma
6909,05 s, bo w strumieniu nie ma bitów paddingu (patrz niżej). Przeglądarka przyjmuje
wyliczoną długość jako `audio.duration` i w tej skali odmierzają pozycję `currentTime`,
pasek postępu i seek.

Skutek: znaczniki liczone z dźwięku (ffmpeg, Shazam, VAD) są w czasie rzeczywistym,
a odtwarzacz mierzy w skróconej skali, więc im dalej w audycję, tym większe rozjechanie —
do ~16 s na końcu. Do tego ostatnie kilkanaście sekund nagrania jest w przeglądarce
nieosiągalne, bo player kończy odtwarzanie na wartości z nagłówka.

## Skąd bierze się błąd

- Nagłówek ramki mówi „MPEG1 Layer III, 128 kb/s, 44,1 kHz", więc rozmiar ramki powinien
  wynosić 417 lub 418 B — 418 wtedy, gdy ustawiony jest bit paddingu.
- W plikach Polskiego Radia bit paddingu **nigdy nie jest ustawiony**: wszystkie 264 487
  ramek ma 417 B, czyli strumień niesie realnie 127,7 kb/s, a nie 128 kb/s.
- Realna długość to liczba ramek × 1152 / 44100 = 6909,05 s, a wyliczenie z rozmiaru
  daje 6893,21 s. Różnica 15,84 s to dokładnie te 0,229%.
- To błąd encodera po stronie Polskiego Radia (plik z `static.prsa.pl`), nie nasz i nie
  do naprawienia lokalnie — plik jest zdalny. Zwykłemu słuchaczowi przesuwa tylko koniec
  paska; nam rozjeżdża znaczniki liczone z dźwięku.

## Czy skala jest stała

Nie. Z 23 zmierzonych plików 19 miało skalę `0,997707`, a 4 miały `1,000000` (ramki
z paddingiem, długość policzona poprawnie). Błąd bezwzględny w grupie z wadą to
15,5–16,6 s, czyli 0,23%. Skala `0,997707` jest tylko wynikiem tego, że większość nagrań
przeszła ten sam pipeline encodera.

Wniosek: **skali nie wolno wpisywać na sztywno** — trzeba ją zmierzyć dla każdego pliku.


## Zasada

Dane trzymamy w **skali odtwarzacza** (tej z nagłówka), a przeliczenie dzieje się przy
produkcji danych. Player i edytor są głupie: dostają czas i ustawiają `currentTime`
bez żadnej arytmetyki.

Pola w obiekcie odcinka:

- `durationSec` — długość w skali odtwarzacza (to pokazuje player; tu: wyliczenie z rozmiaru pliku),
- `audioDurationSec` — realna długość z dekodera, potrzebna do przeliczeń.

## Jak mierzymy

`scripts/lib/timeline.mjs`:

1. `ffprobe -show_entries format=duration` — czas z nagłówka (0,3 s, po HTTP),
2. `ffmpeg … -f s16le -ac 1 -ar 8000 | wc -c` — realna długość z dekodera,
3. `scale = mediaDuration / realDuration`, zapis w `.cache/timeline/<uuid8>.json`
   (klucz zawiera `audioUrl`, więc podmiana pliku unieważnia pomiar).

## Gdzie przeliczamy

1. `scripts/identify-tracks.mjs` — sondy i bloki liczy w czasie realnym (tak tnie ffmpeg),
   ale zapisuje `start`, `end` i `durationSec` już w skali odtwarzacza.
2. `scripts/topics-from-speech.mjs` — bloki VAD (`spans`) są w czasie realnym, więc
   przelicza je przed porównaniem z utworami; skala z `durationSec / audioDurationSec`.
3. `scripts/edytor.mjs` — waveform powstaje z pełnego dekodowania, więc jest próbkowany
   ponownie do skali odtwarzacza; nazwa pliku cache ma znacznik `-v2`, żeby stare piki
   (w czasie realnym) nie były używane.
4. `scripts/edytor.html`, `src/scripts/site.js` — **bez przeliczeń**; znacznik to znacznik.

## Migracja danych

`scripts/fix-timeline.mjs` (jednorazowo, lokalnie):

1. mierzy skalę per odcinek i przelicza `tracks`, `topics`, `tags.at`, `quotes.start`,
   `credits.time` oraz czasy w `data/overrides/<id>.json` (`tracks`, `addTracks`,
   `topics`, `addTopics`);
2. ustawia `durationSec` na czas z nagłówka, a `audioDurationSec` na czas z dekodera;
3. pomija odcinki z `data/reviewed.json`, bo ich znaczniki powstały ręcznie przy
   głupim playerze i są już w dobrej skali;
4. pomija odcinki, które mają `audioDurationSec` — przebieg jest idempotentny.

## Czego nie przeliczamy

- `data/transcripts/*.json` — transkrypt zostaje w czasie realnym; to artefakt wejściowy,
  a konwersja dzieje się w miejscu użycia (etykiety, bloki muzyki).
- `data/overrides/uuid-ów z reviewed.json` — patrz wyżej.
