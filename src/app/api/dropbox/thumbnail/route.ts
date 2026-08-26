import { NextRequest, NextResponse } from 'next/server';
import { getThumbnail } from '@/lib/dropbox';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * Get a thumbnail for a Dropbox file.
 * GET /api/dropbox/thumbnail?path=/path/to/file.pdf&size=w256h256
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const path = req.nextUrl.searchParams.get('path');
    const size = (req.nextUrl.searchParams.get('size') || 'w256h256') as any;

    if (!path) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    const { buffer, contentType } = await getThumbnail(path, size);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600', // cache 1hr
      },
    });
  } catch (err: any) {
    console.error('Dropbox thumbnail error:', err);
    return NextResponse.json({ error: err.message || 'Thumbnail failed' }, { status: 500 });
  }
}
