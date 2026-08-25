/**
 * Server-side generation of the FleetSuite enhanced-estimate PDF — ONE
 * loader/renderer for every surface that hands out the file (the in-app
 * view/print endpoint and the email-PDF attachment), so what staff preview
 * is byte-for-byte what the customer receives.
 *
 * Loads the estimate + lines, enriches lines with catalog photos and vendor
 * product links (enrichLinesWithPartAssets — the same enrichment as the
 * approval email/page), inlines the company letterhead logo, then builds
 * the document with buildEstimatePdf (src/lib/estimate-pdf.ts).
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { enrichLinesWithPartAssets } from './estimate-line-parts';
import { r2PublicUrl } from './r2';
import { buildEstimatePdf, estimatePdfFilename, type EstimatePdfGraphics, type EstimatePdfImage, type EstimatePdfLine } from './estimate-pdf';

// Keep the PDF (and the serverless memory bill) bounded: skip any single
// image over 3MB and stop inlining once 12MB of image data is embedded —
// lines past the budget still render, just without their thumbnail.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

/** Fetch an image URL into the {dataUrl, format} shape jsPDF embeds.
 *  Returns null (never throws) for anything unusable: bad status, a
 *  non-JPEG/PNG type, or an oversize body. */
async function fetchImage(url: string, remainingBudget: number): Promise<{ image: EstimatePdfImage; bytes: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const format: EstimatePdfImage['format'] | null =
      ct.includes('png') ? 'PNG' : (ct.includes('jpeg') || ct.includes('jpg')) ? 'JPEG' : null;
    if (!format) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > Math.min(MAX_IMAGE_BYTES, remainingBudget)) return null;
    return {
      image: { dataUrl: `data:${format === 'PNG' ? 'image/png' : 'image/jpeg'};base64,${buf.toString('base64')}`, format },
      bytes: buf.byteLength,
    };
  } catch {
    return null;
  }
}

export type EstimatePdfResult =
  | { ok: true; buffer: Buffer; filename: string; estimate: any }
  | { ok: false; status: number; error: string };

