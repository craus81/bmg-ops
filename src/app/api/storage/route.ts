import { NextRequest, NextResponse } from 'next/server';
import { r2Upload, r2Delete, r2Get, r2PublicUrl } from '@/lib/r2';
import { requireAuth } from '@/lib/api-auth';
import { checkStoragePath } from '@/lib/storage-guard';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const DeleteSchema = z.object({
  bucket: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(1000),
});

// GET — stream a file from R2. This is the URL storage.getPublicUrl() falls
// back to when NEXT_PUBLIC_R2_PUBLIC_URL isn't configured, so without it
// those links 405'd.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const bucket = req.nextUrl.searchParams.get('bucket')?.trim() || '';
  const path = req.nextUrl.searchParams.get('path')?.trim() || '';
  if (!bucket || !path || bucket.length > 80 || path.length > 1000) {
    return NextResponse.json({ error: 'Missing bucket or path' }, { status: 400 });
  }
  const readErr = checkStoragePath(bucket, path, { write: false });
  if (readErr) return NextResponse.json({ error: readErr }, { status: 403 });

  try {
    const result = await r2Get(bucket, path);
    if (!result.success || !result.body) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    return new NextResponse(result.body as any, {
      headers: {
        'Content-Type': result.contentType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err: any) {
    console.error('Storage read error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST — upload a file to R2
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const bucket = formData.get('bucket') as string; // e.g. 'photos', 'proofs'
    const path = formData.get('path') as string;     // e.g. 'vehicle123/1234567890.jpg'

    if (!file || !bucket || !path) {
      return NextResponse.json({ error: 'Missing file, bucket, or path' }, { status: 400 });
    }
    const writeErr = checkStoragePath(bucket, path, { write: true });
    if (writeErr) return NextResponse.json({ error: writeErr }, { status: 403 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await r2Upload(bucket, path, buffer, file.type);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      key: result.key,
      publicUrl: result.publicUrl,
    });
  } catch (err: any) {
    console.error('Storage upload error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — delete a file from R2
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteSchema);
  if (parsed.error) return parsed.error;
  const { bucket, path } = parsed.data;
  const delErr = checkStoragePath(bucket, path, { write: true });
  if (delErr) return NextResponse.json({ error: delErr }, { status: 403 });

  try {
    const result = await r2Delete(bucket, path);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Storage delete error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
