// iPhone photos arrive as HEIC, which only Safari can render in an <img>.
// A check-in photo saved as .heic showed as a broken tile in Chrome, so
// uploads are converted to JPEG before they're stored, and HEIC files that
// are already stored are converted in the browser when shown.
//
// Decoding tries the browser's own decoder first (Safari and the iPhone app
// have one), then falls back to heic-to (libheif compiled to wasm, ~3 MB),
// which is only fetched the first time a HEIC actually needs it.

const HEIC_EXTS = new Set(['heic', 'heif']);
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

// iOS Safari refuses to draw a canvas over ~16.7M pixels, and a 24/48 MP
// iPhone photo is bigger than that. 4032 is the long edge of a standard
// 12 MP iPhone shot — plenty for a vehicle photo.
export const MAX_EDGE = 4032;
const JPEG_QUALITY = 0.9;

export function isHeicName(name: string | null | undefined): boolean {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  return HEIC_EXTS.has(ext);
}

export function isHeicFile(file: { name: string; type: string }): boolean {
  return HEIC_TYPES.has((file.type || '').toLowerCase()) || isHeicName(file.name);
}

/** "IMG_1234.HEIC" → "IMG_1234.jpg" (a name with no extension gains one). */
export function jpegName(name: string): string {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return `${base || 'photo'}.jpg`;
}

/** Scale (w, h) down so neither side exceeds maxEdge; never scales up. */
export function fitWithin(w: number, h: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

async function nativeToJpeg(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('JPEG encode failed'))), 'image/jpeg', JPEG_QUALITY));
  } finally {
    bitmap.close();
  }
}

async function libheifToJpeg(blob: Blob): Promise<Blob> {
  const { heicTo } = await import('heic-to');
  return heicTo({ blob, type: 'image/jpeg', quality: JPEG_QUALITY });
}

/** Decode a HEIC blob to JPEG. Throws when neither decoder can read it. */
export async function heicBlobToJpeg(blob: Blob, { tryNative = true } = {}): Promise<Blob> {
  if (tryNative) {
    try {
      return await nativeToJpeg(blob);
    } catch {
      // No built-in HEIC decoder (Chrome, Firefox) — fall through to libheif.
    }
  }
  return libheifToJpeg(blob);
}

/**
 * The file to upload in place of `file`: a JPEG copy when it's HEIC, the
 * same file otherwise. A HEIC that can't be decoded is returned unchanged,
 * so a conversion failure never blocks the upload (Safari can still show it).
 */
export async function toJpegIfHeic(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;
  try {
    const jpeg = await heicBlobToJpeg(file);
    return new File([jpeg], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch (err) {
    console.warn('[heic] could not convert to JPEG, uploading the original:', err);
    return file;
  }
}
