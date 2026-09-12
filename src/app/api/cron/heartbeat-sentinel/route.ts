import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany, getSuperAdminIds } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat, evaluateSystemHealth } from '@/lib/system-health';
import {
  evaluateShortfall, evaluateRise, sameWeekdayDates, shopDay, isBusinessDay,
  summarize, BASELINE_WEEKS, type PulseCheck,
} from '@/lib/business-heartbeat';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Business Heartbeat Alarms (R6-13) — a daily sentinel over a SHORT, FIXED
 * list of pulse metrics, alerting only when one trips.
 *
 * Every check is judged against the SAME WEEKDAY over the trailing four
 * weeks. A flat trailing average fires every weekend in a business that
 * does almost nothing on Sundays, and an alarm that cries wolf weekly is
 * worse than no alarm.
 *
 * Three states, never two: ok, tripped, and UNKNOWN. An unknown means the
 * query failed or the baseline is too thin to judge — reported as unknown,
 * never folded into "all clear", and never escalated as a trip. The one
 * thing a sentinel must not do is report health it did not measure.
 *
 * The owners hear about trips. They also hear when a check has been
 * unknown for a while, because a permanently unmeasurable pulse is a
 * broken sentinel, and a broken sentinel that stays quiet is the failure
 * mode this whole thing exists to prevent.
 */

/** Count rows in a window, or null when the query failed — never 0. */
async function countBetween(table: string, column: string, fromIso: string, toIso: string): Promise<number | null> {
  const { count, error } = await service
    .from(table)
    .select('id', { count: 'exact', head: true })
    .gte(column, fromIso)
    .lt(column, toIso);
  if (error) {
    console.error(`[heartbeat-sentinel] count ${table}.${column} failed:`, error.message);
    return null;
  }
  return count ?? null;
}

/** Shop-day bounds as UTC instants. */
function dayWindow(dateKey: string): { from: string; to: string } {
  // The shop runs on America/Chicago; a day is [00:00, 24:00) local. Using
  // a fixed offset would drift an hour twice a year, so the boundary is
  // derived from the date itself.
  const noon = new Date(`${dateKey}T12:00:00Z`);
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'shortOffset',
  }).formatToParts(noon).find(p => p.type === 'timeZoneName')?.value || 'GMT-6';
  const hours = Number(local.replace('GMT', '')) || -6;
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const sign = hours <= 0 ? '-' : '+';
  const offset = `${sign}${pad(hours)}:00`;
  return {
    from: new Date(`${dateKey}T00:00:00${offset}`).toISOString(),
    to: new Date(new Date(`${dateKey}T00:00:00${offset}`).getTime() + 86_400_000).toISOString(),
  };
}

