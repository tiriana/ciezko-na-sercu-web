## [1.20.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.19.0...v1.20.0) (2026-11-09)

### Features

* środowe sondowanie publikacji i zaślepki opracowań ([6426b8a](https://github.com/tiriana/ciezko-na-sercu-web/commit/6426b8a67327be0cdea7833a0f539c5b4d8274fe))

## [1.19.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.18.2...v1.19.0) (2026-11-09)

### Features

* samo otwarcie zgłoszenia przy fragmencie też jest sygnałem ([a3f9c76](https://github.com/tiriana/ciezko-na-sercu-web/commit/a3f9c76824233964cb2a394145e01e87fe038cb3))

## [1.18.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.18.1...v1.18.2) (2026-11-09)

### Bug Fixes

* zgłoszenia idą do nowego arkusza po zmianie wdrożenia ([881eb5f](https://github.com/tiriana/ciezko-na-sercu-web/commit/881eb5f3e15a12618ae6cc03ae7280af60fa5aa1))

## [1.18.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.18.0...v1.18.1) (2026-11-09)

### Bug Fixes

* ikona rogów w podziękowaniu czytelna już przy 16 px ([6dab454](https://github.com/tiriana/ciezko-na-sercu-web/commit/6dab45493bcd5d2c1db1bb99740b85d2626febc5))

## [1.18.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.17.0...v1.18.0) (2026-11-09)

### Features

* zgłaszanie błędów bąbelkiem, bez Google Forms ([792eb0c](https://github.com/tiriana/ciezko-na-sercu-web/commit/792eb0c7091ddc6f84b17c11f33c678147468e7f))

## [1.17.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.16.2...v1.17.0) (2026-11-09)

### Features

* cała transkrypcja odcinka do przeczytania na stronie ([c70a2c9](https://github.com/tiriana/ciezko-na-sercu-web/commit/c70a2c92aa1e5e677537686195a7527787f9e043))
* **edytor:** add keyboard shortcuts and improve pinned playhead UI ([433490e](https://github.com/tiriana/ciezko-na-sercu-web/commit/433490e6aace570f4b1634525b7be32087e29d1e))
* **edytor:** add undo, save shortcut, and spacebar playback ([254d2d1](https://github.com/tiriana/ciezko-na-sercu-web/commit/254d2d1b3a023b75a63da46019c2ba5011db0a63))
* **edytor:** przełącznik auto-zapisu ([b908635](https://github.com/tiriana/ciezko-na-sercu-web/commit/b908635bb441c2e871e1a1225a1b98932190e15e))
* **edytor:** szczyty głośności do waveformu z ffmpeg i cache ([7cbf8fa](https://github.com/tiriana/ciezko-na-sercu-web/commit/7cbf8fae831da0749fbe4ea1bac705e8c9896a79))
* **edytor:** waveform z zoomem i przeciąganymi znacznikami ([c580f9d](https://github.com/tiriana/ciezko-na-sercu-web/commit/c580f9d9612550a9bf52816037f4c66daf5178f0))
* **edytor:** widoczny stan zapisu ([a7424dd](https://github.com/tiriana/ciezko-na-sercu-web/commit/a7424ddb0b3fb5931bff6f0b40a98a31d0ceef66))
* **edytor:** znaczniki z dokładnością do 10 ms ([e1cdc09](https://github.com/tiriana/ciezko-na-sercu-web/commit/e1cdc090a96d5349b4bec3656d0e10239a4b2254))
* **etap 1:** koniec utworu przytulony do początku mowy z transkryptu ([05ea738](https://github.com/tiriana/ciezko-na-sercu-web/commit/05ea738e9532eee97ae8150991968cd6f6a8cb8b))
* odcinki z oznaczeniem ok są nietykalne dla automatów ([d9df8d2](https://github.com/tiriana/ciezko-na-sercu-web/commit/d9df8d2e175cc8efaa63386cea6a7dc415c5627d))
* ręczny `end` utworu w poprawkach i ostrzeżenie o ogonach w check ([4d13a78](https://github.com/tiriana/ciezko-na-sercu-web/commit/4d13a785d413e097a2097b46ea65703a632b060a))
* ręczny `end` wejścia w poprawkach ([fa5ce95](https://github.com/tiriana/ciezko-na-sercu-web/commit/fa5ce950fadab0d345fffd3627cc909335709aef))
* **report:** add client‑side error reporting UI and script ([f3e116a](https://github.com/tiriana/ciezko-na-sercu-web/commit/f3e116a8ff46e2113f722d1bd6eb213cbef8d376))
* wejście z wieloma wątkami to jeden fragment programu ([e563d6f](https://github.com/tiriana/ciezko-na-sercu-web/commit/e563d6f28f77dcc1c8e2b8d64495b75bc36184e3))

### Bug Fixes

* **ci:** preset changelogów w wersji 8, zgodnej z semantic-release ([7e98cd6](https://github.com/tiriana/ciezko-na-sercu-web/commit/7e98cd64c688ef149958e365c3fa2d3ae323986b))
* **data:** Carnal trwa 2:09, nie 53 s ([987c348](https://github.com/tiriana/ciezko-na-sercu-web/commit/987c3484427bd98781b6626a722f0e8f94b47d72))
* **data:** correct end timestamp and reorder keys ([6da7f6d](https://github.com/tiriana/ciezko-na-sercu-web/commit/6da7f6d2ef2ba706868d4a12a5a9bd47fed26494))
* **edytor:** cache szczytów unieważnia się przy zmianie adresu nagrania ([7d2c0ff](https://github.com/tiriana/ciezko-na-sercu-web/commit/7d2c0ffc6766fbb89fba13c10545b936414c8fc0))
* **edytor:** kursor przy krawędzi jest czarny i ze strzałką ([161df4f](https://github.com/tiriana/ciezko-na-sercu-web/commit/161df4f9e0f55ae2316ca35f3b9cd160c1149e76))
* **edytor:** początek zawsze tnie poprzedni fragment ([1212db4](https://github.com/tiriana/ciezko-na-sercu-web/commit/1212db4ea171fa369f61dcce4ffa80c0a5ebf980))
* pasek odtwarzacza trzyma wysokość, gdy nic nie leci ([5248200](https://github.com/tiriana/ciezko-na-sercu-web/commit/5248200cc82d6f19b7ba749ffe42c6196c20f0de))
* początek utworu kończy wejście, także dodane ręcznie ([c2d6541](https://github.com/tiriana/ciezko-na-sercu-web/commit/c2d65417db78e4caab73766ade49bbb924285d5a))

## [1.16.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.16.1...v1.16.2) (2026-11-08)

### Bug Fixes

* **edytor:** wyczyszczone pole poprawki nie trafia jako null ([3e0d589](https://github.com/tiriana/ciezko-na-sercu-web/commit/3e0d5897b6d8de8127e742c73185f7e7db5d94d1))

## [1.16.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.16.0...v1.16.1) (2026-11-08)

### Bug Fixes

* ukrywanie utworu zawężone do jednego wystąpienia ([b7c33ae](https://github.com/tiriana/ciezko-na-sercu-web/commit/b7c33aea0b4c2926c24ec4150ae3031552468ac5))

## [1.16.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.15.2...v1.16.0) (2026-11-08)

### Features

* **edytor:** add supervisor script and UI improvements ([1b556fb](https://github.com/tiriana/ciezko-na-sercu-web/commit/1b556fbaa98578a954d89e83d26ce326d240da70))

## [1.15.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.15.1...v1.15.2) (2026-11-08)

### Bug Fixes

* **edytor:** martwy serwer widoczny na całą szerokość ([82106d5](https://github.com/tiriana/ciezko-na-sercu-web/commit/82106d52b29623f2572e63759446e50d630ce2bb)), closes [#b3102c](https://github.com/tiriana/ciezko-na-sercu-web/issues/b3102c)

## [1.15.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.15.0...v1.15.1) (2026-11-08)

### Bug Fixes

* **edytor:** sidebar w pionie, wysoki na waveform z playerem ([2a69fc4](https://github.com/tiriana/ciezko-na-sercu-web/commit/2a69fc4f21ed57da6417fbeadb912f7ce51db84e))

## [1.15.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.14.1...v1.15.0) (2026-11-08)

### Features

* **data:** add topic entry and correct end time ([0cdf2d0](https://github.com/tiriana/ciezko-na-sercu-web/commit/0cdf2d02b8a976c2caef43830c8a6ee899fe567e))
* **editor:** add context menu and shortcut to insert entry ([2b3d958](https://github.com/tiriana/ciezko-na-sercu-web/commit/2b3d958ac94b679f7c47e3d1d5c9cc53bf6a103e))
* **edytor:** add health endpoint and improve episode list layout ([233c12b](https://github.com/tiriana/ciezko-na-sercu-web/commit/233c12b37c9449d7225951a8dd5ddeebc117ab7b))
* **edytor:** add live reload prompt, SSE events endpoint, and watch mode ([b53b3db](https://github.com/tiriana/ciezko-na-sercu-web/commit/b53b3db6403d4190e5250e901c7c81d1389f1465))
* **edytor:** add reviewed markers UI and persistence API ([2bd9e9b](https://github.com/tiriana/ciezko-na-sercu-web/commit/2bd9e9ba54251c8ad9b226b6de5d024edf5eb605))

### Bug Fixes

* **data:** adjust track timestamps wip ([b7fcecd](https://github.com/tiriana/ciezko-na-sercu-web/commit/b7fcecd4de73122f03d365a6ee2757b8ec360d5e))
* **data:** wip adjust Black Sabbath track end/start times ([3d3eac9](https://github.com/tiriana/ciezko-na-sercu-web/commit/3d3eac90dafedba0b35a1893628929490260cdef))
* **data:** wip adjust event timestamps ([ec7bc13](https://github.com/tiriana/ciezko-na-sercu-web/commit/ec7bc13e6d2202fa902a63e3b11951a38eda4995))
* **overrides:** correct end and start timestamps ([12fad6e](https://github.com/tiriana/ciezko-na-sercu-web/commit/12fad6ebeeaf02d4afaecdd66ecde92ad86186cd))
* **overrides:** correct end/start timestamps for Black Sabbath track ([148ca5a](https://github.com/tiriana/ciezko-na-sercu-web/commit/148ca5a4424305cbe6c2939b19c7187f50673429))
* **overrides:** wip adjust Black Sabbath track timestamps ([c948a43](https://github.com/tiriana/ciezko-na-sercu-web/commit/c948a43d28cb50fa8098231e996d3e23d60284a4))
* **overrides:** wip adjust subtitle timestamps ([39c465b](https://github.com/tiriana/ciezko-na-sercu-web/commit/39c465b5254f6df043eafc56d16fab30af80b260))
* **overrides:** wip adjust track start/end timestamps ([7dc5370](https://github.com/tiriana/ciezko-na-sercu-web/commit/7dc5370efb5a8eb9368bfdadc28e7c49892e4096))

## [1.14.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.14.0...v1.14.1) (2026-11-08)

### Bug Fixes

* obrys fokusu paska fragmentu otula samą linię ([200276c](https://github.com/tiriana/ciezko-na-sercu-web/commit/200276c09598a2d9f3535890ee7da6e0f5e98aa2))

## [1.14.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.13.1...v1.14.0) (2026-11-08)

### Features

* adres wskazuje fragment (?f=), nie sekundę odtwarzania ([4483c11](https://github.com/tiriana/ciezko-na-sercu-web/commit/4483c11d7c1db5c25082c94ed27273f156f1b74c))
* pasek postępu w wierszu odtwarzanego fragmentu ([0dd915b](https://github.com/tiriana/ciezko-na-sercu-web/commit/0dd915b64a672db49b247ba60ac782c52a86490a))

## [1.13.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.13.0...v1.13.1) (2026-11-08)

### Bug Fixes

* bezsensowne ?t= znika z adresu, zbyt duże przycina się do długości nagrania ([444bc9d](https://github.com/tiriana/ciezko-na-sercu-web/commit/444bc9dff7b073d220bea9763ffda60f3f13e662))

## [1.13.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.12.1...v1.13.0) (2026-11-08)

### Features

* adres jest stanem odtwarzacza (?t= i ?wejscia=), bez przycisku kopiowania ([342cd72](https://github.com/tiriana/ciezko-na-sercu-web/commit/342cd72e6ae135e245e1d01c55b20c050b34708e))

### Bug Fixes

* play i pauza jako całe SVG, odstęp od tekstu i jedna kreska po ostatnim wątku ([ed70f9d](https://github.com/tiriana/ciezko-na-sercu-web/commit/ed70f9d0832779d6841b561fabe6ab2e125bac6b)), closes [#48](https://github.com/tiriana/ciezko-na-sercu-web/issues/48) [#49](https://github.com/tiriana/ciezko-na-sercu-web/issues/49)

## [1.12.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.12.0...v1.12.1) (2026-11-08)

### Bug Fixes

* odświeżenie katalogu bez zmian nie podbija daty ani nie publikuje ([1613d5a](https://github.com/tiriana/ciezko-na-sercu-web/commit/1613d5ad362b051c8031a559d0e74400a106e7dc))

## [1.12.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.11.0...v1.12.0) (2026-11-08)

### Features

* podglądy feat/** pod adresem własnej gałęzi ([023ea02](https://github.com/tiriana/ciezko-na-sercu-web/commit/023ea0285cb153347f6d399f0b143f031298eb7b))

## [1.11.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.10.0...v1.11.0) (2026-11-08)

### Features

* develop publikuje staging z noindex, koniec z kopią na Surge ([b723a49](https://github.com/tiriana/ciezko-na-sercu-web/commit/b723a49420b3f8e59dd98185de1e9d5ea38f04f6))
* środowe wykrycie nowego odcinka o 02:00 czasu polskiego ([c0aaa17](https://github.com/tiriana/ciezko-na-sercu-web/commit/c0aaa17ed81386ff2d6aba451a7d02e0ae552330))

## [1.10.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.9.0...v1.10.0) (2026-11-08)

### Features

* katalog odcinków prosto ze strony audycji, transkrypcja strumieniuje audio z URL ([9750200](https://github.com/tiriana/ciezko-na-sercu-web/commit/975020057411cfc1a09af6f79cdb944858009be7))

## [1.9.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.8.2...v1.9.0) (2026-11-08)

### Features

* deeplink do fragmentu i pasek postępu bieżącego fragmentu ([5cbd239](https://github.com/tiriana/ciezko-na-sercu-web/commit/5cbd2394643825aea685609bdd59bd8bccbd02b3))

## [1.8.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.8.1...v1.8.2) (2026-11-08)

### Bug Fixes

* utwory bez wykonawcy i podzielone na bloki scalone, tematy bez długości nie pokazują „—” ([8011951](https://github.com/tiriana/ciezko-na-sercu-web/commit/8011951c947b804b3f35241ffd2f69eb2fb890fb))

## [1.8.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.8.0...v1.8.1) (2026-11-08)

### Bug Fixes

* tytuł odcinka z serwisu nie ginie przy odświeżeniu katalogu ([51afb71](https://github.com/tiriana/ciezko-na-sercu-web/commit/51afb71ff8537eba0caa9eab5fe47207ee915f0a))

## [1.8.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.7...v1.8.0) (2026-11-08)

### Features

* Node z mise zamiast setup-node w workflowach ([#39](https://github.com/tiriana/ciezko-na-sercu-web/issues/39)) ([a4b02a9](https://github.com/tiriana/ciezko-na-sercu-web/commit/a4b02a96ba099a5f2c573d6e12d1dbb0f3680c0e))

### Reverts

* conventional-changelog-conventionalcommits wraca do 8 ([461a399](https://github.com/tiriana/ciezko-na-sercu-web/commit/461a399d5a7c0c04b278d8da2f9c15d4d80d1ef3))

## [1.7.7](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.6...v1.7.7) (2026-11-08)

### Bug Fixes

* **deps:** update npm: minor i patch ([#36](https://github.com/tiriana/ciezko-na-sercu-web/issues/36)) ([4a2589c](https://github.com/tiriana/ciezko-na-sercu-web/commit/4a2589cb7d0622304e413263e3c545f0dd65b07a))

## [1.7.6](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.5...v1.7.6) (2026-11-08)

### Bug Fixes

* **deps:** update dependency astro to v7 [security] ([#33](https://github.com/tiriana/ciezko-na-sercu-web/issues/33)) ([0a594c0](https://github.com/tiriana/ciezko-na-sercu-web/commit/0a594c07f0423aa6e5e0be9b717b2adc94c69573))

## [1.7.5](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.4...v1.7.5) (2026-11-08)

### Bug Fixes

* mode full, żeby Renovate tworzył PR-y mimo trybu Silent ([b478f4c](https://github.com/tiriana/ciezko-na-sercu-web/commit/b478f4c878b97a62beadc67ca810b001907c77af))

## [1.7.4](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.3...v1.7.4) (2026-11-08)

### Bug Fixes

* usunięcie onboarding z renovate.json (opcja tylko globalna) ([f3223a8](https://github.com/tiriana/ciezko-na-sercu-web/commit/f3223a89bfddb976179d1880f5d7cd50b91aa8ac))

## [1.7.3](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.2...v1.7.3) (2026-11-08)

### Bug Fixes

* tracklista ma stałe szerokości kolumn ([438bc7c](https://github.com/tiriana/ciezko-na-sercu-web/commit/438bc7cdc92536bff01d6643ccaa3483d9706162))

## [1.7.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.1...v1.7.2) (2026-11-08)

### Bug Fixes

* odświeżanie katalogu rebase'uje przed pushem ([2f591fb](https://github.com/tiriana/ciezko-na-sercu-web/commit/2f591fbf787e38f63927b94e5551987cb34e73e8))

## [1.7.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.7.0...v1.7.1) (2026-11-08)

### Bug Fixes

* odświeżanie katalogu radzi sobie z dwukropkiem w sekrecie rclone ([371be6c](https://github.com/tiriana/ciezko-na-sercu-web/commit/371be6c00b7e9c8d79383b1e09dcc42908e21339))

## [1.7.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.6.0...v1.7.0) (2026-11-08)

### Features

* transkrypcja codzienna plus natychmiast nowy odcinek ([2f5a921](https://github.com/tiriana/ciezko-na-sercu-web/commit/2f5a921cea77f56409f1b94aca45e201a0d87816))

## [1.6.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.5.0...v1.6.0) (2026-11-08)

### Features

* transkrypcja tygodniowa po pobraniu nowego odcinka ([fd92b68](https://github.com/tiriana/ciezko-na-sercu-web/commit/fd92b681674da6c30de1a9af7a4eca69a41cc945))

## [1.5.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.4.0...v1.5.0) (2026-11-08)

### Features

* przeliczanie czasów tematów po transkrypcji ([dd7a9a2](https://github.com/tiriana/ciezko-na-sercu-web/commit/dd7a9a2ca645912d5f70fbb6da9d79cf1d6bece3))

## [1.4.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.3.0...v1.4.0) (2026-11-08)

### Features

* dzienny wybór odcinka z tytułem w nazwie przebiegu ([8d67799](https://github.com/tiriana/ciezko-na-sercu-web/commit/8d677993fa84f0c2ec7d2bac8c80984721197473))

## [1.3.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.2.0...v1.3.0) (2026-11-08)

### Features

* transkrypcja jednego odcinka dziennie z harmonogramu ([ec63c08](https://github.com/tiriana/ciezko-na-sercu-web/commit/ec63c08e5c0389f282ee811a74064d8b22ece535))

## [1.2.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.1.3...v1.2.0) (2026-11-08)

### Features

* transkrypcja pomija odcinki już zrobione tymi parametrami ([8988216](https://github.com/tiriana/ciezko-na-sercu-web/commit/8988216ffc99ea0ef899ea94bf1b6c53bbf2378b))

## [1.1.3](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.1.2...v1.1.3) (2026-11-08)

### Bug Fixes

* plan transkrypcji mierzy długość audio przez ffprobe ([b43d054](https://github.com/tiriana/ciezko-na-sercu-web/commit/b43d0542a75c4103c18b751b1a4e5f6056f46a3e))

## [1.1.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.1.1...v1.1.2) (2026-11-08)

### Bug Fixes

* plan transkrypcji zakłada minimum 1:55 na odcinek, ostatni kawałek pełnej długości ([e95aa4f](https://github.com/tiriana/ciezko-na-sercu-web/commit/e95aa4ff1999edb751b322bca1599a559be10b84))

## [1.1.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.1.0...v1.1.1) (2026-11-08)

### Bug Fixes

* transkrypcja instaluje ffmpeg na runnerze ([8bbf952](https://github.com/tiriana/ciezko-na-sercu-web/commit/8bbf95217a451953aff44bc7561a398d000dc471))

## [1.1.0](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.11...v1.1.0) (2026-11-08)

### Features

* transkrypcja odcinków w GitHub Actions, gęstsze segmenty ([7b99abf](https://github.com/tiriana/ciezko-na-sercu-web/commit/7b99abf2fd0e329b1244ddf236f48a024c6be418))
* zgłaszanie błędów przy elementach odcinka ([ef992e6](https://github.com/tiriana/ciezko-na-sercu-web/commit/ef992e63fb679fc2759ccf44c27085263e01f22b))

### Bug Fixes

* przebieg deployu na gałęzi podglądu nazywa się nazwą gałęzi ([29710e9](https://github.com/tiriana/ciezko-na-sercu-web/commit/29710e90f0a5a623a1f6a2f1fd99fb22f333a964))

## [1.0.11](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.10...v1.0.11) (2026-11-08)

### Bug Fixes

* lista na stronie tagu ma szerokość treści, bez wewnętrznego przewijania ([0c900db](https://github.com/tiriana/ciezko-na-sercu-web/commit/0c900dbc1cfaee858abaeb93830c55ac938f8f87))

## [1.0.10](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.9...v1.0.10) (2026-11-08)

### Bug Fixes

* menu na telefonie — przycisk z hamburgerem i rozwijana nawigacja ([b53fcf4](https://github.com/tiriana/ciezko-na-sercu-web/commit/b53fcf4a8c1e018d3148b9373e08ab053198314e))

## [1.0.9](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.8...v1.0.9) (2026-11-07)

### Bug Fixes

* chmura tagów bez czerwieni — wydarzenia jak zespoły, osoby i dzieła przygaszone ([46f0ee8](https://github.com/tiriana/ciezko-na-sercu-web/commit/46f0ee8cc9fa9256746f062daf2c7a674589434e))

## [1.0.8](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.7...v1.0.8) (2026-11-07)

### Bug Fixes

* typy w chmurze tagów różnią się subtelnie, bez czerwieni sugerującej wagę ([2a150cb](https://github.com/tiriana/ciezko-na-sercu-web/commit/2a150cb71a1be94921a6478d5859ac73a5ea7aca))

## [1.0.7](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.6...v1.0.7) (2026-11-07)

### Bug Fixes

* deploy nosi nazwę wersji, którą publikuje ([cc762c3](https://github.com/tiriana/ciezko-na-sercu-web/commit/cc762c3e8a4a098c053e325e278c5737b9231756))

## [1.0.6](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.5...v1.0.6) (2026-11-07)

### Bug Fixes

* zwijanie paska tagu obejmuje padding i margines, bez skoku na końcu ([62178cd](https://github.com/tiriana/ciezko-na-sercu-web/commit/62178cdd85273130b6783457f07793c0dbd40235))

## [1.0.5](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.4...v1.0.5) (2026-11-07)

### Bug Fixes

* tytuł odcinka dokłada tagi z istniejącego słownika ([9d7f763](https://github.com/tiriana/ciezko-na-sercu-web/commit/9d7f763ccb35d0a6470a69c5a31625127c37c2c8))

## [1.0.4](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.3...v1.0.4) (2026-11-07)

### Bug Fixes

* pasek tagu znika płynnie, zwijając się do zera ([60ba136](https://github.com/tiriana/ciezko-na-sercu-web/commit/60ba13634486983ff8f69d13eee7e4dd342e5247))
* tag podświetla też wejścia, nie tylko utwory ([08f4e65](https://github.com/tiriana/ciezko-na-sercu-web/commit/08f4e654385d0b79cf30ca065a2939e0ccdd5f4a))

## [1.0.3](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.2...v1.0.3) (2026-11-07)

### Bug Fixes

* wersja w stopce prowadzi do konkretnego wydania ([a225588](https://github.com/tiriana/ciezko-na-sercu-web/commit/a2255882b44fe4be7a437874d969ef5ae043e57a))

## [1.0.2](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.1...v1.0.2) (2026-11-07)

### Bug Fixes

* wersja w stopce bez podkreślenia i mniej widoczna ([4a6e4cd](https://github.com/tiriana/ciezko-na-sercu-web/commit/4a6e4cde4b39910685dcad1321a3f4faef1cb8a3))

## [1.0.1](https://github.com/tiriana/ciezko-na-sercu-web/compare/v1.0.0...v1.0.1) (2026-11-07)

### Bug Fixes

* wydanie podbija wersję w package.json i uruchamia deploy ([94d3a6a](https://github.com/tiriana/ciezko-na-sercu-web/commit/94d3a6aad5a4ba5be94731a66c01194ddc354605))

## 1.0.0 (2026-11-07)

### Features

* wersja w metatagach i stopce, wydania przez semantic-release ([476720f](https://github.com/tiriana/ciezko-na-sercu-web/commit/476720f1eafcaff8705fa36721d8e6f6b8df187a))

### Bug Fixes

* zgodna wersja presetu changelog dla semantic-release ([6203fa3](https://github.com/tiriana/ciezko-na-sercu-web/commit/6203fa304dc154c27957f5c236d1214e3d067553))
