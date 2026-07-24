export const DOCUMENT_SIZE_LIMIT_ERROR_CODE = 'DOCUMENT_SIZE_LIMIT_EXCEEDED';

export class DocumentSizeLimitError extends Error {
  readonly code = DOCUMENT_SIZE_LIMIT_ERROR_CODE;

  constructor() {
    super('Document size limit exceeded');
    this.name = 'DocumentSizeLimitError';
  }
}
