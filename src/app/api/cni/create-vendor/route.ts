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
  // Mailing address from the NetSuite vendor record ({street, city, state,
  // zip} — the shape companies.address already uses).
  address: z.object({
    street: z.string().trim().max(200).optional().default(''),
    city: z.string().trim().max(80).optional().default(''),
    state: z.string().trim().max(40).optional().default(''),
    zip: z.string().trim().max(20).optional().default(''),
  }).optional().nullable(),
  // Link an EXISTING NetSuite vendor (numeric Internal ID from vendor
  // search) instead of creating a new one.
  netsuiteVendorId: z.string().regex(/^\d+$/).optional(),
}).refine(b => b.companyId || b.name, { message: 'companyId or name is required' });

// ilike patterns treat % and _ as wildcards — escape them so a typed name
// can only ever match itself (case-insensitively).
const escapeLike = (s: string) => s.replace(/[\\%_]/g, ch => `\\${ch}`);

// vendorUrl reads NetSuite env config and throws when it's missing — the
// link is cosmetic, so degrade to undefined instead of failing the request.
const safeVendorUrl = (id: string | null | undefined): string | undefined => {
  if (!id || !/^\d+$/.test(id)) return undefined;
  try { return vendorUrl(id); } catch { return undefined; }
};

/**
 * Add a CNI installer as a payable vendor: find-or-create the local
 * companies row, then create the matching NetSuite vendor and store its
 * numeric Internal ID on the company. If a member of the company already
 * has a personal vendor ID (cni_profiles.netsuite_vendor_id, used by
 * individual-mode payouts), that ID is adopted instead of minting a second
 * NetSuite vendor for the same person. A NetSuite failure still saves the
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
      // companies.name has no unique constraint — limit(1) so duplicates
      // resolve to one row instead of erroring (and never wildcard-match).
      const { data: existing } = await service
        .from('companies')
        .select('id, name, netsuite_vendor_id')
        .ilike('name', escapeLike(name))
        .order('name')
        .limit(1);
      if (existing && existing.length > 0) {
        company = existing[0];
      } else {
        const { data: created, error: createErr } = await service
          .from('companies')
          .insert({
            name,
            email: body.email || null,
            phone: body.phone || null,
            address: body.address || {},
          })
          .select('id, name, netsuite_vendor_id')
          .single();
        if (createErr || !created) {
          return NextResponse.json({ error: `Failed to create company: ${createErr?.message}` }, { status: 500 });
        }
        company = created;
      }
    }

    // Backfill contact info from the NetSuite record onto an existing
    // company — fills blanks only, never overwrites something typed here.
    if (body.email || body.phone || body.address) {
      const { data: current } = await service
        .from('companies')
        .select('email, phone, address')
        .eq('id', company.id)
        .maybeSingle();
      const backfill: Record<string, unknown> = {};
      if (body.email && !current?.email) backfill.email = body.email;
      if (body.phone && !current?.phone) backfill.phone = body.phone;
      const hasAddress = current?.address && Object.values(current.address).some(v => !!v);
      if (body.address && !hasAddress) backfill.address = body.address;
      if (Object.keys(backfill).length > 0) {
        await service.from('companies').update(backfill).eq('id', company.id);
      }
    }

    // Already linked to a NetSuite vendor — nothing to create.
    if (company.netsuite_vendor_id) {
      return NextResponse.json({
        success: true,
        companyId: company.id,
        companyName: company.name,
        netsuiteVendorId: company.netsuite_vendor_id,
        netsuiteUrl: safeVendorUrl(company.netsuite_vendor_id),
        alreadyExists: true,
        ...(body.netsuiteVendorId && body.netsuiteVendorId !== company.netsuite_vendor_id
          ? { vendorError: `Company is already linked to NetSuite vendor #${company.netsuite_vendor_id} — not changed to #${body.netsuiteVendorId}.` }
          : {}),
      });
    }

    // Linking a vendor that already exists in NetSuite — no create needed.
    if (body.netsuiteVendorId) {
      const { error: linkErr } = await service
        .from('companies')
        .update({ netsuite_vendor_id: body.netsuiteVendorId })
        .eq('id', company.id);
      if (linkErr) {
        return NextResponse.json({ error: `Failed to link vendor: ${linkErr.message}` }, { status: 500 });
      }
      return NextResponse.json({
        success: true,
        companyId: company.id,
        companyName: company.name,
        netsuiteVendorId: body.netsuiteVendorId,
        netsuiteUrl: safeVendorUrl(body.netsuiteVendorId),
        linked: true,
      });
    }

    // A member may already BE a NetSuite vendor via individual-mode payouts
    // (cni_profiles.netsuite_vendor_id). Adopt a single unambiguous personal
    // ID rather than creating a duplicate vendor for the same installer.
    const { data: members } = await service
      .from('profiles').select('id').eq('company_id', company.id);
    if (members && members.length > 0) {
      const { data: cniProfiles } = await service
        .from('cni_profiles')
        .select('netsuite_vendor_id')
        .in('user_id', members.map(m => m.id))
        .not('netsuite_vendor_id', 'is', null);
      const personalIds = [...new Set(
        (cniProfiles || [])
          .map(p => (p.netsuite_vendor_id || '').trim())
          .filter(v => /^\d+$/.test(v)),
      )];
      if (personalIds.length === 1) {
        const { error: adoptErr } = await service
          .from('companies')
          .update({ netsuite_vendor_id: personalIds[0] })
          .eq('id', company.id);
        return NextResponse.json({
          success: true,
          companyId: company.id,
          companyName: company.name,
          netsuiteVendorId: personalIds[0],
          netsuiteUrl: safeVendorUrl(personalIds[0]),
          alreadyExists: true,
          ...(adoptErr ? { vendorError: `Existing vendor #${personalIds[0]} found but could not be saved on the company: ${adoptErr.message}` } : {}),
        });
      }
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

    const { error: saveErr } = await service
      .from('companies')
      .update({ netsuite_vendor_id: vendor.internalId })
      .eq('id', company.id);
    if (saveErr) {
      // The vendor exists in NetSuite — report the id so it can be saved
      // manually on the company page instead of minting another on retry.
      return NextResponse.json({
        success: true,
        companyId: company.id,
        companyName: company.name,
        netsuiteVendorId: vendor.internalId,
        netsuiteUrl: vendor.netsuiteUrl,
        vendorError: `Vendor #${vendor.internalId} created in NetSuite but could not be saved locally: ${saveErr.message}. Add it on the company page.`,
      });
    }

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
