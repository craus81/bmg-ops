import { NextRequest, NextResponse } from 'next/server';
import { r2PresignPut, ensureR2Cors } from '@/lib/r2';
import { requireAuth } from '@/lib/api-auth';
import { checkStoragePath } from '@/lib/storage-guard';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  bucket: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(1000),
  contentType: z.string().max(120).optional(),
});

// POST — return a presigned PUT URL for uploading directly to R2
// Used for files that would otherwise exceed the 4.5MB API body limit.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { bucket, path, contentType } = parsed.data;
  // A presigned PUT is a write — restrict to the app's known prefixes and
  // never hand out a signed URL for the signed-documents legal snapshots.
  const writeErr = checkStoragePath(bucket, path, { write: true });
  if (writeErr) return NextResponse.json({ error: writeErr }, { status: 403 });

  try {
    // The presigned PUT is a cross-origin browser request — make sure the
    // bucket will answer its CORS preflight before handing out the URL.
    await ensureR2Cors();

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
