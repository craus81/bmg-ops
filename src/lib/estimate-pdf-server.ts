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
import { buildEstimatePdf, estimatePdfFilename, type EstimatePdfImage, type EstimatePdfLine } from './estimate-pdf';

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

  const doc = buildEstimatePdf({ estimate, lines, company, logo });
  if (opts.print) doc.autoPrint();

  return {
    ok: true,
    buffer: Buffer.from(doc.output('arraybuffer')),
    filename: estimatePdfFilename(estimate),
    estimate,
  };
}
