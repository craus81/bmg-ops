/**
 * Shop working hours for the job timer (owner rules 2026-10-02).
 *
 * A shop job timer only counts time inside the shop day: weekdays
 * 7:00 AM – 3:30 PM Central, less a fixed 30-minute lunch. Outside that
 * window a running timer is "paused" — it stays open (the job is still in
 * progress) but adds no hours, and picks back up at 7:00 AM on the next
 * weekday. Weekends count nothing. Holidays are not special (owner call:
 * leave them alone for now, same as quiet-weekends).
 *
 * The pause is computed, not written: hours are the overlap of a timer's
 * interval with these windows, so there is no cron that has to fire at
 * 3:30 on the dot and nothing to go wrong if one is late. Pure and
 * timezone-explicit so it runs the same in the browser and on the server.
 */

export const SHOP_TZ = 'America/Chicago';

/** Minutes after local midnight. */
export const SHOP_DAY_START_MIN = 7 * 60; // 7:00 AM
export const SHOP_DAY_END_MIN = 15 * 60 + 30; // 3:30 PM
export const SHOP_LUNCH_START_MIN = 11 * 60 + 30; // 11:30 AM (owner, 2026-10-02)
export const SHOP_LUNCH_END_MIN = 12 * 60; // 12:00 PM

const DAY_MS = 86_400_000;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric',
  weekday: 'short',
});

interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: string }

function localParts(ms: number): LocalParts {
  const out: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: Number(out.year), m: Number(out.month), d: Number(out.day),
    hh: Number(out.hour) % 24, mm: Number(out.minute), ss: Number(out.second),
    weekday: out.weekday,
  };
}

/** Central's UTC offset (ms, negative) at an instant. */
function offsetAt(ms: number): number {
  const p = localParts(ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a Central wall-clock time happens (DST-safe for 7:00–15:30,
 *  which never falls in a 2 AM transition gap). */
function wallToUtc(y: number, m: number, d: number, minutes: number): number {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** The counted windows ([start, end) instants) of one Central calendar day. */
function dayWindows(y: number, m: number, d: number): [number, number][] {
  // Weekday from the calendar date itself (noon UTC is the same date).
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  if (dow === 0 || dow === 6) return [];
  return [
    [wallToUtc(y, m, d, SHOP_DAY_START_MIN), wallToUtc(y, m, d, SHOP_LUNCH_START_MIN)],
    [wallToUtc(y, m, d, SHOP_LUNCH_END_MIN), wallToUtc(y, m, d, SHOP_DAY_END_MIN)],
  ];
}

/**
 * Milliseconds of shop time between two instants. A timer left open for
 * months still terminates: the walk is capped at ~2 years of days.
 */
export function shopWorkMs(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  const start = localParts(fromMs);
  let total = 0;
  // Walk Central calendar days from the start date; Date.UTC normalizes
  // day overflow (Jan 32 → Feb 1) so plain day arithmetic is safe.
  for (let i = 0; i < 800; i++) {
    const cal = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const y = cal.getUTCFullYear(), m = cal.getUTCMonth() + 1, d = cal.getUTCDate();
    // Stop once this day's 7:00 AM is past the end (≈ a day of slack).
    if (Date.UTC(y, m - 1, d) - DAY_MS > toMs) break;
    for (const [ws, we] of dayWindows(y, m, d)) {
      const s = Math.max(ws, fromMs);
      const e = Math.min(we, toMs);
      if (e > s) total += e - s;
    }
  }
  return total;
}

/** Hours of shop time between two ISO timestamps. */
export function shopWorkHours(fromIso: string, toIso: string): number {
  return shopWorkMs(Date.parse(fromIso), Date.parse(toIso)) / 3_600_000;
}

/** Is the shop clock running at this instant? */
export function isShopClockRunning(ms: number): boolean {
  const p = localParts(ms);
  return dayWindows(p.y, p.m, p.d).some(([s, e]) => ms >= s && ms < e);
}

/**
 * When a paused timer next counts again, as a short label for the timer
 * card: "12:00 PM", "7:00 AM", "Mon 7:00 AM". Null while the clock runs.
 */
export function shopClockResumeLabel(ms: number): string | null {
  if (isShopClockRunning(ms)) return null;
  const p = localParts(ms);
  const minutes = p.hh * 60 + p.mm;
  const weekend = p.weekday === 'Sat' || p.weekday === 'Sun';
  if (!weekend && minutes >= SHOP_LUNCH_START_MIN && minutes < SHOP_LUNCH_END_MIN) return '12:00 PM';
  if (!weekend && minutes < SHOP_DAY_START_MIN) return '7:00 AM';
  // After hours or a weekend: the next weekday morning.
  const next = p.weekday === 'Fri' || weekend ? 'Mon 7:00 AM' : '7:00 AM';
  return next;
}
