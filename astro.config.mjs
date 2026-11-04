import { readFileSync } from 'node:fs';

import { defineConfig } from 'astro/config';

// Stare slugi (po zmianie tytułu odcinka) muszą dalej prowadzić do odcinka, więc każdy
// poprzedni adres dostaje stronę-zaślepkę z meta refresh i linkiem.
function legacyRedirects() {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(new URL('./data/catalog.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
  const redirects = {};
  for (const episode of catalog.episodes) {
    for (const slug of episode.slugs ?? []) {
      if (slug === episode.slug) continue;
      redirects[`/odcinki/${slug}`] = `/odcinki/${episode.slug}/`;
    }
  }
  return redirects;
}

export default defineConfig({
  site: 'https://ciezko-na-sercu.pages.dev',
  build: { format: 'directory' },
  redirects: legacyRedirects(),
});
