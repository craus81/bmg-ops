/**
 * Shrink pictures before they go into a customer email or the estimate PDF.
 *
 * Proof photos and coverage pictures were embedded at full camera size
 * (pdf-lib embeds bytes as-is), so an estimate approval email ran 5–12 MB.
 * Mail filters at customer companies quarantine messages that size from
 * senders they don't know, and Resend still reports them "Delivered" — the
 * estimate just never reaches the inbox. 1600 px on the long side is still
 * sharp on a full letter page and on a phone, at a small fraction of the
 * bytes.
 *
 * A photo or screenshot saved as PNG is the other half of the weight: PNG
 * is lossless, so a 1600 px photo stays 1–3 MB however hard it is
 * compressed, where the same picture as a JPEG is 100–300 KB. Such a PNG
 * goes out as a JPEG (its filename gets .jpg — emailImageFilename). Flat
 * line art, which PNG already packs tightly, stays a PNG.
 *
 * Best-effort by design: anything sharp can't read (or a result that isn't
 * smaller) returns the original bytes untouched, so a shrink can never
 * cost the customer an image.
 */
import sharp from 'sharp';

export const EMAIL_IMAGE_MAX_PX = 1600;
const JPEG_QUALITY = 80;
// Below this an image at full email size is already email-friendly;
// re-encoding it would only cost quality. The bar scales down with maxPx:
// a 600 px thumbnail is "small enough" at a fraction of the bytes.
const SKIP_UNDER_BYTES = 300 * 1024;
// A PNG becomes a JPEG only when that saves more than half its bytes: true
// of a photo or a screenshot of one (PNG stores those 5–10× bigger), never
// of flat drawings and text, which JPEG would only smudge for no gain.
const PNG_TO_JPEG_RATIO = 0.5;

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
 * The filename an attachment should carry once shrunk: a PNG that went
 * out as a JPEG gets a .jpg extension so the name stays honest to what a
 * mail client will open.
 */
export function emailImageFilename(filename: string, contentType: string): string {
  if (!isJpeg(contentType) || /\.jpe?g$/i.test(filename)) return filename;
  return /\.png$/i.test(filename) ? filename.replace(/\.png$/i, '.jpg') : `${filename}.jpg`;
}

/**
 * Resize to maxPx (default EMAIL_IMAGE_MAX_PX) on the long side. JPEGs are
 * re-encoded at quality 80; camera orientation is applied first so a
 * portrait photo doesn't come out sideways once the EXIF tag is dropped.
 * A PNG stays a PNG unless JPEG is far smaller (see PNG_TO_JPEG_RATIO), in
 * which case the result's contentType is image/jpeg and any transparent
 * area is laid on white, as it would show on the page.
 */
export async function shrinkImageForEmail(
  bytes: Buffer,
  contentType: string,
  maxPx: number = EMAIL_IMAGE_MAX_PX,
): Promise<ShrunkImage> {
  const original: ShrunkImage = { bytes, contentType, shrunk: false };
  const skipUnder = Math.round(SKIP_UNDER_BYTES * Math.min(1, (maxPx / EMAIL_IMAGE_MAX_PX) ** 2));
  if (!isShrinkableImage(contentType) || bytes.byteLength < skipUnder) return original;
  try {
    const resized = sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true });
    let out: ShrunkImage;
    if (isJpeg(contentType)) {
      out = { bytes: await resized.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer(), contentType, shrunk: true };
    } else {
      const png = await resized.clone().png({ compressionLevel: 9 }).toBuffer();
      out = { bytes: png, contentType, shrunk: true };
      if (png.byteLength >= skipUnder) {
        const jpeg = await resized.clone().flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
        if (jpeg.byteLength < png.byteLength * PNG_TO_JPEG_RATIO) out = { bytes: jpeg, contentType: 'image/jpeg', shrunk: true };
      }
    }
    if (out.bytes.byteLength >= bytes.byteLength) return original;
    return out;
  } catch (err: any) {
    console.warn('[email-image] shrink failed, sending original:', err?.message || err);
    return original;
  }
}
