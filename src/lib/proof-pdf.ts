'use client';

/**
 * Dimensioned-proof export: rebuild the ORIGINAL proof PDF with the
 * dimensioned pages swapped in for (or inserted after) the pages they were
 * imported from, leaving cover/disclaimer/best-practice pages untouched.
 * proof-assembly.ts plans the page order; this executes it with pdf-lib
 * (dynamic import, same pattern as the knowledge page's PDF splitter).
 *
 * Pages imported from the source PDF were rasterized at PDF_RENDER_SCALE ×
 * 72 dpi, so raster px ÷ PDF_RENDER_SCALE reproduces the page's exact
 * original size in points (rotation already baked in by pdfjs). Guide
 * pages with no place in the source deck (image uploads, other PDFs) are
 * appended at the end at letter-ish width.
 */

import type { InstallGuide } from './install-guide';
import { PDF_RENDER_SCALE } from './install-guide';
import type { RenderedGuidePage } from './install-guide-pdf';
import { planProofAssembly, type ProofMode } from './proof-assembly';

export async function buildDimensionedProofPdf(
  guide: InstallGuide,
  rendered: RenderedGuidePage[],
  sourcePdfBytes: ArrayBuffer,
  sourcePdfPath: string,
  mode: ProofMode,
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  // ignoreEncryption: proof decks are often owner-password "protected" but
  // fully readable; without this pdf-lib refuses to load them.
  const src = await PDFDocument.load(sourcePdfBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();

  const plan = planProofAssembly(src.getPageCount(), guide.pages, sourcePdfPath, mode);
  const byId = new Map(rendered.map(r => [r.page.id, r]));

  const originalIndices = plan.steps
    .filter(s => s.kind === 'original')
    .map(s => (s as { kind: 'original'; sourceIndex: number }).sourceIndex);
  const copied = await out.copyPages(src, originalIndices);
  const copiedByIndex = new Map(originalIndices.map((idx, i) => [idx, copied[i]]));

  const addDimensioned = async (pageId: string, appendedFallbackWidth?: number) => {
    const r = byId.get(pageId);
    if (!r) return; // page failed to render — plan already warned upstream
    const png = await out.embedPng(r.dataUrl);
    const fromSource = guide.pages.find(p => p.id === pageId)?.source_pdf_path === sourcePdfPath;
    const w = fromSource ? r.w / PDF_RENDER_SCALE : appendedFallbackWidth || 792;
    const h = fromSource ? r.h / PDF_RENDER_SCALE : (w * r.h) / r.w;
    const page = out.addPage([w, h]);
    page.drawImage(png, { x: 0, y: 0, width: w, height: h });
  };

  for (const step of plan.steps) {
    if (step.kind === 'original') {
      const p = copiedByIndex.get(step.sourceIndex);
      if (p) out.addPage(p);
    } else {
      await addDimensioned(step.pageId);
    }
  }
  for (const pageId of plan.appended) {
    await addDimensioned(pageId, 792);
  }

  return out.save();
}

export function dimensionedProofFileName(guide: InstallGuide): string {
  const base = (guide.title || guide.customer_name || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `Dimensioned Proof - ${base}.pdf`;
}
