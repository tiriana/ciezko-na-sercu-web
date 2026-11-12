import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitTag, splitTags } from './tags.ts';

const tag = (label, type, extra = {}) => ({ id: 'x', label, type, source: 'tracks', ...extra });

test('nazwa własna z „&” zostaje cała', () => {
  for (const label of ['Zeal & Ardor', 'Author & Punisher', 'Bohren & Der Club of Gore', 'Uncle Acid & The Deadbeats']) {
    const [only] = splitTag(tag(label, 'artist'));
    assert.equal(only.label, label);
    assert.equal(only.id, 'x');
  }
});

test('kolaboracja dzieli się na dwa zespoły z własnymi id', () => {
  const parts = splitTag(tag('BABYMETAL & Poppy', 'artist'));
  assert.deepEqual(
    parts.map((part) => [part.label, part.id]),
    [
      ['BABYMETAL', 'babymetal'],
      ['Poppy', 'poppy'],
    ]
  );
});

test('ukośnik bez spacji nie jest separatorem', () => {
  const [only] = splitTag(tag('AC/DC', 'artist'));
  assert.equal(only.label, 'AC/DC');
});

test('koncert dostaje headlinera i zachowuje prefiks id', () => {
  const [only] = splitTag(tag('Godsmack + POD + Drowning Pool', 'concert', { id: 'koncert-godsmack-pod-drowning-pool' }));
  assert.equal(only.label, 'Godsmack');
  assert.equal(only.id, 'koncert-godsmack');
});

test('koncert z polskim „i” bierze pierwszą nazwę', () => {
  const [only] = splitTag(tag('Inter Arma i Wayfarer — Kraków i Wrocław', 'concert'));
  assert.equal(only.label, 'Inter Arma');
});

test('opis koncertu z nazwą w nawiasie zostaje cały', () => {
  const label = 'Koncert 10 estońskich zespołów w klubie Taper (Tallin, Estonia)';
  const [only] = splitTag(tag(label, 'concert', { id: 'koncert-taper' }));
  assert.equal(only.label, label);
  assert.equal(only.id, 'koncert-taper');
});

test('wydarzenie rozdzielone ukośnikiem daje dwa tagi', () => {
  const parts = splitTag(tag('Rockowisko / Niezły Zwierzyniec', 'event'));
  assert.deepEqual(
    parts.map((part) => part.label),
    ['Rockowisko', 'Niezły Zwierzyniec']
  );
  assert.ok(parts.every((part) => part.type === 'event'));
});

test('duplikat po podziale zostaje scalony, a „at” z drugiego wpisu nie ginie', () => {
  const tags = splitTags([
    tag('BABYMETAL', 'artist', { id: 'babymetal' }),
    tag('BABYMETAL & Spiritbox', 'artist', { id: 'babymetal-spiritbox', at: 42 }),
  ]);
  assert.deepEqual(
    tags.map((entry) => entry.id),
    ['babymetal', 'spiritbox']
  );
  assert.equal(tags[0].at, 42);
});

test('drugi przebieg nic nie zmienia', () => {
  const once = splitTags([
    tag('BABYMETAL & Spiritbox', 'artist'),
    tag('Godsmack + POD', 'concert', { id: 'koncert-godsmack-pod' }),
    tag('Rockowisko / Niezły Zwierzyniec', 'event'),
  ]);
  assert.deepEqual(splitTags(once), once);
});
