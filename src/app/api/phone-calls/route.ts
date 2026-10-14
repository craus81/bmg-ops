import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CALL_COLUMNS = 'id, created_at, started_at, duration_seconds, from_number, callback_number, caller_name, caller_company, caller_email, call_reason, caller_reference, urgent, summary, transcript, recording_url, matched_prospect_id, called_back_at, called_back_by';

const ListSchema = z.object({
  id: z.string().uuid().optional(),
  /** open = not called back yet (the default), all = everything. */
  show: z.enum(['open', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * GET /api/phone-calls — the After-hours Calls page.
 *
 * Calls BMG's virtual assistant (Retell) answered while the office was
 * closed, newest first, from phone_call_events (provider 'retell'). `id`
 * returns that one call even when it is already called back, so the email
 * link always opens it. Internal staff only; service role because the
 * table's RLS read policy covers authenticated browser reads, not this
 * server route.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, ListSchema);
  if (parsed.error) return parsed.error;
  const { id, show = 'open' } = parsed.data;

  let query = supabase
    .from('phone_call_events')
    .select(CALL_COLUMNS)
    .eq('provider', 'retell')
    .order('created_at', { ascending: false })
    .order('id')
    .limit(parsed.data.limit ?? 100);
  if (show === 'open') query = query.is('called_back_at', null);
  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const calls = [...(rows || [])];
  if (id && !calls.some(c => c.id === id)) {
    const { data: one } = await supabase
      .from('phone_call_events').select(CALL_COLUMNS).eq('provider', 'retell').eq('id', id).maybeSingle();
    if (one) calls.unshift(one);
  }

  const prospectIds = [...new Set(calls.map(c => c.matched_prospect_id).filter(Boolean))] as string[];
  const userIds = [...new Set(calls.map(c => c.called_back_by).filter(Boolean))] as string[];
  const [{ data: prospects }, { data: people }, { count: openCount }] = await Promise.all([
    prospectIds.length
      ? supabase.from('prospects').select('id, company_name').in('id', prospectIds)
      : Promise.resolve({ data: [] as any[] }),
    userIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', userIds)
      : Promise.resolve({ data: [] as any[] }),
    supabase.from('phone_call_events').select('id', { count: 'exact', head: true })
      .eq('provider', 'retell').is('called_back_at', null),
  ]);
  const prospectName = new Map((prospects || []).map((p: any) => [p.id, p.company_name]));
  const personName = new Map((people || []).map((p: any) => [p.id, p.full_name]));

  return NextResponse.json({
    openCount: openCount ?? 0,
    calls: calls.map(c => ({
      ...c,
      matched_company: c.matched_prospect_id ? prospectName.get(c.matched_prospect_id) || null : null,
      called_back_by_name: c.called_back_by ? personName.get(c.called_back_by) || null : null,
    })),
  });
}

const PatchSchema = z.object({
  id: z.string().uuid(),
  /** Tick or untick "Called back". */
  calledBack: z.boolean().optional(),
  /** Link the call to a customer record (after "Add as lead" or picking a match). */
  prospectId: z.string().uuid().nullable().optional(),
});

/** PATCH /api/phone-calls — tick "Called back" or link the caller's record. */
export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { id, calledBack, prospectId } = parsed.data;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (calledBack !== undefined) {
    update.called_back_at = calledBack ? new Date().toISOString() : null;
    update.called_back_by = calledBack ? auth.user.id : null;
  }
  if (prospectId !== undefined) update.matched_prospect_id = prospectId;

  const { data, error } = await supabase
    .from('phone_call_events')
    .update(update)
    .eq('id', id)
    .eq('provider', 'retell')
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Call not found' }, { status: 404 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'phone_call_events',
    recordId: id,
    action: calledBack !== undefined ? (calledBack ? 'after_hours_call_called_back' : 'after_hours_call_reopened') : 'after_hours_call_linked',
    detail: { calledBack, prospectId },
  });
  return NextResponse.json({ ok: true });
}
