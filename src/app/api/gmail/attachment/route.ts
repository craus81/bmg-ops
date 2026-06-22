import { NextRequest, NextResponse } from 'next/server';
import { getAttachment, proofContentType } from '@/lib/google';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Stream a single Gmail attachment's bytes so the proof picker can preview it
// before it's attached. Loaded via <img> / pdfjs (same-origin), which can't set
// a bearer header, so this relies on cookie auth like /api/dropbox/thumbnail.
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const messageId = req.nextUrl.searchParams.get('messageId');
  const attachmentId = req.nextUrl.searchParams.get('attachmentId');
  const filename = req.nextUrl.searchParams.get('filename') || 'proof';
  if (!messageId || !attachmentId) {
    return NextResponse.json({ error: 'messageId and attachmentId are required' }, { status: 400 });
  }

  try {
    const base64 = await getAttachment(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': proofContentType(filename),
        // Private: this is a single user's mail. Short cache so re-renders in
        // the picker don't re-download the same attachment.
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected' }, { status: 401 });
    }
    console.error('gmail attachment error:', err);
    return NextResponse.json({ error: err.message || 'Failed to load attachment' }, { status: 500 });
  }
}
