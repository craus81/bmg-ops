import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface FollowUpNote {
  id: string;
  note: string | null;
  remindAt: string | null;
  reminderSentAt: string | null;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: string;
}

export interface FollowUpItem {
  type: 'estimate' | 'wrap';
  id: string;
  number: string;
  title: string;
  customer: string;
  total: number;
  repId: string | null;
  repName: string | null;
  sentAt: string | null;
  lastFollowupAt: string | null;
  followups: FollowUpNote[];
  /** Earliest pending (undelivered, future-or-today) reminder date, if any. */
  nextReminderAt: string | null;
}

/** GET — every sent-and-unanswered quote, both builders, oldest-quiet first. */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const [estRes, wrapRes] = await Promise.all([
    service
      .from('estimates')
      .select('id, estimate_number, title, customer_name, grand_total, created_by, sent_for_approval_at, updated_at, last_followup_at')
      .eq('status', 'sent')
      .order('updated_at', { ascending: true })
      .limit(200),
    service
      .from('wrap_quotes')
      .select('id, quote_number, vehicle_description, customer, total, created_by, sent_at, last_followup_at')
      .eq('status', 'sent')
      .is('archived_at', null)
      .order('sent_at', { ascending: true })
      .limit(200),
  ]);
  if (estRes.error) return NextResponse.json({ error: estRes.error.message }, { status: 500 });
  if (wrapRes.error) return NextResponse.json({ error: wrapRes.error.message }, { status: 500 });

  const items: FollowUpItem[] = [
    ...(estRes.data || []).map(e => ({
      type: 'estimate' as const,
      id: e.id,
      number: e.estimate_number,
      title: e.title || '',
      customer: e.customer_name || '—',
      total: Number(e.grand_total) || 0,
      repId: e.created_by,
      repName: null,
      sentAt: e.sent_for_approval_at || e.updated_at,
      lastFollowupAt: e.last_followup_at,
      followups: [] as FollowUpNote[],
      nextReminderAt: null,
    })),
    ...(wrapRes.data || []).map(w => ({
      type: 'wrap' as const,
      id: w.id,
      number: w.quote_number,
      title: w.vehicle_description || '',
      customer: (w.customer as any)?.name || '—',
      total: Number(w.total) || 0,
      repId: w.created_by,
      repName: null,
      sentAt: w.sent_at,
      lastFollowupAt: w.last_followup_at,
      followups: [] as FollowUpNote[],
      nextReminderAt: null,
    })),
  ];

  // Follow-up history (comments + reminders) for the open quotes. Best-effort
  // — the queue must still load before migration 212 lands. History grows
  // unboundedly, so paginate past the 1000-row cap.
  const byKey = new Map(items.map(i => [`${i.type}-${i.id}`, i]));
  if (items.length > 0) {
    const { data: fuRows } = await fetchAllRows<any>((from, to) =>
      service
        .from('quote_followups')
        .select('id, quote_type, quote_id, note, remind_at, reminder_sent_at, created_by, created_at')
        .in('quote_id', items.map(i => i.id))
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to),
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const r of fuRows || []) {
      const item = byKey.get(`${r.quote_type}-${r.quote_id}`);
      if (!item) continue;
      item.followups.push({
        id: r.id,
        note: r.note,
        remindAt: r.remind_at,
        reminderSentAt: r.reminder_sent_at,
        createdBy: r.created_by,
        creatorName: null,
        createdAt: r.created_at,
      });
      if (r.remind_at && !r.reminder_sent_at && r.remind_at >= today) {
        if (!item.nextReminderAt || r.remind_at < item.nextReminderAt) item.nextReminderAt = r.remind_at;
      }
    }
  }

  const nameIds = [...new Set([
    ...items.map(i => i.repId),
    ...items.flatMap(i => i.followups.map(f => f.createdBy)),
  ].filter(Boolean))] as string[];
  if (nameIds.length > 0) {
    const { data: reps } = await service.from('profiles').select('id, full_name').in('id', nameIds);
    const names = new Map((reps || []).map(r => [r.id, r.full_name]));
    for (const i of items) {
      i.repName = i.repId ? names.get(i.repId) || null : null;
      for (const f of i.followups) f.creatorName = f.createdBy ? names.get(f.createdBy) || null : null;
    }
  }

  return NextResponse.json({ items });
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
