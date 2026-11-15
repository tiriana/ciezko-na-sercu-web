import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aliasCandidates,
  aliasProblems,
  collectLabels,
  normalizeAliasFile,
  resolveAlias,
  tagRows,
} from './aliases.mjs';

const tag = (label, type, extra = {}) => ({ id: label.toLowerCase(), label, type, source: 'tracks', ...extra });

test('alias idzie łańcuchem, ale kończy na powtórzeniu', () => {
  const aliases = { A: 'B', B: 'C', C: 'C' };
  assert.equal(resolveAlias('A', aliases), 'C');
  assert.equal(resolveAlias('D', aliases), 'D');
});

test('etykiety biorą tagi (po podziale) i creditsy jako osoby', () => {
  const labels = collectLabels([
    {
      id: 'e1',
      tags: [tag('BABYMETAL & Poppy', 'artist'), tag('BABYMETAL', 'artist')],
      credits: [{ name: 'Jarek Szubrycht', role: 'prowadzenie' }],
    },
  ]);
  assert.deepEqual([...labels.keys()].sort(), ['BABYMETAL', 'Jarek Szubrycht', 'Poppy']);
  assert.equal(labels.get('BABYMETAL').episodes.size, 1);
  assert.equal(labels.get('Jarek Szubrycht').type, 'person');
});

test('kandydat musi być całym słowem i wystarczająco dłuższy', () => {
  const labels = collectLabels([
    { id: 'e1', tags: [], credits: [{ name: 'Michał', role: 'x' }, { name: 'Michał Kowarski', role: 'x' }, { name: 'Michałek', role: 'x' }] },
  ]);
  assert.deepEqual(aliasCandidates(labels, {}, []), [{ from: 'Michał', to: 'Michał Kowarski' }]);
});

test('pominięta para i już istniejący alias nie wracają jako kandydaci', () => {
  const labels = collectLabels([
    { id: 'e1', tags: [], credits: [{ name: 'Vogg', role: 'x' }, { name: 'Wacław "Vogg" Kiełtyka', role: 'x' }] },
  ]);
  const dismissed = [{ from: 'Vogg', to: 'Wacław "Vogg" Kiełtyka' }];
  assert.deepEqual(aliasCandidates(labels, {}, dismissed), []);
  assert.deepEqual(aliasCandidates(labels, { Vogg: 'Wacław "Vogg" Kiełtyka' }, []), []);
});

test('alias na samego siebie i pętla to błędy, nieistniejący cel już nie', () => {
  assert.deepEqual(aliasProblems({ Roadburn: 'Roadburn' }), ['Roadburn: alias wskazuje sam na siebie']);
  assert.deepEqual(aliasProblems({ A: 'B', B: 'A' }), [
    'A → B: łańcuch aliasów tworzy pętlę',
    'B → A: łańcuch aliasów tworzy pętlę',
  ]);
  assert.deepEqual(aliasProblems({ Marko: 'Marko Laiho' }), []);
});

test('typ idzie za etykietą kanoniczną, a lista jest po polsku', () => {
  const labels = collectLabels([
    { id: 'e1', tags: [tag('Łukasz', 'person'), tag('Alien', 'work')], credits: [] },
  ]);
  const file = { aliases: { Łukasz: 'Łukasz Orbitowski' }, types: { 'Łukasz Orbitowski': 'artist' }, dismissed: [] };
  labels.set('Łukasz Orbitowski', { label: 'Łukasz Orbitowski', type: 'person', episodes: new Set(['e1']) });
  const rows = tagRows(labels, file);
  assert.deepEqual(rows.map((row) => row.label), ['Alien', 'Łukasz', 'Łukasz Orbitowski']);
  assert.equal(rows[1].canonical, 'Łukasz Orbitowski');
  assert.equal(rows[1].type, 'artist');
  assert.equal(rows[1].originalType, 'person');
});

test('zapis pliku czyści spacery, puste pary i nieznane typy', () => {
  const file = normalizeAliasFile({
    aliases: { ' Vogg ': 'Wacław "Vogg" Kiełtyka', Same: ' Same ', Puste: '   ' },
    types: { Roadburn: 'event', Błąd: 'nie-ma-takiego' },
    dismissed: [{ from: ' A ', to: ' B ' }, { from: 'X', to: 'X' }, { from: '', to: 'Y' }],
  });
  assert.deepEqual(file, {
    version: 1,
    aliases: { Vogg: 'Wacław "Vogg" Kiełtyka' },
    types: { Roadburn: 'event' },
    dismissed: [{ from: 'A', to: 'B' }],
  });
});
