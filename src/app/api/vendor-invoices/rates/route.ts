import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const QuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  vendorName: z.string().trim().min(1).max(160).optional(),
}).refine(q => q.companyId || q.vendorName, { message: 'companyId or vendorName required' });

/**
 * What a vendor last billed us per part — derived live from
 * vendor_invoice_lines (newest priced line per part), so it's always the
 * current memory of e.g. "Slide Wraps charges $145 for 06T895". Used to
 * pre-fill amounts on the next invoice from the same installer.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, QuerySchema);
  if (parsed.error) return parsed.error;
  const { companyId, vendorName } = parsed.data;

  try {
    let q = service
      .from('vendor_invoice_lines')
      .select('part_number, amount, created_at, invoice:vendor_invoices!inner(invoice_number, invoice_date, company_id, vendor_name)')
      .not('amount', 'is', null)
      .not('part_number', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (companyId) q = q.eq('invoice.company_id', companyId);
    else q = q.ilike('invoice.vendor_name', vendorName!.replace(/[\\%_]/g, ch => `\\${ch}`));

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Newest priced line per part wins.
    const rates: Record<string, { amount: number; invoiceNumber: string | null; date: string | null }> = {};
    for (const l of data || []) {
      const key = (l.part_number as string).toUpperCase();
      if (rates[key]) continue;
      const inv = Array.isArray(l.invoice) ? l.invoice[0] : l.invoice;
      rates[key] = {
        amount: Number(l.amount),
        invoiceNumber: inv?.invoice_number ?? null,
        date: inv?.invoice_date ?? (l.created_at ? String(l.created_at).slice(0, 10) : null),
      };
    }

    return NextResponse.json({ rates });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Rates lookup failed' }, { status: 500 });
  }
}
