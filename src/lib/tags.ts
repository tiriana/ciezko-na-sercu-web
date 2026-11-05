import type { Tag } from './schema';

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

export interface TagIndexEntry {
  id: string;
  label: string;
  type: Tag['type'];
  /** Odcinki, w których tag występuje, od najnowszego. */
  episodes: { id: string; slug: string; title: string; date: string; at?: number }[];
}

export const TAG_TYPE_LABELS: Record<Tag['type'], string> = {
  artist: 'Zespoły',
  person: 'Osoby',
  work: 'Dzieła',
  event: 'Wydarzenia',
  place: 'Miejsca',
  theme: 'Tematy',
  editorial: 'Redakcyjne',
};

export const TAG_TYPE_ORDER: Tag['type'][] = ['artist', 'person', 'event', 'work', 'place', 'theme', 'editorial'];

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
      current.episodes.push({ id: entry.id, slug: entry.slug, title: entry.title, date: entry.date, at: tag.at });
      index.set(tag.id, current);
    }
  }

  for (const entry of index.values()) {
    entry.episodes.sort((left, right) => right.date.localeCompare(left.date));
  }
  return index;
}
