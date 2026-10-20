import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature, outsideStaff } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CALL_COLUMNS = 'id, created_at, started_at, duration_seconds, from_number, callback_number, caller_name, caller_company, caller_email, call_reason, caller_reference, urgent, summary, transcript, recording_url, matched_prospect_id, called_back_at, called_back_by, external_digits, spam';

const ListSchema = z.object({
  id: z.string().uuid().optional(),
  /** open = not called back yet (the default), all = every call but spam, spam = the Spam tab. */
  show: z.enum(['open', 'all', 'spam']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * GET /api/phone-calls — the After-hours Calls page.
 *
 * Calls BMG's virtual assistant (Retell) answered while the office was
 * closed, newest first, from phone_call_events (provider 'retell'). `id`
 * returns that one call even when it is already called back or spam, so the
 * email link always opens it. Spam calls only list under show=spam.
 * Internal staff only; service role because the table's RLS read policy
 * covers authenticated browser reads, not this server route.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'after_hours_calls');
  if (auth.error) return auth.error;
  const outside = outsideStaff(auth);
  if (outside) return outside;
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
  query = query.eq('spam', show === 'spam');
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
  const [{ data: prospects }, { data: people }, { count: openCount }, { count: spamCount }] = await Promise.all([
    prospectIds.length
      ? supabase.from('prospects').select('id, company_name').in('id', prospectIds)
      : Promise.resolve({ data: [] as any[] }),
    userIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', userIds)
      : Promise.resolve({ data: [] as any[] }),
    supabase.from('phone_call_events').select('id', { count: 'exact', head: true })
      .eq('provider', 'retell').eq('spam', false).is('called_back_at', null),
    supabase.from('phone_call_events').select('id', { count: 'exact', head: true })
      .eq('provider', 'retell').eq('spam', true),
  ]);
  const prospectName = new Map((prospects || []).map((p: any) => [p.id, p.company_name]));
  const personName = new Map((people || []).map((p: any) => [p.id, p.full_name]));

  return NextResponse.json({
    openCount: openCount ?? 0,
    spamCount: spamCount ?? 0,
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
  /**
   * Mark spam (true) or Not spam (false). Spam adds the caller ID to
   * phone_spam_numbers and files every call from it under Spam; Not spam
   * takes the number off the list and puts its calls back.
   */
  spam: z.boolean().optional(),
});

/** PATCH /api/phone-calls — tick "Called back", link the caller's record, or mark spam. */
export async function PATCH(req: NextRequest) {
  const auth = await requireFeature(req, 'after_hours_calls');
  if (auth.error) return auth.error;
  const outside = outsideStaff(auth);
  if (outside) return outside;
  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { id, calledBack, prospectId, spam } = parsed.data;

  if (spam !== undefined) {
    const { data: call } = await supabase
      .from('phone_call_events').select('id, external_digits').eq('provider', 'retell').eq('id', id).maybeSingle();
    if (!call) return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    const digits = call.external_digits && call.external_digits.length >= 7 ? call.external_digits : null;
    const now = new Date().toISOString();
    if (digits && spam) {
      const { error: listErr } = await supabase.from('phone_spam_numbers')
        .upsert({ digits, added_by: auth.user.id, source_call_id: id }, { onConflict: 'digits' });
      if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    } else if (digits) {
      const { error: listErr } = await supabase.from('phone_spam_numbers').delete().eq('digits', digits);
      if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    // Every call from that caller ID moves together; a call with no usable
    // caller ID (blocked/withheld) moves alone.
    let move = supabase.from('phone_call_events').update({ spam, updated_at: now }).eq('provider', 'retell');
    move = digits ? move.eq('external_digits', digits) : move.eq('id', id);
    const { error: moveErr } = await move;
    if (moveErr) return NextResponse.json({ error: moveErr.message }, { status: 500 });
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'phone_call_events',
      recordId: id,
      action: spam ? 'after_hours_call_spam' : 'after_hours_call_not_spam',
      detail: { digits },
    });
    return NextResponse.json({ ok: true, numberBlocked: spam && !!digits });
  }

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
