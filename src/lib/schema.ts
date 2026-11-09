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

export const transcriptSchema = z.object({
  version: z.number(),
  episodeId: z.string(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
    }),
  ),
});

export type Transcript = z.infer<typeof transcriptSchema>;

export const TAG_TYPES = ['artist', 'person', 'work', 'event', 'concert', 'place', 'theme', 'editorial'] as const;
export const TAG_SOURCES = ['tracks', 'credits', 'transcript', 'profile', 'title'] as const;

export const tagSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  type: z.enum(TAG_TYPES),
  source: z.enum(TAG_SOURCES),
  at: z.number().optional(),
});

export type Tag = z.infer<typeof tagSchema>;

// Ten sam byt bywa zapisany różnie („Vogg”, „Vogg (Wojciech Kiełtyka)”, pełne imię).
// Klucz to wariant spotkany w danych, wartość — etykieta kanoniczna.
export const aliasesSchema = z.object({
  version: z.literal(1),
  aliases: z.record(z.string(), z.string().min(1)),
  // Etykieta bywa trafnie nazwana, ale źle opisanym typem (zespół jako osoba).
  types: z.record(z.string(), z.enum(TAG_TYPES)).default({}),
  // Pary „kandydat na scalenie”, które redakcja odrzuciła — żeby nie wracały przy każdym uruchomieniu.
  dismissed: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default([]),
});

export type Aliases = z.infer<typeof aliasesSchema>['aliases'];
export type TagTypes = z.infer<typeof aliasesSchema>['types'];

export const episodeSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  analyzedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Czas ostatniego przeliczenia opracowania (ISO 8601); brak w starszych plikach. */
  updatedAt: z.string().optional(),
  durationSec: z.number().nullable(),
  summary: z.string().nullable(),
  topics: z.array(z.object({ start: z.number(), end: z.number().optional(), label: z.string() })),
  // Tagi odcinka: zespoły, osoby, dzieła, wydarzenia, miejsca, tematy i znaczniki redakcyjne.
  tags: z.array(tagSchema).default([]),
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
        /** Ręczna granica utworu; bez niej `end` wynika z `start + durationSec`. */
        end: z.number().optional(),
        /** Nowe wartości pól; stare (artist/title/album) zostają kluczem dopasowania. */
        newArtist: z.string().optional(),
        newTitle: z.string().optional(),
        newAlbum: z.string().optional(),
        /** Wiersz do ukrycia (np. fałszywe rozpoznanie Shazama). */
        hide: z.boolean().optional(),
      })
    )
    .default([]),
  // Wiersze dodane ręcznie: nie mają czego dopasować, więc są doklejane do osi.
  addTracks: z
    .array(
      z.object({
        artist: z.string().default(''),
        title: z.string().default(''),
        album: z.string().optional(),
        start: z.number(),
        durationSec: z.number().optional(),
        /** Ręczna granica dodanego utworu; bez niej `end` wynika z `durationSec`. */
        end: z.number().optional(),
      })
    )
    .default([]),
  addTopics: z
    .array(
      z.object({
        start: z.number(),
        label: z.string().default(''),
        end: z.number().optional(),
      })
    )
    .default([]),
  // Poprawki wejść: dopasowanie po czasie i etykiecie, bo tagger nie nadaje im id.
  topics: z
    .array(
      z.object({
        time: z.number(),
        label: z.string(),
        start: z.number().optional(),
        /** Ręczny koniec wejścia; bez niego zostaje granica z taggera. */
        end: z.number().optional(),
        newLabel: z.string().optional(),
        hide: z.boolean().optional(),
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

export const duplicatesSchema = z.object({
  version: z.literal(1),
  duplicates: z.record(
    z.string(),
    z.object({
      of: z.string(),
      reason: z.string().default(''),
    }),
  ),
});

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
