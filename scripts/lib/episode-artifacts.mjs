// Artefakty odcinka: rozkład starego episode.json, złożenie z artefaktów i scalenie
// z warstwą ręczną. Kompilator nie zna kolejności uruchomień producentów — czyta tylko to,
// co leży w katalogu odcinka, więc każdy etap można powtórzyć w dowolnym momencie.

import { mergeEpisode } from '../../src/lib/merge.ts';

const META_KEYS = new Set(['version', 'id', 'analyzedAt', 'updatedAt', 'durationSec']);
const PRODUCED_KEYS = new Set(['summary', 'topics', 'tracks']);
const MANUAL_KEYS = new Set(['tags', 'quotes', 'credits']);

export const INTRO_ARTIST = 'Ciężko na sercu';
export const INTRO_TITLE = 'Intro';

const isIntro = (track) => track.artist === INTRO_ARTIST && track.title === INTRO_TITLE;

export function decomposeEpisode(episode, entry, patches = null) {
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
      patches,
    },
  };
}

/**
 * Artefakty → odcinek przed nałożeniem warstwy ręcznej.
 * Pierwszeństwo: ręczne > text > voice/intro/audio-id > to, co przyszło z taggera.
 */
export function composeEpisode({ metadata, audioId, topics, text, voice, intro, manual }) {
  const tracks = [...(audioId?.tracks ?? [])];
  if (intro?.track) tracks.push({ ...intro.track });

  const entries = [...(topics?.topics ?? [])];
  for (const added of voice?.topics ?? []) entries.push({ ...added });

  for (const item of text?.labels ?? []) {
    const entry = entries.find((candidate) => Math.abs(candidate.start - item.start) < 0.5);
    if (entry && item.label) entry.label = item.label;
  }

  if (intro || voice?.topics?.length) tracks.sort((left, right) => left.start - right.start);
  if (voice?.topics?.length) entries.sort((left, right) => left.start - right.start);

  return {
    version: metadata?.episodeVersion ?? 1,
    id: metadata?.uuid,
    analyzedAt: metadata?.analyzedAt,
    updatedAt: metadata?.updatedAt,
    durationSec: metadata?.durationSec ?? null,
    summary: manual?.summary ?? text?.summary ?? null,
    topics: entries,
    tags: manual?.tags ?? [],
    tracks,
    quotes: manual?.quotes ?? [],
    credits: manual?.credits ?? [],
    ...(manual?.extra ?? {}),
  };
}

/**
 * Artefakty + warstwa ręczna + warianty nazw → gotowy odcinek (to, co czyta strona).
 * Poprawki ręczne mają ten sam format co dzisiejsze `data/overrides/<id>.json`.
 */
export function compileEpisode(artifacts, { aliases = {}, types = {} } = {}) {
  const episode = composeEpisode(artifacts);
  const override = artifacts.manual?.patches ?? null;
  return mergeEpisode(episode, { override, aliases, types });
}
