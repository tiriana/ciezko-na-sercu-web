// Reguły nazywania tagów: `id` etykiety i rozbijanie zlepionych nazw. Czysty ES moduł,
// bo ten sam kod importuje strona (Astro), testy i edytor online w przeglądarce.

/** Musi odpowiadać tagId w taggerze (src/tag/tags.ts), inaczej deep link nie trafi. */
export const tagId = (label) =>
  String(label ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// „&” bywa częścią nazwy, nie spójnikiem dwóch zespołów — tych etykiet nie ruszamy.
const COMPOUND_ARTISTS = new Set([
  'author & punisher',
  'bohren & der club of gore',
  'uncle acid & the deadbeats',
  'zeal & ardor',
  'sowieso & co',
]);

// Separatory wymagają spacji po obu stronach, więc „AC/DC” i „sunn O)))” zostają całe.
const ARTIST_SEPARATORS = /\s+(?:&|\+|\/)\s+|,\s+/;
const CONCERT_SEPARATORS = /\s+(?:&|\+|\/|i)\s+|,\s+/;
const EVENT_SEPARATORS = /\s+\/\s+/;

const partsOf = (label, pattern) =>
  label
    .split(pattern)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

const withLabel = (tag, label) => ({
  ...tag,
  label,
  id: `${tag.id?.startsWith('koncert-') ? 'koncert-' : ''}${tagId(label)}`,
});

/**
 * Jeden tag = jeden byt. Import z taggera skleja kolaboracje („A & B”), składy
 * koncertów („A + B / C”) i nazwy festiwali („X / Y”), co zaśmieca indeks tagów.
 * Koncert dostaje headlinera, bo tag koncertu nazywa wydarzenie, nie cały skład.
 */
export const splitTag = (tag) => {
  const label = String(tag.label ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) return [tag];
  const base = label === tag.label ? tag : { ...tag, label };

  if (tag.type === 'artist') {
    if (COMPOUND_ARTISTS.has(label.toLowerCase())) return [base];
    const parts = partsOf(label, ARTIST_SEPARATORS);
    return parts.length > 1 ? parts.map((part) => withLabel(base, part)) : [base];
  }
  if (tag.type === 'concert') {
    const [headliner] = partsOf(label, CONCERT_SEPARATORS);
    // „Koncert … (Tallin, Estonia)” to nazwa wydarzenia, nie skład — ucięcie w środku
    // nawiasu albo na „Koncert/Trasa” dałoby etykietę bez sensu.
    const description = !headliner || /\([^)]*$/.test(headliner) || /^(koncert|trasa|festiwal|tour)\b/i.test(headliner);
    return headliner && headliner !== label && !description ? [withLabel(base, headliner)] : [base];
  }
  if (tag.type === 'event') {
    const parts = partsOf(label, EVENT_SEPARATORS);
    return parts.length > 1 ? parts.map((part) => withLabel(base, part)) : [base];
  }
  return [base];
};

/** Dzieli wszystkie tagi odcinka i scala duplikaty, które po podziale mają ten sam id. */
export const splitTags = (tags) => {
  const merged = new Map();
  for (const tag of tags ?? []) {
    for (const next of splitTag(tag)) {
      const current = merged.get(next.id);
      if (!current) {
        merged.set(next.id, next);
        continue;
      }
      if (current.at === undefined && next.at !== undefined) current.at = next.at;
    }
  }
  return [...merged.values()];
};
