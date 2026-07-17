import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { findVendors } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const QuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
});

/**
 * Live NetSuite vendor search for the vendor-invoice picker — existing
 * NetSuite vendors get LINKED to a FleetSuite company instead of a duplicate
 * vendor being created. Errors (e.g. the role lacking vendor SuiteQL access)
 * come back as `error` so the UI can quietly fall back to local companies.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, QuerySchema);
  if (parsed.error) return parsed.error;

  const result = await findVendors(parsed.data.q);
  return NextResponse.json({ vendors: result.vendors, ...(result.error ? { error: result.error } : {}) });
}
