import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const STUCK_HOURS = 48;
const REALERT_HOURS = 48;

/**
 * Daily stuck-vehicle sweep: a vehicle sitting in "waiting on parts" or
 * "waiting on graphics" for 48+ hours gets an internal alert to admins and
 * the assigned tech — so the shop reaches out to the customer before the
 * customer calls asking. (Deliberately internal: the customer-facing story
 * is the weekly digest's plain-language status, not a raw "stuck" email.)
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const { data: stuck } = await service
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, customer_name, assigned_to, updated_at')
      .in('status', ['stuck_parts', 'stuck_graphics'])
      .limit(500);

    const now = Date.now();
    const hourMs = 3_600_000;

    // When did each vehicle ENTER its stuck state? Latest history row whose
    // to_status matches its current status; updated_at as fallback.
    const ids = (stuck || []).map(v => v.id);
    const enteredAt = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: history } = await service
        .from('vehicle_status_history')
        .select('vehicle_id, to_status, created_at')
        .in('vehicle_id', ids.slice(i, i + 200))
        .in('to_status', ['stuck_parts', 'stuck_graphics'])
        .order('created_at', { ascending: false });
      for (const h of history || []) {
        if (!enteredAt.has(h.vehicle_id)) enteredAt.set(h.vehicle_id, new Date(h.created_at).getTime());
      }
    }

    // Per-vehicle alert dedupe lives in this cron's own sync_state row.
    const { data: state } = await service
      .from('sync_state').select('last_result').eq('sync_type', 'stuck_vehicle_check').maybeSingle();
    const lastAlerts: Record<string, string> = ((state?.last_result as any)?.alerts as Record<string, string>) || {};

    const { data: admins } = await service
      .from('profiles').select('id')
      .or('role.eq.admin,roles.cs.{admin}')
      .eq('status', 'approved');
    const adminIds = (admins || []).map(a => a.id);

    let alerted = 0;
    const activeIds = new Set<string>();
    for (const v of stuck || []) {
      activeIds.add(v.id);
      const entered = enteredAt.get(v.id) ?? new Date(v.updated_at).getTime();
      const stuckHours = (now - entered) / hourMs;
      if (stuckHours < STUCK_HOURS) continue;
      const last = lastAlerts[v.id];
      if (last && now - new Date(last).getTime() < REALERT_HOURS * hourMs) continue;

      const label = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || `VIN …${String(v.vin || '').slice(-8)}`;
      const reason = v.status === 'stuck_parts' ? 'waiting on parts' : 'waiting on graphics';
      const targets = new Set<string>(adminIds);
      if (v.assigned_to) targets.add(v.assigned_to);
      if (targets.size > 0) {
        await notifyMany([...targets], {
          type: 'vehicle_stuck',
          title: `🚩 ${label} stuck ${Math.floor(stuckHours / 24)}d — ${reason}`,
          body: `${v.customer_name ? `${v.customer_name}'s ` : ''}${label} (VIN …${String(v.vin || '').slice(-8)}) has been ${reason} for ${Math.floor(stuckHours)} hours. Reach out to the customer before they call.`,
          url: '/tracking',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
      lastAlerts[v.id] = new Date().toISOString();
      alerted++;
    }

    // Drop dedupe entries for vehicles no longer stuck so a future re-stick
    // alerts immediately.
    for (const id of Object.keys(lastAlerts)) {
      if (!activeIds.has(id)) delete lastAlerts[id];
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'stuck_vehicle_check', { status: 'ok', stuck: (stuck || []).length, alerted, alerts: lastAlerts },
    );

    return NextResponse.json({ status: 'ok', stuck: (stuck || []).length, alerted, syncStateWrite });
  } catch (e: any) {
    console.error('stuck-vehicle-check failed:', e);
    await recordHeartbeat(service, 'stuck_vehicle_check', { error: e.message || 'stuck vehicle check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'stuck vehicle check failed' }, { status: 500 });
  }
}
