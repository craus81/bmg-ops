/**
 * Business Heartbeat Alarms (R6-13) — a short, fixed list of pulse metrics
 * checked daily against SAME-WEEKDAY trailing baselines, alerting only when
 * one trips.
 *
 * SAME-WEEKDAY IS THE WHOLE DESIGN. This shop does almost nothing on a
 * Sunday, so "today is 90% below the last 28 days" fires every weekend and
 * trains everyone to ignore it. Each metric compares today against the same
 * weekday over the trailing BASELINE_WEEKS, which is the only comparison
 * that means anything for a business with a weekly rhythm.
 *
 * SILENCE IS NOT HEALTH, AND NOT AN ALARM EITHER. Every check can return
 * `unknown` — the query failed, or the baseline has too few weekdays behind
 * it to say anything. An unknown is reported as unknown and never as "ok":
 * a sentinel that reports all-clear when it could not look is worse than no
 * sentinel. It is also never escalated as a trip, because "we could not
 * measure it" is not evidence the business stopped.
 *
 * A BASELINE OF ZERO CANNOT BE BEATEN. If the same weekday has averaged
 * zero for four weeks, any percentage comparison is meaningless (or divides
 * by zero), so those checks report `unknown` with that reason rather than
 * a 100%-down alarm every single week.
 */

export const BASELINE_WEEKS = 4;
/** Fewer than this many comparable weekdays and there is no baseline yet. */
export const MIN_BASELINE_POINTS = 3;

export type PulseStatus = 'ok' | 'tripped' | 'unknown';

export interface PulseCheck {
  key: string;
  label: string;
  status: PulseStatus;
  /** What the alert says when tripped, or why it is unknown. Always true. */
  detail: string;
  /** Today's measured value, null when it could not be measured. */
  value: number | null;
  /** The same-weekday baseline it was judged against, null when there is none. */
  baseline: number | null;
  /** How many comparable days went into the baseline, so a thin one is visible. */
  baselinePoints: number;
}

/** Mean of the same-weekday history, ignoring days we have no figure for. */
export function baselineOf(values: Array<number | null | undefined>): { mean: number | null; points: number } {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return { mean: null, points: 0 };
  return { mean: nums.reduce((a, b) => a + b, 0) / nums.length, points: nums.length };
}

export interface ShortfallInput {
  key: string;
  label: string;
  /** Today's figure; null when the query failed. */
  today: number | null;
  /** Same-weekday history, oldest or newest first — order does not matter. */
  history: Array<number | null | undefined>;
  /** Trip when today is this fraction below the baseline (0.6 = 60% down). */
  dropFraction: number;
  /** Rendered into the message, e.g. 'scans' or 'quotes sent'. */
  noun: string;
}

/**
 * The shared shape for "today is far below the same weekday recently".
 * Used by the volume pulses; the money ones have their own rules.
 */
export function evaluateShortfall(input: ShortfallInput): PulseCheck {
  const { mean, points } = baselineOf(input.history);
  const base: Omit<PulseCheck, 'status' | 'detail'> = {
    key: input.key,
    label: input.label,
    value: input.today,
    baseline: mean,
    baselinePoints: points,
  };

  if (input.today == null) {
    return { ...base, status: 'unknown', detail: `Could not measure ${input.noun} today.` };
  }
  if (points < MIN_BASELINE_POINTS) {
    return {
      ...base,
      status: 'unknown',
      detail: `Not enough history yet — ${points} comparable ${points === 1 ? 'day' : 'days'} on file, ${MIN_BASELINE_POINTS} needed.`,
    };
  }
  if (mean == null || mean <= 0) {
    // A zero baseline makes every percentage either infinite or undefined.
    return { ...base, status: 'unknown', detail: `No ${input.noun} on this weekday in the last ${BASELINE_WEEKS} weeks, so there is nothing to compare against.` };
  }

  const drop = (mean - input.today) / mean;
  if (drop >= input.dropFraction) {
    return {
      ...base,
      status: 'tripped',
      detail: `${input.today} ${input.noun} today against a same-weekday average of ${mean.toFixed(1)} — ${Math.round(drop * 100)}% down.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    detail: `${input.today} ${input.noun} today, same-weekday average ${mean.toFixed(1)}.`,
  };
}

export interface RiseInput {
  key: string;
  label: string;
  today: number | null;
  history: Array<number | null | undefined>;
  /** Trip when today exceeds the baseline by this fraction. */
  riseFraction: number;
  /** And by at least this absolute amount, so a jump from $2 to $6 is not news. */
  minAbsolute: number;
  noun: string;
  format?: (n: number) => string;
}

/** "Today is far ABOVE the same weekday recently" — for A/R and bounces. */
export function evaluateRise(input: RiseInput): PulseCheck {
  const fmt = input.format || ((n: number) => String(Math.round(n)));
  const { mean, points } = baselineOf(input.history);
  const base: Omit<PulseCheck, 'status' | 'detail'> = {
    key: input.key,
    label: input.label,
    value: input.today,
    baseline: mean,
    baselinePoints: points,
  };

  if (input.today == null) {
    return { ...base, status: 'unknown', detail: `Could not measure ${input.noun} today.` };
  }
  if (points < MIN_BASELINE_POINTS) {
    return { ...base, status: 'unknown', detail: `Not enough history yet — ${points} comparable ${points === 1 ? 'day' : 'days'} on file, ${MIN_BASELINE_POINTS} needed.` };
  }
  if (mean == null || mean <= 0) {
    // Rising from nothing is only news if the absolute figure is material.
    if (input.today >= input.minAbsolute) {
      return { ...base, status: 'tripped', detail: `${fmt(input.today)} ${input.noun} today, against none on this weekday in the last ${BASELINE_WEEKS} weeks.` };
    }
    return { ...base, status: 'ok', detail: `${fmt(input.today)} ${input.noun} today — below the ${fmt(input.minAbsolute)} worth reporting.` };
  }

  const rise = (input.today - mean) / mean;
  const absolute = input.today - mean;
  if (rise >= input.riseFraction && absolute >= input.minAbsolute) {
    return {
      ...base,
      status: 'tripped',
      detail: `${fmt(input.today)} ${input.noun} today against a same-weekday average of ${fmt(mean)} — up ${Math.round(rise * 100)}%.`,
    };
  }
  return { ...base, status: 'ok', detail: `${fmt(input.today)} ${input.noun} today, same-weekday average ${fmt(mean)}.` };
}

/** The same weekday as `from`, going back `weeks` weeks (nearest first). */
export function sameWeekdayDates(from: Date, weeks = BASELINE_WEEKS): string[] {
  const out: string[] = [];
  for (let i = 1; i <= weeks; i++) {
    const d = new Date(from.getTime() - i * 7 * 86_400_000);
    out.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d));
  }
  return out;
}

/** The shop-calendar date for an instant — the same key every other report uses. */
export function shopDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);
}

/** Sunday=0. Saturday and Sunday are not judged against weekday volume. */
export function isBusinessDay(dateKey: string): boolean {
  // Parsed at noon so the day never slips across a timezone boundary.
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

export interface HeartbeatReport {
  day: string;
  checks: PulseCheck[];
  tripped: PulseCheck[];
  unknown: PulseCheck[];
}

export function summarize(day: string, checks: PulseCheck[]): HeartbeatReport {
  return {
    day,
    checks,
    tripped: checks.filter(c => c.status === 'tripped'),
    unknown: checks.filter(c => c.status === 'unknown'),
  };
}
