import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getVendorContact } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({ companyId: z.string().uuid() });

/**
 * POST /api/cni/refresh-vendor
 *
 * "↻ Refresh from NetSuite" on the CNI company page: re-fetches the
 * linked vendor's current email, phone, and mailing address and
 * OVERWRITES the company's values with them (unlike the add-time import,
 * which only fills blanks — the button is an explicit "NetSuite is
 * right, take theirs"). The company name is left alone.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { companyId } = parsed.data;

  const { data: company } = await service
    .from('companies')
    .select('id, name, netsuite_vendor_id')
    .eq('id', companyId)
    .maybeSingle();
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  if (!company.netsuite_vendor_id) {
    return NextResponse.json({ error: 'This company has no linked NetSuite vendor.' }, { status: 400 });
  }

  const vendor = await getVendorContact(company.netsuite_vendor_id);
  if (!vendor.found) {
    return NextResponse.json({ error: vendor.error || 'Vendor lookup failed' }, { status: 502 });
  }

  const updates = {
    email: vendor.email || null,
    phone: vendor.phone || null,
    address: vendor.address || {},
  };
  const { error: updErr } = await service.from('companies').update(updates).eq('id', companyId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    vendorName: vendor.companyName,
    ...updates,
    // Which query found the address — or exactly why none did, so the UI
    // can show the real cause instead of a silent blank.
    addressLookup: vendor.addressLookup || null,
  });
}
