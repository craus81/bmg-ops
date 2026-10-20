// Printing photos from the photo viewer (PhotoLightbox).
//
// Print = the photo on screen, one to a page. Print all = every photo in the
// viewer's set, four to a page (Craig, 2026-10-20). Each photo prints with
// its caption (VIN, date, who took it) and the page carries a heading such
// as the part number.
//
// Two routes, same as ProofViewer: the iPhone app's web view ignores
// window.print(), so on touch screens that can share files we build a PDF
// and open the share sheet (Print, AirPrint, Save to Files). Computers print
// an HTML page from a hidden frame.

import { ensureFreshSession } from './native-files';

export interface PrintablePhoto {
  url: string;
  title?: string | null;
  subtitle?: string | null;
}

export type PhotosPerPage = 1 | 4;

/** Split the photos into pages. */
export function photoPages<T>(photos: T[], perPage: PhotosPerPage): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < photos.length; i += perPage) pages.push(photos.slice(i, i + perPage));
  return pages;
}

/** File name for the shared PDF: the heading, made file-safe. */
export function photoPdfName(heading: string | undefined, count: number): string {
  const base = (heading || 'Photos').replace(/[^A-Za-z0-9 ._-]+/g, '').trim().replace(/\s+/g, '-') || 'Photos';
  return `${base}${count > 1 ? `-${count}-photos` : ''}.pdf`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function absolute(url: string): string {
  try { return new URL(url, window.location.href).href; } catch { return url; }
}

/** Computers: lay the pages out as HTML in a hidden frame and print it. */
function printInFrame(photos: PrintablePhoto[], perPage: PhotosPerPage, heading?: string): Promise<void> {
  const pages = photoPages(photos, perPage);
  const cell = (p: PrintablePhoto) => `
    <figure>
      <div class="img"><img src="${esc(absolute(p.url))}" alt=""></div>
      <figcaption>
        ${p.title ? `<b>${esc(p.title)}</b>` : ''}
        ${p.subtitle ? `<span>${esc(p.subtitle)}</span>` : ''}
      </figcaption>
    </figure>`;
  const html = `<!doctype html><html><head><title>${esc(heading || 'Photos')}</title><style>
    @page { margin: 0.4in; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: -apple-system, system-ui, sans-serif; }
    .page { height: calc(100vh - 1px); display: flex; flex-direction: column; break-after: page; page-break-after: always; }
    .page:last-child { break-after: auto; page-break-after: auto; }
    h1 { font-size: 13pt; margin: 0 0 8px; }
    .grid { flex: 1; min-height: 0; display: grid; gap: 12px; }
    .grid.n1 { grid-template: 1fr / 1fr; }
    .grid.n4 { grid-template: 1fr 1fr / 1fr 1fr; }
    figure { margin: 0; min-height: 0; display: flex; flex-direction: column; }
    .img { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
    figcaption { font-size: 9pt; line-height: 1.35; padding-top: 4px; }
    figcaption b { display: block; }
    figcaption span { color: #444; }
  </style></head><body>${pages.map(pg => `
    <section class="page">
      ${heading ? `<h1>${esc(heading)}</h1>` : ''}
      <div class="grid n${perPage}">${pg.map(cell).join('')}</div>
    </section>`).join('')}</body></html>`;

  return new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
    const imgs = Array.from(doc.images);
    Promise.all(imgs.map(i => (i.complete ? Promise.resolve() : new Promise(r => { i.onload = r; i.onerror = r; })))).then(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60_000);
      resolve();
    });
  });
}

/**
 * Get a photo's pixels. Download-route links answer with a short-lived R2
 * link when asked for JSON, fetched without credentials so R2's CORS rule
 * applies (same as fetchStoredFile). Anything else is fetched directly.
 */
async function loadPhotoBlob(url: string): Promise<Blob> {
  if (url.startsWith('/api/storage/download')) {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}format=json`, { credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.url) throw new Error(body?.error || `HTTP ${res.status}`);
    const file = await fetch(body.url, { credentials: 'omit' });
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
    return file.blob();
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Re-encode as a JPEG data URL no wider than 1600px, keeping the PDF small. */
async function toJpeg(blob: Blob): Promise<{ data: string; w: number; h: number }> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas context');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const out = { data: canvas.toDataURL('image/jpeg', 0.85), w: canvas.width, h: canvas.height };
  // Hand canvas memory back now: iPhones cap it, and Print all draws many.
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

/** Phones: build a letter-size PDF with the same layout. */
async function buildPdf(photos: PrintablePhoto[], perPage: PhotosPerPage, heading?: string): Promise<{ blob: Blob; failed: number }> {
  const { default: jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 29; // 0.4in
  const gap = 12;
  const capH = 26;
  let failed = 0;

  const pages = photoPages(photos, perPage);
  for (let pi = 0; pi < pages.length; pi++) {
    if (pi > 0) doc.addPage();
    let top = M;
    if (heading) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text(heading, M, top + 12);
      top += 22;
    }
    const cols = perPage === 4 ? 2 : 1;
    const rows = perPage === 4 ? 2 : 1;
    const cellW = (W - 2 * M - (cols - 1) * gap) / cols;
    const cellH = (H - top - M - (rows - 1) * gap) / rows;

    for (let i = 0; i < pages[pi].length; i++) {
      const p = pages[pi][i];
      const x = M + (i % cols) * (cellW + gap);
      const y = top + Math.floor(i / cols) * (cellH + gap);
      const boxH = cellH - capH;
      try {
        const img = await toJpeg(await loadPhotoBlob(p.url));
        const s = Math.min(cellW / img.w, boxH / img.h);
        const w = img.w * s;
        const h = img.h * s;
        doc.addImage(img.data, 'JPEG', x + (cellW - w) / 2, y + (boxH - h) / 2, w, h);
      } catch {
        failed++;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text('This photo could not be loaded.', x + 4, y + boxH / 2);
      }
      doc.setFontSize(9);
      if (p.title) {
        doc.setFont('helvetica', 'bold');
        doc.text(doc.splitTextToSize(p.title, cellW)[0], x, y + boxH + 11);
      }
      if (p.subtitle) {
        doc.setFont('helvetica', 'normal');
        doc.text(doc.splitTextToSize(p.subtitle, cellW)[0], x, y + boxH + 22);
      }
    }
  }
  return { blob: doc.output('blob'), failed };
}

/**
 * Print photos. Returns a message for the viewer to show when something
 * went wrong (null when it went fine or the person cancelled).
 */
export async function printPhotos(
  photos: PrintablePhoto[],
  opts: { perPage: PhotosPerPage; heading?: string },
): Promise<string | null> {
  if (photos.length === 0) return null;
  const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  if (isTouch && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function') {
    try {
      await ensureFreshSession();
      const { blob, failed } = await buildPdf(photos, opts.perPage, opts.heading);
      if (failed === photos.length) return 'None of these photos could be loaded, so there is nothing to print.';
      const file = new File([blob], photoPdfName(opts.heading, photos.length), { type: 'application/pdf' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: opts.heading || 'Photos' });
        } catch { /* cancelled */ }
        return failed > 0 ? `${failed} photo${failed !== 1 ? 's' : ''} could not be loaded and printed as a blank box.` : null;
      }
    } catch (e: any) {
      return `Could not get the photos ready to print: ${e?.message || 'unknown error'}`;
    }
  }
  await printInFrame(photos, opts.perPage, opts.heading);
  return null;
}
