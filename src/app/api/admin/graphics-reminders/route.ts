import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { resolveReminderSettings, STAGE_LABELS } from '@/lib/graphics-reminders';

export const dynamic = 'force-dynamic';

/**
 * Graphics reminder thresholds (migration 319) — what the daily sweep at
 * /api/cron/graphics-reminders counts as "gone quiet".
 *
 * Reading is staff-wide: the settings screen shows everyone why they got a
 * reminder, and "designing warns after 3 days" is not a secret. Writing is
 * admin, because these numbers decide how often the whole shop is
 * interrupted.
 */

const service = createServiceClient();

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data } = await service
    .from('graphics_reminder_settings')
    .select('enabled, stage_days, due_soon_days, unassigned_days, escalate_after_days')
    .eq('id', 1)
    .maybeSingle();
  return NextResponse.json({ settings: resolveReminderSettings(data), stages: STAGE_LABELS });
}

const days = z.number().int().min(0).max(365);

const UpdateSchema = z.object({
  enabled: z.boolean().optional(),
  /** status → days. 0 turns that stage off. Unknown keys are rejected. */
  stageDays: z.record(z.string(), days).optional(),
  dueSoonDays: days.optional(),
  unassignedDays: days.optional(),
  escalateAfterDays: days.optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.stageDays) {
    const unknown = Object.keys(body.stageDays).filter(k => !(k in STAGE_LABELS));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Not a graphics stage that can be reminded on: ${unknown.join(', ')}` },
        { status: 400 },
      );
    }
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: auth.user?.id ?? null,
  };
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.stageDays !== undefined) patch.stage_days = body.stageDays;
  if (body.dueSoonDays !== undefined) patch.due_soon_days = body.dueSoonDays;
  if (body.unassignedDays !== undefined) patch.unassigned_days = body.unassignedDays;
  if (body.escalateAfterDays !== undefined) patch.escalate_after_days = body.escalateAfterDays;

  // The row is seeded by the migration; upsert so a database restored
  // without it still saves rather than silently updating nothing.
  const { data, error } = await service
    .from('graphics_reminder_settings')
    .upsert({ id: 1, ...patch }, { onConflict: 'id' })
    .select('enabled, stage_days, due_soon_days, unassigned_days, escalate_after_days')
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: `Could not save reminder settings: ${error.message}` }, { status: 500 });
  }

  await logAudit(service, {
    actorId: auth.user?.id ?? null,
    table: 'graphics_reminder_settings',
    recordId: '1',
    action: 'update',
    detail: body,
  });

  return NextResponse.json({ settings: resolveReminderSettings(data) });
}
