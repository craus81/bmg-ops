import { describe, it, expect } from 'vitest';
import { parseScaleFactor, parseVectorArtboard, parseImageSize, computeCalibration } from './template-calibration';

const enc = (s: string) => new TextEncoder().encode(s);

// Minimal PNG: signature + IHDR length/type, then width/height (big-endian).
function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width, false);
  new DataView(b.buffer).setUint32(20, height, false);
  return b;
}

// Minimal JPEG: SOI, one APP0 segment, then SOF0 with height/width.
function jpegBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, len 4
    0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, // SOF0, len 17, precision 8
  ]);
  const view = new DataView(b.buffer);
  view.setUint16(13, height, false);
  view.setUint16(15, width, false);
  return b;
}

describe('parseScaleFactor', () => {
  it('parses 1:20 and 1/20', () => {
    expect(parseScaleFactor('1:20')).toBe(20);
    expect(parseScaleFactor('1/20')).toBe(20);
    expect(parseScaleFactor('1 : 12.5')).toBe(12.5);
  });
  it('defaults to 20 for junk', () => {
    expect(parseScaleFactor(null)).toBe(20);
    expect(parseScaleFactor('full size')).toBe(20);
  });
});

describe('parseVectorArtboard', () => {
  it('reads a plain EPS BoundingBox', () => {
    const eps = enc('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 720 360\n%%EndComments\n');
    expect(parseVectorArtboard(eps)).toEqual({ widthPt: 720, heightPt: 360 });
  });

  it('prefers HiResBoundingBox over BoundingBox', () => {
    const eps = enc('%!PS\n%%BoundingBox: 0 0 720 360\n%%HiResBoundingBox: 0 0 719.52 359.76\n');
    const r = parseVectorArtboard(eps)!;
    expect(r.widthPt).toBeCloseTo(719.52);
    expect(r.heightPt).toBeCloseTo(359.76);
  });

  it('handles (atend) by using the trailer values', () => {
    const eps = enc('%!PS\n%%BoundingBox: (atend)\n...body...\n%%Trailer\n%%BoundingBox: 10 10 730 370\n%%EOF\n');
    expect(parseVectorArtboard(eps)).toEqual({ widthPt: 720, heightPt: 360 });
  });

  it('unwraps DOS EPS binary headers', () => {
    const ps = enc('%!PS\n%%BoundingBox: 0 0 100 50\n');
    const bin = new Uint8Array(12 + ps.length);
    bin.set([0xc5, 0xd0, 0xd3, 0xc6]);
    new DataView(bin.buffer).setUint32(4, 12, true); // PS offset
    new DataView(bin.buffer).setUint32(8, ps.length, true); // PS length
    bin.set(ps, 12);
    expect(parseVectorArtboard(bin)).toEqual({ widthPt: 100, heightPt: 50 });
  });

  it('reads a PDF/AI MediaBox', () => {
    const pdf = enc('%PDF-1.5\n1 0 obj\n<< /Type /Page /MediaBox [ 0 0 612 792 ] >>\nendobj\n');
    expect(parseVectorArtboard(pdf)).toEqual({ widthPt: 612, heightPt: 792 });
  });

  it('returns null when nothing parseable exists', () => {
    expect(parseVectorArtboard(enc('hello world'))).toBeNull();
  });
});

describe('parseImageSize', () => {
  it('reads PNG dimensions', () => {
    expect(parseImageSize(pngBytes(1440, 720))).toEqual({ width: 1440, height: 720 });
  });
  it('reads JPEG dimensions', () => {
    expect(parseImageSize(jpegBytes(800, 400))).toEqual({ width: 800, height: 400 });
  });
  it('returns null for other data', () => {
    expect(parseImageSize(enc('not an image'))).toBeNull();
  });
});

describe('computeCalibration', () => {
  // Artboard 10in × 5in at 1:20 → 200in × 100in real. Preview 1440×720 px
  // → 7.2 px per real inch.
  const eps = enc('%!PS\n%%BoundingBox: 0 0 720 360\n');

  it('computes px_per_in from EPS + PNG', () => {
    const r = computeCalibration(eps, pngBytes(1440, 720), 20);
    expect(r.reason).toBe('ok');
    expect(r.pxPerIn).toBeCloseTo(7.2);
  });

  it('rejects previews whose aspect ratio disagrees with the artboard', () => {
    const r = computeCalibration(eps, pngBytes(1440, 1440), 20);
    expect(r.reason).toBe('aspect-mismatch');
    expect(r.pxPerIn).toBeNull();
  });

  it('tolerates small rounding in the export', () => {
    // 1441×719 is within 3% aspect tolerance of 2:1
    const r = computeCalibration(eps, pngBytes(1441, 719), 20);
    expect(r.reason).toBe('ok');
  });

  it('reports missing artboard / image data', () => {
    expect(computeCalibration(enc('junk'), pngBytes(10, 10), 20).reason).toBe('no-artboard');
    expect(computeCalibration(eps, enc('junk'), 20).reason).toBe('no-image-size');
  });
});
