import { NextRequest, NextResponse } from 'next/server';
import { loadPhotoShare } from '@/lib/photo-shares';
import { r2PresignGet } from '@/lib/r2';

export const dynamic = 'force-dynamic';

/**
 * GET /api/shared-photos/[token]/[photoId]
 *
 * One photo from a shared link, for a customer with no FleetSuite login.
 * The share token is the credential, and only a photo pinned on that share
 * is served. Redirects to a short-lived signed R2 URL (as
 * /api/storage/download does for staff), so full-size photos never pass
 * through a serverless response.
 *
 *   ?download=1   save it, under its readable name
 *   ?format=json  { url } instead of a redirect (the page's "Download all"
 *                 fetches each photo itself to build the zip)
 */
export async function GET(req: NextRequest, { params }: { params: { token: string; photoId: string } }) {
  const share = await loadPhotoShare(params.token);
  if (share.status === 'expired') return NextResponse.json({ error: 'This link has expired' }, { status: 410 });
  if (share.status !== 'ok') return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const photoId = decodeURIComponent(params.photoId);
  const photo = share.photos.find(p => p.id === photoId);
  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const q = req.nextUrl.searchParams;
  try {
    const url = await r2PresignGet('photos', photo.storagePath, {
      filename: photo.fileName,
      disposition: q.get('download') === '1' ? 'attachment' : 'inline',
      expiresIn: 3600,
    });
    if (q.get('format') === 'json') {
      return NextResponse.json({ url, fileName: photo.fileName }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('Shared photo presign error:', err);
    return NextResponse.json({ error: 'Could not load the photo' }, { status: 500 });
  }
}
