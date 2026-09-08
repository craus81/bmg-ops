import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { chicagoDay } from './exec-metrics';
import { loadWeeklyRevenue, type WeeklyRevenue } from './revenue-summary';
import { loadQuoteFacts, summarizeQuoteFacts, type QuoteFactSummary } from './sales-facts';
import { loadCompletions, loadOpenCommitments, classifyPromise, dateDiffDays } from './on-time';
import { getCollectionsFromRestlet } from './netsuite';
import { EXCEPTION_ACTIONS, ACTION_LABELS } from './exception-actions';
import { callAnthropicWithRetry } from './anthropic';

/**
 * Owner's Weekly Brief (R5-7): ONE Monday-morning email covering the week
 * that just ended — money, sales, shop, order book, exceptions — assembled
 * from the same loaders the reports use (sales-facts, on-time,
 * revenue-summary, exec-metrics snapshots), so no number in the email can
 * disagree with the page it links to. Every section gathers independently:
 * a NetSuite outage costs that section, not the brief.
 *
 * The audit doc's rule: the Monday CEO digest and the weekly brief are one
 * composer, one email — never both separately.
 */

/** `day` (YYYY-MM-DD) shifted by whole days, calendar-safe across months/years. */
export function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

/**
 * The reporting week for a brief generated on `today`: [start, end) where
 * `end` is the most recent Monday ≤ today. Run on its Monday schedule the
 * brief covers the week that just ended; a manual run mid-week re-sends the
 * same completed week rather than a partial one.
 */
export function briefWeekBounds(today: string): { start: string; end: string } {
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
  const sinceMonday = (dow + 6) % 7;
  const end = shiftDay(today, -sinceMonday);
  return { start: shiftDay(end, -7), end };
}

export interface MetricDelta {
  now: number | null;
  nowDay: string | null;
  weekAgo: number | null;
}

/**
 * Latest value and the value ~7 days earlier for each metric, from
 * metric_snapshots rows. Null-valued rows (source errored that night) are
 * skipped; the week-ago point is the non-null day closest to now−7 within
 * ±3 days (ties → the earlier day), so a missed night doesn't blank the
 * delta. Metrics captured less than a week get { weekAgo: null }.
 */
export function metricDeltas(
  rows: { metric: string; day: string; value: number | null }[],
  metrics: string[],
): Record<string, MetricDelta> {
  const out: Record<string, MetricDelta> = {};
  for (const metric of metrics) {
    const mine = rows
      .filter(r => r.metric === metric && r.value != null)
      .sort((a, b) => a.day.localeCompare(b.day));
    const latest = mine[mine.length - 1];
    if (!latest) { out[metric] = { now: null, nowDay: null, weekAgo: null }; continue; }
    const target = shiftDay(latest.day, -7);
    let weekAgo: { day: string; value: number | null } | null = null;
    let bestDist = Infinity;
    for (const r of mine) {
      if (r.day === latest.day) continue;
      const dist = Math.abs(dateDiffDays(target, r.day));
      if (dist <= 3 && (dist < bestDist || (dist === bestDist && weekAgo && r.day < weekAgo.day))) {
        bestDist = dist;
        weekAgo = r;
      }
    }
    out[metric] = { now: latest.value, nowDay: latest.day, weekAgo: weekAgo ? weekAgo.value : null };
  }
  return out;
}

/** The snapshot metrics the brief trends week-over-week (R4-1 keys). */
export const BRIEF_DELTA_METRICS = [
  'ar_total',
  'open_quotes_value',
  'so_order_book_value',
  'so_unbilled_value',
  'vehicles_complete_not_shipped',
] as const;

type Section<T> = T | { error: string };

export interface OwnerBriefData {
  weekStart: string; // inclusive
  weekEnd: string; // exclusive (the Monday the brief goes out)
  revenue: Section<WeeklyRevenue>;
  collections: Section<{ total: number; count: number }>;
  quotes: Section<QuoteFactSummary>;
  shipped: Section<{ vehicles: number; customers: number }>;
  promises: Section<{ kept: number; missed: number; overdueNow: number }>;
  deltas: Record<string, MetricDelta>;
  exceptions: Section<{ total: number; top: { label: string; count: number }[] }>;
}

