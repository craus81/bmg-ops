import { NextRequest, NextResponse } from 'next/server';
import { searchFiles } from '@/lib/dropbox';

export const dynamic = 'force-dynamic';

/**
 * Search Dropbox for proof files by customer name.
 * GET /api/dropbox/search?q=customer+name
 */
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get('q')?.trim();
    if (!q || q.length < 2) {
      return NextResponse.json({ results: [], error: 'Search term must be at least 2 characters' });
    }

    const results = await searchFiles(q, ['pdf']);

    return NextResponse.json({ results });
  } catch (err: any) {
    console.error('Dropbox search error:', err);

    if (err.message?.includes('not connected') || err.message?.includes('Missing DROPBOX')) {
      return NextResponse.json({ error: 'Dropbox not connected', connected: false }, { status: 400 });
    }

    return NextResponse.json({ error: err.message || 'Search failed' }, { status: 500 });
  }
}
