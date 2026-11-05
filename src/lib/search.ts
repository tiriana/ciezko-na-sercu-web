/** Normalizacja do porównań: bez wielkości liter, polskich znaków i interpunkcji. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface SearchTag {
  id: string;
  label: string;
  type: string;
}

export interface SearchEntry {
  slug: string;
  title: string;
  date: string;
  /** Tytuł i tagi znormalizowane raz przy buildzie — klient tylko porównuje. */
  haystack: string;
  tags: SearchTag[];
}

export function matches(entry: SearchEntry, query: string): { hit: boolean; tags: SearchTag[] } {
  const needle = normalize(query);
  if (needle.length < 2) return { hit: false, tags: [] };
  const words = needle.split(' ').filter(Boolean);
  const hit = words.every((word) => entry.haystack.includes(word));
  if (!hit) return { hit: false, tags: [] };
  const tags = entry.tags.filter((tag) => words.every((word) => normalize(`${tag.label} ${tag.id}`).includes(word)));
  return { hit: true, tags };
}
