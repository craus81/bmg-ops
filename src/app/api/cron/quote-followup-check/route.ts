import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';

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
    const today = new Date().toISOString().slice(0, 10);

    // ── Deliver due follow-up reminders ("remind me Sept 1") ──────────────
    // Best-effort: the sweep below must run even before migration 212 lands.
    let reminded = 0;
    try {
      // Oldest first so a backlog over the per-run cap drains fairly
      // instead of in arbitrary order.
      const { data: due } = await service
        .from('quote_followups')
        .select('id, quote_type, quote_id, note, created_by, remind_at')
        .is('reminder_sent_at', null)
        .not('remind_at', 'is', null)
        .lte('remind_at', today)
        .order('remind_at')
        .order('id')
        .limit(200);
      for (const r of due || []) {
        const table = r.quote_type === 'estimate' ? 'estimates' : 'wrap_quotes';
        const { data: q } = await service
          .from(table)
          .select(r.quote_type === 'estimate'
            ? 'id, status, estimate_number, customer_name, grand_total, created_by'
            : 'id, status, quote_number, customer, total, created_by')
          .eq('id', r.quote_id)
          .maybeSingle();
        // Quote answered (or gone) before the reminder date — nothing to
        // chase; retire the reminder silently.
        if (q && (q as any).status === 'sent') {
          const number = r.quote_type === 'estimate' ? (q as any).estimate_number : (q as any).quote_number;
          const customer = r.quote_type === 'estimate'
            ? (q as any).customer_name || '—'
            : ((q as any).customer as any)?.name || '—';
          const targets = [...new Set([r.created_by, (q as any).created_by].filter(Boolean))] as string[];
          if (targets.length > 0) {
            await notifyMany(targets, {
              type: 'quote_followup',
              title: `⏰ Follow-up reminder: ${number} — ${customer}`,
              body: r.note ? r.note.slice(0, 900) : `You asked to be reminded today to follow up on ${number}.`,
              url: deepLinks.quoteFollowUps(r.quote_type as 'estimate' | 'wrap', r.quote_id),
              channels: ['in_app', 'push'],
              forceChannels: true,
            });
            reminded++;
          }
        }
        await service.from('quote_followups').update({ reminder_sent_at: new Date().toISOString() }).eq('id', r.id);
      }
    } catch (e: any) {
      console.warn('quote follow-up reminders unavailable:', e.message || e);
    }

    // A pending FUTURE reminder means the rep deliberately deferred this
    // quote ("customer answers in September") — hold the quiet-day nudge
    // until the reminder fires.
    const deferred = new Set<string>();
    try {
      // Paginated (R3-1 MAJOR sweep): a deferral that falls past the
      // 1000-row cap silently drops out of this set, and the quote the rep
      // deliberately parked gets nudged anyway.
      const { data: pending } = await fetchAllRows<{ quote_type: string; quote_id: string }>((from, to) =>
        service
          .from('quote_followups')
          .select('quote_type, quote_id')
          .is('reminder_sent_at', null)
          .gt('remind_at', today)
          .order('id')
          .range(from, to));
      for (const p of pending || []) {
        deferred.add(`${p.quote_type === 'estimate' ? 'estimates' : 'wrap_quotes'}:${p.quote_id}`);
      }
    } catch (e: any) {
      console.warn('quote follow-up deferrals unavailable:', e.message || e);
    }

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

    // Paginated (R3-1 MAJOR sweep): with >500 sent quotes the .limit(500)
    // reads silently dropped the tail, and those quotes were never nudged.
    const [estRes, wrapRes] = await Promise.all([
      fetchAllRows<any>((from, to) =>
        service.from('estimates')
          .select('id, estimate_number, customer_name, grand_total, created_by, sent_for_approval_at, updated_at, last_followup_at, followup_nudged_at')
          .eq('status', 'sent').order('id').range(from, to)),
      fetchAllRows<any>((from, to) =>
        service.from('wrap_quotes')
          .select('id, quote_number, customer, total, created_by, sent_at, last_followup_at, followup_nudged_at')
          .eq('status', 'sent').is('archived_at', null).order('id').range(from, to)),
    ]);

    for (const e of estRes.data || []) {
      if (deferred.has(`estimates:${e.id}`)) continue;
      const days = isDue(e.sent_for_approval_at || e.updated_at, e.last_followup_at, e.followup_nudged_at);
      if (days != null) quiet.push({ table: 'estimates', id: e.id, number: e.estimate_number, customer: e.customer_name || '—', total: Number(e.grand_total) || 0, repId: e.created_by, quietDays: days });
    }
    for (const w of wrapRes.data || []) {
      if (deferred.has(`wrap_quotes:${w.id}`)) continue;
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
        // Land on the follow-ups queue — that's where Log Follow-Up / Won /
        // Lost live. A one-quote nudge highlights its exact row; a real
        // multi-quote digest opens the list.
        const only = quotes.length === 1 ? quotes[0] : null;
        await notifyMany([repId], {
          type: 'quote_followup',
          title: `${quotes.length} quote${quotes.length !== 1 ? 's' : ''} need${quotes.length === 1 ? 's' : ''} a follow-up`,
          body: lines.slice(0, 900),
          url: only
            ? deepLinks.quoteFollowUps(only.table === 'estimates' ? 'estimate' : 'wrap', only.id)
            : deepLinks.quoteFollowUps(),
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
      service, 'quote_followup_check', { status: 'ok', quiet: quiet.length, notified, reminded },
    );

    return NextResponse.json({ status: 'ok', quiet: quiet.length, notified, reminded, syncStateWrite });
  } catch (e: any) {
    console.error('quote-followup-check failed:', e);
    await recordHeartbeat(service, 'quote_followup_check', { error: e.message || 'quote follow-up check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'quote follow-up check failed' }, { status: 500 });
  }
}
