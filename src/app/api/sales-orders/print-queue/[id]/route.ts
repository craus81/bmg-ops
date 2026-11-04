import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /** printed = it's on the board; to_print = put it back on the list. */
  status: z.enum(['printed', 'to_print']),
});

/** POST /api/sales-orders/print-queue/[id] — Mark printed, or put back on the list. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Not a list entry' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const supabase = createServiceClient();
  const patch = parsed.data.status === 'printed'
    ? { status: 'printed', printed_at: new Date().toISOString(), printed_by: auth.user.id }
    : { status: 'to_print', queued_at: new Date().toISOString() };
  const { data, error } = await supabase.from('so_print_queue').update(patch).eq('id', params.id).select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: 'That sales order is no longer on the list. Reload the page.' }, { status: 404 });
  return NextResponse.json({ success: true });
}
