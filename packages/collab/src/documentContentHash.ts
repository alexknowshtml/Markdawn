import { createHash } from 'node:crypto';

export function getDocumentContentHash(content: Uint8Array | null): string {
  return createHash('sha256')
    .update(content ?? new Uint8Array())
    .digest('hex');
}
