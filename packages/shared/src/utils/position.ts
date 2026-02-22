const POSITION_GAP = 1024;

export function generatePosition(previous?: number | null, next?: number | null) {
  const safePrev = typeof previous === "number" ? previous : null;
  const safeNext = typeof next === "number" ? next : null;

  if (safePrev === null && safeNext === null) {
    return 0;
  }

  if (safePrev === null && safeNext !== null) {
    return safeNext - POSITION_GAP;
  }

  if (safeNext === null && safePrev !== null) {
    return safePrev + POSITION_GAP;
  }

  if (safePrev !== null && safeNext !== null && safePrev === safeNext) {
    return safePrev + 0.1;
  }

  if (safePrev !== null && safeNext !== null) {
    return (safePrev + safeNext) / 2;
  }

  return 0;
}
