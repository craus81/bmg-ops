import { describe, expect, it } from 'vitest';
import { firstImageFile, namePastedImage } from './use-image-drop';

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('firstImageFile', () => {
  it('skips non-images and returns the first picture', () => {
    expect(firstImageFile([file('notes.pdf', 'application/pdf'), file('a.jpg', 'image/jpeg')])?.name).toBe('a.jpg');
  });
  it('accepts HEIC even when the browser leaves the type blank', () => {
    expect(firstImageFile([file('IMG_1.HEIC', '')])?.name).toBe('IMG_1.HEIC');
  });
  it('returns null when nothing is an image', () => {
    expect(firstImageFile([file('a.txt', 'text/plain')])).toBeNull();
    expect(firstImageFile(null)).toBeNull();
  });
});

describe('namePastedImage', () => {
  it('renames generic clipboard screenshots', () => {
    const out = namePastedImage(file('image.png', 'image/png'), new Date('2026-10-16T17:05:09Z'));
    expect(out.name).toBe('pasted-20261016170509.png');
    expect(out.type).toBe('image/png');
  });
  it('keeps real file names', () => {
    const f = file('rack.jpg', 'image/jpeg');
    expect(namePastedImage(f)).toBe(f);
  });
});
