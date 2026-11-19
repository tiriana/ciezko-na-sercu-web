import { existsSync, readFileSync } from 'node:fs';

export const isIntro = (track) => track.artist === 'Ciężko na sercu' && track.title === 'Intro';

export const hasIntro = (id) => {
  const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  const episode = read(`data/episodes/${id}.json`);
  const override = read(`data/overrides/${id}.json`);
  return [...(episode.tracks ?? []), ...(override.addTracks ?? [])].some(isIntro);
};

// Starsze odcinki bez intra (np. bez jingla na antenie) nie mogą wracać co dzień jako luka.
export const introWindowStart = (days = 45) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
