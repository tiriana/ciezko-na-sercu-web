# ciezko-na-sercu-web

Strona z katalogiem odcinków audycji „Ciężko na sercu" (Trójka): lista odcinków, strona
każdego odcinka i — uzupełniane z czasem — opracowanie: rozpoznane utwory, wykonawcy,
streszczenie i tematy.

Strona nie publikuje dźwięku ani treści audycji. Indeksuje odcinki i linkuje do nich.

## Status

Repozytorium zawiera plan i decyzje. Kodu jeszcze nie ma — [docs/plan.md](docs/plan.md).

## Powiązane repozytoria

1. [polskie-radio-downloader](https://github.com/tiriana/polskie-radio-downloader) — pobiera
   odcinki i utrzymuje `episodes.json`. Kompletny, traktowany jako źródło prawdy o katalogu.
2. [radio-auditions-tagger](https://github.com/tiriana/radio-auditions-tagger) — analiza audio:
   segmentacja mowa/muzyka, transkrypcja, rozpoznawanie utworów, ekstrakcja tematów.
   Na razie POC (jeden opracowany odcinek, brak zdalnego repozytorium); do przepisania pod
   schemat tej strony.
3. To repozytorium — konsument obu powyższych.
