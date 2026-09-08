import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { recordHeartbeat } from '@/lib/system-health';
import {
  gatherOwnerBrief, narrativeFacts, generateBriefNarrative, sectionError,
  shiftDay, fmtUsd, type OwnerBriefData, type MetricDelta,
} from '@/lib/owner-brief';
import { sendEmail, buildOwnerBriefEmail, type BriefRow } from '@/lib/resend';
import type { WeeklyRevenue } from '@/lib/revenue-summary';
import type { QuoteFactSummary } from '@/lib/sales-facts';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

/**
 * Owner's Weekly Brief (R5-7) — Monday 12:45 UTC (7:45 AM Chicago). One
 * email to approved super_admin + executive accounts (opt-out via
 * notification_preferences.notify_weekly_brief) with the week's money,
 * sales, shop, order-book, and exceptions numbers, plus an optional AI
 * narrative under a numbers-verbatim contract — the numbers never wait on
 * the model.
 *
 * Links are per-audience: executives are deliberately walled to home +
 * financials (src/lib/features.ts), so their copy links only to /home —
 * an /admin URL would be a dead click (the deep-links rule). Super admins
 * get rows linked to the report each number comes from.
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
    const data = await gatherOwnerBrief(service);

    const failed: string[] = [];
    for (const [name, section] of Object.entries({
      revenue: data.revenue, collections: data.collections, quotes: data.quotes,
      shipped: data.shipped, promises: data.promises, exceptions: data.exceptions,
    })) {
      const err = sectionError(section);
      if (err) failed.push(`${name}: ${err}`);
    }
    const hasDeltas = Object.values(data.deltas).some(d => d.now != null);
    if (failed.length === 6 && !hasDeltas) {
      // Nothing gathered at all — an empty brief teaches people to ignore it.
      throw new Error(`every section failed — ${failed.join('; ')}`);
    }

    const facts = narrativeFacts(data);
    const narrative = await generateBriefNarrative(facts);

    // Audience: approved super_admin/executive (role scalar or roles array —
    // same match as getSuperAdminIds), minus notify_weekly_brief opt-outs.
    const { data: audience, error: audErr } = await service
      .from('profiles')
      .select('id, email, role, roles')
      .or('role.eq.super_admin,roles.cs.{super_admin},role.eq.executive,roles.cs.{executive}')
      .eq('status', 'approved');
    if (audErr) throw new Error(audErr.message);

    const optedOut = new Set<string>();
    const ids = (audience || []).map(p => p.id);
    if (ids.length > 0) {
      const { data: prefs } = await service
        .from('notification_preferences')
        .select('user_id, notify_weekly_brief')
        .in('user_id', ids);
      for (const p of prefs || []) {
        if (p.notify_weekly_brief === false) optedOut.add(String(p.user_id));
      }
    }
    const recipients = (audience || []).filter(p => !optedOut.has(p.id));

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
    const weekLabel = fmtWeekLabel(data.weekStart, shiftDay(data.weekEnd, -1));
    const subject = `Owner's brief — week of ${fmtDayShort(data.weekStart)}`;

    // Two HTML variants: super admins get report links, executives (walled
    // to home + financials) get /home only.
    const adminHtml = buildOwnerBriefEmail(
      weekLabel, narrative, briefSections(data, path => `${appUrl}${path}`), `${appUrl}/home`,
    );
    const execHtml = buildOwnerBriefEmail(
      weekLabel, narrative,
      briefSections(data, path => (path === '/home' ? `${appUrl}/home` : undefined)),
      `${appUrl}/home`,
    );

    let sent = 0;
    for (const p of recipients) {
      if (!p.email) continue;
      const roles: string[] = Array.isArray(p.roles) ? p.roles : [];
      const isSuper = p.role === 'super_admin' || roles.includes('super_admin');
      const ok = await sendEmail(
        p.email, subject, isSuper ? adminHtml : execHtml,
        undefined, undefined, undefined, undefined,
        { kind: 'owner_brief' },
      );
      if (ok) sent++;
    }

    // In-app + push companion (email above IS the email channel — sending
    // it again through notify would double-deliver). Digest of the whole
    // week → /home, which every recipient role can open.
    if (recipients.length > 0) {
      await notifyMany(recipients.map(p => p.id), {
        type: 'owner_brief',
        title: `Owner's brief — week of ${fmtDayShort(data.weekStart)}`,
        body: (facts[0] || 'Your Monday brief is ready.').slice(0, 300),
        url: '/home',
        channels: ['in_app', 'push'],
      });
    }

    const syncStateWrite = await recordHeartbeat(service, 'owner_brief', {
      status: 'ok', week: data.weekStart, recipients: recipients.length, sent,
      optedOut: optedOut.size, failedSections: failed, narrative: !!narrative,
    });
    return NextResponse.json({
      status: 'ok', week: data.weekStart, recipients: recipients.length, sent,
      optedOut: optedOut.size, failedSections: failed, narrative: !!narrative, syncStateWrite,
    });
  } catch (e: any) {
    console.error('owner-brief failed:', e);
    await recordHeartbeat(service, 'owner_brief', { error: e.message || 'owner brief failed' }).catch(() => {});
    return NextResponse.json({ error: e.message || 'owner brief failed' }, { status: 500 });
  }
}

/** "Sep 1" from YYYY-MM-DD. */
function fmtDayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "September 1 – 7, 2026" (both dates inclusive). */
function fmtWeekLabel(start: string, endInclusive: string): string {
  const [y, m, d] = start.split('-').map(Number);
  const s = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const [ey, em, ed] = endInclusive.split('-').map(Number);
  const sameMonth = y === ey && m === em;
  const e = new Date(Date.UTC(ey, em - 1, ed)).toLocaleDateString('en-US', sameMonth
    ? { day: 'numeric', timeZone: 'UTC' }
    : { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `${s} – ${e}, ${ey}`;
}

/** "up $12,300 from last Monday" / "down…" / "flat…" / first-week note. */
function deltaPhrase(d: MetricDelta, money = true): string {
  if (d.weekAgo == null) return 'first week of tracking';
  const diff = (d.now || 0) - d.weekAgo;
  const mag = money ? fmtUsd(Math.abs(diff)) : String(Math.abs(Math.round(diff)));
  if (Math.abs(diff) < 0.5) return 'flat vs last Monday';
  return diff > 0 ? `up ${mag} from last Monday` : `down ${mag} from last Monday`;
}

/**
 * The email's sections. `toUrl` maps an app path to an absolute URL the
 * recipient's role can open — or undefined, which renders the row unlinked
 * (never a dead click).
 */
function briefSections(data: OwnerBriefData, toUrl: (path: string) => string | undefined): { title: string; rows: BriefRow[] }[] {
  const rows = {
    money: [] as BriefRow[], sales: [] as BriefRow[], shop: [] as BriefRow[],
    book: [] as BriefRow[], exceptions: [] as BriefRow[],
  };

  if (!sectionError(data.revenue)) {
    const r = data.revenue as WeeklyRevenue;
    rows.money.push({
      text: `Invoiced ${fmtUsd(r.thisWeek)} this week — last week ${fmtUsd(r.lastWeek)}, same week last year ${fmtUsd(r.sameWeekLastYear)}`,
      url: toUrl('/home'), strong: true,
    });
  } else {
    rows.money.push({ text: 'Invoiced revenue unavailable this week (NetSuite query failed)' });
  }
  if (!sectionError(data.collections)) {
    const c = data.collections as { total: number; count: number };
    rows.money.push({ text: `Collected ${fmtUsd(c.total)} across ${c.count} payment${c.count === 1 ? '' : 's'}`, url: toUrl('/home') });
  } else {
    const err = sectionError(data.collections) || '';
    rows.money.push({
      text: /restlet/i.test(err)
        ? 'Collections pending the financials RESTlet redeploy (docs/pnl-restlet-deploy.md)'
        : 'Collections unavailable this week',
    });
  }
  const ar = data.deltas.ar_total;
  if (ar?.now != null) {
    rows.money.push({ text: `A/R ${fmtUsd(ar.now)} open — ${deltaPhrase(ar)}`, url: toUrl('/home') });
  }

  if (!sectionError(data.quotes)) {
    const q = data.quotes as QuoteFactSummary;
    const winPart = q.winRate != null ? `, win rate ${Math.round(q.winRate * 100)}%` : '';
    rows.sales.push({
      text: `${q.sentCount} quote${q.sentCount === 1 ? '' : 's'} sent (${fmtUsd(q.sentValue)}) — ${q.wonCount} won (${fmtUsd(q.wonValue)})${winPart}`,
      url: toUrl('/admin/reports/sales-performance'), strong: true,
    });
  } else {
    rows.sales.push({ text: 'Quote activity unavailable this week' });
  }
  const pipe = data.deltas.open_quotes_value;
  if (pipe?.now != null) {
    rows.sales.push({ text: `Open quote pipeline ${fmtUsd(pipe.now)} — ${deltaPhrase(pipe)}`, url: toUrl('/quotes') });
  }

  if (!sectionError(data.shipped)) {
    const s = data.shipped as { vehicles: number; customers: number };
    rows.shop.push({
      text: `${s.vehicles} vehicle${s.vehicles === 1 ? '' : 's'} shipped for ${s.customers} customer${s.customers === 1 ? '' : 's'}`,
      url: toUrl('/tracking'), strong: true,
    });
  }
  if (!sectionError(data.promises)) {
    const p = data.promises as { kept: number; missed: number; overdueNow: number };
    rows.shop.push({
      text: `Promised-back dates: ${p.kept} kept, ${p.missed} missed — ${p.overdueNow} overdue in the shop right now`,
      url: toUrl('/admin/reports/on-time'),
    });
  }
  const done = data.deltas.vehicles_complete_not_shipped;
  if (done?.now != null) {
    rows.shop.push({ text: `${Math.round(done.now)} complete but not shipped — ${deltaPhrase(done, false)}`, url: toUrl('/tracking') });
  }

  const book = data.deltas.so_order_book_value;
  if (book?.now != null) {
    rows.book.push({ text: `Order book ${fmtUsd(book.now)} open — ${deltaPhrase(book)}`, url: toUrl('/admin/reports/order-book'), strong: true });
  }
  const unbilled = data.deltas.so_unbilled_value;
  if (unbilled?.now != null) {
    rows.book.push({ text: `Unbilled work ${fmtUsd(unbilled.now)} — ${deltaPhrase(unbilled)}`, url: toUrl('/admin/reports/order-book') });
  }

  if (!sectionError(data.exceptions)) {
    const e = data.exceptions as { total: number; top: { label: string; count: number }[] };
    if (e.total > 0) {
      const top = e.top.map(t => `${t.label} ×${t.count}`).join(', ');
      rows.exceptions.push({ text: `${e.total} guard override${e.total === 1 ? '' : 's'} — ${top}`, url: toUrl('/admin/audit') });
    } else {
      rows.exceptions.push({ text: 'No guard overrides this week' });
    }
  }

  return [
    { title: 'Money', rows: rows.money },
    { title: 'Sales', rows: rows.sales },
    { title: 'Shop', rows: rows.shop },
    { title: 'Order book', rows: rows.book },
    { title: 'Exceptions', rows: rows.exceptions },
  ];
}
