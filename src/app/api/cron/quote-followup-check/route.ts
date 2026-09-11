import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { sendEstimateApprovalReminder, type EstimateReminderRow } from '@/lib/estimate-approval-reminder';
import { dueWarning, dueExpiredNotice, daysUntilExpiry, expiryDateText } from '@/lib/quote-expiry';
import { sendQuoteExpiryWarning } from '@/lib/quote-expiry-email';
import { summarizeViews, neverOpenedDue, type ViewSummary } from '@/lib/quote-views';

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
          .select('id, estimate_number, title, customer_name, customer_id, customer_netsuite_id, grand_total, created_by, sent_for_approval_at, sent_for_approval_by, updated_at, last_followup_at, followup_nudged_at, approval_email_to, approval_email_status, never_opened_notified_at, approval_token, approval_token_expires_at, approval_reminder_sent_at, approval_reminder_count, approval_escalated_at, expiry_warned_for, expiry_notified_for')
          .eq('status', 'sent').order('id').range(from, to)),
      fetchAllRows<any>((from, to) =>
        service.from('wrap_quotes')
          .select('id, quote_number, vehicle_description, customer, customer_id, total, created_by, sent_at, sent_to, last_followup_at, followup_nudged_at, never_opened_notified_at, approval_token, approval_token_expires_at, expiry_warned_for, expiry_notified_for')
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

    // Quotes with no rep fall back to admins so nothing goes unwatched.
    // Loaded once and shared with the expiry pass below.
    let adminIdsCache: string[] | null = null;
    const adminIds = async (): Promise<string[]> => {
      if (adminIdsCache) return adminIdsCache;
      const { data: admins } = await service
        .from('profiles').select('id')
        .or('role.eq.admin,roles.cs.{admin}')
        .eq('status', 'approved');
      adminIdsCache = (admins || []).map((a: any) => a.id);
      return adminIdsCache;
    };

    let notified = 0;
    if (quiet.length > 0) {
      const fallbackAdmins = await adminIds();

      const byRep = new Map<string, QuietQuote[]>();
      for (const q of quiet) {
        const targets = q.repId ? [q.repId] : fallbackAdmins;
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
        });
        notified++;
      }

      const nudgeStamp = new Date().toISOString();
      const estIds = quiet.filter(q => q.table === 'estimates').map(q => q.id);
      const wrapIds = quiet.filter(q => q.table === 'wrap_quotes').map(q => q.id);
      if (estIds.length > 0) await service.from('estimates').update({ followup_nudged_at: nudgeStamp }).in('id', estIds);
      if (wrapIds.length > 0) await service.from('wrap_quotes').update({ followup_nudged_at: nudgeStamp }).in('id', wrapIds);
    }

    // ── Quote expiry engine (R6-9) ────────────────────────────────────────
    // The approval link's expiry IS the quote's expiry: it is the date in the
    // customer's email and the moment the Accept button stops working (the
    // approval routes already 410 past it). Until now nothing said so before
    // or after — a quote just quietly stopped being acceptable.
    //
    // A rep deferral ("customer answers in September") suppresses the
    // CUSTOMER email but never the rep's heads-up. The rep parked the
    // customer, not themselves, and they are exactly who needs to know their
    // parked quote is about to go dead so they can re-send with more room.
    const warnedNow = new Set<string>();
    let expiryWarned = 0;
    const expiryWarnFailures: string[] = [];
    let expiryNotified = 0;
    try {
      const stamp = (table: 'estimates' | 'wrap_quotes', id: string, patch: Record<string, unknown>) =>
        service.from(table).update(patch).eq('id', id);

      for (const e of estRes.data || []) {
        const parked = deferred.has(`estimates:${e.id}`);
        if (dueWarning(e, now)) {
          const targets = [...new Set([e.sent_for_approval_by, e.created_by].filter(Boolean))] as string[];
          const days = daysUntilExpiry(e.approval_token_expires_at, now);
          const label = `Estimate #${e.estimate_number}${e.title ? ` — ${e.title}` : ''}`;
          let sent = false;
          if (!parked) {
            const res = await sendQuoteExpiryWarning(service, {
              kind: 'estimate', id: e.id, number: e.estimate_number, label,
              customerName: e.customer_name || null,
              total: Number(e.grand_total) || null,
              token: e.approval_token, expiresAt: e.approval_token_expires_at,
              emails: e.approval_email_to || [],
              customerId: e.customer_id, netsuiteCustomerId: e.customer_netsuite_id,
            });
            sent = res.ok;
            if (!res.ok && !res.skipped) expiryWarnFailures.push(`${e.estimate_number}: ${res.error}`);
          }
          await notifyMany(targets.length > 0 ? targets : await adminIds(), {
            type: 'quote_followup',
            title: `Quote link expiring — ${e.estimate_number}`,
            body: `${label} can no longer be accepted after ${expiryDateText(e.approval_token_expires_at) || 'its expiry date'}`
              + ` (${days} day${days === 1 ? '' : 's'} left).`
              + (parked
                ? ' You parked this one, so the customer was NOT emailed — re-send if you want the link to outlive the pause.'
                : sent ? ' The customer has been emailed a reminder with the live link.'
                : ' The customer could NOT be emailed (no address on file or the send failed) — reach out directly.'),
            url: deepLinks.quoteFollowUps('estimate', e.id),
            channels: ['in_app', 'push'],
          });
          // Stamped against the expiry it fired for, so a re-send re-arms on
          // its own. The reminder clock is reset too — this WAS the reminder
          // today, and the generic chase must not follow it tomorrow — but
          // the reminder COUNT is untouched: the last-chance warning is not
          // one of the three polite chases.
          await stamp('estimates', e.id, {
            expiry_warned_for: e.approval_token_expires_at,
            ...(sent ? { approval_reminder_sent_at: new Date().toISOString() } : {}),
          });
          if (sent) warnedNow.add(e.id);
          expiryWarned++;
        } else if (dueExpiredNotice(e, now)) {
          // No customer email here on purpose: telling someone their link is
          // dead, with no working link to offer, is a dead end. The rep holds
          // the only thing that helps — a re-send.
          const targets = [...new Set([e.sent_for_approval_by, e.created_by].filter(Boolean))] as string[];
          await notifyMany(targets.length > 0 ? targets : await adminIds(), {
            type: 'quote_followup',
            title: `Quote link expired — ${e.estimate_number}`,
            body: `${e.customer_name || 'The customer'} can no longer accept estimate ${e.estimate_number} — the approval link expired`
              + `${expiryDateText(e.approval_token_expires_at) ? ` on ${expiryDateText(e.approval_token_expires_at)}` : ''}.`
              + ' Re-send it to give them a live link again.',
            url: deepLinks.quoteFollowUps('estimate', e.id),
            channels: ['in_app', 'push'],
          });
          await stamp('estimates', e.id, { expiry_notified_for: e.approval_token_expires_at });
          expiryNotified++;
        }
      }

      for (const w of wrapRes.data || []) {
        const parked = deferred.has(`wrap_quotes:${w.id}`);
        const customerName = (w.customer as any)?.name || null;
        const label = `Quote ${w.quote_number}${w.vehicle_description ? ` — ${w.vehicle_description}` : ''}`;
        if (dueWarning(w, now)) {
          const days = daysUntilExpiry(w.approval_token_expires_at, now);
          let sent = false;
          if (!parked) {
            const res = await sendQuoteExpiryWarning(service, {
              kind: 'wrap', id: w.id, number: w.quote_number, label,
              customerName,
              total: Number(w.total) || null,
              token: w.approval_token, expiresAt: w.approval_token_expires_at,
              // sent_to is the single address a wrap quote was sent to;
              // the customer JSON's email is the fallback.
              emails: [w.sent_to || (w.customer as any)?.email].filter(Boolean),
              customerId: w.customer_id,
            });
            sent = res.ok;
            if (!res.ok && !res.skipped) expiryWarnFailures.push(`${w.quote_number}: ${res.error}`);
          }
          await notifyMany(w.created_by ? [w.created_by] : await adminIds(), {
            type: 'quote_followup',
            title: `Quote link expiring — ${w.quote_number}`,
            body: `${label} can no longer be accepted after ${expiryDateText(w.approval_token_expires_at) || 'its expiry date'}`
              + ` (${days} day${days === 1 ? '' : 's'} left).`
              + (parked
                ? ' You parked this one, so the customer was NOT emailed.'
                : sent ? ' The customer has been emailed a reminder with the live link.'
                : ' The customer could NOT be emailed (no address on file or the send failed) — reach out directly.'),
            url: deepLinks.quoteFollowUps('wrap', w.id),
            channels: ['in_app', 'push'],
          });
          await stamp('wrap_quotes', w.id, { expiry_warned_for: w.approval_token_expires_at });
          expiryWarned++;
        } else if (dueExpiredNotice(w, now)) {
          await notifyMany(w.created_by ? [w.created_by] : await adminIds(), {
            type: 'quote_followup',
            title: `Quote link expired — ${w.quote_number}`,
            body: `${customerName || 'The customer'} can no longer accept ${w.quote_number} — the approval link expired`
              + `${expiryDateText(w.approval_token_expires_at) ? ` on ${expiryDateText(w.approval_token_expires_at)}` : ''}.`
              + ' Re-send it to give them a live link again.',
            url: deepLinks.quoteFollowUps('wrap', w.id),
            channels: ['in_app', 'push'],
          });
          await stamp('wrap_quotes', w.id, { expiry_notified_for: w.approval_token_expires_at });
          expiryNotified++;
        }
      }
    } catch (e: any) {
      // Contained: an expiry problem must not cost the run its quiet nudges
      // and escalations, which is the job this cron had first.
      console.warn('quote expiry pass failed:', e?.message || e);
      expiryWarnFailures.push(`pass failed: ${e?.message || e}`);
    }

    // ── Never-opened nudge (R6-9) ─────────────────────────────────────────
    // Three days out with nobody having opened the approval link is a
    // different problem from a quiet customer: the address may be wrong. The
    // rep is told once, with the address it went to and the delivery status,
    // so they can check it.
    //
    // The customer reminder is NOT suppressed. "Never opened" is inferred —
    // link scanners are filtered out by a heuristic, and a customer who read
    // the PDF attachment without clicking through looks identical to one who
    // never saw it. Withholding a real email on that inference would cost
    // more than the extra send.
    let neverOpened = 0;
    try {
      const sentIds = [
        ...(estRes.data || []).map((e: any) => e.id),
        ...(wrapRes.data || []).map((w: any) => w.id),
      ];
      if (sentIds.length > 0) {
        // When view tracking started. A quote sent before it cannot be judged
        // — we were not watching — so no marker means no alerts at all.
        const { data: settings } = await service
          .from('quote_settings').select('view_tracking_started_at').eq('id', 1).maybeSingle();
        const trackingStartedAt = (settings as any)?.view_tracking_started_at || null;

        const byQuote = new Map<string, any[]>();
        // Chunked: `.in()` rides in the URL, and a shop with hundreds of sent
        // quotes would build a query string long enough to be rejected.
        for (let i = 0; i < sentIds.length; i += 200) {
          const slice = sentIds.slice(i, i + 200);
          const { data: viewRows } = await fetchAllRows<any>((from, to) =>
            service.from('quote_views')
              .select('quote_type, quote_id, viewed_at, viewer_kind')
              .in('quote_id', slice)
              .order('viewed_at', { ascending: false })
              .order('id')
              .range(from, to));
          for (const v of viewRows || []) {
            const k = `${v.quote_type}-${v.quote_id}`;
            const arr = byQuote.get(k) || [];
            arr.push(v);
            byQuote.set(k, arr);
          }
        }
        const summaryFor = (type: string, id: string): ViewSummary =>
          summarizeViews(byQuote.get(`${type}-${id}`) || []);

        for (const e of estRes.data || []) {
          if (deferred.has(`estimates:${e.id}`)) continue;
          if (!neverOpenedDue(e.sent_for_approval_at, summaryFor('estimate', e.id), e.never_opened_notified_at, now, trackingStartedAt)) continue;
          const targets = [...new Set([e.sent_for_approval_by, e.created_by].filter(Boolean))] as string[];
          const sentToLine = (e.approval_email_to || []).filter(Boolean).join(', ');
          await notifyMany(targets.length > 0 ? targets : await adminIds(), {
            type: 'quote_followup',
            title: `Never opened — ${e.estimate_number}`,
            body: `Nobody has opened the approval link for ${e.estimate_number}`
              + `${e.customer_name ? ` (${e.customer_name})` : ''} since it was sent.`
              + `${sentToLine ? ` It went to ${sentToLine}` : ' No recipient address is on record'}`
              + `${e.approval_email_status ? ` — delivery status: ${e.approval_email_status}.` : '.'}`
              + ' Worth checking the address is right, or reaching out another way.',
            url: deepLinks.quoteFollowUps('estimate', e.id),
            channels: ['in_app', 'push'],
          });
          await service.from('estimates').update({ never_opened_notified_at: new Date().toISOString() }).eq('id', e.id);
          neverOpened++;
        }

        for (const w of wrapRes.data || []) {
          if (deferred.has(`wrap_quotes:${w.id}`)) continue;
          if (!neverOpenedDue(w.sent_at, summaryFor('wrap', w.id), w.never_opened_notified_at, now, trackingStartedAt)) continue;
          const customerName = (w.customer as any)?.name || null;
          await notifyMany(w.created_by ? [w.created_by] : await adminIds(), {
            type: 'quote_followup',
            title: `Never opened — ${w.quote_number}`,
            body: `Nobody has opened the approval link for ${w.quote_number}`
              + `${customerName ? ` (${customerName})` : ''} since it was sent.`
              + `${w.sent_to ? ` It went to ${w.sent_to}.` : ' No recipient address is on record.'}`
              + ' Worth checking the address is right, or reaching out another way.',
            url: deepLinks.quoteFollowUps('wrap', w.id),
            channels: ['in_app', 'push'],
          });
          await service.from('wrap_quotes').update({ never_opened_notified_at: new Date().toISOString() }).eq('id', w.id);
          neverOpened++;
        }
      }
    } catch (e: any) {
      // Contained, like the expiry pass: view tracking is the newest thing
      // in this cron and must not be able to cost it the older jobs.
      console.warn('never-opened pass failed:', e?.message || e);
    }

    // ── Customer-facing reminders + internal escalation (Stage 3) ─────────
    // Same cadence as the proof cron: quiet 3+ days → automatic reminder
    // email to the original approval recipients (capped at 3); waiting 7+
    // days total → internal escalation, re-escalated at most weekly. A
    // rep-set deferral ("customer answers in September") suppresses BOTH —
    // pestering a customer the rep deliberately parked burns goodwill. A
    // logged manual follow-up (last_followup_at) also resets the reminder
    // clock so the customer isn't emailed the morning after a phone call.
    const REMIND_AFTER_DAYS = 3;
    const MAX_REMINDERS = 3;
    const ESCALATE_AFTER_DAYS = 7;
    let customerReminded = 0;
    let escalated = 0;
    const reminderFailures: string[] = [];
    for (const e of estRes.data || []) {
      if (!e.sent_for_approval_at) continue;
      if (deferred.has(`estimates:${e.id}`)) continue;
      // Already emailed today, with a better message — the expiry warning
      // IS the reminder. Two emails the same morning is how a customer
      // learns to filter us.
      if (warnedNow.has(e.id)) continue;
      const sentDays = (now - new Date(e.sent_for_approval_at).getTime()) / dayMs;

      const lastTouch = Math.max(
        new Date(e.sent_for_approval_at).getTime(),
        e.approval_reminder_sent_at ? new Date(e.approval_reminder_sent_at).getTime() : 0,
        e.last_followup_at ? new Date(e.last_followup_at).getTime() : 0,
      );
      const quietSinceTouch = (now - lastTouch) / dayMs;
      if (quietSinceTouch >= REMIND_AFTER_DAYS && (e.approval_reminder_count || 0) < MAX_REMINDERS) {
        const result = await sendEstimateApprovalReminder(service, e as EstimateReminderRow);
        if (result.ok) customerReminded++;
        else if (!result.skipped) reminderFailures.push(`${e.estimate_number}: ${result.error}`);
      }

      const escalatedDays = e.approval_escalated_at ? (now - new Date(e.approval_escalated_at).getTime()) / dayMs : null;
      if (sentDays >= ESCALATE_AFTER_DAYS && (escalatedDays == null || escalatedDays >= ESCALATE_AFTER_DAYS)) {
        const targets = [...new Set([e.sent_for_approval_by, e.created_by].filter(Boolean))] as string[];
        if (targets.length > 0) {
          await notifyMany(targets, {
            type: 'quote_followup',
            title: `Estimate stuck ${Math.floor(sentDays)}d — ${e.estimate_number}`,
            body: `${e.customer_name || 'The customer'} hasn't answered ${e.estimate_number} in ${Math.floor(sentDays)} days (${e.approval_reminder_count || 0} automatic reminder${(e.approval_reminder_count || 0) !== 1 ? 's' : ''} sent). Worth a call.`,
            url: deepLinks.quoteFollowUps('estimate', e.id),
            channels: ['in_app', 'push'],
          });
        }
        await service.from('estimates')
          .update({ approval_escalated_at: new Date().toISOString() })
          .eq('id', e.id);
        escalated++;
      }
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'quote_followup_check', { status: 'ok', quiet: quiet.length, notified, reminded, customerReminded, escalated, expiryWarned, expiryNotified, neverOpened, reminderFailures: reminderFailures.slice(0, 10), expiryWarnFailures: expiryWarnFailures.slice(0, 10) },
    );

    return NextResponse.json({ status: 'ok', quiet: quiet.length, notified, reminded, customerReminded, escalated, expiryWarned, expiryNotified, neverOpened, reminderFailures, expiryWarnFailures, syncStateWrite });
  } catch (e: any) {
    console.error('quote-followup-check failed:', e);
    await recordHeartbeat(service, 'quote_followup_check', { error: e.message || 'quote follow-up check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'quote follow-up check failed' }, { status: 500 });
  }
}
