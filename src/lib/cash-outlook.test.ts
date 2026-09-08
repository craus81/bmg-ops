import { describe, it, expect } from 'vitest';
import {
  weekStartOf, addDays, horizonWeeks, bucketFor, placeInvoice, medianDaysToPay,
  buildOutlook, payrollRunRate, MIN_PAY_SAMPLES, HORIZON_WEEKS,
  type OutlookInputs,
} from './cash-outlook';

const inv = (over: Partial<any> = {}): any => ({
  id: '1', tranid: 'INV1', date: '2026-06-01', dueDate: '2026-07-01',
  po: null, customer: 'Acme', entityId: '77', total: 1000, unpaid: 1000,
  daysPastDue: 0, bucket: 'current', nsUrl: '', ...over,
});
const bill = (over: Partial<any> = {}): any => ({
  id: 'b1', tranid: 'BILL1', date: '2026-06-01', dueDate: '2026-07-08',
  vendor: 'Vend', memo: null, total: 500, unpaid: 500, daysPastDue: 0, nsUrl: '', ...over,
});

const baseInput = (over: Partial<OutlookInputs> = {}): OutlookInputs => ({
  today: '2026-07-01',            // a Wednesday
  invoices: [], bills: [], payouts: [],
  medianDays: new Map(),
  startingCash: 100_000, startingCashError: null,
  payrollWeekly: null, payrollBasis: null, payrollError: 'not configured',
  ...over,
});

describe('week maths', () => {
  it('anchors weeks on Monday', () => {
    expect(weekStartOf('2026-07-01')).toBe('2026-06-29'); // Wed -> Mon
    expect(weekStartOf('2026-06-29')).toBe('2026-06-29'); // Mon -> itself
    expect(weekStartOf('2026-07-05')).toBe('2026-06-29'); // Sun -> that Mon
  });
  it('walks the horizon in 7-day steps from the week containing today', () => {
    expect(horizonWeeks('2026-07-01')).toEqual(['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20']);
    expect(horizonWeeks('2026-07-01')).toHaveLength(HORIZON_WEEKS);
  });
  it('adds days across a month boundary', () => {
    expect(addDays('2026-06-29', 7)).toBe('2026-07-06');
  });
});

describe('bucketFor', () => {
  const weeks = horizonWeeks('2026-07-01');
  const today = '2026-07-01';

  it('puts a date in its own week', () => {
    expect(bucketFor('2026-07-02', weeks, today)).toBe(0);
    expect(bucketFor('2026-07-06', weeks, today)).toBe(1);
    expect(bucketFor('2026-07-26', weeks, today)).toBe(3);
  });
  it('calls a past date overdue rather than sliding it into this week', () => {
    expect(bucketFor('2026-06-30', weeks, today)).toBe('overdue');
  });
  it('calls a date past the horizon beyond', () => {
    expect(bucketFor('2026-07-27', weeks, today)).toBe('beyond');
  });
  it('calls a missing date unplaceable, never week 1', () => {
    expect(bucketFor(null, weeks, today)).toBe('unplaceable');
  });
});

describe('placeInvoice', () => {
  it('prefers observed days-to-pay over the stated terms', () => {
    const p = placeInvoice(inv(), new Map([['e:77', { days: 52, samples: 4 }]]));
    expect(p.basis).toBe('history');
    expect(p.date).toBe('2026-07-23');   // 2026-06-01 + 52d
  });

  it('falls back to the due date when history is too thin to trust', () => {
    const p = placeInvoice(inv(), new Map([['e:77', { days: 52, samples: MIN_PAY_SAMPLES - 1 }]]));
    expect(p.basis).toBe('terms');
    expect(p.date).toBe('2026-07-01');
  });

  it('falls back to the due date when the customer has no history at all', () => {
    expect(placeInvoice(inv(), new Map()).basis).toBe('terms');
  });

  it('returns no date at all rather than guessing when neither exists', () => {
    const p = placeInvoice(inv({ dueDate: null }), new Map());
    expect(p.date).toBeNull();
    expect(p.basis).toBeNull();
  });

  it('keys history by entity id, and by name only when there is no id', () => {
    const byId = placeInvoice(inv(), new Map([['e:77', { days: 10, samples: 3 }]]));
    expect(byId.date).toBe('2026-06-11');
    const byName = placeInvoice(inv({ entityId: null }), new Map([['n:Acme', { days: 10, samples: 3 }]]));
    expect(byName.date).toBe('2026-06-11');
    // The name entry must NOT reach an invoice that carries an id.
    const noCross = placeInvoice(inv(), new Map([['n:Acme', { days: 10, samples: 3 }]]));
    expect(noCross.basis).toBe('terms');
  });
});

