import type { Tag } from './schema.ts';

/** Musi odpowiadać tagId w taggerze (src/tag/tags.ts), inaczej deep link nie trafi. */
export function tagId(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

const partsOf = (label: string, pattern: RegExp) =>
  label
    .split(pattern)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

const withLabel = (tag: Tag, label: string): Tag => ({
  ...tag,
  label,
  id: `${tag.id.startsWith('koncert-') ? 'koncert-' : ''}${tagId(label)}`,
});

/**
 * Jeden tag = jeden byt. Import z taggera skleja kolaboracje („A & B”), składy
 * koncertów („A + B / C”) i nazwy festiwali („X / Y”), co zaśmieca indeks tagów.
 * Koncert dostaje headlinera, bo tag koncertu nazywa wydarzenie, nie cały skład.
 */
export function splitTag(tag: Tag): Tag[] {
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
}

/** Dzieli wszystkie tagi odcinka i scala duplikaty, które po podziale mają ten sam id. */
export function splitTags(tags: Tag[]): Tag[] {
  const merged = new Map<string, Tag>();
  for (const tag of tags) {
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
}

export interface TagIndexEntry {
  id: string;
  label: string;
  type: Tag['type'];
  /** Odcinki, w których tag występuje, od najnowszego. */
  episodes: { id: string; slug: string; title: string; displayTitle?: string; date: string; at?: number }[];
}

export const TAG_TYPE_LABELS: Record<Tag['type'], string> = {
  artist: 'Zespoły',
  person: 'Osoby',
  work: 'Dzieła',
  event: 'Wydarzenia',
  concert: 'Koncerty',
  place: 'Miejsca',
  theme: 'Tematy',
  editorial: 'Redakcyjne',
};

export const TAG_TYPE_ORDER: Tag['type'][] = ['artist', 'person', 'event', 'concert', 'work', 'place', 'theme', 'editorial'];

interface EpisodeForTags {
  id: string;
  tags: Tag[];
}

interface EntryForTags {
  id: string;
  slug: string;
  title: string;
  date: string;
}

/** Indeks tagów: jedno `id` na etykietę, z listą odcinków od najnowszego. */
export function buildTagIndex(
  episodes: Map<string, EpisodeForTags>,
  entries: EntryForTags[]
): Map<string, TagIndexEntry> {
  const byEntry = new Map(entries.map((entry) => [entry.id, entry]));
  const index = new Map<string, TagIndexEntry>();

  for (const entry of entries) {
    const episode = episodes.get(entry.id);
    if (!episode) continue;
    for (const tag of episode.tags) {
      const current = index.get(tag.id) ?? { id: tag.id, label: tag.label, type: tag.type, episodes: [] };
      current.episodes.push({
        id: entry.id,
        slug: entry.slug,
        title: entry.title,
        displayTitle: entry.displayTitle,
        date: entry.date,
        at: tag.at,
      });
      index.set(tag.id, current);
    }
  }

  for (const entry of index.values()) {
    entry.episodes.sort((left, right) => right.date.localeCompare(left.date));
  }
  return index;
}
