#!/usr/bin/env node
/**
 * Składa katalog publikacji edytora online: pliki z `editor/` plus wspólny
 * `lib/overrides.mjs`, który w repo leży poza `editor/`, a w przeglądarce musi być
 * importem względnym. Wynik trafia do tymczasowego `.cache/editor-dist`, więc w repo
 * nie ma kopii tego samego kodu.
 *
 * Użycie: node scripts/build-editor.mjs [katalog-docelowy]
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2] ?? '.cache/editor-dist';

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'lib'), { recursive: true });
await cp('editor', OUT, { recursive: true });
for (const name of ['overrides.mjs', 'tags.mjs', 'aliases.mjs']) {
  await cp(`lib/${name}`, join(OUT, 'lib', name));
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  join(OUT, 'version.json'),
  `${JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2)}\n`
);

console.log(`edytor zbudowany w ${OUT} (wersja ${pkg.version})`);
console.log(`podgląd lokalny: node scripts/editor-serve.mjs ${OUT}`);
