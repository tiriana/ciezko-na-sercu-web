import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'astro/config';

// Adres odcinka zależy tylko od uuid: tytuł bywa poprawiany po publikacji, a stary link
// nie może wtedy umrzeć. Ta sama reguła trafia do `_redirects` (Cloudflare zwraca 301)
// i do stron-zaślepek, żeby przekierowanie działało też bez Cloudflare.
const shortId = (id) => id.slice(0, 8);

function legacyRedirects(catalog) {
  if (!catalog) return {};
  const redirects = {};
  for (const episode of catalog.episodes) {
    const target = `/odcinki/${shortId(episode.id)}/${episode.slug}/`;
    // Także bieżący slug: płaski adres `/odcinki/<slug>/` nie jest już trasą,
    // więc każdy wpis z `slugs[]` prowadzi na wersję z uuid.
    for (const slug of episode.slugs ?? []) redirects[`/odcinki/${slug}`] = target;
  }
  return redirects;
}

function readCatalog() {
  try {
    return JSON.parse(readFileSync(new URL('./data/catalog.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

const catalog = readCatalog();

const redirectsFile = {
  name: 'redirects-file',
  hooks: {
    'astro:build:done': ({ dir }) => {
      if (!catalog) return;
      const lines = ['# wygenerowane przy buildzie: stary slug odcinka → adres kanoniczny'];
      for (const [source, target] of Object.entries(legacyRedirects(catalog))) {
        lines.push(`${source} ${target} 301`);
      }
      writeFileSync(join(dir.pathname, '_redirects'), `${lines.join('\n')}\n`);
    },
  },
};

export default defineConfig({
  site: 'https://ciezko-na-sercu.pages.dev',
  build: { format: 'directory', inlineStylesheets: 'always' },
  redirects: legacyRedirects(catalog),
  integrations: [redirectsFile],
});
