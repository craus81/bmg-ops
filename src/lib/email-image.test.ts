import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { shrinkImageForEmail, EMAIL_IMAGE_MAX_PX } from './email-image';

// Random noise doesn't compress, so the input is camera-photo heavy.
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

describe('shrinkImageForEmail', () => {
  it('resizes a camera-size JPEG to the email limit and keeps it a JPEG', async () => {
    const big = await noisyJpeg(4000, 3000);
    const out = await shrinkImageForEmail(big, 'image/jpeg');
    expect(out.shrunk).toBe(true);
    expect(out.contentType).toBe('image/jpeg');
    expect(out.bytes.byteLength).toBeLessThan(big.byteLength);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(EMAIL_IMAGE_MAX_PX);
  });

  it('leaves small images, non-images and unreadable bytes untouched', async () => {
    const small = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await shrinkImageForEmail(small, 'image/png')).bytes).toBe(small);
    const pdf = Buffer.alloc(400 * 1024, 1);
    expect((await shrinkImageForEmail(pdf, 'application/pdf')).shrunk).toBe(false);
    const junk = Buffer.alloc(400 * 1024, 7);
    const out = await shrinkImageForEmail(junk, 'image/jpeg');
    expect(out.shrunk).toBe(false);
    expect(out.bytes).toBe(junk);
  });
});
