# Stack: co budować i dlaczego

## 1. Co ta strona robi

1. Lista 105 odcinków z filtrem po roku i wyszukiwaniem po tytule.
2. Strona odcinka: tracklista, streszczenie, tematy, metadane rozpoznania.
3. Później: indeks wykonawców, linki do źródeł, może osadzony odtwarzacz.
4. Nic więcej: brak logowania, brak zapisu, brak danych w czasie rzeczywistym.

To jest **katalog treści o znanej z góry strukturze**, generowany z plików. Każdy odcinek ma
własny adres, stałą treść i tę samą szatę. Taki profil pasuje do generatora stron statycznych,
a nie do aplikacji.

## 2. Rekomendacja

**Astro z wyjściem statycznym, dane w JSON, walidacja schematem `zod`, zero JS-u domyślnie.**

1. Routing plikowy daje `/odcinki/<id>` bez własnego routera i bez klienta.
2. Strona odcinka to gotowy HTML — szybki pierwszy render, działa bez JS-u, indeksuje się.
3. Wyspy tylko tam, gdzie naprawdę trzeba (filtr, motyw); mockup pokazuje, że to ~60 linii
   zwykłego JS-u, więc wyspa Reacta nie jest potrzebna.
4. `zod` na wejściu wywala build z nazwą pliku, gdy dane są niespójne — to ważniejsze niż
   wygoda szablonów, bo dane produkuje automat.

## 3. Odrzucone alternatywy

| Opcja | Dlaczego nie |
|---|---|
| Ręczny HTML + CSS (jak mockup) | Działa dla dwóch stron; przy 105 odcinkach i filtrach trzeba generatora. Mockup jest celowo frameworkowy, żeby dał się przenieść w godzinę. |
| EJS / Handlebars + skrypt Node | Wykonalne, ale routing, layouty, walidację danych, hashowanie assetów i serwer dev piszesz sam. Ma sens tylko wtedy, gdy „zero zależności” jest celem samym w sobie. |
| Vite + React (SPA) | Każda strona odcinka renderuje się w przeglądarce: gorszy pierwszy render, brak treści w HTML, SEO do dorabiania. React zarabia na siebie dopiero, gdy UI staje się aplikacją (odtwarzacz, edycja, filtry na żywo). |
| Next.js (static export) | To samo co Astro, ale z cięższym toolchainem i runtime'em, którego statyczna strona nie używa. |
| Strony odcinków w Markdown | Tracklista, czasy, pewność rozpoznania i linki to dane strukturalne, nie proza. W Markdownie trafiają do front-mattera jako zagnieżdżone tablice — czyli JSON z gorszym typowaniem i łatwiejszy do zepsucia. |

## 4. Gdzie Markdown ma sens

Jeżeli odcinki dostaną ręcznie pisane wstępy albo notki redakcyjne, warto dodać **MDX tylko dla
tych pól**: dane zostają w JSON-ie, proza w osobnym pliku obok. Nie zamieniamy całości na
Markdown — mieszamy dwa źródła tylko tam, gdzie ludzkie pisanie jest realne.

## 5. Kiedy zmienić decyzję

1. Jeśli ma powstać edycja treści w przeglądarce (panel administracyjny) — wtedy SSR albo CMS,
   nie statyk.
2. Jeśli strona urośnie do tysięcy podstron z częstymi zmianami — buildy przyrostowe.
3. Jeśli pojawi się odtwarzacz z playlistą i stanem — jedna wyspa Reacta, nie przepisanie całości.
