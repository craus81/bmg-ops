import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

// A sent quote is "quiet" once this many days pass with no follow-up logged.
const QUIET_DAYS = 5;

interface QuietQuote {
  table: 'estimates' | 'wrap_quotes';
  id: string;
  number: string;
  customer: string;
  total: number;
  repId: string | null;
  quietDays: number;
}

/**
 * Daily rep nudge: sent quotes with no activity (no follow-up logged, no
 * answer) for 5+ days get their rep pinged — follow-up speed is the
 * highest-leverage sales behavior there is. Re-nudges at most every
 * QUIET_DAYS, and a logged follow-up resets the clock.
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
    const now = Date.now();
    const dayMs = 86_400_000;
    const quiet: QuietQuote[] = [];
    const isDue = (sentAt: string | null, lastFollowup: string | null, nudgedAt: string | null): number | null => {
      const ref = Math.max(
        sentAt ? new Date(sentAt).getTime() : 0,
        lastFollowup ? new Date(lastFollowup).getTime() : 0,
      );
      if (!ref) return null;
      const quietDays = Math.floor((now - ref) / dayMs);
      if (quietDays < QUIET_DAYS) return null;
      // Already nudged since the last activity, and recently — let it rest.
      if (nudgedAt && new Date(nudgedAt).getTime() > ref && now - new Date(nudgedAt).getTime() < QUIET_DAYS * dayMs) return null;
      return quietDays;
    };

    const [estRes, wrapRes] = await Promise.all([
      service.from('estimates')
        .select('id, estimate_number, customer_name, grand_total, created_by, sent_for_approval_at, updated_at, last_followup_at, followup_nudged_at')
        .eq('status', 'sent').limit(500),
      service.from('wrap_quotes')
        .select('id, quote_number, customer, total, created_by, sent_at, last_followup_at, followup_nudged_at')
        .eq('status', 'sent').is('archived_at', null).limit(500),
    ]);

    for (const e of estRes.data || []) {
      const days = isDue(e.sent_for_approval_at || e.updated_at, e.last_followup_at, e.followup_nudged_at);
      if (days != null) quiet.push({ table: 'estimates', id: e.id, number: e.estimate_number, customer: e.customer_name || '—', total: Number(e.grand_total) || 0, repId: e.created_by, quietDays: days });
    }
    for (const w of wrapRes.data || []) {
      const days = isDue(w.sent_at, w.last_followup_at, w.followup_nudged_at);
      if (days != null) quiet.push({ table: 'wrap_quotes', id: w.id, number: w.quote_number, customer: (w.customer as any)?.name || '—', total: Number(w.total) || 0, repId: w.created_by, quietDays: days });
    }

    let notified = 0;
    if (quiet.length > 0) {
      // Quotes with no rep fall back to admins so nothing goes unwatched.
      const { data: admins } = await service
        .from('profiles').select('id')
        .or('role.eq.admin,roles.cs.{admin}')
        .eq('status', 'approved');
      const adminIds = (admins || []).map(a => a.id);

      const byRep = new Map<string, QuietQuote[]>();
      for (const q of quiet) {
        const targets = q.repId ? [q.repId] : adminIds;
        for (const t of targets) {
          const arr = byRep.get(t) || [];
          arr.push(q);
          byRep.set(t, arr);
        }
      }
      const fmtK = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`;
      for (const [repId, quotes] of byRep) {
        const lines = quotes
          .sort((a, b) => b.quietDays - a.quietDays)
          .map(q => `${q.number} ${q.customer} (${fmtK(q.total)}, quiet ${q.quietDays}d)`)
          .join(' · ');
        await notifyMany([repId], {
          type: 'quote_followup',
          title: `${quotes.length} quote${quotes.length !== 1 ? 's' : ''} need${quotes.length === 1 ? 's' : ''} a follow-up`,
          body: lines.slice(0, 900),
          url: '/admin/quote-followups',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
        notified++;
      }

      const nudgeStamp = new Date().toISOString();
      const estIds = quiet.filter(q => q.table === 'estimates').map(q => q.id);
      const wrapIds = quiet.filter(q => q.table === 'wrap_quotes').map(q => q.id);
      if (estIds.length > 0) await service.from('estimates').update({ followup_nudged_at: nudgeStamp }).in('id', estIds);
      if (wrapIds.length > 0) await service.from('wrap_quotes').update({ followup_nudged_at: nudgeStamp }).in('id', wrapIds);
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'quote_followup_check', { status: 'ok', quiet: quiet.length, notified },
    );

    return NextResponse.json({ status: 'ok', quiet: quiet.length, notified, syncStateWrite });
  } catch (e: any) {
    console.error('quote-followup-check failed:', e);
    await recordHeartbeat(service, 'quote_followup_check', { error: e.message || 'quote follow-up check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'quote follow-up check failed' }, { status: 500 });
  }
}
