import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { getVendorContact, vendorUrl } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/cni/vendor-link?id=<internal id>
 *
 * Sends the browser to the NetSuite vendor record. The NetSuite URL needs
 * the account id, which only the server has, so links in the app point here
 * (deepLinks.netsuiteVendor) instead of building the URL client-side.
 *
 * With `&info=1` it returns { found, companyName } instead — the company
 * page shows the linked vendor's NetSuite name next to its id, so a wrong
 * id reads as the wrong name rather than going unnoticed until a bill fails.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const id = (req.nextUrl.searchParams.get('id') || '').trim();
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'A numeric NetSuite vendor id is required' }, { status: 400 });
  }

  if (req.nextUrl.searchParams.get('info') === '1') {
    const vendor = await getVendorContact(id);
    return NextResponse.json({
      found: vendor.found,
      companyName: vendor.companyName || null,
      ...(vendor.found ? {} : { error: vendor.error || 'Vendor not found in NetSuite' }),
    });
  }

  try {
    return NextResponse.redirect(vendorUrl(id));
  } catch {
    return NextResponse.json({ error: 'NetSuite is not configured' }, { status: 500 });
  }
}