describe('medianDaysToPay', () => {
  const row = (key: string, invoice: string, invoiced: string, paid: string) =>
    ({ key, invoice, invoiced, paid });

  it('counts one sample per invoice number, however many lines it had', () => {
    const m = medianDaysToPay([
      row('e:1', 'INV1', '2026-01-01', '2026-01-31'),
      row('e:1', 'INV1', '2026-01-01', '2026-01-31'),
      row('e:1', 'INV2', '2026-02-01', '2026-02-11'),
    ]);
    expect(m.get('e:1')).toEqual({ days: 20, samples: 2 });
  });

  it('drops impossible spans instead of letting them move the median', () => {
    const m = medianDaysToPay([
      row('e:1', 'INV1', '2026-01-01', '2025-01-01'),   // paid before invoiced
      row('e:1', 'INV2', '2026-01-01', '2028-01-01'),   // two years later
      row('e:1', 'INV3', '2026-01-01', '2026-01-11'),
    ]);
    expect(m.get('e:1')).toEqual({ days: 10, samples: 1 });
  });

  it('ignores rows missing an invoice number or either date', () => {
    const m = medianDaysToPay([
      { key: 'e:1', invoice: null, invoiced: '2026-01-01', paid: '2026-01-10' },
      { key: 'e:1', invoice: 'INV1', invoiced: null, paid: '2026-01-10' },
      { key: 'e:1', invoice: 'INV2', invoiced: '2026-01-01', paid: null },
    ]);
    expect(m.size).toBe(0);
  });
});

