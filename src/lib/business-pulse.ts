import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateSystemHealth } from '@/lib/system-health';
import {
  evaluateShortfall, evaluateRise, sameWeekdayKeys, lastCompletedBusinessDay, weekdayShort, shopDay,
  summarize, type PulseCheck, type HeartbeatReport,
} from '@/lib/business-heartbeat';

/**
 * Business Pulse (R6-13) — the five pulse checks behind the super-admin
 * Dashboard card and the daily heartbeat-sentinel record on System Health.
 *
 * Owner decision 2026-10-22: no notification. The pulse used to push, email
 * and bell the super admins at 11:10 AM whenever a check tripped; it now
 * lives on the Dashboard and is worked out when the page opens.
 *
 * Every day-based check judges the LAST COMPLETED BUSINESS DAY against the
 * same weekday over the trailing four weeks. The 11 AM alert judged the
 * morning so far against whole-day averages (a normal morning read as a
 * 70-100% drop), and looked for an A/R snapshot that is not written until
 * that night. Today-so-far counts ride along for reference only.
 */

/** Shop-day bounds as UTC instants. The shop runs on America/Chicago. */
export function dayWindow(dateKey: string): { from: string; to: string } {
  // Derived from the date itself so the boundary never drifts with DST.
  const noon = new Date(`${dateKey}T12:00:00Z`);
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'shortOffset',
  }).formatToParts(noon).find(p => p.type === 'timeZoneName')?.value || 'GMT-6';
  const hours = Number(local.replace('GMT', '')) || -6;
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const sign = hours <= 0 ? '-' : '+';
  const start = new Date(`${dateKey}T00:00:00${sign}${pad(hours)}:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
}

export interface BusinessPulse extends HeartbeatReport {
  /** 'Fri' — the judged day, as the card names it. */
  dayLabel: string;
  /** Today's counts so far (shop day), for reference. Null when unmeasured. */
  todaySoFar: { scans: number | null; quotesSent: number | null };
}

export async function computeBusinessPulse(service: SupabaseClient, now = new Date()): Promise<BusinessPulse> {
  const day = lastCompletedBusinessDay(now);
  const priorDays = sameWeekdayKeys(day);
  const dayLabel = weekdayShort(day);
  const dayWord = `on ${dayLabel}`;

  /** Count rows in a window, or null when the query failed — never 0. */
  const countBetween = async (table: string, column: string, fromIso: string, toIso: string): Promise<number | null> => {
    const { count, error } = await service
      .from(table)
      .select('id', { count: 'exact', head: true })
      .gte(column, fromIso)
      .lt(column, toIso);
    if (error) {
      console.error(`[business-pulse] count ${table}.${column} failed:`, error.message);
      return null;
    }
    return count ?? null;
  };
  const countDay = (table: string, column: string, key: string) => {
    const { from, to } = dayWindow(key);
    return countBetween(table, column, from, to);
  };
  const countDays = (table: string, column: string, keys: string[]) =>
    Promise.all(keys.map(k => countDay(table, column, k)));

  const bouncesOn = async (key: string): Promise<number | null> => {
    const { from, to } = dayWindow(key);
    const { count, error } = await service
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .in('delivery_status', ['bounced', 'failed'])
      .gte('created_at', from)
      .lt('created_at', to);
    if (error) { console.error('[business-pulse] bounce count failed:', error.message); return null; }
    return count ?? null;
  };

  const arOver60 = async (key: string): Promise<number | null> => {
    const { data, error } = await service
      .from('ar_snapshots')
      .select('value')
      .eq('day', key)
      .eq('scope', 'bucket')
      .in('key', ['d61_90', 'd90_plus'])
      .limit(10);
    if (error) return null;
    if (!data || data.length === 0) return null;   // no snapshot ⇒ unknown, not $0
    return data.reduce((s, r: any) => s + (Number(r.value) || 0), 0);
  };

  const todayKey = shopDay(now);

  const [
    scansDay, scansHistory, quotesDay, quotesHistory,
    bouncesDay, bouncesHistory, arDay, arHistory,
    scansToday, quotesToday,
  ] = await Promise.all([
    countDay('scan_logs', 'scanned_at', day),
    countDays('scan_logs', 'scanned_at', priorDays),
    countDay('estimates', 'sent_for_approval_at', day),
    countDays('estimates', 'sent_for_approval_at', priorDays),
    bouncesOn(day),
    Promise.all(priorDays.map(bouncesOn)),
    arOver60(day),
    Promise.all(priorDays.map(arOver60)),
    countDay('scan_logs', 'scanned_at', todayKey),
    countDay('estimates', 'sent_for_approval_at', todayKey),
  ]);

  const checks: PulseCheck[] = [
    evaluateShortfall({
      key: 'scans', label: 'Install scans', today: scansDay, history: scansHistory,
      dropFraction: 0.7, noun: 'scans', dayWord,
    }),
    evaluateShortfall({
      key: 'quotes_sent', label: 'Quotes sent', today: quotesDay, history: quotesHistory,
      dropFraction: 0.8, noun: 'quotes sent', dayWord,
    }),
    evaluateRise({
      key: 'ar_over_60', label: 'A/R over 60 days', today: arDay, history: arHistory,
      riseFraction: 0.25, minAbsolute: 10_000, noun: 'in A/R over 60 days', dayWord,
      format: (n) => `$${Math.round(n).toLocaleString()}`,
    }),
    evaluateRise({
      key: 'bounces', label: 'Email bounces', today: bouncesDay, history: bouncesHistory,
      riseFraction: 1.0, minAbsolute: 5, noun: 'bounced or failed emails', dayWord,
    }),
  ];

  // Not a same-weekday comparison: a job that has not run is not a seasonal
  // dip. evaluateSystemHealth is the existing authority, judged as of now.
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

  return {
    ...summarize(day, checks),
    dayLabel,
    todaySoFar: { scans: scansToday, quotesSent: quotesToday },
  };
}
