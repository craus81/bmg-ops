/**
 * Server-side generation of the FleetSuite wrap-quote PDF — ONE
 * loader/renderer for every surface that hands out the file (the in-app
 * view/download endpoint, the quote email, the follow-up email), so what
 * staff open off the customer record is byte-for-byte what the customer
 * receives.
 *
 * Built from the shared quote-document model (wrapQuoteDocModel → the same
 * rows the emailed quote and the signed snapshot render) with the company
 * letterhead inlined, via buildQuoteDocPdf (src/lib/quote-doc-pdf.ts).
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { r2GetBytes } from './r2';
import { buildQuoteDocPdf, type QuoteDocPdfImage } from './quote-doc-pdf';
import { wrapQuoteDocModel } from './wrap-quote-document';

const MAX_LOGO_BYTES = 3 * 1024 * 1024;

/** File name for the generated PDF, shared by the view and email routes. */
export function wrapQuotePdfFilename(quote: any): string {
  const num = String(quote?.quote_number || quote?.id || 'quote').replace(/[^\w-]+/g, '_');
  return `Wrap-Quote-${num}.pdf`;
}

export type WrapQuotePdfResult =
  | { ok: true; buffer: Buffer; filename: string; quote: any }
  | { ok: false; status: number; error: string };

export interface WrapQuotePdfOptions {
  /** Show the itemized rows. Defaults to the quote's stored customer-facing
   *  choice (`hide_line_items`), so a copy handed out later matches what
   *  the customer was shown. */
  lineItems?: boolean;
  /** Pass an already-loaded wrap_quotes row (select '*') to skip the fetch. */
  quote?: any;
  print?: boolean;
}

export async function generateWrapQuotePdf(
  supabase: SupabaseClient,
  quoteId: string,
  opts: WrapQuotePdfOptions = {},
): Promise<WrapQuotePdfResult> {
  let quote = opts.quote;
  if (!quote) {
    const { data, error } = await supabase
      .from('wrap_quotes')
      .select('*')
      .eq('id', quoteId)
      .single();
    if (error || !data) return { ok: false, status: 404, error: 'Quote not found' };
    quote = data;
  }

  // Letterhead — the same settings singleton the emailed quote uses.
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || null;
  let logo: QuoteDocPdfImage | null = null;
  if (company?.logo_path) {
    const got = await r2GetBytes('vehicle-templates', company.logo_path, MAX_LOGO_BYTES);
    const format = got?.contentType.includes('png') ? 'PNG'
      : (got?.contentType.includes('jpeg') || got?.contentType.includes('jpg')) ? 'JPEG'
        : null;
    if (got && format) {
      logo = {
        dataUrl: `data:${format === 'PNG' ? 'image/png' : 'image/jpeg'};base64,${got.bytes.toString('base64')}`,
        format,
      };
    }
  }

  // The PDF copy always prices the quote (it's the transaction of record);
  // line items follow the sender's customer-facing choice. The coverage
  // diagram is an emails-only element (a mutable R2 object) and stays out.
  const lineItems = opts.lineItems ?? !quote.hide_line_items;
  const doc = buildQuoteDocPdf(
    wrapQuoteDocModel(quote, { pricing: true, lineItems }),
    { company, logo },
  );
  if (opts.print) doc.autoPrint();

  return {
    ok: true,
    buffer: Buffer.from(doc.output('arraybuffer')),
    filename: wrapQuotePdfFilename(quote),
    quote,
  };
}
