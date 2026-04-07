import { NextRequest, NextResponse } from 'next/server';
import { isConnected } from '@/lib/dropbox';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * Check if Dropbox is connected.
 * GET /api/dropbox/status
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const connected = await isConnected();
    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
