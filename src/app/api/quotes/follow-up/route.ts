import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

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
    })),
  ];

  const repIds = [...new Set(items.map(i => i.repId).filter(Boolean))] as string[];
  if (repIds.length > 0) {
    const { data: reps } = await service.from('profiles').select('id, full_name').in('id', repIds);
    const names = new Map((reps || []).map(r => [r.id, r.full_name]));
    for (const i of items) i.repName = i.repId ? names.get(i.repId) || null : null;
  }

  return NextResponse.json({ items });
}

const PostSchema = z.object({
  type: z.enum(['estimate', 'wrap']),
  id: z.string().uuid(),
  action: z.enum(['log_followup', 'mark_accepted', 'mark_rejected']),
});

/** POST — log a follow-up touch, or mark a sent quote accepted/rejected. */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { type, id, action } = parsed.data;
  const table = type === 'estimate' ? 'estimates' : 'wrap_quotes';
  const now = new Date().toISOString();

  const { data: row } = await service
    .from(table)
    .select(type === 'estimate' ? 'id, status, estimate_number, customer_name, grand_total' : 'id, status, quote_number, customer, total')
    .eq('id', id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

  if (action === 'log_followup') {
    const { error } = await service.from(table).update({ last_followup_at: now }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
