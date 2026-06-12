/**
 * Biweekly payroll periods for field install credits, anchored at
 * 2026-06-15 (period boundaries every 14 days from that Monday, in local
 * time). Dates before the anchor fall into earlier periods via the same
 * 14-day grid, so historical credits still report cleanly.
 */

export const PAYROLL_ANCHOR = new Date(2026, 5, 15); // June 15, 2026 (local)
const PERIOD_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PayPeriod {
  start: Date;       // first day, 00:00:00 local
  end: Date;         // last day, 00:00:00 local (inclusive)
  endExclusive: Date; // start of the next period (for < comparisons)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The period containing `date`. */
export function periodForDate(date: Date): PayPeriod {
  const day = startOfDay(date);
  // Calendar-day difference; DST shifts make raw ms division off by an hour,
  // so round to the nearest whole day before flooring into periods.
  const dayDiff = Math.round((day.getTime() - PAYROLL_ANCHOR.getTime()) / MS_PER_DAY);
  const index = Math.floor(dayDiff / PERIOD_DAYS);
  return periodAt(index);
}

/** Period `index` relative to the anchor (0 = the period starting 6/15/26). */
export function periodAt(index: number): PayPeriod {
  const start = new Date(PAYROLL_ANCHOR);
  start.setDate(start.getDate() + index * PERIOD_DAYS);
  const end = new Date(start);
  end.setDate(end.getDate() + PERIOD_DAYS - 1);
  const endExclusive = new Date(start);
  endExclusive.setDate(endExclusive.getDate() + PERIOD_DAYS);
  return { start, end, endExclusive };
}

/** Step from `period` by `delta` periods (±1 for prev/next). */
export function shiftPeriod(period: PayPeriod, delta: number): PayPeriod {
  const probe = new Date(period.start);
  probe.setDate(probe.getDate() + delta * PERIOD_DAYS);
  return periodForDate(probe);
}

/** YYYY-MM-DD in local time (what the payroll API exchanges). */
export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromDateString(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatPeriod(p: PayPeriod): string {
  const fmt = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${fmt(p.start)} – ${fmt(p.end)}, ${p.end.getFullYear()}`;
}
