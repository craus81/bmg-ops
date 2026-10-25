import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { isValidVIN } from '@/lib/vin-decoder';
import { parseCarsxeSpecs } from '@/lib/vin-factory-data';

/**
 * GET /api/vin-lookup?vin=…&cab=… — paid factory data (CarsXE /specs) for
 * the VIN Lookup window. Server-side so the key stays out of the browser.
 * Each call costs (~$0.10 per VIN found), so the window calls it once per
 * lookup, after the free NHTSA decode. `configured: false` when the key
 * isn't set, so the window just shows NHTSA.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const key = process.env.CARSXE_API_KEY;
  if (!key) return NextResponse.json({ configured: false });

  const vin = (req.nextUrl.searchParams.get('vin') || '').toUpperCase();
  if (!isValidVIN(vin)) return NextResponse.json({ error: 'Not a valid VIN' }, { status: 400 });
  const cab = req.nextUrl.searchParams.get('cab') || '';

  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const res = await fetch(
      `https://api.carsxe.com/specs?key=${encodeURIComponent(key)}&vin=${vin}`,
      { signal: c.signal, cache: 'no-store' },
    );
    const json = await res.json().catch(() => null);
    const data = parseCarsxeSpecs(json, cab);
    if (!data) {
      // CarsXE answers a miss with success:false and a message; pass that on.
      const msg = json?.message || json?.error || (res.ok ? 'No factory data for this VIN' : `CarsXE error ${res.status}`);
      return NextResponse.json({ configured: true, found: false, message: String(msg).slice(0, 200) });
    }
    return NextResponse.json({ configured: true, found: true, data });
  } catch {
    return NextResponse.json({ configured: true, found: false, message: "Couldn't reach CarsXE" });
  } finally {
    clearTimeout(t);
  }
}
