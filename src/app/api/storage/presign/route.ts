import { NextRequest, NextResponse } from 'next/server';
import { r2PresignPut } from '@/lib/r2';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

// POST — return a presigned PUT URL for uploading directly to R2
// Used for files that would otherwise exceed the 4.5MB API body limit.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { bucket, path, contentType } = await req.json();

    if (!bucket || !path) {
      return NextResponse.json({ error: 'Missing bucket or path' }, { status: 400 });
    }

    const result = await r2PresignPut(
      bucket,
      path,
      contentType || 'application/octet-stream',
    );

    return NextResponse.json({
      success: true,
      url: result.url,
      key: result.key,
      publicUrl: result.publicUrl,
    });
  } catch (err: any) {
    console.error('Storage presign error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
