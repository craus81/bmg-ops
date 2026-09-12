import { describe, it, expect } from 'vitest';
import {
  ageInDays, daysUntil, factLines, unknownSections, buildBriefPrompt,
  BRIEF_SYSTEM_PROMPT, EMAIL_WINDOW_DAYS,
  type BriefFacts,
} from './customer-brief';

const NOW = Date.parse('2026-09-12T12:00:00Z');

function facts(over: Partial<BriefFacts> = {}): BriefFacts {
  return {
    customer: { name: 'Acme Fleet', prospectId: 'p1', customerId: 'c1', netsuiteId: '48210', entityId: 'ACME', email: null, phone: null },
    estimates: { status: 'ok', open: [] },
    ar: { status: 'ok', openTotal: 0, pastDue: 0, oldestDaysPastDue: 0, invoices: [] },
    vehicles: { status: 'ok', inShop: [] },
    emails: { status: 'ok', sent90: 0, failed90: 0, lastFailure: null },
    threads: { status: 'ok', open: 0, unread: 0, lastInboundAt: null },
    activities: { status: 'ok', recent: [] },
    spend: { status: 'ok', lastYear: null, ytd: null, lastOrderDate: null },
    generatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

describe('date helpers', () => {
  it('measures age and time-to-expiry, and refuses garbage', () => {
    expect(ageInDays('2026-09-02T12:00:00Z', NOW)).toBe(10);
    expect(daysUntil('2026-09-22', NOW)).toBe(10);
    expect(daysUntil('2026-09-02', NOW)).toBe(-10);
    expect(ageInDays(null, NOW)).toBeNull();
    expect(ageInDays('not a date', NOW)).toBeNull();
    expect(daysUntil('', NOW)).toBeNull();
  });
});

describe('factLines', () => {
  it('reports a real zero as a real zero', () => {
    const lines = factLines(facts());
    expect(lines.some(l => l.startsWith('A/R: nothing open.'))).toBe(true);
    expect(lines.some(l => l.startsWith('Open estimates: none open.'))).toBe(true);
  });

  it('NEVER turns an unreadable section into a zero', () => {
    // This is the whole point of the feature's design: the person is about
    // to repeat these numbers to a customer down the phone.
    const lines = factLines(facts({
      ar: { status: 'unknown', reason: 'NetSuite timed out', openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] },
    }));
    const ar = lines.find(l => l.startsWith('A/R:'))!;
    expect(ar).toContain('unavailable');
    expect(ar).toContain('NetSuite timed out');
    expect(ar).toContain('not zero');
    expect(ar).not.toMatch(/\$0|nothing open|none/);
  });

  it('omits a section the caller was never allowed to see, rather than reporting it clean', () => {
    const lines = factLines(facts({
      ar: { status: 'skipped', openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] },
    }));
    expect(lines.some(l => l.startsWith('A/R'))).toBe(false);
  });

  it('leads an estimate line with its age, money and expiry, and flags an expired one', () => {
    const lines = factLines(facts({
      estimates: {
        status: 'ok',
        open: [
          { number: 'EST-1042', title: 'Sprinter shelving', status: 'sent', ageDays: 21, total: 8450, expiresInDays: -3 },
          { number: 'EST-1051', title: null, status: 'draft', ageDays: 2, total: null, expiresInDays: 12 },
        ],
      },
    }));
    const l = lines.find(x => x.startsWith('Open estimates:'))!;
    expect(l).toContain('EST-1042, sent, 21d old, $8,450, EXPIRED 3d ago');
    expect(l).toContain('EST-1051, draft, 2d old, expires in 12d');
    // No total was known for the second one, and none was invented.
    expect(l).not.toContain('$0');
  });

  it('flags a vehicle past its promised-back date', () => {
    const l = factLines(facts({
      vehicles: {
        status: 'ok',
        inShop: [{ vin: '1FT', description: '2024 Ford Transit', stage: 'in_progress', promisedBack: '2026-09-05', daysOverdue: 7 }],
      },
    })).find(x => x.startsWith('In the shop:'))!;
    expect(l).toContain('2024 Ford Transit — in_progress — 7d PAST promised-back');
  });

  it('names a failed delivery instead of only counting sends', () => {
    const l = factLines(facts({
      emails: { status: 'ok', sent90: 9, failed90: 2, lastFailure: { to: 'ap@acme.test', status: 'bounced', at: '2026-09-01T00:00:00Z' } },
    })).find(x => x.startsWith('Email:'))!;
    expect(l).toContain(`9 sent in ${EMAIL_WINDOW_DAYS} days`);
    expect(l).toContain('2 did NOT arrive');
    expect(l).toContain('ap@acme.test, bounced');
  });

  it('says so when the spend columns are empty rather than printing $0', () => {
    const l = factLines(facts()).find(x => x.startsWith('Spend:'))!;
    expect(l).toBe('Spend: no synced spend figures on this record.');
  });
});

describe('unknownSections', () => {
  it('lists only the sections that failed', () => {
    expect(unknownSections(facts())).toEqual([]);
    expect(unknownSections(facts({
      ar: { status: 'unknown', reason: 'x', openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] },
      threads: { status: 'unknown', reason: 'y', open: null, unread: null, lastInboundAt: null },
      vehicles: { status: 'skipped', inShop: [] },
    }))).toEqual(['A/R', 'threads']);
  });
});

describe('buildBriefPrompt', () => {
  it('hands the model the facts and an explicit list of what could not be read', () => {
    const p = buildBriefPrompt(facts({
      ar: { status: 'unknown', reason: 'NetSuite timed out', openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] },
    }));
    expect(p).toContain('Customer: Acme Fleet');
    expect(p).toContain('report as unavailable, never as zero): A/R.');
  });

  it('says every section read cleanly when it did', () => {
    expect(buildBriefPrompt(facts())).toContain('Every section was read successfully.');
  });
});

describe('BRIEF_SYSTEM_PROMPT', () => {
  it('forbids inventing figures and forbids reading an unavailable as clean', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/Never add a number/i);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/NEVER report it as zero, none, clean, current or fine/);
  });
});