export function sectionError<T>(s: Section<T>): string | null {
  return s && typeof s === 'object' && 'error' in s ? (s as { error: string }).error : null;
}

const errOf = (e: unknown) => String((e as any)?.message || e).slice(0, 300);

/** Vehicles whose status reached 'shipped' during [start, end), deduped, with distinct customers. */
async function loadShippedWeek(
  service: SupabaseClient,
  start: string,
  end: string,
): Promise<{ vehicles: number; customers: number }> {
  const { data, error } = await fetchAllRows<{ vehicle_id: string }>((from, to) => service
    .from('vehicle_status_history')
    .select('id, vehicle_id')
    .eq('to_status', 'shipped')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const ids = [...new Set((data || []).map(r => r.vehicle_id))];
  const customers = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: checkins, error: cErr } = await service
      .from('fleet_checkins')
      .select('id, customer_name')
      .in('id', ids.slice(i, i + 200));
    if (cErr) throw new Error(cErr.message);
    for (const c of checkins || []) {
      const name = (c.customer_name || '').trim();
      if (name) customers.add(name.toLowerCase());
    }
  }
  return { vehicles: ids.length, customers: customers.size };
}

async function loadPromisesWeek(
  service: SupabaseClient,
  start: string,
  end: string,
): Promise<{ kept: number; missed: number; overdueNow: number }> {
  const [completions, open] = await Promise.all([
    loadCompletions(service, start),
    loadOpenCommitments(service),
  ]);
  let kept = 0, missed = 0;
  for (const row of completions) {
    if (row.completedDay < start || row.completedDay >= end) continue;
    const outcome = classifyPromise(row.promised, row.completedDay);
    if (outcome === 'on_time') kept++;
    else if (outcome === 'late') missed++;
  }
  return { kept, missed, overdueNow: open.filter(c => c.daysUntil < 0).length };
}

