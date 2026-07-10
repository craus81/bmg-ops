// Automatic scale calibration for vehicle wrap templates.
//
// Vector template files carry their artboard size internally: EPS declares a
// %%BoundingBox (PostScript points, 72 pt = 1 artboard inch) and AI/PDF files
// declare a /MediaBox. The templates are drawn to scale (1:20 by default), so
// artboard inches × scale factor = real-world inches. Dividing the raster
// preview's pixel width by the real-world width gives px_per_in — the same
// number Illustrator would show — with no manual measuring.
//
// Previews aren't always straight artboard exports: PVO renders them onto a
// fixed-shape canvas, letterboxing (contain-fit) the artwork — it fills one
// axis exactly and pads the other. Verified against a real template: 4:3
// preview canvas vs 1.243 artboard, artwork spanning the height. Under
// contain-fit the scale is the smaller of the two axis ratios, and padding
// doesn't distort measurements (the mapping stays uniform across the image).
// When the aspects DO match, both axes agree and we average them.

// NOTE: server/test only — the PDF path inflates compressed streams via
// node:zlib, so don't import this from client components.
import { inflateSync, inflateRawSync } from 'zlib';

export interface ArtboardSize { widthPt: number; heightPt: number }
export interface PixelSize { width: number; height: number }

export interface CalibrationResult {
  pxPerIn: number | null;
  reason: 'ok' | 'ok-letterboxed' | 'no-artboard' | 'no-image-size' | 'degenerate';
}

// Aspect agreement below this means the preview is a straight artboard
// export (average both axes); above it, treat as letterboxed contain-fit.
const ASPECT_TOLERANCE = 0.03;

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/** '1:20' / '1/20' → 20. Defaults to 20 (the standard template scale). */
export function parseScaleFactor(scale: string | null | undefined): number {
  const m = /1\s*[:/]\s*(\d+(?:\.\d+)?)/.exec(scale || '');
  const f = m ? parseFloat(m[1]) : NaN;
  return f > 0 ? f : 20;
}

/**
 * Artboard size in PostScript points from an EPS, AI, or PDF file.
 *
 * Handles DOS-EPS binary wrappers (TIFF/WMF preview + PostScript section at
 * an offset) and `%%BoundingBox: (atend)` by preferring the last parseable
 * bounding-box comment in the file. AI files are PDF-compatible, so the
 * /MediaBox path covers them.
 */
export function parseVectorArtboard(bytes: Uint8Array): ArtboardSize | null {
  let ps = bytes;
  // DOS EPS binary header: magic C5 D0 D3 C6, then LE offset + length of the
  // PostScript section.
  if (bytes.length >= 12 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = view.getUint32(4, true);
    const length = view.getUint32(8, true);
    if (offset + length <= bytes.length) ps = bytes.subarray(offset, offset + length);
  }
  const text = latin1(ps);

  // EPS: prefer HiRes; "(atend)" instances parse as non-numeric and are
  // skipped, so the trailer values win.
  for (const re of [
    /%%HiResBoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/g,
    /%%BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/g,
  ]) {
    let last: ArtboardSize | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const [x0, y0, x1, y1] = [m[1], m[2], m[3], m[4]].map(parseFloat);
      const w = x1 - x0, h = y1 - y0;
      if (w > 0 && h > 0) last = { widthPt: w, heightPt: h };
    }
    if (last) return last;
  }

  // PDF / AI: first /MediaBox (page 1).
  const fromMediaBox = (t: string): ArtboardSize | null => {
    const mb = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(t);
    if (!mb) return null;
    const [x0, y0, x1, y1] = [mb[1], mb[2], mb[3], mb[4]].map(parseFloat);
    const w = x1 - x0, h = y1 - y0;
    return w > 0 && h > 0 ? { widthPt: w, heightPt: h } : null;
  };
  const plain = fromMediaBox(text);
  if (plain) return plain;

  // Modern .ai / PDF 1.5+ files often Flate-compress their object streams,
  // so /MediaBox (or the AI content's %%BoundingBox) never appears as plain
  // text. Inflate each stream...endstream segment and search inside.
  if (text.startsWith('%PDF') || text.indexOf('FlateDecode') !== -1) {
    const streamRe = /stream\r?\n/g;
    let m: RegExpExecArray | null;
    let scanned = 0;
    while ((m = streamRe.exec(text)) !== null && scanned < 400) {
      const start = m.index + m[0].length;
      const end = text.indexOf('endstream', start);
      if (end < 0) break;
      scanned++;
      const raw = ps.subarray(start, Math.min(end, start + 8_000_000));
      let inflated: Buffer | null = null;
      try { inflated = inflateSync(raw); }
      catch {
        try { inflated = inflateRawSync(raw); } catch { /* not deflate data */ }
      }
      if (!inflated) continue;
      const inner = inflated.toString('latin1');
      const viaMb = fromMediaBox(inner);
      if (viaMb) return viaMb;
      // AI private data inside the stream carries EPS-style bounding boxes
      const bb = /%%(?:HiRes)?BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(inner);
      if (bb) {
        const [x0, y0, x1, y1] = [bb[1], bb[2], bb[3], bb[4]].map(parseFloat);
        const w = x1 - x0, h = y1 - y0;
        if (w > 0 && h > 0) return { widthPt: w, heightPt: h };
      }
    }
  }

  return null;
}

