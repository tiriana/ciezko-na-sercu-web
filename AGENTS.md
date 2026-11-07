# ciezko-na-sercu-web — wskazówki dla agentów

Dane audycji leżą w `data/`; opis pól i przepływu jest w README. Poniżej fakty, których
nie trzeba za każdym razem odkrywać.

## Wersje

Numer wersji powstaje automatycznie z typów commitów (`semantic-release`, workflow
`.github/workflows/release.yml`). Prefiksy, które robią release: `feat:` → minor,
`fix:`/`perf:`/`refactor:`/`revert:` → patch, `!`/`BREAKING CHANGE:` → major. Commity
bez prefiksu (`docs:`, `chore:` albo zwykłe zdanie) nie tworzą wersji. Wersja jest
wypisana w stopce strony.

## Ciężko na sercu (Trójka)

1. Prowadzącym jest **Jarek Szubrycht** — pisownia stała, nie zmieniała się od początku
   audycji. Warianty w creditsach („Szubrych") to błędy transkrypcji, nie inne osoby.
2. Wydawcą i producentem jest **Mariusz Owczarek**.
3. Kontakt do redakcji audycji: `ciezko@polskieradio.pl` (potwierdzone na stronie Trójki).
4. Audycja leci w środy o 00:05; pliki audio nigdy nie trafiają do repo — strona tylko
   odsyła do plików Polskiego Radia.

## Warianty tej samej nazwy

`data/aliases.json` mapuje wariant etykiety na jej formę kanoniczną („Vogg" →
„Wacław "Vogg" Kiełtyka"). Podstawienie dzieje się przy wczytywaniu danych, więc tagi,
creditsy i strony `/tagi/<id>/` widzą jedną osobę. Klucz to dosłowna etykieta z danych —
łączenie robimy tutaj, nie przez podmianę w `data/episodes`. `npm run check` wypisuje
kandydatów: osoby, których krótsza etykieta jest całym słowem w dłuższej.

## Osoby w creditsach

Nową osobę dodajemy do `data/people.json` z polem `url` tylko po sprawdzeniu wyszukiwaniem
„<Imię Nazwisko> polskie radio”: czołowe wyniki muszą prowadzić do profilu tej osoby
w serwisie Polskiego Radia (HTTP 200 i zgodne nazwisko w treści). Bez pewności wpis
zostaje bez `url` i renderuje się jako zwykły tekst.
