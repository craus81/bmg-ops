import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sales-orders/print-queue?status=to_print|printed&count=1
 *
 * The board's "To print" list (src/lib/so-print-queue.ts). to_print is
 * oldest first so the board fills in order; printed is the last 50.
 * count=1 returns only { toPrint } for the menu badge.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const supabase = createServiceClient();

  const { count: toPrint } = await supabase
    .from('so_print_queue').select('id', { count: 'exact', head: true }).eq('status', 'to_print');
  if (req.nextUrl.searchParams.get('count')) {
    return NextResponse.json({ toPrint: toPrint || 0 });
  }

  const status = req.nextUrl.searchParams.get('status') === 'printed' ? 'printed' : 'to_print';
  const q = supabase.from('so_print_queue')
    .select('id, so_netsuite_id, so_number, customer_name, end_user, status, reason, queued_at, printed_at, printed_by');
  const { data, error } = status === 'printed'
    ? await q.eq('status', 'printed').order('printed_at', { ascending: false }).limit(50)
    : await q.eq('status', 'to_print').order('queued_at', { ascending: true }).limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data || []) as any[];
  const ids = [...new Set(rows.map(r => r.printed_by).filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
    for (const p of profs || []) names.set(p.id, p.full_name || 'Someone');
  }
  return NextResponse.json({
    toPrint: toPrint || 0,
    rows: rows.map(r => ({
      id: r.id,
      soId: r.so_netsuite_id,
      soNumber: r.so_number,
      customer: r.customer_name,
      endUser: r.end_user,
      status: r.status,
      reason: r.reason,
      queuedAt: r.queued_at,
      printedAt: r.printed_at,
      printedBy: r.printed_by ? names.get(r.printed_by) || 'Someone' : null,
    })),
  });
}
