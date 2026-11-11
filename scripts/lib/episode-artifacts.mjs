// Rozkład starego episode.json na artefakty i złożenie go z powrotem.
// Etap przejściowy: dzieli tylko to, co da się przypisać producentowi, resztę oddaje
// warstwie ręcznej — bez zmiany treści, żeby dało się to zweryfikować diffem.

const META_KEYS = new Set(['version', 'id', 'analyzedAt', 'updatedAt', 'durationSec']);
const PRODUCED_KEYS = new Set(['summary', 'topics', 'tracks']);
const MANUAL_KEYS = new Set(['tags', 'quotes', 'credits']);

export const INTRO_ARTIST = 'Ciężko na sercu';
export const INTRO_TITLE = 'Intro';

const isIntro = (track) => track.artist === INTRO_ARTIST && track.title === INTRO_TITLE;

export function decomposeEpisode(episode, entry) {
  const intro = episode.tracks?.[0] && isIntro(episode.tracks[0]) ? episode.tracks[0] : null;
  const tracks = intro ? episode.tracks.slice(1) : [...(episode.tracks ?? [])];
  const extra = Object.fromEntries(
    Object.entries(episode).filter(([key]) => !META_KEYS.has(key) && !PRODUCED_KEYS.has(key) && !MANUAL_KEYS.has(key))
  );

  return {
    metadata: {
      version: 1,
      uuid: episode.id,
      date: entry?.date ?? null,
      title: entry?.title ?? null,
      sourceUrl: entry?.sourceUrl ?? null,
      audioUrl: entry?.audioUrl ?? null,
      durationSec: episode.durationSec,
      analyzedAt: episode.analyzedAt,
      updatedAt: episode.updatedAt,
      episodeVersion: episode.version ?? 1,
    },
    audioId: { version: 1, tracks },
    topics: { version: 1, topics: episode.topics ?? [] },
    text: { version: 1, summary: episode.summary ?? null },
    intro: intro ? { version: 1, track: intro } : null,
    manual: {
      version: 1,
      title: null,
      tags: episode.tags ?? [],
      quotes: episode.quotes ?? [],
      credits: episode.credits ?? [],
      extra,
    },
  };
}

export function compileEpisode(artifacts) {
  const { metadata, audioId, topics, text, intro, manual } = artifacts;
  const tracks = [...(audioId?.tracks ?? [])];
  if (intro?.track) tracks.unshift({ ...intro.track });

  return {
    version: metadata.episodeVersion ?? 1,
    id: metadata.uuid,
    analyzedAt: metadata.analyzedAt,
    updatedAt: metadata.updatedAt,
    durationSec: metadata.durationSec,
    summary: text?.summary ?? null,
    topics: topics?.topics ?? [],
    tags: manual?.tags ?? [],
    tracks,
    quotes: manual?.quotes ?? [],
    credits: manual?.credits ?? [],
    ...(manual?.extra ?? {}),
  };
}