describe('buildOutlook', () => {
  it('lands collections in the week their money is expected', () => {
    const o = buildOutlook(baseInput({
      invoices: [inv({ dueDate: '2026-07-08', unpaid: 4000 })],
    }));
    expect(o.weeks[1].inflow).toBe(4000);
    expect(o.weeks[1].inflowDetail[0]).toMatchObject({ source: 'ar_terms', amount: 4000, count: 1 });
  });

  it('keeps overdue receivables OUT of every week and out of the balance', () => {
    const o = buildOutlook(baseInput({
      invoices: [inv({ dueDate: '2026-06-01', unpaid: 9000 })],
    }));
    expect(o.overdue).toEqual({ amount: 9000, count: 1 });
    expect(o.weeks.every(w => w.inflow === 0)).toBe(true);
    // Balance is flat at the starting cash, not lifted by money that is late.
    expect(o.weeks[3].projectedBalance).toBe(100_000);
    expect(o.warnings.some(w => /already past the date/.test(w))).toBe(true);
  });

  it('reports an unplaceable invoice instead of dropping it into week 1', () => {
    const o = buildOutlook(baseInput({
      invoices: [inv({ dueDate: null, unpaid: 2500 })],
    }));
    expect(o.unplaceable).toEqual({ amount: 2500, count: 1 });
    expect(o.weeks[0].inflow).toBe(0);
    expect(o.coverage.unplaced).toBe(2500);
    expect(o.warnings.some(w => /neither payment history nor a due date/.test(w))).toBe(true);
  });

  it('sets aside money expected beyond the horizon', () => {
    const o = buildOutlook(baseInput({ invoices: [inv({ dueDate: '2026-09-01', unpaid: 700 })] }));
    expect(o.beyond).toEqual({ amount: 700, count: 1 });
  });

  it('treats a payable with no due date as owed NOW, unlike a receivable', () => {
    const o = buildOutlook(baseInput({ bills: [bill({ dueDate: null, unpaid: 300 })] }));
    expect(o.weeks[0].outflow).toBe(300);
  });

  it('pulls an already-overdue payable into the current week', () => {
    const o = buildOutlook(baseInput({ bills: [bill({ dueDate: '2026-05-01', unpaid: 800 })] }));
    expect(o.weeks[0].outflow).toBe(800);
  });

  it('puts approved payouts in the current week (they have no scheduled date)', () => {
    const o = buildOutlook(baseInput({ payouts: [{ amount: 1200 }, { amount: 800 }] }));
    expect(o.weeks[0].outflow).toBe(2000);
    expect(o.weeks[0].outflowDetail[0]).toMatchObject({ source: 'payouts', count: 2 });
  });

  it('spreads the payroll run-rate across every week', () => {
    const o = buildOutlook(baseInput({ payrollWeekly: 5000, payrollBasis: '3-month GL average', payrollError: null }));
    expect(o.weeks.map(w => w.outflow)).toEqual([5000, 5000, 5000, 5000]);
    expect(o.warnings.some(w => /Payroll is NOT/.test(w))).toBe(false);
  });

  it('warns loudly when payroll is missing rather than quietly under-spending', () => {
    const o = buildOutlook(baseInput({ payrollWeekly: null }));
    expect(o.warnings.some(w => /Payroll is NOT in these outflows/.test(w))).toBe(true);
  });

  it('runs the balance forward week by week', () => {
    const o = buildOutlook(baseInput({
      invoices: [inv({ dueDate: '2026-07-08', unpaid: 10_000 })],
      bills: [bill({ dueDate: '2026-07-15', unpaid: 4_000 })],
    }));
    expect(o.weeks.map(w => w.projectedBalance)).toEqual([100_000, 110_000, 106_000, 106_000]);
  });

  it('leaves every projected balance null when the bank total is unknown', () => {
    const o = buildOutlook(baseInput({
      startingCash: null, startingCashError: 'RESTlet down',
      invoices: [inv({ dueDate: '2026-07-08', unpaid: 10_000 })],
    }));
    expect(o.weeks.every(w => w.projectedBalance === null)).toBe(true);
    // The deltas are still real even with no starting point.
    expect(o.weeks[1].net).toBe(10_000);
    expect(o.warnings.some(w => /No bank balance available/.test(w))).toBe(true);
  });

  it('splits coverage between real history and stated terms', () => {
    const o = buildOutlook(baseInput({
      invoices: [
        inv({ id: 'a', entityId: '77', dueDate: '2026-07-08', unpaid: 1000 }),
        inv({ id: 'b', entityId: '88', dueDate: '2026-07-08', unpaid: 500 }),
      ],
      medianDays: new Map([['e:77', { days: 10, samples: 5 }]]),
    }));
    expect(o.coverage.byHistory).toBe(1000);
    expect(o.coverage.byTerms).toBe(500);
  });

  it('ignores a zero or negative open balance', () => {
    const o = buildOutlook(baseInput({
      invoices: [inv({ unpaid: 0, dueDate: '2026-07-08' })],
      bills: [bill({ unpaid: -50, dueDate: '2026-07-08' })],
    }));
    expect(o.weeks.every(w => w.inflow === 0 && w.outflow === 0)).toBe(true);
  });
});

describe('payrollRunRate', () => {
  const period = (payroll: number | null, directional = false) =>
    ({ directional, pnl: payroll == null ? null : { payroll } });

  it('averages CLOSED months only — a month-to-date figure would drag it down', () => {
    const r = payrollRunRate({ status: 'fulfilled', value: {
      payrollConfigured: true,
      periods: [period(3000, true), period(52_000), period(52_000)],
    } } as any);
    expect(r.weekly).toBe(12_000);   // 52k/mo * 12 / 52
    expect(r.basis).toContain('2-month');
  });

  it('reports no figure at all when payroll accounts are not configured', () => {
    const r = payrollRunRate({ status: 'fulfilled', value: { payrollConfigured: false, periods: [] } } as any);
    expect(r.weekly).toBeNull();
    expect(r.error).toMatch(/payroll accounts/);
  });

  it('reports no figure when the RESTlet failed, rather than assuming zero', () => {
    const r = payrollRunRate({ status: 'rejected', reason: new Error('x') } as any);
    expect(r.weekly).toBeNull();
    expect(r.error).toMatch(/unavailable/);
  });

  it('reports no figure when every closed period posted nothing', () => {
    const r = payrollRunRate({ status: 'fulfilled', value: {
      payrollConfigured: true, periods: [period(null), period(0)],
    } } as any);
    expect(r.weekly).toBeNull();
  });
});
