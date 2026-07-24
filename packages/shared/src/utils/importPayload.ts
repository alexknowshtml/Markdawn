import type { MarkdownImportResult, MarkdownImportWarning } from '../types/import.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWarning(value: unknown): MarkdownImportWarning {
  if (!isRecord(value)) throw new Error('Invalid markdown import response');
  if (
    value.code !== 'LOCAL_IMAGES_NOT_IMPORTED' ||
    typeof value.count !== 'number' ||
    !Number.isInteger(value.count) ||
    value.count < 1 ||
    typeof value.message !== 'string'
  ) {
    throw new Error('Invalid markdown import response');
  }
  return {
    code: value.code,
    count: value.count,
    message: value.message,
  };
}

export function parseMarkdownImportResult(value: unknown): MarkdownImportResult {
  if (!isRecord(value) || !isRecord(value.page) || !Array.isArray(value.warnings)) {
    throw new Error('Invalid markdown import response');
  }
  if (typeof value.page.id !== 'string' || typeof value.page.title !== 'string') {
    throw new Error('Invalid markdown import response');
  }
  return {
    page: { id: value.page.id, title: value.page.title },
    warnings: value.warnings.map(parseWarning),
  };
}
