export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

export type SafeImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const IMAGE_EXTENSION_BY_MIME = new Map<SafeImageType, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, SafeImageType>([
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

export const safeImageMimeForExtension = (extension: string): SafeImageType | null =>
  IMAGE_MIME_BY_EXTENSION.get(extension.toLowerCase()) ?? null;

export const isSafeImageMime = (value: string): value is SafeImageType =>
  IMAGE_EXTENSION_BY_MIME.has(value as SafeImageType);

export const hasValidImageSignature = (buffer: Buffer, mimeType: SafeImageType): boolean => {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimeType === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  if (mimeType === 'image/gif') {
    const signature = buffer.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }

  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
};
