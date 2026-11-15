import type { Tag } from './schema.ts';

// Reguły `id` i dzielenia etykiet żyją w `lib/tags.mjs`, bo importuje je też edytor
// online w przeglądarce; tutaj zostaje tylko to, co potrzebuje typów odcinka.
export { splitTag, splitTags, tagId } from '../../../lib/tags.mjs';

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
