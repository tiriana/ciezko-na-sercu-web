/**
 * Tytuł techniczny to ten, który serwis nadaje automatycznie przy publikacji:
 * „Ciężko na sercu 11 listopada godz. 00:06”. Redakcja podmienia go później
 * na własny, więc dopóki tego nie zrobi, nie mamy od nich żadnej informacji
 * o treści odcinka.
 */
const PROGRAM = /ci[ęe]żko na serc[uae]/i;

export const isTechnicalTitle = (title: string): boolean => {
  const text = (title ?? '').trim();
  if (!PROGRAM.test(text)) return false;
  if (/\bgodz\.?\s*\d{2}[.:]?\d{2}\b/i.test(text)) return true;
  // Sam program i data, bez godziny — też techniczny.
  return /^ci[ęe]żko na serc[uae]\s+\d{1,2}\s+\S+$/i.test(text);
};

/** Wersja dla skryptów działających na tytułach bez czasu (np. „Ciężko na sercu”). */
export const looksLikeProgramName = (title: string): boolean => PROGRAM.test(title ?? '');
