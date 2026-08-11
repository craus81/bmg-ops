import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { listVendors } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/vendors — every active NetSuite vendor (id + display
 * name). Feeds dropdowns that must match NetSuite's vendor names exactly,
 * like the vendor-asset import's "tag matched parts with this vendor"
 * picker (Craig 2026-08-11: free text drifts; the list shouldn't).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { vendors, error } = await listVendors();
  if (error && vendors.length === 0) return NextResponse.json({ error }, { status: 502 });
  return NextResponse.json({ vendors });
}