async function loadExceptionsWeek(
  service: SupabaseClient,
  start: string,
  end: string,
): Promise<{ total: number; top: { label: string; count: number }[] }> {
  const { data, error } = await fetchAllRows<{ action: string }>((from, to) => service
    .from('audit_log')
    .select('id, action')
    .in('action', EXCEPTION_ACTIONS)
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const r of data || []) counts.set(r.action, (counts.get(r.action) || 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([action, count]) => ({ label: ACTION_LABELS[action] || action, count }));
  return { total: (data || []).length, top };
}

export async function gatherOwnerBrief(service: SupabaseClient, today = chicagoDay()): Promise<OwnerBriefData> {
  const { start, end } = briefWeekBounds(today);

  const [revenue, collections, quotes, shipped, promises, snapshots, exceptions] = await Promise.allSettled([
    loadWeeklyRevenue(end),
    getCollectionsFromRestlet(start, shiftDay(end, -1)),
    loadQuoteFacts(service, start, end).then(summarizeQuoteFacts),
    loadShippedWeek(service, start, end),
    loadPromisesWeek(service, start, end),
    service
      .from('metric_snapshots')
      .select('metric, day, value')
      .in('metric', [...BRIEF_DELTA_METRICS])
      .gte('day', shiftDay(today, -12))
      .order('day'),
    loadExceptionsWeek(service, start, end),
  ]);

  const settle = <T,>(r: PromiseSettledResult<T>): Section<T> =>
    r.status === 'fulfilled' ? r.value : { error: errOf(r.reason) };

  // Collections come back { success, total, count } | { success: false, error }.
  let collectionsSection: Section<{ total: number; count: number }>;
  if (collections.status === 'fulfilled') {
    const c = collections.value;
    collectionsSection = c.success
      ? { total: Math.abs(c.total || 0), count: c.count || 0 }
      : { error: c.error || 'Collections unavailable' };
  } else {
    collectionsSection = { error: errOf(collections.reason) };
  }

  const snapRows = snapshots.status === 'fulfilled' ? ((snapshots.value as any).data || []) : [];

  return {
    weekStart: start,
    weekEnd: end,
    revenue: settle(revenue),
    collections: collectionsSection,
    quotes: settle(quotes),
    shipped: settle(shipped),
    promises: settle(promises),
    deltas: metricDeltas(snapRows, [...BRIEF_DELTA_METRICS]),
    exceptions: settle(exceptions),
  };
}

/** Whole dollars, US format: 1234.56 → "$1,235"; negatives → "−$…". */
export function fmtUsd(n: number): string {
  const rounded = Math.round(Math.abs(n));
  const s = '$' + rounded.toLocaleString('en-US');
  return n < 0 ? `−${s}` : s;
}

/**
 * The fact lines handed to the narrative model AND nothing else — the
 * narrative may only restate these. Pure so the contract is testable:
 * errored sections contribute no line (the model can't mention what it
 * never saw).
 */
export function narrativeFacts(data: OwnerBriefData): string[] {
  const lines: string[] = [];
  if (!sectionError(data.revenue)) {
    const r = data.revenue as WeeklyRevenue;
    lines.push(`Invoiced revenue this week: ${fmtUsd(r.thisWeek)} (previous week ${fmtUsd(r.lastWeek)}; same week last year ${fmtUsd(r.sameWeekLastYear)})`);
  }
  if (!sectionError(data.collections)) {
    const c = data.collections as { total: number; count: number };
    lines.push(`Customer payments collected this week: ${fmtUsd(c.total)} across ${c.count} payments`);
  }
  if (!sectionError(data.quotes)) {
    const q = data.quotes as QuoteFactSummary;
    lines.push(`Quotes sent this week: ${q.sentCount} worth ${fmtUsd(q.sentValue)}; won ${q.wonCount} worth ${fmtUsd(q.wonValue)}`);
  }
  if (!sectionError(data.shipped)) {
    const s = data.shipped as { vehicles: number; customers: number };
    lines.push(`Vehicles shipped this week: ${s.vehicles} for ${s.customers} customers`);
  }
  if (!sectionError(data.promises)) {
    const p = data.promises as { kept: number; missed: number; overdueNow: number };
    lines.push(`Promised-back dates: ${p.kept} kept, ${p.missed} missed this week; ${p.overdueNow} vehicles in the shop are past their promise right now`);
  }
  const ar = data.deltas.ar_total;
  if (ar && ar.now != null) {
    lines.push(`Open receivables now: ${fmtUsd(ar.now)}${ar.weekAgo != null ? ` (a week ago ${fmtUsd(ar.weekAgo)})` : ''}`);
  }
  const book = data.deltas.so_order_book_value;
  if (book && book.now != null) {
    lines.push(`Open sales-order book now: ${fmtUsd(book.now)}${book.weekAgo != null ? ` (a week ago ${fmtUsd(book.weekAgo)})` : ''}`);
  }
  if (!sectionError(data.exceptions)) {
    const e = data.exceptions as { total: number; top: { label: string; count: number }[] };
    lines.push(`Guard overrides recorded this week: ${e.total}`);
  }
  return lines;
}

const NARRATIVE_SYSTEM = `You write the short opening paragraph of a weekly business brief for the owner of a fleet-graphics shop. You are given a list of fact lines. Rules, absolute:
- Use ONLY numbers that appear in the fact lines, copied verbatim (same rounding, same units). Never compute, sum, subtract, average, or estimate a number yourself — no percentages, no differences, no totals that are not already in a line.
- Comparative words (up, down, ahead, behind, flat) are fine when the two numbers you are comparing both appear in the lines.
- Mention only what the lines say. No advice, no speculation, no praise, no filler.
- 2 to 3 sentences, plain text, no markdown, no greeting, no sign-off.`;

/**
 * Optional AI opening paragraph. Numbers-verbatim contract enforced by the
 * system prompt; any failure (no key, API error, empty reply) returns null
 * and the brief sends without it — the numbers never wait on the model.
 */
export async function generateBriefNarrative(facts: string[]): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || facts.length === 0) return null;
  try {
    const response = await callAnthropicWithRetry(
      {
        model: 'claude-opus-5',
        max_tokens: 512,
        system: NARRATIVE_SYSTEM,
        messages: [{ role: 'user', content: `Fact lines for the week:\n${facts.map(f => `- ${f}`).join('\n')}` }],
      },
      apiKey,
    );
    if (!response.ok) return null;
    const result = await response.json();
    const text: string = (result.content || []).find((b: any) => b.type === 'text')?.text || '';
    const trimmed = text.trim();
    return trimmed ? trimmed.slice(0, 900) : null;
  } catch (e) {
    console.error('owner-brief narrative failed:', e);
    return null;
  }
}