export async function generateEstimatePdf(
  supabase: SupabaseClient,
  estimateId: string,
  opts: { print?: boolean } = {},
): Promise<EstimatePdfResult> {
  const { data: estimate, error: estErr } = await supabase
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('id', estimateId)
    .single();
  if (estErr || !estimate) return { ok: false, status: 404, error: 'Estimate not found' };
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;

  const { data: rawLines } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimateId)
    .order('sort_order')
    .order('id');
  const enriched = await enrichLinesWithPartAssets(supabase, rawLines || []);

  // Letterhead — same settings singleton as the approval email / wrap quote.
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || null;
  let logo: EstimatePdfImage | null = null;
  if (company?.logo_path) {
    logo = (await fetchImage(r2PublicUrl('vehicle-templates', company.logo_path), MAX_IMAGE_BYTES))?.image || null;
  }

  // Inline the line thumbnails, deduped by URL (kits repeat parts).
  let budget = MAX_TOTAL_IMAGE_BYTES;
  const byUrl = new Map<string, EstimatePdfImage | null>();
  const lines: EstimatePdfLine[] = [];
  for (const l of enriched) {
    let image: EstimatePdfImage | null = null;
    if (l.part_image_url) {
      if (byUrl.has(l.part_image_url)) {
        image = byUrl.get(l.part_image_url) || null;
      } else if (budget > 0) {
        const fetched = await fetchImage(l.part_image_url, budget);
        if (fetched) budget -= fetched.bytes;
        image = fetched?.image || null;
        byUrl.set(l.part_image_url, image);
      }
    }
    lines.push({ ...l, image });
  }

  // ── Linked wrap quotes: what each contributes to this PDF ──────────────
  // estimate_attach (migration 223) carries the estimator's Add-to-Estimate
  // checkboxes: films → a Vinyl/Graphics section inside the document;
  // diagram/attachments → pages MERGED onto the end (images as pages, PDF
  // attachments page-by-page), so the customer approves ONE file.
  const { data: wrapQuotes } = await supabase
    .from('wrap_quotes')
    .select('id, quote_number, vehicle_description, diagram_path, attachments, measurements, estimate_attach, total_area_sqft')
    .eq('estimate_id', estimateId)
    .not('estimate_attach', 'is', null);

  const graphics: EstimatePdfGraphics[] = [];
  for (const q of wrapQuotes || []) {
    if (!q.estimate_attach?.films) continue;
    const measurements: any[] = Array.isArray(q.measurements) ? q.measurements : [];
    const filmIds = [...new Set(measurements.map(m => m?.substrate_id).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (filmIds.length > 0) {
      const { data: films } = await supabase
        .from('wrap_substrates').select('id, name').in('id', filmIds);
      for (const f of films || []) names.set(f.id, f.name);
    }
    const byFilm = new Map<string, string[]>();
    for (const m of measurements) {
      const name = m?.substrate_id ? (names.get(m.substrate_id) || 'Vinyl') : 'Vinyl';
      const areas = byFilm.get(name) || [];
      if (m?.name) areas.push(String(m.name));
      byFilm.set(name, areas);
    }
    graphics.push({
      quoteNumber: q.quote_number,
      vehicle: q.vehicle_description,
      totalSqft: parseFloat(q.total_area_sqft) || 0,
      films: [...byFilm.entries()].map(([name, areas]) => ({ name, areas })),
    });
  }

  const doc = buildEstimatePdf({ estimate, lines, company, logo, ...(graphics.length > 0 ? { graphics } : {}) });
  if (opts.print) doc.autoPrint();
  let buffer: Buffer = Buffer.from(doc.output('arraybuffer'));

  const needsMerge = (wrapQuotes || []).some(q =>
    (q.estimate_attach?.diagram && q.diagram_path)
    || (q.estimate_attach?.attachments && Array.isArray(q.attachments) && q.attachments.length > 0));
  if (needsMerge) {
    try {
      buffer = await mergeWrapAssets(buffer, wrapQuotes || []);
    } catch (err: any) {
      // The base document is still a complete quote — ship it rather than
      // failing the whole request over an unreadable attachment.
      console.error('[estimate-pdf] wrap-asset merge failed:', err?.message || err);
    }
  }

  return {
    ok: true,
    buffer,
    filename: estimatePdfFilename(estimate),
    estimate,
  };
}

// Append the selected wrap assets to the base PDF: the coverage diagram and
// image attachments as full letter pages (fitted, with a small caption),
// PDF attachments merged page-by-page. Per-file failures skip that file.
const PAGE_W = 612;
const PAGE_H = 792;
const PAGE_MARGIN = 36;
const MAX_MERGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_APPENDED_PAGES = 30;

async function mergeWrapAssets(base: Buffer, quotes: any[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const out = await PDFDocument.load(base);
  const font = await out.embedFont(StandardFonts.Helvetica);
  let appended = 0;

  const addImagePage = async (bytes: Buffer, contentType: string, caption: string) => {
    if (appended >= MAX_APPENDED_PAGES) return;
    const img = contentType.includes('png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const page = out.addPage([PAGE_W, PAGE_H]);
    const maxW = PAGE_W - PAGE_MARGIN * 2;
    const maxH = PAGE_H - PAGE_MARGIN * 2 - 24;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawText(caption, { x: PAGE_MARGIN, y: PAGE_H - PAGE_MARGIN + 4, size: 9, font, color: rgb(0.42, 0.45, 0.5) });
    page.drawImage(img, { x: (PAGE_W - w) / 2, y: (PAGE_H - 24 - h) / 2, width: w, height: h });
    appended++;
  };

  const fetchAsset = async (url: string): Promise<{ bytes: Buffer; contentType: string } | null> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_MERGE_FILE_BYTES) return null;
      return { bytes, contentType: (res.headers.get('content-type') || '').toLowerCase() };
    } catch {
      return null;
    }
  };

  for (const q of quotes) {
    if (q.estimate_attach?.diagram && q.diagram_path) {
      const asset = await fetchAsset(r2PublicUrl('vehicle-templates', q.diagram_path));
      if (asset) {
        // Diagrams are rendered as PNG by the estimator.
        try { await addImagePage(asset.bytes, 'image/png', `Coverage — Quote ${q.quote_number}`); }
        catch (err: any) { console.warn('[estimate-pdf] diagram embed failed:', err?.message); }
      }
    }
    if (q.estimate_attach?.attachments) {
      for (const a of (Array.isArray(q.attachments) ? q.attachments : [])) {
        if (appended >= MAX_APPENDED_PAGES) break;
        if (!a?.path) continue;
        const asset = await fetchAsset(r2PublicUrl('vehicle-templates', a.path));
        if (!asset) continue;
        const label = `${a.name || 'Attachment'} — Quote ${q.quote_number}`;
        try {
          if (asset.contentType.includes('pdf') || /\.pdf$/i.test(a.name || a.path)) {
            const src = await PDFDocument.load(asset.bytes, { ignoreEncryption: true });
            const idx = src.getPageIndices().slice(0, MAX_APPENDED_PAGES - appended);
            const pages = await out.copyPages(src, idx);
            for (const p of pages) { out.addPage(p); appended++; }
          } else if (asset.contentType.includes('png') || asset.contentType.includes('jpeg') || asset.contentType.includes('jpg')) {
            await addImagePage(asset.bytes, asset.contentType, label);
          }
          // Other types (design source files etc.) aren't page-mergeable — skip.
        } catch (err: any) {
          console.warn(`[estimate-pdf] attachment merge failed (${a.name}):`, err?.message);
        }
      }
    }
  }

  return Buffer.from(await out.save());
}
