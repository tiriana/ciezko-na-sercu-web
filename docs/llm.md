# Wybór modelu językowego

Wszystkie zadania LLM (streszczenie odcinka, nazwy wejść, kredyty, rozpoznanie
utworu z zapowiedzi) idą przez `scripts/lib/llm.mjs`. Skrypty nie znają nazw
dostawców ani modeli — wołają `ask()`/`askJson()`, a Python przez mostek
`scripts/llm.mjs`.

## Dostawcy i limity

| dostawca | klucz | darmowy limit |
| --- | --- | --- |
| Groq | `GROQ_API_KEY` | 30 RPM, 1 000 RPD, 8 000 TPM, 200 000 TPD na model |
| Google Gemini | `GEMINI_API_KEY` | per projekt, podgląd w AI Studio; reset 00:00 PT |
| OpenRouter | `OPENROUTER_API_KEY` | 20 RPM; 50 RPD (<10 kredytów) lub 1 000 RPD |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | 10 000 neuronów/dzień, 300 RPM |

Wystarczy jeden klucz; każdy następny zwiększa pulę i sumę limitów. Klucz nie
ustawiony po prostu nie wchodzi do losowania.

## Jak wybierany jest model

1. Katalog jest odkrywany z API dostawcy i cache'owany 6 h w
   `.cache/llm/models.json`. Filtr zostawia wyłącznie darmowe modele czatu:
   bez whisper/TTS/embeddingów/obrazu, OpenRouter tylko z ceną 0/0, Google tylko
   `generateContent` bez preview, Cloudflare z listy modeli darmowego planu.
2. Najpierw losowana jest **półka redakcyjna** (`QUALITY` w module), a reszta
   katalogu jest zapasem. Bez tego losowanie wrzuca do streszczenia model 1.7B.
3. Kolejność wewnątrz półki jest mieszana przed **każdym** pytaniem
   (Fisher–Yates), więc zużycie rozkłada się równo i limit jednego modelu nie
   blokuje całości.
4. Po 429 model dostaje karencję (`retry-after`, min. 1 min, maks. 15 min),
   po 401/403/404 — 24 h, po timeoucie/5xx — 5 min. Karencje leżą w
   `.cache/llm/cooldowns.json`, więc kolejne procesy w tym samym przebiegu ich
   nie powtarzają. `retry-after` czekamy tylko do 3 s.
5. Pusta odpowiedź albo odpowiedź bez JSON-a to powód, by spróbować następnego
   modelu; treść sprawdza już zadanie (np. długość streszczenia).

## Diagnoza

```sh
npm run llm:models                       # kandydaci w kolejności losowania
node scripts/llm.mjs --models --all      # także modele na karencji
echo '{"prompt":"..."}' | node scripts/llm.mjs --json
ENRICH_MODELS=groq:openai/gpt-oss-120b npm run enrich
```

`--model`/`ENRICH_MODELS` tylko zawęża listę — nie omija karencji ani losowania.

## Dodanie dostawcy

Dopisz wpis w `PROVIDERS` (`keyEnv`, `chatUrl`, `list` zwracające `{id, context}`)
i, jeśli model ma pisać treści na stronę, wzorzec w `QUALITY`. Reszta — cache,
losowanie, karencje, mostek dla Pythona — działa bez zmian.
