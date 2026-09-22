import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Two crons must never fire in the same minute.
 *
 * This is a real production incident, not tidiness: `*​/20`, `*​/30`, `*​/15`
 * and `0 * * * *` all firing together at :00 saturated Supabase into
 * `Gateway Timeout` 504s on ordinary reads and writes. The symptoms blamed
 * the wrong things — heartbeat writes failed so healthy jobs reported stale
 * ("no run in 3h"), and a timed-out google_tokens read surfaced as "Gmail
 * not connected". Every DOWN alert landed on :00; the same health check at
 * :30 never failed. The fix was giving each recurring job an exclusive
 * minute, and CLAUDE.md records the allocation.
 *
 * Nothing enforced it, so the next person adding a cron had to have read
 * that note. This test does: it expands every schedule into the
 * (day-of-week, hour, minute) slots it actually occupies and fails on any
 * slot claimed twice. A daily job and an hourly one sharing a minute is
 * caught, and two daily jobs at the same minute in DIFFERENT hours is
 * correctly not flagged — they never meet.
 */

interface CronEntry { path: string; schedule: string }

/** Expand one cron field. Supports `*`, `*​/n`, `a,b,c` and a bare number. */
function expandField(field: string, lo: number, hi: number): number[] {
  const all = () => { const o: number[] = []; for (let i = lo; i <= hi; i++) o.push(i); return o; };
  if (field === '*') return all();
  if (field.startsWith('*/')) {
    const step = Number(field.slice(2));
    if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step: ${field}`);
    return all().filter(i => i % step === 0);
  }
  return field.split(',').map(part => {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      const o: number[] = [];
      for (let i = a; i <= b; i++) o.push(i);
      return o;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`bad field value: ${part}`);
    return [n];
  }).flat();
}

/** Every (dow, hour, minute) this schedule fires in a week. */
function slotsOf(schedule: string): string[] {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 cron fields, got ${parts.length}: ${schedule}`);
  const [min, hour, dom, , dow] = parts;
  // A day-of-month restriction would need real calendar expansion; the repo
  // uses none, and the test refuses to silently under-report if one appears.
  if (dom !== '*') throw new Error(`day-of-month schedules are not modelled: ${schedule}`);
  const out: string[] = [];
  for (const d of expandField(dow, 0, 6)) {
    for (const h of expandField(hour, 0, 23)) {
      for (const m of expandField(min, 0, 59)) out.push(`${d}:${h}:${m}`);
    }
  }
  return out;
}

const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
const crons: CronEntry[] = config.crons || [];

describe('vercel.json cron schedules', () => {
  it('has crons to check (this test must not pass vacuously)', () => {
    expect(crons.length).toBeGreaterThan(20);
  });

  it('gives every cron its own minute — no two fire in the same slot', () => {
    const claimed = new Map<string, string>();
    const clashes: string[] = [];
    for (const c of crons) {
      for (const slot of slotsOf(c.schedule)) {
        const holder = claimed.get(slot);
        if (holder && holder !== c.path) {
          const [d, h, m] = slot.split(':');
          clashes.push(`${holder} and ${c.path} both fire at ${h}:${String(m).padStart(2, '0')} (day ${d})`);
        } else {
          claimed.set(slot, c.path);
        }
      }
    }
    // One line per colliding PAIR rather than per slot — an hourly job
    // against a daily one produces seven identical days otherwise.
    expect([...new Set(clashes.map(c => c.replace(/ \(day \d\)$/, '')))]).toEqual([]);
  });

  it('every schedule is a parseable 5-field expression', () => {
    for (const c of crons) expect(() => slotsOf(c.schedule), c.path).not.toThrow();
  });

  it('every cron path points at a route that exists', () => {
    // A schedule for a deleted route is a job that silently never runs.
    for (const c of crons) {
      const rel = c.path.replace(/^\//, '');
      expect(
        existsAny([
          join(process.cwd(), 'src', 'app', rel, 'route.ts'),
          join(process.cwd(), 'src', 'app', rel, 'route.tsx'),
        ]),
        c.path,
      ).toBe(true);
    }
  });
});

function existsAny(paths: string[]): boolean {
  for (const p of paths) {
    try { readFileSync(p); return true; } catch { /* next */ }
  }
  return false;
}
