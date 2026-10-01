// Turning a customer's proof file into pages the Estimator can draw on.
//
// Proofs arrive as PDFs (most), JPEG/PNG exports, and the odd iPhone HEIC.
// Every page becomes a canvas at a resolution the measuring code can work
// with (hairline body lines need a few pixels of width to be told apart from
// lettering), and that canvas is what gets uploaded — so the uploaded
// picture and the pixels that were analysed are the same pixels, and box
// coordinates mean the same thing on screen later.
//
// Browser-only: canvas, pdfjs, createImageBitmap.

import { toJpegIfHeic } from './heic';

/** Longest edge of a rendered page. 3000 keeps an 11×17 proof's 2 px body
 *  lines at ~3–4 px, and stays under the iPhone canvas-memory cap. */
export const PROOF_MAX_EDGE = 3000;
/** A proof PDF past this many pages is a brand book, not a layout. */
export const PROOF_MAX_PAGES = 6;
/** What the upload control accepts. */
export const PROOF_ACCEPT = '.pdf,application/pdf,image/*,.heic,.heif';
/** Long edge of the copy sent to the reader — Claude's vision sweet spot. */
export const READER_MAX_EDGE = 1568;

export interface ProofPage {
  /** File name without extension, for labels and storage paths. */
  name: string;
  /** 1-based page number within the file. */
  page: number;
  /** How many pages the file has (what was rendered may be fewer). */
  pages: number;
  canvas: HTMLCanvasElement;
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function isProofFile(file: File): boolean {
  return isPdfFile(file) || file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);
}

const baseName = (name: string) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name) || 'proof';

/** Fit (w, h) inside maxEdge without scaling up. */
const fit = (w: number, h: number, maxEdge: number) => {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the proof (no canvas).');
  // Transparent PNG pages must land on white, not the black a JPEG would
  // make of them — and the wheel finder reads "black" as a tyre.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
};

/** Hand canvas memory back as soon as a page is done with — iPhones cap it. */
export function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Render every page of a proof file to a canvas. PDF pages come through
 * pdfjs (already in the app for the proof viewer); images through the
 * browser's decoder, HEIC converted first. Throws when the file can't be
 * read at all; a PDF whose later page fails keeps the pages it has.
 */
export async function rasterizeProofFile(file: File, onProgress?: (message: string) => void): Promise<ProofPage[]> {
  const name = baseName(file.name);
  if (isPdfFile(file)) {
    onProgress?.(`Opening ${file.name}…`);
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const total = pdf.numPages;
    const out: ProofPage[] = [];
    for (let n = 1; n <= Math.min(total, PROOF_MAX_PAGES); n++) {
      onProgress?.(`Drawing page ${n} of ${Math.min(total, PROOF_MAX_PAGES)}…`);
      try {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const { width, height } = fit(base.width, base.height, PROOF_MAX_EDGE);
        const viewport = page.getViewport({ scale: width / base.width });
        const { canvas, ctx } = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
        await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
        page.cleanup();
        out.push({ name, page: n, pages: total, canvas });
      } catch (e) {
        if (out.length === 0) throw e;
        console.warn(`Proof page ${n} failed to render:`, e);
        break;
      }
    }
    return out;
  }

  onProgress?.(`Opening ${file.name}…`);
  const jpeg = await toJpegIfHeic(file);
  const url = URL.createObjectURL(jpeg);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error(`${file.name} doesn't look like an image.`);
    const { width, height } = fit(w, h, PROOF_MAX_EDGE);
    const { canvas, ctx } = makeCanvas(width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return [{ name, page: 1, pages: 1, canvas }];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the page.'))), 'image/jpeg', quality));
}

/**
 * A smaller copy of the page for the reader, as base64 JPEG. The reader
 * answers in fractions of the page, so the downscale costs nothing in
 * coordinates.
 */
export async function pageForReader(canvas: HTMLCanvasElement): Promise<{ base64: string; mimeType: 'image/jpeg' }> {
  const { width, height } = fit(canvas.width, canvas.height, READER_MAX_EDGE);
  const { canvas: small, ctx } = makeCanvas(width, height);
  ctx.drawImage(canvas, 0, 0, width, height);
  try {
    const blob = await canvasToJpeg(small, 0.85);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    return { base64: btoa(bin), mimeType: 'image/jpeg' };
  } finally {
    releaseCanvas(small);
  }
}

/** The page's pixels, for the wheel finder and the snapper. */
export function pagePixels(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read the page.');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