/** Pixel dimensions from PNG or JPEG bytes (header parse, no image decode). */
export function parseImageSize(bytes: Uint8Array): PixelSize | null {
  // PNG: 8-byte signature, then IHDR chunk — width/height are big-endian
  // uint32 at offsets 16 and 20.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // JPEG: walk the segment list to the first SOF marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xff) { pos++; continue; }
      const marker = bytes[pos + 1];
      if (marker === 0xff) { pos++; continue; } // padding
      // Standalone markers without a length payload
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
      if (pos + 4 > bytes.length) break;
      const segLen = view.getUint16(pos + 2, false);
      // SOF0-SOF15 (minus DHT/JPG/DAC which share the range)
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        if (pos + 9 > bytes.length) break;
        const height = view.getUint16(pos + 5, false);
        const width = view.getUint16(pos + 7, false);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      pos += 2 + segLen;
    }
  }

  return null;
}

/**
 * px_per_in for a template given its vector source, raster preview, and
 * scale factor (20 for 1:20). Null with a reason when the inputs don't
 * support a trustworthy answer.
 */
export function computeCalibration(
  vectorBytes: Uint8Array,
  imageBytes: Uint8Array,
  scaleFactor: number
): CalibrationResult {
  const art = parseVectorArtboard(vectorBytes);
  if (!art) return { pxPerIn: null, reason: 'no-artboard' };
  const img = parseImageSize(imageBytes);
  if (!img) return { pxPerIn: null, reason: 'no-image-size' };
  if (scaleFactor <= 0) return { pxPerIn: null, reason: 'degenerate' };

  const artAspect = art.widthPt / art.heightPt;
  const imgAspect = img.width / img.height;
  const realWidthIn = (art.widthPt / 72) * scaleFactor;
  const realHeightIn = (art.heightPt / 72) * scaleFactor;
  const wRatio = img.width / realWidthIn;
  const hRatio = img.height / realHeightIn;

  // Aspects agree → straight artboard export; average the axes to smooth
  // pixel rounding. Aspects differ → letterboxed contain-fit render; the
  // artwork fills the constraining axis, so the true scale is the smaller
  // axis ratio (the larger one includes the padding).
  const letterboxed = Math.abs(artAspect - imgAspect) / artAspect > ASPECT_TOLERANCE;
  const pxPerIn = letterboxed ? Math.min(wRatio, hRatio) : (wRatio + hRatio) / 2;
  if (!isFinite(pxPerIn) || pxPerIn <= 0) return { pxPerIn: null, reason: 'degenerate' };
  return { pxPerIn, reason: letterboxed ? 'ok-letterboxed' : 'ok' };
}
