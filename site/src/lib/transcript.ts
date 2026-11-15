import type { Transcript } from './schema';

export interface TranscriptParagraph {
  start: number;
  text: string;
}

// Akapity powstają z segmentów Whispera: przerwa w mowie albo zbyt długi blok
// zamyka akapit. Bez tego cały odcinek byłby jednym blokiem tekstu.
const PAUSE_SEC = 2;
const MAX_PARAGRAPH_CHARS = 700;

export const transcriptParagraphs = (transcript: Transcript | undefined): TranscriptParagraph[] => {
  if (!transcript) return [];
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;
  let previousEnd = 0;

  for (const segment of transcript.segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const startsNew =
      current === null ||
      segment.start - previousEnd > PAUSE_SEC ||
      current.text.length + text.length > MAX_PARAGRAPH_CHARS;

    if (startsNew) {
      if (current) paragraphs.push(current);
      current = { start: segment.start, text };
    } else {
      current.text = `${current.text} ${text}`;
    }
    previousEnd = segment.end;
  }

  if (current) paragraphs.push(current);
  return paragraphs;
};
