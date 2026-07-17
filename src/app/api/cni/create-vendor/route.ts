import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createVendor, vendorUrl } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
// NetSuite record creates are slow.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  // Either attach a vendor to an existing company…
  companyId: z.string().uuid().optional(),
  // …or find-or-create a company by name (solo installers get a one-person
  // company, same policy as migration 122 / the CNI invite flow).
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
}).refine(b => b.companyId || b.name, { message: 'companyId or name is required' });

/**
 * Add a CNI installer as a payable vendor: find-or-create the local
 * companies row, then create the matching NetSuite vendor and store its
 * numeric Internal ID on the company. A NetSuite failure still saves the
 * local company (the invoice can be recorded; the vendor ID can be added
 * later on the company page) and is returned as `vendorError`.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    let company: { id: string; name: string; netsuite_vendor_id: string | null } | null = null;

    if (body.companyId) {
      const { data } = await service
        .from('companies')
        .select('id, name, netsuite_vendor_id')
        .eq('id', body.companyId)
        .maybeSingle();
      if (!data) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      company = data;
    } else {
      const name = body.name!;
      const { data: existing } = await service
        .from('companies')
        .select('id, name, netsuite_vendor_id')
        .ilike('name', name)
        .maybeSingle();
      if (existing) {
        company = existing;
      } else {
        const { data: created, error: createErr } = await service
          .from('companies')
          .insert({
            name,
            email: body.email || null,
            phone: body.phone || null,
          })
          .select('id, name, netsuite_vendor_id')
          .single();
        if (createErr || !created) {
          return NextResponse.json({ error: `Failed to create company: ${createErr?.message}` }, { status: 500 });
        }
        company = created;
      }
    }

    // Already linked to a NetSuite vendor — nothing to create.
    if (company.netsuite_vendor_id) {
      return NextResponse.json({
        success: true,
        companyId: company.id,
        companyName: company.name,
        netsuiteVendorId: company.netsuite_vendor_id,
        netsuiteUrl: /^\d+$/.test(company.netsuite_vendor_id) ? vendorUrl(company.netsuite_vendor_id) : undefined,
        alreadyExists: true,
      });
    }

    const vendor = await createVendor({
      companyName: company.name,
      email: body.email || undefined,
      phone: body.phone || undefined,
    });

    if (!vendor.success || !vendor.internalId) {
      return NextResponse.json({
        success: true,
        companyId: company.id,
        companyName: company.name,
        netsuiteVendorId: null,
        vendorError: vendor.error || 'NetSuite did not return a vendor id',
      });
    }

    await service
      .from('companies')
      .update({ netsuite_vendor_id: vendor.internalId })
      .eq('id', company.id);

    return NextResponse.json({
      success: true,
      companyId: company.id,
      companyName: company.name,
      netsuiteVendorId: vendor.internalId,
      netsuiteUrl: vendor.netsuiteUrl,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to create vendor' }, { status: 500 });
  }
}
