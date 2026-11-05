import type { APIRoute } from 'astro';

import { getEntries, getEpisodeFiles } from '../lib/data';
import { normalize } from '../lib/search';

export const prerender = true;

/**
 * Statyczny indeks wyszukiwania: metadane odcinka i tagi, bez streszczeń.
 * Budowany raz przy buildzie, pobierany przez stronę /szukaj/.
 */
export const GET: APIRoute = async () => {
  const [entries, files] = await Promise.all([getEntries(), getEpisodeFiles()]);

  const index = entries.map((entry) => {
    const episode = files.get(entry.id);
    const tags = (episode?.tags ?? []).map((tag) => ({ id: tag.id, label: tag.label, type: tag.type }));
    const haystack = normalize([entry.title, ...tags.map((tag) => tag.label)].join(' '));
    return { slug: entry.slug, title: entry.title, date: entry.date, haystack, tags };
  });

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
