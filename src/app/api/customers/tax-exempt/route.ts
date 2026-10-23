import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { setCustomerTaxable } from '@/lib/netsuite';
import { staffTaxExemptPatch } from '@/lib/customer-tax-exempt';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  customerId: z.string().uuid(),
  taxExempt: z.boolean(),
});

/**
 * POST /api/customers/tax-exempt — set a customer tax exempt or taxed, from
 * the customer page's Sales tax card or an estimate's Edit defaults (owner,
 * 2026-10-23: "A", carry it to NetSuite). A linked customer's Taxable box
 * in NetSuite is changed first; if NetSuite refuses, nothing is saved here,
 * so the two never disagree. Staff-wide, like the estimate's Edit defaults
 * that already set this flag. Audited on the customer row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { customerId, taxExempt } = parsed.data;

  const supabase = createServiceClient();
  const { data: customer, error: readError } = await supabase
    .from('customers')
    .select('id, netsuite_id, tax_exempt, netsuite_taxable')
    .eq('id', customerId)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const netsuiteId = customer.netsuite_id ? String(customer.netsuite_id) : null;
  let netsuite: 'updated' | 'not_linked' = 'not_linked';
  if (netsuiteId) {
    const pushed = await setCustomerTaxable(netsuiteId, !taxExempt);
    if (!pushed.success) {
      return NextResponse.json(
        { error: `NetSuite wouldn't change Taxable on this customer, so nothing was saved: ${pushed.error}` },
        { status: 502 },
      );
    }
    netsuite = 'updated';
  }

  const patch = {
    ...staffTaxExemptPatch(taxExempt),
    ...(netsuite === 'updated' ? { netsuite_taxable: !taxExempt } : {}),
  };
  const { error } = await supabase.from('customers').update(patch).eq('id', customerId);
  if (error) {
    return NextResponse.json(
      { error: `NetSuite was changed but FleetSuite couldn't save: ${error.message}. Try again.` },
      { status: 500 },
    );
  }

  await logAudit(supabase, {
    actorId: auth.user.id, table: 'customers', recordId: customerId, action: taxExempt ? 'tax_exempt_on' : 'tax_exempt_off',
    detail: { was_tax_exempt: !!customer.tax_exempt, netsuite },
  });
  return NextResponse.json({ success: true, netsuite });
}
