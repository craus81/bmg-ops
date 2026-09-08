import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * One-tap call logging (R6-3). The caller-ID search finds who is on the
 * phone; this writes what the call WAS, in one form, without leaving the
 * search overlay — the gap that made phone notes evaporate.
 *
 * Optionally closes the loop two ways: stamping the Dialpad call event as
 * logged (so an "unlogged calls" view stays honest), and dropping a
 * follow-up into prospect_reminders, which the existing reminder cron and
 * the schedule board already read.
 */

const LogSchema = z.object({
  prospectId: z.string().uuid(),
  direction: z.enum(['inbound', 'outbound']),
  summary: z.string().min(1).max(300),
  details: z.string().max(2000).optional(),
  /** YYYY-MM-DD — creates a reminder due 9am local that day. */
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Links this note to the provider call it describes. */
  callEventId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, LogSchema);
  if (parsed.error) return parsed.error;
  const { prospectId, direction, summary, details, followUpDate, callEventId } = parsed.data;

  const { data: prospect } = await service
    .from('prospects').select('id, company_name').eq('id', prospectId).maybeSingle();
  if (!prospect) return NextResponse.json({ error: 'Record not found' }, { status: 404 });

  const { data: activity, error } = await service
    .from('prospect_activities')
    .insert({
      prospect_id: prospectId,
      type: 'call',
      summary: `${direction === 'inbound' ? 'Inbound' : 'Outbound'} call — ${summary.trim()}`,
      details: details?.trim() || null,
      created_by: auth.user.id,
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Touch the record so the quiet-lead tile (R3-18) counts this as contact.
  await service.from('prospects').update({ updated_at: new Date().toISOString() }).eq('id', prospectId);

  let reminderId: string | null = null;
  if (followUpDate) {
    const { data: reminder } = await service
      .from('prospect_reminders')
      .insert({
        prospect_id: prospectId,
        activity_id: activity.id,
        title: `Follow up: ${prospect.company_name}`,
        description: summary.trim(),
        due_at: `${followUpDate}T09:00:00`,
        created_by: auth.user.id,
      })
      .select('id')
      .single();
    reminderId = reminder?.id || null;
  }

  if (callEventId) {
    await service.from('phone_call_events')
      .update({ logged_activity_id: activity.id, updated_at: new Date().toISOString() })
      .eq('id', callEventId);
  }

  return NextResponse.json({ ok: true, activityId: activity.id, reminderId });
}
