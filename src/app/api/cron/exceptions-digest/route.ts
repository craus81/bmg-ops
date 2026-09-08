import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany, getSuperAdminIds } from '@/lib/notify';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { EXCEPTION_ACTIONS, ACTION_LABELS } from '@/lib/exception-actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Weekly exceptions & overrides digest (Monday morning): one notification to
 * super admins summarizing every guard a human bypassed in the last 7 days —
 * forced status transitions, invoices past the already-invoiced guard,
 * conversions without customer approval, post-approval estimate edits, rate
 * changes. The audit log already records each of these; this makes someone
 * actually see them. A quiet week sends nothing (heartbeat only).
 *
 * Audience is super_admin, not executive: the digest deep-links to
 * /admin/audit, which requires the audit_log feature — super-admin-only.
 * The executive role is deliberately walled to home + financials
 * (src/lib/features.ts), and a link they can't open is a dead click.
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
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await fetchAllRows<{
      actor_id: string | null; action: string; created_at: string;
    }>((from, to) => service
      .from('audit_log')
      .select('id, actor_id, action, created_at')
      .in('action', EXCEPTION_ACTIONS)
      .gte('created_at', since)
      .order('created_at').order('id')
      .range(from, to));
    if (error) throw new Error(error.message);

    const entries = rows || [];
    if (entries.length === 0) {
      const syncStateWrite = await recordHeartbeat(service, 'exceptions_digest', {
        status: 'ok', exceptions: 0, notified: 0,
      });
      return NextResponse.json({ status: 'ok', exceptions: 0, notified: 0, syncStateWrite });
    }

    // Actor names, one lookup for the whole batch.
    const actorIds = [...new Set(entries.map(r => r.actor_id).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data: profiles } = await service
        .from('profiles').select('id, full_name').in('id', actorIds);
      for (const p of profiles || []) names.set(p.id, p.full_name || 'Unknown');
    }

    // One line per action, in the declared order: "label ×N (who)".
    const lines: string[] = [];
    for (const action of EXCEPTION_ACTIONS) {
      const hits = entries.filter(r => r.action === action);
      if (hits.length === 0) continue;
      const who = [...new Set(hits.map(r => (r.actor_id && names.get(r.actor_id)) || 'Unknown'))];
      lines.push(`${ACTION_LABELS[action] || action} ×${hits.length} (${who.join(', ')})`);
    }

    const total = entries.length;
    let notified = 0;
    const superAdminIds = await getSuperAdminIds();
    if (superAdminIds.length > 0) {
      await notifyMany(superAdminIds, {
        type: 'exceptions_digest',
        title: `${total} override${total !== 1 ? 's' : ''} & exception${total !== 1 ? 's' : ''} in the last 7 days`,
        body: lines.join(' · ').slice(0, 900),
        // Digest of many records → the audit log list (deep-links rule's
        // digest carve-out); every recipient holds the audit_log feature.
        url: '/admin/audit',
        channels: ['in_app', 'push', 'email'],
      });
      notified = superAdminIds.length;
    }

    const byAction: Record<string, number> = {};
    for (const r of entries) byAction[r.action] = (byAction[r.action] || 0) + 1;
    const syncStateWrite = await recordHeartbeat(service, 'exceptions_digest', {
      status: 'ok', exceptions: total, notified, by_action: byAction,
    });

    return NextResponse.json({ status: 'ok', exceptions: total, notified, byAction, syncStateWrite });
  } catch (e: any) {
    console.error('exceptions-digest failed:', e);
    await recordHeartbeat(service, 'exceptions_digest', { error: e.message || 'exceptions digest failed' });
    return NextResponse.json({ error: e.message || 'exceptions digest failed' }, { status: 500 });
  }
}
