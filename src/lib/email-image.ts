/**
 * Shrink photos before they go into a customer email or the estimate PDF.
 *
 * Proof photos and coverage pictures were embedded at full camera size
 * (pdf-lib embeds bytes as-is), so an estimate approval email ran 5–12 MB.
 * Mail filters at customer companies quarantine messages that size from
 * senders they don't know, and Resend still reports them "Delivered" — the
 * estimate just never reaches the inbox. 1600 px on the long side is still
 * sharp on a full letter page and on a phone, at a small fraction of the
 * bytes.
 *
 * Best-effort by design: anything sharp can't read (or a result that isn't
 * smaller) returns the original bytes untouched, so a shrink can never
 * cost the customer an image.
 */
import sharp from 'sharp';

export const EMAIL_IMAGE_MAX_PX = 1600;
const JPEG_QUALITY = 80;
// Below this an image is already email-friendly; re-encoding it would only
// cost quality.
const SKIP_UNDER_BYTES = 300 * 1024;

export interface ShrunkImage {
  bytes: Buffer;
  contentType: string;
  shrunk: boolean;
}

function isJpeg(contentType: string): boolean {
  return /jpe?g/i.test(contentType);
}

function isPng(contentType: string): boolean {
  return /png/i.test(contentType);
}

/** True for the image types shrinkImageForEmail handles. */
export function isShrinkableImage(contentType: string | null | undefined): boolean {
  const t = contentType || '';
  return isJpeg(t) || isPng(t);
}

/**
 * Resize to maxPx (default EMAIL_IMAGE_MAX_PX) on the long side, keeping the format (a
 * .png attachment stays a PNG, so its filename stays honest). JPEGs are
 * re-encoded at quality 80; camera orientation is applied first so a
 * portrait photo doesn't come out sideways once the EXIF tag is dropped.
 */
export async function shrinkImageForEmail(
  bytes: Buffer,
  contentType: string,
  maxPx: number = EMAIL_IMAGE_MAX_PX,
): Promise<ShrunkImage> {
  const original: ShrunkImage = { bytes, contentType, shrunk: false };
  if (!isShrinkableImage(contentType) || bytes.byteLength < SKIP_UNDER_BYTES) return original;
  try {
    const pipeline = sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true });
    const out = isJpeg(contentType)
      ? await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (out.byteLength >= bytes.byteLength) return original;
    return { bytes: out, contentType, shrunk: true };
  } catch (err: any) {
    console.warn('[email-image] shrink failed, sending original:', err?.message || err);
    return original;
  }
}
