import { NextResponse } from 'next/server';
import { isConnected } from '@/lib/dropbox';

export const dynamic = 'force-dynamic';

/**
 * Check if Dropbox is connected.
 * GET /api/dropbox/status
 */
export async function GET() {
  try {
    const connected = await isConnected();
    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
