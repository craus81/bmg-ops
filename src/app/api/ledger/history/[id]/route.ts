import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireMoney } from '@/lib/api-auth';
import { getHistoryDetail } from '@/lib/ledger/history';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/ledger/history/[id] — one QuickBooks sales document from before
 * the cutover: header, lines, and its stored PDF and attachments (opened
 * through GET /api/ledger/documents/[id]). Same wall and same row rules as
 * the list (src/lib/ledger/history.ts), so a post-cutover or NetSuite row
 * answers 404 here rather than leaking past the list's filter.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireMoney(req);
  if (auth.error) return auth.error;

  const id = (params.id || '').trim();
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  try {
    const detail = await getHistoryDetail(createServiceClient(), id);
    if (!detail) return NextResponse.json({ error: 'QuickBooks record not found' }, { status: 404 });
    return NextResponse.json({ success: true, record: detail });
  } catch (err: any) {
    console.error('ledger history detail failed:', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
