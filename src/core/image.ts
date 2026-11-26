// Reads an image's real format and size from its first bytes, so what we store
// and serve is decided by the file itself, not by its URL or content type.

export type ImageFormat = 'jpg' | 'png';

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

/** TikTok rejects images below this on either side ("Image is less than 500x500"). */
export const MIN_IMAGE_PX = 500;

export const IMAGE_CONTENT_TYPES: Record<ImageFormat, string> = { jpg: 'image/jpeg', png: 'image/png' };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// 'IHDR', the chunk a PNG must start with; it holds the size.
const IHDR = [0x49, 0x48, 0x44, 0x52];

function hasBytes(bytes: Uint8Array, at: number, expected: readonly number[]): boolean {
  return expected.every((b, i) => bytes[at + i] === b);
}

function sniffPng(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 24 || !hasBytes(bytes, 12, IHDR)) return null;
  return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

function sniffJpeg(bytes: Uint8Array, view: DataView): ImageInfo | null {
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Padding before a marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    at += 2;
    // Markers with no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image or start of scan, before any size.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > bytes.length) return null;
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (at + 7 > bytes.length) return null;
      return { format: 'jpg', height: view.getUint16(at + 3), width: view.getUint16(at + 5) };
    }
    at += view.getUint16(at);
  }
  return null;
}

/** The file's format and size, or null when it isn't a readable JPG or PNG. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = hasBytes(bytes, 0, PNG_SIGNATURE) ? sniffPng(bytes, view) : hasBytes(bytes, 0, [0xff, 0xd8]) ? sniffJpeg(bytes, view) : null;
  return info && info.width > 0 && info.height > 0 ? info : null;
}
