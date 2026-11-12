#!/usr/bin/env node
/**
 * Wkłada artefakty VAD pobrane przez `download-artifact` do `data/artifacts/<id>/`.
 *
 * `actions/download-artifact` z `pattern` rozpakowuje **jeden** artefakt płasko do
 * katalogu docelowego, a kilka — do podkatalogów per artefakt. Dlatego identyfikator
 * odcinka czytamy z zawartości pliku (`episodeId`), a nie z nazwy katalogu: przy
 * partii wielkości jeden zgadywanie z nazwy gubiło artefakt, a transkrypcja dostawała
 * pustą macierz.
 *
 * Użycie: node scripts/collect-spans.mjs [katalog-pobrany] [katalog-docelowy]
 * `EXPECTED` (opcjonalnie): ile artefaktów powinno być; niezgodność kończy się błędem.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = process.argv[2] ?? '.spans';
const destination = process.argv[3] ?? 'data/artifacts';
const expected = Number.parseInt(process.env.EXPECTED ?? '0', 10) || 0;

const artifacts = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else if (entry.name === 'speech-spans.json') {
      artifacts.push(path);
    }
  }
};

if (!existsSync(source)) {
  console.error(`Brak katalogu ${source} z artefaktami VAD.`);
  process.exit(expected > 0 ? 1 : 0);
}
walk(source);

let placed = 0;
for (const file of artifacts) {
  let episodeId;
  try {
    episodeId = JSON.parse(readFileSync(file, 'utf8')).episodeId;
  } catch (error) {
    console.error(`::error::${file}: nie da się odczytać JSON-a (${error.message})`);
    process.exit(1);
  }
  if (!episodeId) {
    console.error(`::error::${file}: brak episodeId — nie wiem, do którego odcinka trafić.`);
    process.exit(1);
  }
  mkdirSync(join(destination, episodeId), { recursive: true });
  cpSync(file, join(destination, episodeId, 'speech-spans.json'));
  placed += 1;
}

console.log(`włożonych artefaktów: ${placed}`);

if (expected > 0 && placed !== expected) {
  console.error(`::error::Artefaktów VAD: ${placed}, oczekiwano ${expected} — część bloków mowy nie trafiła do repo.`);
  process.exit(1);
}
