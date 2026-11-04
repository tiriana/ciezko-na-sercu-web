# ciezko-na-sercu-web

Strona z katalogiem odcinków audycji „Ciężko na sercu" (Trójka): lista odcinków, strona
każdego odcinka i — uzupełniane z czasem — opracowanie: rozpoznane utwory, wykonawcy,
streszczenie i tematy.

Strona nie publikuje dźwięku ani treści audycji. Indeksuje odcinki i linkuje do nich.

## Status

Strona działa na Astro (output statyczny) i publikuje się na Surge przy każdym pushu do `main`
oraz raz na dobę z harmonogramu. Build czyta wyłącznie `data/`; katalog odcinków odświeża
workflow, pobierając `episodes.json` z Egnyte.

1. [docs/plan.md](docs/plan.md) — zakres, model danych, harmonogram, ryzyka.
2. [docs/design.md](docs/design.md) — co przenosimy z wyglądu Trójki, a czego nie.
3. [docs/stack.md](docs/stack.md) — wybór generatora i odrzucone alternatywy.
4. `mockup/` — statyczny mockup, z którego powstał layout (nie jest deployowany).

## Uruchomienie

```
npm install
npm run build      # waliduje data/ i buduje dist/
npm run dev        # podgląd na localhost:4321
```

Dane:

1. `data/catalog.json` — katalog odcinków, generowany z downloadera: `npm run catalog -- <episodes.json>`.
2. `data/episodes/<id>.json` — opracowania. Import z taggera: `npm run import:tagger -- ../radio-auditions-tagger/work/episodes`.

## Deploy

Workflow `.github/workflows/deploy.yml` wymaga sekretu `SURGE_TOKEN` (deploy) i `RCLONE_REMOTE`
(pobranie katalogu z Egnyte); opcjonalna zmienna `RADIO_DIR` (domyślnie `/Shared/Radio`).

## Powiązane repozytoria

1. [polskie-radio-downloader](https://github.com/tiriana/polskie-radio-downloader) — pobiera
   odcinki i utrzymuje `episodes.json`. Kompletny, traktowany jako źródło prawdy o katalogu.
2. [radio-auditions-tagger](https://github.com/tiriana/radio-auditions-tagger) — analiza audio:
   segmentacja mowa/muzyka, transkrypcja, rozpoznawanie utworów, ekstrakcja tematów.
   Na razie POC (jeden opracowany odcinek, brak zdalnego repozytorium); do przepisania pod
   schemat tej strony.
3. To repozytorium — konsument obu powyższych.
