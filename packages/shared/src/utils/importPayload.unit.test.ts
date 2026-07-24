import { describe, expect, it } from 'vitest';
import { parseMarkdownImportResult } from './importPayload';

describe('parseMarkdownImportResult', () => {
  it('parses the JSON-safe import result and discards undeclared page fields', () => {
    expect(
      parseMarkdownImportResult({
        page: { id: 'page-1', title: 'Imported note', createdAt: '2026-01-01T00:00:00.000Z' },
        warnings: [
          {
            code: 'LOCAL_IMAGES_NOT_IMPORTED',
            count: 2,
            message: 'Two images were not imported',
          },
        ],
      }),
    ).toEqual({
      page: { id: 'page-1', title: 'Imported note' },
      warnings: [
        {
          code: 'LOCAL_IMAGES_NOT_IMPORTED',
          count: 2,
          message: 'Two images were not imported',
        },
      ],
    });
  });

  it.each([
    null,
    { page: { id: 'page-1' }, warnings: [] },
    { page: { id: 'page-1', title: 'Imported note' }, warnings: null },
    {
      page: { id: 'page-1', title: 'Imported note' },
      warnings: [{ code: 'LOCAL_IMAGES_NOT_IMPORTED', count: 0, message: 'Invalid count' }],
    },
  ])('rejects malformed payloads', (value) => {
    expect(() => parseMarkdownImportResult(value)).toThrow('Invalid markdown import response');
  });
});
