#!/usr/bin/env node
/**
 * Rejestr przerobionych odcinków: data/voiceprint.json.
 * Trzyma, które odcinki mają już policzony profil głosu i co z tego wyszło,
 * żeby kolejne przebiegi nie liczyły ich drugi raz i dało się pokazać postęp.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const LEDGER_PATH = new URL('../data/voiceprint.json', import.meta.url);

export const readLedger = () => {
  if (!existsSync(LEDGER_PATH)) return { version: 1, model: 'silero-vad+ecapa', episodes: {} };
  try {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    return { version: ledger.version ?? 1, model: ledger.model ?? 'silero-vad+ecapa', episodes: ledger.episodes ?? {} };
  } catch {
    return { version: 1, model: 'silero-vad+ecapa', episodes: {} };
  }
};

export const writeLedger = (ledger) => {
  const sorted = Object.fromEntries(Object.entries(ledger.episodes).sort(([left], [right]) => left.localeCompare(right)));
  writeFileSync(LEDGER_PATH, `${JSON.stringify({ ...ledger, episodes: sorted }, null, 2)}\n`);
};

export const recordEpisode = (id, result) => {
  const ledger = readLedger();
  ledger.episodes[id] = { analyzedAt: new Date().toISOString().slice(0, 10), ...result };
  writeLedger(ledger);
  return ledger;
};

export const processedEpisodes = () => new Set(Object.keys(readLedger().episodes));
