import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyOverrides,
  compact,
  isEmptyOverrides,
  mergeOverrides,
  validateOverride,
  validateSavePayload,
  validateTrackTimes,
} from './overrides.mjs';

const episode = () => ({
  id: '216a8fd5-1292-4951-bbea-8ebbbebbb063',
  tracks: [
    { start: 100, end: 200, durationSec: 100, artist: 'Vader', title: 'Wings', album: null },
    { start: 300, end: 400, durationSec: 100, artist: 'Behemoth', title: 'Chant', album: 'The Satanist' },
  ],
  topics: [{ start: 0, end: 100, label: 'Wstęp' }],
});

test('dopisuje poprawkę nowego utworu', () => {
  const next = mergeOverrides({ tracks: [], topics: [] }, { tracks: [{ artist: 'Vader', title: 'Wings', start: 90 }] });
  assert.deepEqual(next.tracks, [{ artist: 'Vader', title: 'Wings', start: 90 }]);
});

test('nadpisuje pasującą poprawkę zamiast dublować', () => {
  const previous = { tracks: [{ artist: 'Vader', title: 'Wings', start: 90 }], topics: [] };
  const next = mergeOverrides(previous, { tracks: [{ artist: 'vader ', title: 'wings', start: 95 }] });
  assert.equal(next.tracks.length, 1);
  assert.equal(next.tracks[0].start, 95);
});

test('zachowuje poprzednie poprawki przy zapisie innego utworu', () => {
  const previous = { tracks: [{ artist: 'Vader', title: 'Wings', start: 90 }], topics: [{ time: 0, label: 'Wstęp', start: 5 }] };
  const next = mergeOverrides(previous, { tracks: [{ artist: 'Behemoth', title: 'Chant', start: 310 }] });
  assert.equal(next.tracks.length, 2);
  assert.deepEqual(
    next.tracks.map((track) => track.artist),
    ['Vader', 'Behemoth']
  );
  assert.equal(next.topics.length, 1);
});

test('wyczyszczone pole (null) znika z poprawki', () => {
  const next = mergeOverrides({ tracks: [], topics: [] }, { tracks: [{ artist: 'Vader', title: 'Wings', album: null }] });
  assert.deepEqual(next.tracks[0], { artist: 'Vader', title: 'Wings' });
  assert.deepEqual(compact({ album: '', other: null, start: 1 }), { album: '', start: 1 });
});

test('puste poprawki kasują plik, bo nie ma czego trzymać', () => {
  assert.equal(isEmptyOverrides(mergeOverrides({ tracks: [], topics: [] }, {})), true);
  assert.equal(isEmptyOverrides(mergeOverrides({ tracks: [], topics: [] }, { tracks: [{ artist: 'A', title: 'B' }] })), false);
});

test('widok efektywny nakłada nazwy, czasy i ukrycie', () => {
  const override = {
    tracks: [
      { artist: 'Vader', title: 'Wings', start: 95, end: 195, newArtist: 'Vader (PL)', newTitle: 'Wings of Death' },
      { artist: 'Behemoth', title: 'Chant', hide: true },
    ],
  };
  const result = applyOverrides(episode(), override);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].artist, 'Vader (PL)');
  assert.equal(result.tracks[0].title, 'Wings of Death');
  assert.equal(result.tracks[0].start, 95);
  assert.equal(result.tracks[0].end, 195);
  assert.equal(result.tracks[0]._index, 0);
});

test('widok efektywny nie rusza oryginalnego odcinka', () => {
  const source = episode();
  applyOverrides(source, { tracks: [{ artist: 'Vader', title: 'Wings', start: 1 }] });
  assert.equal(source.tracks[0].start, 100);
});

test('walidacja odrzuca zły identyfikator i przyjmuje poprawny payload', () => {
  assert.match(validateSavePayload({ id: 'nie-uuid' }), /id odcinka/);
  assert.match(validateSavePayload({ id: '216a8fd5-1292-4951-bbea-8ebbbebbb063', tracks: {} }), /tracks musi być tablicą/);
  assert.equal(
    validateSavePayload({ id: '216a8fd5-1292-4951-bbea-8ebbbebbb063', tracks: [{ artist: 'A', title: 'B', start: 1 }] }),
    null
  );
});

test('walidacja poprawek łapie koniec przed początkiem i wyjście poza nagranie', () => {
  const base = { version: 1, tracks: [], addTracks: [], topics: [], addTopics: [] };
  assert.deepEqual(validateOverride(base, { durationSec: 6893 }), []);

  const reversed = [{ start: 100, end: 90 }];
  assert.match(validateTrackTimes(reversed, { durationSec: 6893 }).join(' '), /koniec musi być po początku/);

  const beyond = { ...base, tracks: [{ artist: 'A', title: 'B', start: 9999 }] };
  assert.match(validateOverride(beyond, { durationSec: 6893 }).join(' '), /poza nagranie/);

  const missingStart = { ...base, addTracks: [{ artist: 'A', title: 'B' }] };
  assert.match(validateOverride(missingStart, { durationSec: 100 }).join(' '), /addTracks\[0\]\.start jest wymagany/);
});

test('walidacja poprawek toleruje różnicę skali nagłówka mp3', () => {
  const override = { version: 1, tracks: [{ artist: 'A', title: 'B', start: 6900 }], addTracks: [], topics: [], addTopics: [] };
  assert.deepEqual(validateOverride(override, { durationSec: 6893 }), []);
});

test('granice efektywnych utworów łapią koniec przed początkiem z samej poprawki', () => {
  const episode = { tracks: [{ artist: 'A', title: 'B', start: 71, end: 200, _index: 0 }], topics: [], quotes: [], credits: [] };
  const override = { version: 1, tracks: [{ artist: 'A', title: 'B', end: 1 }], addTracks: [], topics: [], addTopics: [] };
  assert.deepEqual(validateOverride(override, { durationSec: 6893 }), []);
  const effective = applyOverrides(episode, override);
  assert.match(validateTrackTimes(effective.tracks, { durationSec: 6893 }).join(' '), /koniec musi być po początku/);
});

test('granice efektywnych utworów pomijają ukryte wiersze', () => {
  const tracks = [{ start: 100, end: 90, hide: true }];
  assert.deepEqual(validateTrackTimes(tracks, { durationSec: 500 }), []);
});
