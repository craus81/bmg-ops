import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { loadQuoteListItems } from '@/lib/quote-list';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET — every sent-and-unanswered quote, both builders. Legacy endpoint:
 * the combined list at GET /api/quotes supersedes it (this is that route
 * with status=sent), kept for clients loaded before the /quotes page
 * shipped. Same shared loader, so the two can't drift.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  try {
    const items = await loadQuoteListItems(service, 'sent');
    return NextResponse.json({ items });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

const PostSchema = z.object({
  type: z.enum(['estimate', 'wrap']),
  id: z.string().uuid(),
  action: z.enum(['log_followup', 'mark_accepted', 'mark_rejected']),
  // log_followup extras: what the customer said, and an optional date to be
  // reminded on ("vehicles arrive in September — remind me Sept 1").
  note: z.string().max(2000).optional(),
  remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** POST — log a follow-up touch (with comment/reminder), or mark a sent quote accepted/rejected. */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { type, id, action, note, remindAt } = parsed.data;
  const table = type === 'estimate' ? 'estimates' : 'wrap_quotes';
  const now = new Date().toISOString();

  const { data: row } = await service
    .from(table)
    .select(type === 'estimate' ? 'id, status, estimate_number, customer_name, grand_total' : 'id, status, quote_number, customer, total')
    .eq('id', id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

  if (action === 'log_followup') {
    // A reminder in the past would fire (or be skipped) confusingly — catch
    // the obvious mistake while allowing "today" across timezones.
    if (remindAt) {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      if (remindAt < yesterday) {
        return NextResponse.json({ error: `Reminder date ${remindAt} is in the past` }, { status: 400 });
      }
    }
    const { error } = await service.from(table).update({ last_followup_at: now }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // History row — best-effort so logging still works before migration 212.
    const { error: fuError } = await service.from('quote_followups').insert({
      quote_type: type,
      quote_id: id,
      note: note?.trim() || null,
      remind_at: remindAt || null,
      created_by: auth.user!.id,
    });
    if (fuError) {
      console.warn('quote_followups insert failed (migration 212 applied?):', fuError.message);
      // The comment/reminder is the part the user typed — losing it silently
      // would be worse than a visible error, but only fail when they typed one.
      if (note?.trim() || remindAt) {
        return NextResponse.json({ error: `Follow-up logged, but the comment/reminder could not be saved: ${fuError.message}` }, { status: 500 });
      }
    }
    return NextResponse.json({ success: true });
  }

  if ((row as any).status !== 'sent') {
    return NextResponse.json({ error: `Quote is ${(row as any).status} — only sent quotes can be marked` }, { status: 400 });
  }
  const accepted = action === 'mark_accepted';
  const patch = type === 'estimate'
    ? { status: accepted ? 'accepted' : 'rejected' }
    : { status: accepted ? 'accepted' : 'rejected', [accepted ? 'accepted_at' : 'rejected_at']: now };
  const { error } = await service.from(table).update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const label = type === 'estimate'
    ? `${(row as any).estimate_number} · ${(row as any).customer_name || ''}`
    : `${(row as any).quote_number} · ${((row as any).customer as any)?.name || ''}`;
  const amount = Number(type === 'estimate' ? (row as any).grand_total : (row as any).total) || 0;
  await logAudit(service, {
    actorId: auth.user!.id,
    table,
    recordId: id,
    action: accepted ? 'mark_accepted' : 'mark_rejected',
    detail: { quote: label, amount },
  });

  return NextResponse.json({ success: true });
}
