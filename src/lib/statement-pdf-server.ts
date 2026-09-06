/**
 * Server-side generation of the customer statement PDF — the PDF copy the
 * statement email attaches (CLAUDE.md "every transaction email carries a
 * PDF copy"). Built by the same pure renderer the in-app Statement PDF /
 * Print buttons use (src/lib/statement-pdf-doc.ts), with the company
 * letterhead loaded from the same settings singleton and the logo read
 * through R2 credentials, so what staff open is byte-for-byte what the
 * customer receives.
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { r2GetBytes } from './r2';
import { buildStatementPdf, statementPdfFilename, type CompanyProfile, type StatementPdfData } from './statement-pdf-doc';

// Same cap as /api/company-profile — a huge logo isn't worth stalling every
// statement render; the text letterhead is the fallback.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export type StatementPdfResult =
  | { ok: true; buffer: Buffer; filename: string }
  | { ok: false; status: number; error: string };

export async function generateStatementPdf(
  supabase: SupabaseClient,
  data: Omit<StatementPdfData, 'letterhead'>,
): Promise<StatementPdfResult> {
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const c: any = settings?.company || {};
  const company: CompanyProfile = {
    name: c.name || null,
    address: c.address || null,
    city: c.city || null,
    state: c.state || null,
    zip: c.zip || null,
    phone: c.phone || null,
    email: c.email || null,
  };

  let logoDataUrl: string | null = null;
  if (c.logo_path) {
    const got = await r2GetBytes('vehicle-templates', c.logo_path, MAX_LOGO_BYTES);
    if (got && got.bytes.byteLength > 0) {
      const type = got.contentType || (/\.jpe?g$/i.test(c.logo_path) ? 'image/jpeg' : 'image/png');
      logoDataUrl = `data:${type};base64,${got.bytes.toString('base64')}`;
    }
  }

  const doc = buildStatementPdf({ ...data, letterhead: { company, logoDataUrl } });
  return {
    ok: true,
    buffer: Buffer.from(doc.output('arraybuffer')),
    filename: statementPdfFilename(data.customer),
  };
}
