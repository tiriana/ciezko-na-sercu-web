// Wspólna logika poprawek (`data/overrides/<id>.json`): walidacja payloadu edytora,
// scalanie z poprzednimi poprawkami i widok efektywny. Ten sam plik importuje serwer
// lokalny (Node) i edytor w przeglądarce, więc musi być czystym ES modulem bez I/O.

export const normalize = (value) => (value ?? '').normalize('NFC').trim().toLowerCase();

export const same = (left, right) => right === undefined || normalize(left) === normalize(right);

export const validateSavePayload = (payload) => {
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value) => typeof value === 'string';
  const optionalString = (value) => value === undefined || value === null || string(value);
  const optionalNumber = (value) => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
  const optionalBoolean = (value) => value === undefined || typeof value === 'boolean';
  const array = (value) => value === undefined || Array.isArray(value);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!record(payload)) return 'treść musi być obiektem JSON';
  if (typeof payload.id !== 'string' || !uuid.test(payload.id)) return 'id odcinka ma nieprawidłowy format';
  if (!optionalString(payload.title)) return 'title musi być tekstem';
  for (const key of ['tracks', 'topics', 'addTracks', 'addTopics']) {
    if (!array(payload[key])) return `${key} musi być tablicą`;
  }
  for (const [index, track] of (payload.tracks ?? []).entries()) {
    if (!record(track)) return `tracks[${index}] musi być obiektem`;
    for (const field of ['artist', 'title', 'newArtist', 'newTitle', 'album', 'newAlbum']) {
      if (!optionalString(track[field])) return `tracks[${index}].${field} musi być tekstem`;
    }
    for (const field of ['start', 'durationSec', 'end']) {
      if (!optionalNumber(track[field])) return `tracks[${index}].${field} musi być liczbą`;
    }
    if (!optionalBoolean(track.hide)) return `tracks[${index}].hide musi być wartością logiczną`;
  }
  for (const [index, topic] of (payload.topics ?? []).entries()) {
    if (!record(topic)) return `topics[${index}] musi być obiektem`;
    if (typeof topic.label !== 'string') return `topics[${index}].label musi być tekstem`;
    if (typeof topic.time !== 'number' || !Number.isFinite(topic.time)) return `topics[${index}].time musi być liczbą`;
    for (const field of ['time', 'start', 'end']) {
      if (!optionalNumber(topic[field])) return `topics[${index}].${field} musi być liczbą`;
    }
    if (!optionalString(topic.newLabel)) return `topics[${index}].newLabel musi być tekstem`;
    if (!optionalBoolean(topic.hide)) return `topics[${index}].hide musi być wartością logiczną`;
  }
  for (const [index, track] of (payload.addTracks ?? []).entries()) {
    if (!record(track)) return `addTracks[${index}] musi być obiektem`;
    if (!string(track.artist) || !string(track.title)) return `addTracks[${index}] wymaga tekstowych pól artist i title`;
    if (!optionalString(track.album)) return `addTracks[${index}].album musi być tekstem`;
    if (typeof track.start !== 'number' || !Number.isFinite(track.start)) return `addTracks[${index}].start musi być liczbą`;
    if (!optionalNumber(track.durationSec)) return `addTracks[${index}].durationSec musi być liczbą`;
    if (!optionalBoolean(track.unrecognized)) return `addTracks[${index}].unrecognized musi być wartością logiczną`;
  }
  for (const [index, topic] of (payload.addTopics ?? []).entries()) {
    if (!record(topic)) return `addTopics[${index}] musi być obiektem`;
    if (typeof topic.label !== 'string') return `addTopics[${index}].label musi być tekstem`;
    if (typeof topic.start !== 'number' || !Number.isFinite(topic.start)) return `addTopics[${index}].start musi być liczbą`;
    if (!optionalNumber(topic.end)) return `addTopics[${index}].end musi być liczbą`;
  }
  return null;
};

const sameTrack = (left, right) =>
  normalize(left.artist) === normalize(right.artist) &&
  normalize(left.title) === normalize(right.title) &&
  normalize(left.album ?? '') === normalize(right.album ?? '');

