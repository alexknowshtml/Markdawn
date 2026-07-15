import { HTTPException } from 'hono/http-exception';

const DECIMAL_POSITION = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_POSITION_LENGTH = 128;

export const INVALID_POSITION_CODE = 'INVALID_POSITION';

export function normalizePosition(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;

  const normalized =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (
    normalized.length > 0 &&
    normalized.length <= MAX_POSITION_LENGTH &&
    DECIMAL_POSITION.test(normalized) &&
    Number.isFinite(Number(normalized))
  ) {
    return normalized;
  }

  throw new HTTPException(400, {
    message: 'Position must be a finite decimal number',
    cause: { code: INVALID_POSITION_CODE },
  });
}
