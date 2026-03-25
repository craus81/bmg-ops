import { NextRequest, NextResponse } from 'next/server';
import { r2Upload, r2Delete, r2PublicUrl } from '@/lib/r2';

export const dynamic = 'force-dynamic';

// POST — upload a file to R2
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const bucket = formData.get('bucket') as string; // e.g. 'photos', 'proofs'
    const path = formData.get('path') as string;     // e.g. 'vehicle123/1234567890.jpg'

    if (!file || !bucket || !path) {
      return NextResponse.json({ error: 'Missing file, bucket, or path' }, { status: 400 });
    }

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
  try {
    const { bucket, path } = await req.json();

    if (!bucket || !path) {
      return NextResponse.json({ error: 'Missing bucket or path' }, { status: 400 });
    }

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