async function countForDays(table: string, column: string, days: string[]): Promise<Array<number | null>> {
  return Promise.all(days.map(async d => {
    const { from, to } = dayWindow(d);
    return countBetween(table, column, from, to);
  }));
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const today = shopDay(new Date());
  const priorDays = sameWeekdayDates(new Date(), BASELINE_WEEKS);
  const { from: todayFrom, to: todayTo } = dayWindow(today);
  const checks: PulseCheck[] = [];

  try {
    // ── 1. Scans on a business day ────────────────────────────────────
    if (isBusinessDay(today)) {
      const [todayScans, history] = await Promise.all([
        countBetween('scan_logs', 'scanned_at', todayFrom, todayTo),
        countForDays('scan_logs', 'scanned_at', priorDays),
      ]);
      checks.push(evaluateShortfall({
        key: 'scans', label: 'Install scans', today: todayScans, history,
        dropFraction: 0.7, noun: 'scans',
      }));
    } else {
      checks.push({
        key: 'scans', label: 'Install scans', status: 'ok',
        detail: 'Not a business day — scan volume is not judged at the weekend.',
        value: null, baseline: null, baselinePoints: 0,
      });
    }

    // ── 2. Quotes sent ────────────────────────────────────────────────
    if (isBusinessDay(today)) {
      const [todaySent, history] = await Promise.all([
        countBetween('estimates', 'sent_for_approval_at', todayFrom, todayTo),
        countForDays('estimates', 'sent_for_approval_at', priorDays),
      ]);
      checks.push(evaluateShortfall({
        key: 'quotes_sent', label: 'Quotes sent', today: todaySent, history,
        dropFraction: 0.8, noun: 'quotes sent',
      }));
    } else {
      checks.push({
        key: 'quotes_sent', label: 'Quotes sent', status: 'ok',
        detail: 'Not a business day — quote volume is not judged at the weekend.',
        value: null, baseline: null, baselinePoints: 0,
      });
    }

    // ── 3. Email bounces ──────────────────────────────────────────────
    const bouncedToday = await (async () => {
      const { count, error } = await service
        .from('email_log')
        .select('id', { count: 'exact', head: true })
        .in('delivery_status', ['bounced', 'failed'])
        .gte('created_at', todayFrom)
        .lt('created_at', todayTo);
      if (error) { console.error('[heartbeat-sentinel] bounce count failed:', error.message); return null; }
      return count ?? null;
    })();
    const bounceHistory = await Promise.all(priorDays.map(async d => {
      const { from, to } = dayWindow(d);
      const { count, error } = await service
        .from('email_log')
        .select('id', { count: 'exact', head: true })
        .in('delivery_status', ['bounced', 'failed'])
        .gte('created_at', from).lt('created_at', to);
      return error ? null : (count ?? null);
    }));
    checks.push(evaluateRise({
      key: 'bounces', label: 'Email bounces', today: bouncedToday, history: bounceHistory,
      riseFraction: 1.0, minAbsolute: 5, noun: 'bounced or failed emails',
    }));

    // ── 4. A/R over 60 days ───────────────────────────────────────────
    const arValue = async (day: string): Promise<number | null> => {
      const { data, error } = await service
        .from('ar_snapshots')
        .select('value')
        .eq('day', day)
        .eq('scope', 'bucket')
        .in('key', ['d61_90', 'd90_plus'])
        .limit(10);
      if (error) return null;
      if (!data || data.length === 0) return null;   // no snapshot ⇒ unknown, not $0
      return data.reduce((s, r: any) => s + (Number(r.value) || 0), 0);
    };
    const [arToday, ...arHistory] = await Promise.all([arValue(today), ...priorDays.map(arValue)]);
    checks.push(evaluateRise({
      key: 'ar_over_60', label: 'A/R over 60 days', today: arToday, history: arHistory,
      riseFraction: 0.25, minAbsolute: 10_000, noun: 'in A/R over 60 days',
      format: (n) => `$${Math.round(n).toLocaleString()}`,
    }));

    // ── 5. Dead cron heartbeat ────────────────────────────────────────
    // Not a same-weekday comparison: a job that has not run is not a
    // seasonal dip. evaluateSystemHealth is the existing authority.
    try {
      const health = await evaluateSystemHealth(service);
      const dead = health.filter(c => c.status === 'stale' || c.status === 'error');
      checks.push(dead.length > 0
        ? {
          key: 'dead_crons', label: 'Background jobs', status: 'tripped',
          detail: `${dead.length} job${dead.length === 1 ? '' : 's'} stale or erroring: ${dead.slice(0, 4).map(d => d.label).join(', ')}${dead.length > 4 ? '…' : ''}.`,
          value: dead.length, baseline: 0, baselinePoints: 0,
        }
        : {
          key: 'dead_crons', label: 'Background jobs', status: 'ok',
          detail: `All ${health.length} monitored jobs reporting on schedule.`,
          value: 0, baseline: 0, baselinePoints: 0,
        });
    } catch (e: any) {
      checks.push({
        key: 'dead_crons', label: 'Background jobs', status: 'unknown',
        detail: `Could not read job health: ${e?.message || 'unknown error'}.`,
        value: null, baseline: null, baselinePoints: 0,
      });
    }

    const report = summarize(today, checks);

    // Alert only on trips. Unknowns are carried in the response and the
    // heartbeat payload — visible on System Health — but do not page
    // anyone, because "we could not measure it" is not evidence of trouble.
    if (report.tripped.length > 0) {
      const ids = await getSuperAdminIds();
      if (ids.length > 0) {
        await notifyMany(ids, {
          type: 'system_health',
          title: `⚠ Business pulse: ${report.tripped.length} check${report.tripped.length === 1 ? '' : 's'} tripped`,
          body: report.tripped.map(c => `${c.label}: ${c.detail}`).join('\n').slice(0, 900),
          url: deepLinks.systemHealth(),
          channels: ['in_app', 'push', 'email'],
        });
      }
    }

    const payload = {
      day: report.day,
      tripped: report.tripped.map(c => ({ key: c.key, detail: c.detail })),
      unknown: report.unknown.map(c => ({ key: c.key, detail: c.detail })),
      ok: report.checks.filter(c => c.status === 'ok').length,
      records: report.checks.length,
    };
    await recordHeartbeat(service, 'heartbeat_sentinel', payload, { startedAt, records: report.checks.length });
    return NextResponse.json({ success: true, ...payload, checks: report.checks });
  } catch (e: any) {
    console.error('heartbeat sentinel failed:', e);
    await recordHeartbeat(service, 'heartbeat_sentinel', { error: e?.message || 'unknown' }, { startedAt });
    return NextResponse.json({ error: 'Heartbeat sentinel failed' }, { status: 500 });
  }
}
