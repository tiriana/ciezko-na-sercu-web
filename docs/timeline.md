# Skala czasu nagrań (nagłówek Xing)

## Co to jest

Pliki mp3 Polskiego Radia mają nagłówek Xing/Info z długością nagrania. Długość bywa
**krótsza niż realne audio**: nagłówek podaje ~6893,21 s, a zdekodowane próbki dają
6909,05 s. Przeglądarka wierzy nagłówkowi — `audio.duration` wynosi tyle, ile w nagłówku,
i w tej skali odmierzają pozycję `currentTime`, pasek postępu i seek.

Skutek: znaczniki liczone z dźwięku (ffmpeg, Shazam, VAD) są w czasie rzeczywistym,
a odtwarzacz mierzy w skróconej skali, więc im dalej w audycję, tym większe rozjechanie —
do ~16 s na końcu. Do tego ostatnie kilkanaście sekund nagrania jest w przeglądarce
nieosiągalne, bo player kończy odtwarzanie na wartości z nagłówka.

## Skąd bierze się błąd

- Nagłówek Xing jest policzony z rozmiaru pliku przy nominalnym bitrate (128 kb/s):
  `size × 8 / 128000` = 6893,21 s.
- Realna długość to liczba ramek × 1152 próbki / 44100 Hz: 264 487 × 1152 / 44100 = 6909,05 s.
- Ramki są CBR (417/418 B), więc różnica nie jest „rozjechaniem" bitrate, tylko tym, że
  rozmiar pliku odpowiada średnio 127,7 kb/s — nagłówek liczy z nominalnej wartości.

## Czy skala jest stała

Nie. Z 13 zmierzonych plików 10 miało skalę `0,997707`, a 3 miały `1,000000` (nagłówek
poprawny, błąd 0 s). Błąd bezwzględny w grupie z wadą to 15,5–16,6 s, czyli 0,23%.

Wniosek: **skali nie wolno wpisywać na sztywno** — trzeba ją zmierzyć dla każdego pliku.
Stała wartość `0,997707` jest tylko wynikiem tego, że większość nagrań przeszła ten sam
pipeline encodera.

## Zasada

Dane trzymamy w **skali odtwarzacza** (tej z nagłówka), a przeliczenie dzieje się przy
produkcji danych. Player i edytor są głupie: dostają czas i ustawiają `currentTime`
bez żadnej arytmetyki.

Pola w obiekcie odcinka:

- `durationSec` — długość w skali odtwarzacza (to pokazuje player),
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
