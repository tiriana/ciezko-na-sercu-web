# ciezko-na-sercu-web

Opublikowana wersja: **https://ciezko-na-sercu.pages.dev** (Cloudflare Pages), kopia: https://ciezko-na-sercu.surge.sh

Strona z katalogiem odcinków audycji „Ciężko na sercu" (Trójka): lista odcinków, strona
każdego odcinka i — uzupełniane z czasem — opracowanie: rozpoznane utwory, wykonawcy,
streszczenie i tematy.

Strona nie publikuje dźwięku ani treści audycji. Indeksuje odcinki i linkuje do nich.

## Status

Strona działa na Astro (output statyczny) i publikuje się przy każdym pushu do `main` na Cloudflare
Pages, a dodatkowo — jako kopia zapasowa — na Surge (błąd Surge nie przerywa przebiegu).
Build czyta wyłącznie `data/`; katalog odcinków odświeża osobny workflow (środa 04:00 UTC,
`repository_dispatch` z downloadera albo ręcznie), pobierając `episodes.json` z Egnyte
i commitując przeliczony `data/catalog.json`.

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
3. `data/titles.json` — tytuły nieoficjalne dla odcinków, które w katalogu mają tytuł techniczny
   („Ciężko na sercu 1 maja godz. 0005”). Każdy wpis trzyma `originalTitle`, a strona pokazuje
   oba i oznacza nasz tytuł jako nieoficjalny.

## Kolejka opracowań

Na stronie głównej jest szacowana data końca kolejki: liczba odcinków bez opracowania,
~18,5 min na odcinek (pomiar z 2026-11-04) i okno nocne 21:00–09:00, czyli ~38 odcinków
na noc. Wartości siedzą w `src/lib/schedule.ts`; data jest orientacyjna i przelicza się
przy każdym buildzie.

## Dane

Wszystkie dane audycji leżą w tym repozytorium, w `data/`: `catalog.json` (z downloadera),
`episodes/<uuid>.json` (opracowania), `transcripts/<uuid>.json|.txt` (pełne transkrypty),
`titles.json` (tytuły redakcyjne) i `overrides/<uuid>.json` (ręczne poprawki, odporne na
ponowny import). `npm run check` waliduje całość przed buildem; import z taggera robi
`scripts/import-tagger.mjs`.

## Deploy

1. `.github/workflows/deploy.yml` — build i publikacja; wymaga sekretu `CLOUDFLARE_PAGES_TOKEN`
   (Cloudflare Pages, uprawnienie Account → Cloudflare Pages → Edit) i `SURGE_TOKEN` (kopia).
   Numer konta Cloudflare bierze ze zmiennej `CLOUDFLARE_ACCOUNT_ID`, a gdy jej nie ma — z API.
2. `.github/workflows/refresh-catalog.yml` — katalog z Egnyte; wymaga `RCLONE_REMOTE`,
   opcjonalna zmienna `RADIO_DIR` (domyślnie `/Shared/Radio`).

## Powiązane repozytoria

1. [polskie-radio-downloader](https://github.com/tiriana/polskie-radio-downloader) — pobiera
   odcinki i utrzymuje `episodes.json`. Kompletny, traktowany jako źródło prawdy o katalogu.
2. [radio-auditions-tagger](https://github.com/tiriana/radio-auditions-tagger) — analiza audio:
   segmentacja mowa/muzyka, transkrypcja, rozpoznawanie utworów, ekstrakcja tematów.
   Wyciąga też metadane opracowań (`episode.json`); import do tej strony: `npm run import:tagger`.
3. To repozytorium — konsument obu powyższych.
