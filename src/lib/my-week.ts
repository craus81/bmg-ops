/**
 * "My week" windows for the personal Home screen (field + shop techs).
 *
 * The week runs Monday through today on the shop's calendar (America/Chicago),
 * per the owner (2026-09-29). Last week is compared like-for-like: its Monday
 * up to the same moment seven days ago, so a Tuesday morning isn't measured
 * against a whole finished week.
 */
import { weekStartMonday, addDays } from '@/lib/shop-week';

const TZ = 'America/Chicago';

/** The shop calendar date (YYYY-MM-DD) for an instant. */
export function shopDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at);
}

/** The instant a shop calendar day starts (Chicago midnight), DST-aware. */
export function shopMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Chicago's wall clock at `guess`, read back as if it were UTC, gives the
  // zone offset at that moment; shifting by it lands on local midnight.
  const wall = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(t)).map(x => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  let t = guess - (wall(guess) - guess);
  // A DST change between `guess` and the result shifts the offset; one
  // correction pass settles it.
  t = t - (wall(t) - guess);
  return new Date(t);
}

export interface WeekWindows {
  today: string;          // YYYY-MM-DD, shop calendar
  weekStart: string;      // this week's Monday
  thisStart: Date;
  thisEnd: Date;          // now
  lastStart: Date;        // last week's Monday
  lastEnd: Date;          // now minus 7 days
}

export function weekWindows(now: Date): WeekWindows {
  const today = shopDate(now);
  const weekStart = weekStartMonday(today);
  return {
    today,
    weekStart,
    thisStart: shopMidnight(weekStart),
    thisEnd: now,
    lastStart: shopMidnight(addDays(weekStart, -7)),
    lastEnd: new Date(now.getTime() - 7 * 86_400_000),
  };
}

export interface WeekCount { thisWeek: number; lastWeek: number }

/**
 * Count items per window. `key` dedupes (e.g. one vehicle scanned twice
 * counts once); items without a key count individually.
 */
export function countByWeek<T>(
  items: T[],
  at: (item: T) => string | null | undefined,
  w: Pick<WeekWindows, 'thisStart' | 'thisEnd' | 'lastStart' | 'lastEnd'>,
  key?: (item: T) => string | null | undefined,
): WeekCount {
  const thisKeys = new Set<string>();
  const lastKeys = new Set<string>();
  let thisN = 0;
  let lastN = 0;
  for (const it of items) {
    const iso = at(it);
    if (!iso) continue;
    const t = new Date(iso).getTime();
    const k = key?.(it);
    if (t >= w.thisStart.getTime() && t <= w.thisEnd.getTime()) {
      if (k) thisKeys.add(k); else thisN++;
    } else if (t >= w.lastStart.getTime() && t <= w.lastEnd.getTime()) {
      if (k) lastKeys.add(k); else lastN++;
    }
  }
  return { thisWeek: thisN + thisKeys.size, lastWeek: lastN + lastKeys.size };
}
