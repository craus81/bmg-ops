import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadQuoteListItems, type QuoteListStatus } from '@/lib/quote-list';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const STATUSES: QuoteListStatus[] = ['working', 'sent', 'won', 'lost', 'all'];

/**
 * GET /api/quotes?status=working|sent|won|lost|all — the combined quotes
 * list: estimates and wrap quotes as one stream (src/lib/quote-list.ts),
 * with follow-up history folded onto sent quotes. Follow-up actions stay
 * on POST /api/quotes/follow-up.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const raw = req.nextUrl.searchParams.get('status') || 'all';
  const status = (STATUSES as string[]).includes(raw) ? (raw as QuoteListStatus) : 'all';
  try {
    const items = await loadQuoteListItems(service, status);
    return NextResponse.json({ items });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
