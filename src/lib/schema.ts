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
  topics: z.array(z.object({ start: z.number(), end: z.number().optional(), label: z.string() })),
  // Tagi wyprowadzone ze znaczników profilu (np. Kanonada); służą też przyszłemu wyszukiwaniu.
  tags: z.array(z.object({ id: z.string(), label: z.string(), start: z.number().optional() })).default([]),
  tracks: z.array(
    z.object({
      start: z.number(),
      /** Koniec pozycji na osi programu, po uzgodnieniu z wejściami. */
      end: z.number().optional(),
      durationSec: z.number(),
      // Utwór rozpoznany tylko z zapowiedzi może nie mieć wykonawcy w trackliście taggera.
      artist: z.string().nullable(),
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
  // Poprawki creditsów: rename zastępuje nazwę we wszystkich rolach, credits podmienia
  // całą listę (np. gdy tagger pominął osobę).
  credits: z
    .object({
      rename: z.record(z.string(), z.string()).default({}),
      replace: z
        .array(z.object({ role: z.string(), name: z.string(), time: z.number().default(0), quote: z.string().default('') }))
        .optional(),
    })
    .default({ rename: {} }),
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

// Osoby z creditsów. Adresu profilu nie da się wyprowadzić z nazwiska (identyfikatory
// w URL-ach Polskiego Radia), więc mapowanie trzymamy ręcznie.
export const peopleSchema = z.object({
  version: z.literal(1),
  people: z.record(
    z.string(),
    z.object({
      url: z.string().url().optional(),
      note: z.string().optional(),
    })
  ),
});

export type Person = z.infer<typeof peopleSchema>['people'][string];
