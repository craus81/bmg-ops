import { describe, it, expect } from 'vitest';
import { escapeText, foldLine, icsDate, exclusiveEnd, icsStamp, buildEvent, buildCalendar } from './ics';

const NOW = '2026-06-10T12:00:00.000Z';

describe('escapeText', () => {
  it('escapes backslash FIRST so later escapes are not double-escaped', () => {
    expect(escapeText('a\\b')).toBe('a\\\\b');
  });
  // Written with String.raw on purpose. The first cut of this test asserted
  // `'\;'` in an ordinary quoted string — which JavaScript reads as a plain
  // semicolon — so it agreed with a bug that left semicolons unescaped and
  // reported green. String.raw makes the expected bytes unmistakable.
  it('escapes semicolons, commas and newlines', () => {
    expect(escapeText('Wrap 12 vans, rush; night shift')).toBe(String.raw`Wrap 12 vans\, rush\; night shift`);
    expect(escapeText('line one\nline two')).toBe(String.raw`line one\nline two`);
    expect(escapeText('crlf\r\nhere')).toBe(String.raw`crlf\nhere`);
  });
  it('really does put a backslash BEFORE the semicolon', () => {
    const out = escapeText('a;b');
    expect(out).toHaveLength(4);
    expect(out.charCodeAt(1)).toBe(92);  // reverse solidus
    expect(out.charCodeAt(2)).toBe(59);  // semicolon
  });
  it('leaves ordinary text alone', () => {
    expect(escapeText('Front bumper decal')).toBe('Front bumper decal');
  });
});

describe('exclusiveEnd', () => {
  it('is the day AFTER the inclusive end — the classic off-by-one', () => {
    // A job running the 3rd to the 5th must carry DTEND of the 6th, or every
    // booking shows a day short in the installer's calendar.
    expect(exclusiveEnd('2026-06-05')).toBe('20260606');
  });
  it('rolls over a month boundary', () => {
    expect(exclusiveEnd('2026-06-30')).toBe('20260701');
  });
  it('rolls over a year boundary', () => {
    expect(exclusiveEnd('2026-12-31')).toBe('20270101');
  });
  it('handles a leap day', () => {
    expect(exclusiveEnd('2028-02-28')).toBe('20280229');
    expect(exclusiveEnd('2028-02-29')).toBe('20280301');
  });
  it('degrades to the raw date rather than throwing on garbage', () => {
    expect(exclusiveEnd('not-a-date')).toBe('nota-date'.replace(/-/g, ''));
  });
});

describe('icsDate / icsStamp', () => {
  it('strips the dashes', () => {
    expect(icsDate('2026-06-05')).toBe('20260605');
  });
  it('tolerates a timestamp where a date was expected', () => {
    expect(icsDate('2026-06-05T13:00:00Z')).toBe('20260605');
  });
  it('formats an instant with no punctuation and no milliseconds', () => {
    expect(icsStamp(NOW)).toBe('20260610T120000Z');
  });
  it('falls back to now on an unparseable instant rather than emitting NaN', () => {
    expect(icsStamp('nonsense')).toMatch(/^\d{8}T\d{6}Z$/);
  });
});

describe('foldLine', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds past 75 octets with a leading space on continuations', () => {
    const folded = foldLine('DESCRIPTION:' + 'x'.repeat(200));
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.from(parts[0], 'utf8').length).toBe(75);
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true);
  });

  it('never splits a multi-byte character', () => {
    // Byte-counting is the point: folding mid-sequence corrupts the value.
    const folded = foldLine('SUMMARY:' + 'é'.repeat(80));
    const rejoined = folded.split('\r\n ').join('');
    expect(rejoined).toBe('SUMMARY:' + 'é'.repeat(80));
    for (const line of folded.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
  });
});

describe('buildEvent', () => {
  const base = { uid: 'cni-1@bmg', start: '2026-06-03', end: '2026-06-05', summary: 'Wrap 12 vans' };

  it('emits the required properties', () => {
    const lines = buildEvent(base, NOW);
    expect(lines[0]).toBe('BEGIN:VEVENT');
    expect(lines).toContain('UID:cni-1@bmg');
    expect(lines).toContain('DTSTART;VALUE=DATE:20260603');
    expect(lines).toContain('DTEND;VALUE=DATE:20260606');
    expect(lines).toContain('SUMMARY:Wrap 12 vans');
    expect(lines[lines.length - 1]).toBe('END:VEVENT');
  });

  it('defaults to CONFIRMED and busy', () => {
    const lines = buildEvent(base, NOW);
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('TRANSP:OPAQUE');
  });

  it('marks a cancelled event free, so it stops blocking the installer', () => {
    const lines = buildEvent({ ...base, status: 'CANCELLED' }, NOW);
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines).toContain('TRANSP:TRANSPARENT');
  });

  it('omits optional properties rather than emitting empty ones', () => {
    const lines = buildEvent(base, NOW);
    expect(lines.some(l => l.startsWith('DESCRIPTION'))).toBe(false);
    expect(lines.some(l => l.startsWith('LOCATION'))).toBe(false);
    expect(lines.some(l => l.startsWith('URL'))).toBe(false);
  });

  it('escapes a comma in the summary', () => {
    const lines = buildEvent({ ...base, summary: 'Wrap 12 vans, rush' }, NOW);
    expect(lines).toContain('SUMMARY:Wrap 12 vans\\, rush');
  });

  it('carries a sequence so an edit replaces rather than duplicates', () => {
    expect(buildEvent({ ...base, sequence: 3 }, NOW)).toContain('SEQUENCE:3');
  });
});

describe('buildCalendar', () => {
  const ev = { uid: 'a@bmg', start: '2026-06-03', end: '2026-06-03', summary: 'One day job' };

  it('wraps events in a VCALENDAR with CRLF line endings', () => {
    const out = buildCalendar([ev], { name: 'BMG Jobs', now: NOW });
    expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(out.includes('\n\n')).toBe(false);
    // Every newline is preceded by a carriage return.
    expect(out.split('\n').every((p, i, a) => i === a.length - 1 || p.endsWith('\r'))).toBe(true);
  });

  it('names the calendar for the client sidebar and escapes the name', () => {
    const out = buildCalendar([], { name: 'BMG Fleet, CNI', now: NOW });
    expect(out).toContain('X-WR-CALNAME:BMG Fleet\\, CNI');
  });

  it('a single-day job still gets an exclusive end of the next day', () => {
    const out = buildCalendar([ev], { name: 'X', now: NOW });
    expect(out).toContain('DTSTART;VALUE=DATE:20260603');
    expect(out).toContain('DTEND;VALUE=DATE:20260604');
  });

  it('is valid with no events at all', () => {
    const out = buildCalendar([], { name: 'X', now: NOW });
    expect(out).toContain('BEGIN:VCALENDAR');
    expect(out).toContain('END:VCALENDAR');
    expect(out).not.toContain('BEGIN:VEVENT');
  });

  it('publishes a refresh hint', () => {
    const out = buildCalendar([], { name: 'X', refreshMinutes: 30, now: NOW });
    expect(out).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT30M');
    expect(out).toContain('X-PUBLISHED-TTL:PT30M');
  });
});
