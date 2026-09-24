import { describe, it, expect } from 'vitest';
import { isHeicName, isHeicFile, jpegName, fitWithin, toJpegIfHeic, MAX_EDGE } from './heic';

describe('isHeicName / isHeicFile', () => {
  it('matches heic and heif extensions in any case', () => {
    expect(isHeicName('checkin-1790174413224-0.heic')).toBe(true);
    expect(isHeicName('IMG_1234.HEIC')).toBe(true);
    expect(isHeicName('scan.heif')).toBe(true);
    expect(isHeicName('photo.jpg')).toBe(false);
    expect(isHeicName('heic')).toBe(true);
    expect(isHeicName('')).toBe(false);
    expect(isHeicName(null)).toBe(false);
  });

  it('trusts the MIME type when the name has no extension', () => {
    expect(isHeicFile({ name: 'image', type: 'image/heic' })).toBe(true);
    expect(isHeicFile({ name: 'image', type: 'IMAGE/HEIF' })).toBe(true);
    expect(isHeicFile({ name: 'IMG_1.HEIC', type: '' })).toBe(true);
    expect(isHeicFile({ name: 'IMG_1.jpeg', type: 'image/jpeg' })).toBe(false);
  });
});

describe('jpegName', () => {
  it('swaps the extension for .jpg', () => {
    expect(jpegName('IMG_1234.HEIC')).toBe('IMG_1234.jpg');
    expect(jpegName('a.b.heic')).toBe('a.b.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
    expect(jpegName('.heic')).toBe('photo.jpg');
  });
});

describe('fitWithin', () => {
  it('leaves a standard 12 MP iPhone photo alone', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 4032, height: 3024 });
  });

  it('shrinks a 24 MP photo under the iOS canvas limit, keeping aspect', () => {
    const { width, height } = fitWithin(5712, 4284);
    expect(Math.max(width, height)).toBe(MAX_EDGE);
    expect(width * height).toBeLessThan(16_777_216);
    expect(width / height).toBeCloseTo(5712 / 4284, 2);
  });

  it('handles portrait and never scales up', () => {
    expect(fitWithin(4284, 5712).height).toBe(MAX_EDGE);
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('toJpegIfHeic', () => {
  it('returns a non-HEIC file untouched', async () => {
    const f = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    expect(await toJpegIfHeic(f)).toBe(f);
  });

  it('uploads the original when the HEIC cannot be decoded', async () => {
    const f = new File(['not really heic'], 'IMG_1.HEIC', { type: 'image/heic' });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await toJpegIfHeic(f)).toBe(f);
    } finally {
      console.warn = warn;
    }
  });
});
