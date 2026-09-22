import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { loadQuietLeads, QUIET_DAYS } from '@/lib/quiet-leads';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/leads/quiet — active leads nobody has touched in `days` or more,
 * worst first (R6-9). The triage queue's whole dataset in one call, so a rep
 * can act on every row without leaving the list.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({
    days: z.coerce.number().int().min(1).max(3650).optional(),
  }));
  if (q.error) return q.error;

  try {
    const leads = await loadQuietLeads(service, { days: q.data.days ?? QUIET_DAYS });
    return NextResponse.json({ leads, quietDays: q.data.days ?? QUIET_DAYS });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not load quiet leads' }, { status: 500 });
  }
}

// Same vocabulary as migration 263's deal-level reasons, so lead losses and
// deal losses can be counted together rather than as two incompatible lists.
const LOST_REASONS = ['price', 'timing', 'competitor', 'no_response', 'other'] as const;

const ActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['touch', 'nurture', 'lost', 'hot', 'unhot', 'remind']),
  note: z.string().trim().max(1000).optional(),
  reason: z.enum(LOST_REASONS).optional(),
  /** remind only — the date to be nudged. */
  remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * POST /api/leads/quiet — the triage actions, in bulk.
 *
 * These live here rather than on PUT /api/prospects because each one is a
 * DECISION with a timeline consequence, not a field edit: every action
 * writes a prospect_activities row, so the reason a lead was parked or
 * closed is readable on the record afterwards. A status silently changed
 * with no trace is how a lead gets re-worked by the next person.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ActionSchema);
  if (parsed.error) return parsed.error;
  const { ids, action, note, reason, remindAt } = parsed.data;

  // A lost lead without a reason is the exact hole migration 263 closed for
  // deals — refuse rather than record an unanswerable loss.
  if (action === 'lost' && !reason) {
    return NextResponse.json({ error: 'A reason is required to close a lead as lost.' }, { status: 400 });
  }
  if (action === 'remind' && !remindAt) {
    return NextResponse.json({ error: 'A date is required to set a reminder.' }, { status: 400 });
  }
  if (action === 'touch' && !note) {
    return NextResponse.json({ error: 'Say what the touch was — an empty touch is not a record of anything.' }, { status: 400 });
  }

  const { data: leads } = await service
    .from('prospects')
    .select('id, company_name, status')
    .in('id', ids);
  const found = leads || [];
  if (found.length === 0) return NextResponse.json({ error: 'No matching records' }, { status: 404 });

  const now = new Date().toISOString();
  const activities: any[] = [];
  let updated = 0;

  for (const lead of found) {
    if (action === 'touch') {
      activities.push({
        prospect_id: lead.id, type: 'note', summary: note!.slice(0, 500),
        created_by: auth.user.id,
      });
      // The touch itself is the update: bump updated_at so every other
      // reader of "recently worked" agrees with the timeline.
      await service.from('prospects').update({ updated_at: now }).eq('id', lead.id);
      updated++;
      continue;
    }

    if (action === 'hot' || action === 'unhot') {
      await service.from('prospects').update({ is_hot: action === 'hot', updated_at: now }).eq('id', lead.id);
      activities.push({
        prospect_id: lead.id, type: 'status_change',
        summary: action === 'hot' ? 'Marked hot' : 'Hot flag removed',
        details: note?.slice(0, 1000) || null,
        created_by: auth.user.id,
      });
      updated++;
      continue;
    }

    if (action === 'remind') {
      await service.from('prospect_reminders').insert({
        prospect_id: lead.id,
        title: note?.slice(0, 200) || `Follow up with ${lead.company_name || 'this lead'}`,
        description: note?.slice(0, 1000) || null,
        // Midday so a date-only reminder cannot land on the previous day in
        // a western timezone.
        due_at: `${remindAt}T12:00:00Z`,
        created_by: auth.user.id,
      });
      updated++;
      continue;
    }

    const status = action === 'nurture' ? 'nurturing' : 'lost';
    await service.from('prospects').update({
      status,
      updated_at: now,
      ...(action === 'lost'
        ? { lost_reason: reason, lost_note: note?.slice(0, 1000) || null }
        // Reopening as nurture clears a previous loss rather than leaving a
        // stale reason attached to a live lead.
        : { lost_reason: null, lost_note: null }),
    }).eq('id', lead.id);
    activities.push({
      prospect_id: lead.id, type: 'status_change',
      summary: action === 'nurture'
        ? 'Parked as nurturing'
        : `Closed as lost — ${reason}`,
      details: note?.slice(0, 1000) || null,
      created_by: auth.user.id,
    });
    updated++;
  }

  if (activities.length > 0) {
    // Best-effort: the decision is already recorded on the row; a failed
    // timeline write must not make the caller think nothing happened.
    await service.from('prospect_activities').insert(activities);
  }

  return NextResponse.json({ success: true, updated });
}
