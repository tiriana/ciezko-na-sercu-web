# ciezko-na-sercu-web

Strona z katalogiem odcinków audycji „Ciężko na sercu" (Trójka): lista odcinków, strona
każdego odcinka i — uzupełniane z czasem — opracowanie: rozpoznane utwory, wykonawcy,
streszczenie i tematy.

Strona nie publikuje dźwięku ani treści audycji. Indeksuje odcinki i linkuje do nich.

## Status

Repozytorium zawiera plan, decyzje i klikalny mockup wyglądu. Kodu produkcyjnego jeszcze nie ma.

1. [docs/plan.md](docs/plan.md) — zakres, model danych, harmonogram, ryzyka.
2. [docs/design.md](docs/design.md) — co przenosimy z wyglądu Trójki, a czego nie.
3. [docs/stack.md](docs/stack.md) — wybór generatora i odrzucone alternatywy.
4. `mockup/` — statyczny mockup (lista, odcinek opracowany, odcinek w kolejce, jasny i ciemny
   motyw). Otwórz `mockup/index.html` albo `python3 -m http.server 4173 -d mockup`.

## Powiązane repozytoria

1. [polskie-radio-downloader](https://github.com/tiriana/polskie-radio-downloader) — pobiera
   odcinki i utrzymuje `episodes.json`. Kompletny, traktowany jako źródło prawdy o katalogu.
2. [radio-auditions-tagger](https://github.com/tiriana/radio-auditions-tagger) — analiza audio:
   segmentacja mowa/muzyka, transkrypcja, rozpoznawanie utworów, ekstrakcja tematów.
   Na razie POC (jeden opracowany odcinek, brak zdalnego repozytorium); do przepisania pod
   schemat tej strony.
3. To repozytorium — konsument obu powyższych.
