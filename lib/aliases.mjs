// Warianty nazw (`data/aliases.json`): który wariant wskazuje na którą etykietę, jakie
// typy mają etykiety i które propozycje scalenia redakcja odrzuciła. Ten sam moduł
// liczy to lokalny serwer edytora i przeglądarka, więc nie ma dwóch prawd o danych.

import { splitTags } from './tags.mjs';

export const TAG_TYPES = ['artist', 'person', 'work', 'event', 'concert', 'place', 'theme', 'editorial'];

export const emptyAliasFile = () => ({ version: 1, aliases: {}, types: {}, dismissed: [] });

/** Warianty mogą wskazywać jeden na drugi, więc idziemy łańcuchem do końca; zbiór
 * odwiedzonych etykiet zatrzymuje pętlę niezależnie od jej długości. */
export const resolveAlias = (label, aliases) => {
  const seen = new Set([label]);
  let current = label;
  for (;;) {
    const next = (aliases ?? {})[current];
    if (!next || next === current) return current;
    if (seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
};

const foldWords = (value) =>
  String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Etykiety z odcinków plus nazwy z creditsów: alias może celować w każdą z nich. */
export const collectLabels = (episodes) => {
  const labels = new Map();
  for (const episode of episodes ?? []) {
    if (!episode) continue;
    for (const tag of splitTags(episode.tags)) {
      const current = labels.get(tag.label) ?? { label: tag.label, type: tag.type, episodes: new Set() };
      current.episodes.add(episode.id);
      labels.set(tag.label, current);
    }
    for (const credit of episode.credits ?? []) {
      const current = labels.get(credit.name) ?? { label: credit.name, type: 'person', episodes: new Set() };
      current.episodes.add(episode.id);
      labels.set(credit.name, current);
    }
  }
  return labels;
};

/** Kandydat = osoba, której krótsza etykieta jest całym słowem w dłuższej. */
export const aliasCandidates = (labels, aliases, dismissed) => {
  const people = [...labels.values()].filter((item) => item.type === 'person' && resolveAlias(item.label, aliases) === item.label);
  const out = [];
  for (const shorter of people) {
    for (const longer of people) {
      if (longer.label.length <= shorter.label.length + 3) continue;
      if (!` ${foldWords(longer.label)} `.includes(` ${foldWords(shorter.label)} `)) continue;
      if ((dismissed ?? []).some((pair) => pair.from === shorter.label && pair.to === longer.label)) continue;
      out.push({ from: shorter.label, to: longer.label });
    }
  }
  return out;
};

/** Alias wskazujący sam na siebie albo łańcuch z pętlą. Cel nie musi istnieć w danych:
 * kanoniczna nazwa bywa ustalona, zanim pojawi się w którymkolwiek odcinku. */
export const aliasProblems = (aliases) => {
  const problems = [];
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (alias === target) problems.push(`${alias}: alias wskazuje sam na siebie`);
    if (resolveAlias(target, aliases) !== target) problems.push(`${alias} → ${target}: łańcuch aliasów tworzy pętlę`);
  }
  return problems;
};

/** Widok etykiet do listy: kanoniczna nazwa i typ po podstawieniu aliasów. */
export const tagRows = (labels, file) =>
  [...labels.values()]
    .map((item) => {
      const canonical = resolveAlias(item.label, file.aliases);
      return {
        label: item.label,
        type: (file.types ?? {})[canonical] ?? item.type,
        originalType: item.type,
        count: item.episodes.size,
        canonical,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, 'pl'));

/** Wejście z formularza bywa zaśmiecone spacjami i pustymi wierszami; zapisujemy tylko
 * to, co przechodzi schemat strony, bo plik trafia prosto do repozytorium. */
const sortedRecord = (record) =>
  Object.fromEntries(Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right, 'pl')));

/** Klucz porównania plików: kolejność wpisów nie jest zmianą, więc sortujemy wszystko. */
export const aliasFileKey = (file) => {
  const normalized = normalizeAliasFile(file ?? {});
  return JSON.stringify({
    aliases: sortedRecord(normalized.aliases),
    types: sortedRecord(normalized.types),
    dismissed: normalized.dismissed.map((pair) => `${pair.from}\u0000${pair.to}`).sort(),
  });
};

export const normalizeAliasFile = (payload) => {
  const aliases = {};
  for (const [from, to] of Object.entries(payload?.aliases ?? {})) {
    const key = String(from).trim();
    const value = String(to).trim();
    if (key && value && key !== value) aliases[key] = value;
  }
  const types = {};
  for (const [label, type] of Object.entries(payload?.types ?? {})) {
    const key = String(label).trim();
    if (key && TAG_TYPES.includes(type)) types[key] = type;
  }
  const dismissed = (payload?.dismissed ?? [])
    .filter((pair) => pair?.from && pair?.to)
    .map((pair) => ({ from: String(pair.from).trim(), to: String(pair.to).trim() }))
    .filter((pair) => pair.from && pair.to && pair.from !== pair.to);
  return { version: 1, aliases, types, dismissed };
};
