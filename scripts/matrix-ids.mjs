#!/usr/bin/env node
/**
 * Wypisuje identyfikatory odcinków z macierzy `plan-transcribe.mjs`.
 * Skrypt emituje płaską tablicę jobów (zarówno w trybie `spans`, jak i `time`),
 * a nie obiekt `{include: [...]}` — czytanie `.include` dawało `undefined`
 * i wywalało kroki zamawiające profil głosu oraz Shazama.
 */

const raw = process.env.MATRIX?.trim() || '[]';
const parsed = JSON.parse(raw);
const rows = Array.isArray(parsed) ? parsed : (parsed.include ?? []);

console.log([...new Set(rows.map((row) => row.id))].join(','));
