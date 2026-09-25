import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, storageAccessOf } from '@/lib/api-auth';
import { checkStoragePath } from '@/lib/storage-guard';
import { r2PresignGet } from '@/lib/r2';

export const dynamic = 'force-dynamic';

/**
 * GET /api/storage/download?bucket=…&path=…&name=…&disposition=inline|attachment
 *
 * Redirects to a short-lived presigned R2 GET whose
 * response-content-disposition carries the record's original file name
 * (e.g. graphics_job_files.file_name). Objects live under randomized
 * storage keys, so linking the public URL directly saves downloads as
 * "<timestamp>-<rand>.<ext>" — only a signed URL can rename. Redirecting
 * instead of proxying keeps multi-hundred-MB design files off the
 * serverless response path.
 *
 * format=json returns { url } instead of redirecting. The iPhone app uses it:
 * a link there opens in Safari, which has no FleetSuite session, so the app
 * fetches the file itself (credentials omitted, so R2's `*` CORS rule
 * applies) and shows it in-app or hands it to the share sheet.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const q = req.nextUrl.searchParams;
  const bucket = q.get('bucket')?.trim() || '';
  const path = q.get('path')?.trim() || '';
  const name = q.get('name')?.trim() || '';
  const disposition = q.get('disposition') === 'attachment' ? 'attachment' as const : 'inline' as const;
  if (!bucket || !path || bucket.length > 80 || path.length > 1000 || name.length > 300) {
    return NextResponse.json({ error: 'Missing or invalid bucket/path/name' }, { status: 400 });
  }
  const readErr = checkStoragePath(bucket, path, { write: false, access: storageAccessOf(auth.profile) });
  if (readErr) return NextResponse.json({ error: readErr }, { status: 403 });

  try {
    const url = await r2PresignGet(bucket, path, {
      filename: name || path.split('/').pop() || 'file',
      disposition,
    });
    if (q.get('format') === 'json') {
      return NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('Storage download presign error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
