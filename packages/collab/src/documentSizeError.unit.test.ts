import { describe, expect, it } from 'vitest';
import { DOCUMENT_SIZE_LIMIT_ERROR_CODE, DocumentSizeLimitError } from './documentSizeError';

describe('DocumentSizeLimitError', () => {
  it('exposes a stable identifier independent of its message', () => {
    const error = new DocumentSizeLimitError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DocumentSizeLimitError');
    expect(error.code).toBe(DOCUMENT_SIZE_LIMIT_ERROR_CODE);
  });
});
