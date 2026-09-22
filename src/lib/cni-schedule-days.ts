/**
 * Expanding a CNI job's confirmed date range into the days a calendar board
 * actually draws (R6-8).
 *
 * Its own module, free of any server import, because the schedule board is a
 * client component: pulling this out of cni-schedule-feed.ts (which reaches
 * for node crypto and a Supabase client) would drag both into the browser
 * bundle.
 *
 * `total` counts the WHOLE range, not the visible slice, so a job showing
 * only its middle day still reads "Day 2 of 3" instead of "Day 1 of 1".
 */

export interface ScheduledDay {
  /** YYYY-MM-DD */
  date: string;
  /** 1-based position within the full confirmed range. */
  index: number;
  /** Length of the full confirmed range in days. */
  total: number;
}

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const parse = (value: string) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);

/**
 * Every day of `start`..`end` (inclusive, both YYYY-MM-DD) that falls inside
 * `from`..`to`. A missing end is a one-day job; an end before the start is
 * bad data collapsed to the start day rather than dropped, so a job with
 * reversed dates still appears somewhere a human can see and fix it.
 */
export function scheduledDays(
  start: string | null | undefined,
  end: string | null | undefined,
  from: string,
  to: string,
): ScheduledDay[] {
  if (!start) return [];
  const startMs = parse(start);
  if (Number.isNaN(startMs)) return [];
  const rawEndMs = end ? parse(end) : NaN;
  const endMs = Number.isNaN(rawEndMs) || rawEndMs < startMs ? startMs : rawEndMs;

  const total = Math.floor((endMs - startMs) / DAY_MS) + 1;
  const out: ScheduledDay[] = [];
  for (let i = 0; i < total; i++) {
    const date = ymd(new Date(startMs + i * DAY_MS));
    if (date >= from && date <= to) out.push({ date, index: i + 1, total });
  }
  return out;
}

/** "Day 2 of 3", or nothing at all for a single-day job. */
export function dayLabel(day: ScheduledDay): string | null {
  return day.total > 1 ? `Day ${day.index} of ${day.total}` : null;
}
