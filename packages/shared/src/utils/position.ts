const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
const MID_CHAR = ALPHABET[Math.floor(BASE / 2)] ?? '0';

const indexOfChar = (char: string) => {
  const index = ALPHABET.indexOf(char);
  if (index === -1) {
    throw new Error(`Invalid position character: ${char}`);
  }
  return index;
};

const midpointBetween = (previous: string, next: string) => {
  if (!previous && !next) {
    return MID_CHAR;
  }

  if (previous && next && previous >= next) {
    return `${previous}${MID_CHAR}`;
  }

  // Special case: inserting before the first item (previous is empty)
  if (!previous && next) {
    // Find a position that sorts before next
    let result = '';
    let index = 0;
    while (true) {
      const rightDigit = index < next.length ? indexOfChar(next[index] ?? '') : BASE;

      if (rightDigit > 0) {
        const midDigit = Math.floor(rightDigit / 2);
        return `${result}${ALPHABET[midDigit]}`;
      }

      result += next[index] ?? ALPHABET[0];
      index += 1;
    }
  }

  // Normal case: between two positions
  let result = '';
  let index = 0;

  while (true) {
    const leftDigit = index < previous.length ? indexOfChar(previous[index] ?? '') : -1;
    const rightDigit = index < next.length ? indexOfChar(next[index] ?? '') : BASE;

    if (rightDigit - leftDigit > 1) {
      const midDigit = Math.floor((leftDigit + rightDigit) / 2);
      return `${result}${ALPHABET[midDigit]}`;
    }

    result += index < previous.length ? previous[index] : ALPHABET[0];
    index += 1;
  }
};

export function generatePosition(previous?: string | null, next?: string | null) {
  const safePrev = typeof previous === 'string' && previous.length > 0 ? previous : null;
  const safeNext = typeof next === 'string' && next.length > 0 ? next : null;

  if (!safePrev && !safeNext) {
    return MID_CHAR;
  }

  if (!safePrev && safeNext) {
    return midpointBetween('', safeNext);
  }

  if (safePrev && !safeNext) {
    return `${safePrev}${MID_CHAR}`;
  }

  if (!safePrev || !safeNext) {
    return MID_CHAR;
  }
  return midpointBetween(safePrev, safeNext);
}
