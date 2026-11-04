import { z } from 'zod';

export const catalogSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  program: z.object({
    slug: z.string(),
    name: z.string(),
    station: z.string(),
    pageUrl: z.url(),
  }),
  episodes: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string().min(1),
      slugs: z.array(z.string().min(1)).min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      title: z.string().min(1),
      articleId: z.number().nullable(),
      durationSec: z.number().nullable(),
      sourceUrl: z.url().nullable(),
      audioUrl: z.url().nullable(),
    }),
  ),
});

export const episodeSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  analyzedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationSec: z.number().nullable(),
  summary: z.string().nullable(),
  topics: z.array(z.object({ start: z.number(), label: z.string() })),
  tracks: z.array(
    z.object({
      start: z.number(),
      durationSec: z.number(),
      artist: z.string(),
      title: z.string().nullable(),
      album: z.string().nullable(),
      confidence: z.string().nullable(),
      sources: z.array(z.string()),
      links: z.array(z.url()),
    }),
  ),
  quotes: z.array(z.object({ start: z.number(), text: z.string() })),
  credits: z
    .array(z.object({ role: z.string(), name: z.string(), time: z.number(), quote: z.string() }))
    .default([]),
});

// Ręczne poprawki do opracowań. Trzymamy je osobno od data/episodes, bo import z taggera
// nadpisuje tamte pliki bezwarunkowo, a korekta redakcyjna nie może zniknąć.
export const overrideSchema = z.object({
  version: z.number().default(1),
  tracks: z
    .array(
      z.object({
        artist: z.string().optional(),
        title: z.string().optional(),
        album: z.string().optional(),
        start: z.number().optional(),
        durationSec: z.number().optional(),
      })
    )
    .default([]),
});

export type TrackOverride = z.infer<typeof overrideSchema>['tracks'][number];

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogEpisode = Catalog['episodes'][number];
export type Episode = z.infer<typeof episodeSchema>;
export type Track = Episode['tracks'][number];

export const titlesSchema = z.object({
  version: z.literal(1),
  titles: z.record(
    z.string(),
    z.object({
      title: z.string().min(1),
      kind: z.literal('unofficial'),
      originalTitle: z.string().min(1),
      note: z.string().optional(),
    }),
  ),
});

export type TitleOverride = z.infer<typeof titlesSchema>['titles'][string];
