import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { shrinkImageForEmail, emailImageFilename, EMAIL_IMAGE_MAX_PX } from './email-image';

// Random noise doesn't compress, so the input is camera-photo heavy.
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

// A photo: smooth gradients with sensor-like grain, which PNG can't pack
// (it stays near raw size) and JPEG quantises away.
function photoRaw(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grain = ((x * 2654435761 + y * 40503) >>> 24) & 15;
      raw[i] = ((x * 255) / width + grain) & 255;
      raw[i + 1] = ((y * 255) / height + grain) & 255;
      raw[i + 2] = 128 + grain;
    }
  }
  return raw;
}

// Line art: flat colour blocks with hard edges, PNG's home ground.
function flatRaw(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x % 200 < 100) !== (y % 200 < 100)) {
        const i = (y * width + x) * 3;
        raw[i] = 20; raw[i + 1] = 30; raw[i + 2] = 40;
      }
    }
  }
  return raw;
}

describe('shrinkImageForEmail', () => {
  it('sends a photo saved as PNG out as a far smaller JPEG', async () => {
    const png = await sharp(photoRaw(2400, 1800), { raw: { width: 2400, height: 1800, channels: 3 } }).png().toBuffer();
    expect(png.byteLength).toBeGreaterThan(1024 * 1024);
    const out = await shrinkImageForEmail(png, 'image/png');
    expect(out.shrunk).toBe(true);
    expect(out.contentType).toBe('image/jpeg');
    expect(out.bytes.byteLength).toBeLessThan(png.byteLength / 4);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(EMAIL_IMAGE_MAX_PX);
  });

  it('keeps flat line art a PNG', async () => {
    const png = await sharp(flatRaw(2400, 1800), { raw: { width: 2400, height: 1800, channels: 3 } }).png().toBuffer();
    const out = await shrinkImageForEmail(png, 'image/png');
    expect(out.contentType).toBe('image/png');
    expect((await sharp(out.bytes).metadata()).format).toBe('png');
  });

  it('shrinks a thumbnail-size source that would pass as small at full email size', async () => {
    const jpeg = await sharp(photoRaw(1200, 900), { raw: { width: 1200, height: 900, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
    expect(jpeg.byteLength).toBeLessThan(300 * 1024);
    expect((await shrinkImageForEmail(jpeg, 'image/jpeg')).shrunk).toBe(false);
    const thumb = await shrinkImageForEmail(jpeg, 'image/jpeg', 600);
    expect(thumb.shrunk).toBe(true);
    expect((await sharp(thumb.bytes).metadata()).width).toBe(600);
  });

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

describe('emailImageFilename', () => {
  it('renames a PNG that went out as a JPEG, and nothing else', () => {
    expect(emailImageFilename('Screenshot 2026-10-13 at 2.33.01_PM.png', 'image/jpeg')).toBe('Screenshot 2026-10-13 at 2.33.01_PM.jpg');
    expect(emailImageFilename('image.PNG', 'image/jpeg')).toBe('image.jpg');
    expect(emailImageFilename('pasted', 'image/jpeg')).toBe('pasted.jpg');
    expect(emailImageFilename('photo.JPG', 'image/jpeg')).toBe('photo.JPG');
    expect(emailImageFilename('diagram.png', 'image/png')).toBe('diagram.png');
    expect(emailImageFilename('spec.pdf', 'application/pdf')).toBe('spec.pdf');
  });
});
