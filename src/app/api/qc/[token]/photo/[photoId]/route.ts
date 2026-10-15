import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { isUuid } from '@/lib/qc-fixes';
import { qcPhotoSignedUrl, resolveQcCustomer } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/qc/[token]/photo/[photoId] — one QC fix photo through the
 * customer's link (the page and the emails both point here). Redirects to a
 * short-lived signed R2 URL; only this customer's photos resolve.
 * `?download=1` saves it under its name.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string; photoId: string } }) {
  if (!await checkRateLimit(getRequestIp(req), 'qc_link_photo_get', 1200)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }
  const customer = await resolveQcCustomer(supabase, params.token);
  if (!customer || !isUuid(params.photoId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { data: photo } = await supabase
    .from('qc_fix_photos').select('storage_path, file_name, customer_id')
    .eq('id', params.photoId).eq('customer_id', customer.id).maybeSingle();
  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const url = await qcPhotoSignedUrl(photo, req.nextUrl.searchParams.get('download') === '1');
    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, max-age=600' } });
  } catch (err) {
    console.error('qc photo presign failed:', err);
    return NextResponse.json({ error: 'Could not load the photo' }, { status: 500 });
  }
}
