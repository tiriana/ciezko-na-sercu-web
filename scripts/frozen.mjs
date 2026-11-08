import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Odcinki z co najmniej jednym znacznikiem oznaczonym w edytorze jako „ok” są
 * nietykalne dla automatów. Redakcja już je przejrzała, więc maszynowa korekta
 * (przyciąganie końców do transkryptu, dopasowanie tematów) tylko by je psuła.
 */
export const frozenEpisodes = (root = process.cwd()) => {
  let file;
  try {
    file = JSON.parse(readFileSync(join(root, 'data', 'reviewed.json'), 'utf8'));
  } catch {
    return new Set();
  }
  return new Set(
    Object.entries(file.episodes ?? {})
      .filter(([, marks]) => marks && Object.keys(marks).length > 0)
      .map(([id]) => id)
  );
};
