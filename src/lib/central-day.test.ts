// The day and the month in O'Fallon (src/lib/central-day.ts), and that the books, Receiving, Purchasing and drop
// ship take them from it rather than from UTC, which is tomorrow by 7 PM Central (6 PM in winter).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { centralDate, centralLastMonth, centralMonth } from './central-day';

afterEach(() => { vi.useRealTimers(); });

describe("the day in O'Fallon", () => {
  it('stays today through the evening, in summer time and in winter', () => {
    // 7:30 PM CDT and 8:00 PM CST: UTC has moved on to the next day already.
    expect(centralDate(new Date('2026-07-15T00:30:00Z'))).toBe('2026-07-14');
    expect(centralDate(new Date('2026-11-03T02:00:00Z'))).toBe('2026-11-02');
    // 11:59 PM CST, then midnight.
    expect(centralDate(new Date('2026-11-03T05:59:00Z'))).toBe('2026-11-02');
    expect(centralDate(new Date('2026-11-03T06:00:00Z'))).toBe('2026-11-03');
    // The morning is the same day in both.
    expect(centralDate(new Date('2026-11-03T15:00:00Z'))).toBe('2026-11-03');
  });

  it('turns at midnight Central on the days the clocks change', () => {
    // Clocks went back at 2 AM CDT on Sunday, November 1, 2026: still the 1st at 1:30 AM CST.
    expect(centralDate(new Date('2026-11-01T04:59:00Z'))).toBe('2026-10-31');
    expect(centralDate(new Date('2026-11-01T05:00:00Z'))).toBe('2026-11-01');
    expect(centralDate(new Date('2026-11-01T07:30:00Z'))).toBe('2026-11-01');
    // They go forward on Sunday, March 14, 2027.
    expect(centralDate(new Date('2027-03-14T05:59:00Z'))).toBe('2027-03-13');
    expect(centralDate(new Date('2027-03-14T06:00:00Z'))).toBe('2027-03-14');
    expect(centralDate(new Date('2027-03-15T04:59:00Z'))).toBe('2027-03-14');
    expect(centralDate(new Date('2027-03-15T05:00:00Z'))).toBe('2027-03-15');
  });

  it('is now unless told when', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T03:30:00Z'));
    expect(centralDate()).toBe('2026-10-31');
    expect(centralMonth()).toBe('2026-10-01');
    expect(centralLastMonth()).toBe('2026-09-01');
  });
});

describe("the month in O'Fallon", () => {
  it("keeps the month through its last evening, and the year through New Year's Eve", () => {
    expect(centralMonth(new Date('2026-11-01T03:30:00Z'))).toBe('2026-10-01');
    expect(centralMonth(new Date('2026-11-01T05:00:00Z'))).toBe('2026-11-01');
    expect(centralMonth(new Date('2027-01-01T03:00:00Z'))).toBe('2026-12-01');
    expect(centralMonth(new Date('2027-01-01T06:00:00Z'))).toBe('2027-01-01');
  });

  it('opens Books on the month before, the year before in January', () => {
    expect(centralLastMonth(new Date('2026-11-01T03:30:00Z'))).toBe('2026-09-01');
    expect(centralLastMonth(new Date('2026-11-15T18:00:00Z'))).toBe('2026-10-01');
    expect(centralLastMonth(new Date('2027-01-01T03:00:00Z'))).toBe('2026-11-01');
    expect(centralLastMonth(new Date('2027-01-20T18:00:00Z'))).toBe('2026-12-01');
    expect(centralLastMonth(new Date('2027-02-01T18:00:00Z'))).toBe('2027-01-01');
  });
});

// Where today and this month are taken: the books, and the documents Receiving, Purchasing and drop ship date.
const ROOT = join(__dirname, '..', '..');
const DIRS = ['src/lib/books', 'src/app/api/admin/books', 'src/app/(main)/admin/books'];
const FILES = [
  'src/app/api/po-receipts/route.ts',
  'src/app/api/purchase-requests/create-po/route.ts',
  'src/app/api/estimates/[id]/drop-ship/route.ts',
];
/** Today or this month taken from UTC: now as an ISO string, cut to its date or month. */
const UTC_TODAY = [
  /new Date\((?:now\(\)|Date\.now\(\))?\)\.toISOString\(\)\.(?:slice|substring)\(0, ?(?:7|10)\)/,
  /new Date\((?:now\(\)|Date\.now\(\))?\)\.toISOString\(\)\.split\(['"]T['"]\)/,
  /\bnow\.toISOString\(\)\.(?:slice|substring)\(0, ?(?:7|10)\)/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('where today comes from', () => {
  it("takes today and this month from O'Fallon's calendar in the books, Receiving, Purchasing and drop ship", () => {
    const files = [...DIRS.flatMap((d) => sources(join(ROOT, d))), ...FILES.map((f) => join(ROOT, f))];
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (
      UTC_TODAY.some((re) => re.test(line)) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : []
    )));
    // Use centralDate(), centralMonth() or centralLastMonth() from src/lib/central-day.ts.
    expect(found).toEqual([]);
  });

  it('would catch each way of taking it from UTC', () => {
    const caught = (line: string) => UTC_TODAY.some((re) => re.test(line));
    expect(caught('const today = new Date().toISOString().slice(0, 10);')).toBe(true);
    expect(caught("const thisMonth = () => new Date().toISOString().slice(0, 7);")).toBe(true);
    expect(caught('monthOfDate(new Date(now()).toISOString().slice(0, 10))')).toBe(true);
    expect(caught("const day = new Date().toISOString().split('T')[0];")).toBe(true);
    expect(caught('const current = monthOfDate(now.toISOString().slice(0, 10))!;')).toBe(true);
    // A date worked out from a known one is calendar arithmetic, and a timestamp keeps its time.
    expect(caught('return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);')).toBe(false);
    expect(caught('updated_at: new Date().toISOString(),')).toBe(false);
  });
});
