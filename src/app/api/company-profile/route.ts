import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { r2Get, r2PublicUrl } from '@/lib/r2';

export const dynamic = 'force-dynamic';

/**
 * GET /api/company-profile
 *
 * The company letterhead used on outgoing documents — name, address, phone,
 * email, and logo — from the same `wrap_quote_settings.company` singleton the
 * wrap-quote builder edits (Settings → Company on that page), so quotes and
 * statements always carry identical branding.
 *
 * Auth is plain requireAuth rather than requireStaff: this is the letterhead
 * we print on documents we email to customers (not internal data), and both
 * staff (Customer Record statements) and the executive-only Financials
 * drill-down need it — executive fails requireStaff.
 *
 * The logo comes back as a data URL because jsPDF's addImage needs bytes and
 * the R2 public origin would otherwise be a cross-origin fetch. Everything is
 * optional — callers render a text-only letterhead when it's absent.
 *
 * Response: { success, company: {...}, logoDataUrl, logoUrl }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { data } = await supabase.from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle();
    const c: any = data?.company || {};

    const company = {
      name: c.name || null,
      address: c.address || null,
      city: c.city || null,
      state: c.state || null,
      zip: c.zip || null,
      phone: c.phone || null,
      email: c.email || null,
    };

    let logoDataUrl: string | null = null;
    const logoUrl = c.logo_path ? r2PublicUrl('vehicle-templates', c.logo_path) : null;
    if (c.logo_path) {
      try {
        const result = await r2Get('vehicle-templates', c.logo_path);
        if (result.success && result.body) {
          const chunks: Buffer[] = [];
          for await (const chunk of result.body as any) {
            chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
          }
          const buf = Buffer.concat(chunks);
          // Cap the inline payload — a huge logo isn't worth stalling every
          // statement render; callers fall back to the text letterhead.
          if (buf.length > 0 && buf.length <= 2 * 1024 * 1024) {
            const type = result.contentType || (/\.jpe?g$/i.test(c.logo_path) ? 'image/jpeg' : 'image/png');
            logoDataUrl = `data:${type};base64,${buf.toString('base64')}`;
          }
        }
      } catch { /* logo is optional — never fail the profile over it */ }
    }

    return NextResponse.json({ success: true, company, logoDataUrl, logoUrl });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load company profile' }, { status: 500 });
  }
}