const sameTopic = (left, right) => left.time === right.time && normalize(left.label) === normalize(right.label);

// Edytor wysyła `null`, gdy pole zostanie wyczyszczone (album bywa `null` już w danych
// odcinka), a schemat strony przyjmuje tylko tekst albo brak pola — bez tego zapis
// wywalał build.
export const compact = (fix) => Object.fromEntries(Object.entries(fix).filter(([, value]) => value !== null && value !== undefined));

/** Nowe wpisy zastępują pasujące, reszta poprzednich poprawek zostaje — inaczej zapis
 * jednego wiersza kasowałby wcześniejsze korekty. */
export const mergeOverrides = (previous, payload) => {
  const base = previous ?? { version: 1, tracks: [], topics: [], credits: { rename: {} } };
  const tracks = [...(base.tracks ?? [])];
  for (const incoming of payload.tracks ?? []) {
    const fix = compact(incoming);
    const index = tracks.findIndex((existing) => sameTrack(existing, fix));
    if (index >= 0) tracks[index] = fix;
    else tracks.push(fix);
  }
  const topics = [...(base.topics ?? [])];
  for (const incoming of payload.topics ?? []) {
    const fix = compact(incoming);
    const index = topics.findIndex((existing) => sameTopic(existing, fix));
    if (index >= 0) topics[index] = fix;
    else topics.push(fix);
  }
  return {
    version: 1,
    tracks,
    topics,
    addTracks: (payload.addTracks ?? base.addTracks ?? []).map(compact),
    addTopics: (payload.addTopics ?? base.addTopics ?? []).map(compact),
    credits: base.credits ?? { rename: {} },
  };
};

export const isEmptyOverrides = (value) =>
  value.tracks.length === 0 && value.topics.length === 0 && value.addTracks.length === 0 && value.addTopics.length === 0;

/** Wartości efektywne: to samo, co widzi strona po nałożeniu poprawek. */
export const applyOverrides = (episode, override) => {
  if (!episode) return null;
  const result = structuredClone(episode);
  // Indeks w pliku odcinka: jedyny stabilny identyfikator, bo ten sam utwór bywa
  // rozpoznany dwa razy (te same artist/title/album).
  result.tracks = result.tracks.map((track, index) => ({ ...track, _index: index }));
  for (const fix of override?.tracks ?? []) {
    const track = result.tracks.find(
      (candidate) => same(candidate.artist, fix.artist) && same(candidate.title, fix.title) && same(candidate.album, fix.album)
    );
    if (!track) continue;
    if (fix.start !== undefined) track.start = fix.start;
    if (fix.durationSec !== undefined) track.durationSec = fix.durationSec;
    // `end` podmienia granicę utworu, gdy redakcja przecięła go ręcznie (to samo pole
    // czyta site/src/lib/data.ts); bez tego edytor po przeładowaniu liczyłby koniec
    // z durationSec.
    if (fix.end !== undefined) track.end = fix.end;
    if (fix.newArtist !== undefined) track.artist = fix.newArtist;
    if (fix.newTitle !== undefined) track.title = fix.newTitle;
    if (fix.newAlbum !== undefined) track.album = fix.newAlbum;
  }
  result.tracks = result.tracks.filter(
    (track) =>
      !(override?.tracks ?? []).some(
        (fix) =>
          fix.hide &&
          same(track.artist, fix.artist) &&
          same(track.title, fix.title) &&
          same(track.album, fix.album) &&
          (fix.start === undefined || Math.abs(track.start - fix.start) < 0.01)
      )
  );
  for (const fix of override?.topics ?? []) {
    const topic = result.topics.find((candidate) => candidate.start === fix.time && same(candidate.label, fix.label));
    if (!topic) continue;
    if (fix.start !== undefined) topic.start = fix.start;
    if (fix.end !== undefined) topic.end = fix.end;
    if (fix.newLabel) topic.label = fix.newLabel;
  }
  result.topics = result.topics.filter(
    (topic) => !(override?.topics ?? []).some((fix) => fix.hide && fix.time === topic.start && same(topic.label, fix.label))
  );
  return result;
};
