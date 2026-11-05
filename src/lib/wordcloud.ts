export interface CloudWord {
  id: string;
  label: string;
  count: number;
  type: string;
}

export interface PlacedWord extends CloudWord {
  x: number;
  y: number;
  size: number;
  rotate: boolean;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const intersects = (a: Box, b: Box): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Deterministyczny generator, żeby układ nie drgał między buildami. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Układa chmurę tagów: najczęstsze największe, w spirali od środka, bez nakładania.
 * Szerokość tekstu szacowana z liczby znaków — wystarcza, bo SVG skaluje się do kontenera.
 */
export function layoutCloud(
  words: CloudWord[],
  options: { width?: number; height?: number; minSize?: number; maxSize?: number; seed?: number } = {}
): { placed: PlacedWord[]; width: number; height: number } {
  const width = options.width ?? 1000;
  const height = options.height ?? 460;
  const minSize = options.minSize ?? 13;
  const maxSize = options.maxSize ?? 62;
  const next = random(options.seed ?? 20261105);

  const sorted = [...words].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'pl'));
  const maxCount = sorted[0]?.count ?? 1;
  const minCount = sorted[sorted.length - 1]?.count ?? 1;
  const spread = Math.max(1, maxCount - minCount);

  const boxes: Box[] = [];
  const placed: PlacedWord[] = [];
  const centerX = width / 2;
  const centerY = height / 2;

  for (const word of sorted) {
    // Pierwiastek z częstości: różnice są widoczne, ale rzadkie tagi nie znikają.
    const ratio = (Math.sqrt(word.count) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount) || 1);
    const size = Math.round(minSize + ratio * (maxSize - minSize));
    const rotate = word.count < maxCount * 0.5 && next() < 0.28;
    const textWidth = word.label.length * size * (rotate ? 0.62 : 0.56);
    const textHeight = size * 1.05;
    const boxWidth = rotate ? textHeight : textWidth;
    const boxHeight = rotate ? textWidth : textHeight;

    let spot: { x: number; y: number } | null = null;
    const step = Math.max(6, size * 0.35);
    for (let radius = 0; radius < Math.max(width, height) && !spot; radius += step) {
      const turns = Math.max(6, Math.round(radius / 4));
      for (let turn = 0; turn < turns && !spot; turn++) {
        const angle = (turn / turns) * Math.PI * 2 + radius * 0.15;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius * 0.62;
        const box: Box = {
          left: x - boxWidth / 2,
          top: y - boxHeight / 2,
          right: x + boxWidth / 2,
          bottom: y + boxHeight / 2,
        };
        if (box.left < 4 || box.right > width - 4 || box.top < 4 || box.bottom > height - 4) continue;
        if (boxes.some((other) => intersects(box, other))) continue;
        boxes.push(box);
        spot = { x, y };
      }
    }

    // Gdy zabraknie miejsca, pomijamy najdalsze tagi — chmura ma zostać czytelna.
    if (!spot) continue;
    placed.push({ ...word, x: Math.round(spot.x), y: Math.round(spot.y), size, rotate });
  }

  return { placed, width, height };
}
