import { describe, it, expect } from 'vitest';
import {
  MAX_APPLIED, MAX_PAYMENT_CENTS, appliedAsSent, appliedToKeep, applyOldestFirst, keptApplied, netsuiteMemo,
  netsuitePayment, paymentExternalId, sameReference, workOutPayment, type OpenInvoice, type PaymentDraft,
} from './receive-payment';

// A customer's check or ACH payment worked out against the open invoices
// NetSuite has for them (Books part 54). Made-up data.

const OPEN: OpenInvoice[] = [
  { id: '9001', number: 'INV2001', date: '2026-10-01', dueDate: '2026-10-31', po: null, totalCents: 25000, openCents: 25000 },
  { id: '8990', number: 'INV1990', date: '2026-09-03', dueDate: '2026-10-03', po: 'PO-77', totalCents: 120000, openCents: 40010 },
  { id: '8995', number: 'INV1995', date: '2026-09-20', dueDate: null, po: null, totalCents: 7500, openCents: 7500 },
];
const TODAY = '2026-10-31';
const DRAFT: PaymentDraft = {
  date: '2026-10-30',
  method: 'check',
  reference: ' 10442 ',
  memo: '  September  and October ',
  amountCents: 65010,
  applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '8990', cents: 40010 }],
};
const work = (d: Partial<PaymentDraft>, open: OpenInvoice[] = OPEN) => workOutPayment({ ...DRAFT, ...d }, open, { today: TODAY });
const problemsOf = (d: Partial<PaymentDraft>, open?: OpenInvoice[]) => work(d, open).problems;

describe('workOutPayment', () => {
  it('works out a check that pays two invoices in full, oldest first', () => {
    expect(work({})).toEqual({
      problems: [],
      date: '2026-10-30',
      method: 'check',
      reference: '10442',
      memo: 'September and October',
      netsuiteMemo: 'Check 10442 · September and October',
      amountCents: 65010,
      applied: [
        { invoiceId: '8990', number: 'INV1990', cents: 40010, openCents: 40010 },
        { invoiceId: '9001', number: 'INV2001', cents: 25000, openCents: 25000 },
      ],
      appliedCents: 65010,
    });
  });

  it('takes an ACH payment with no reference or memo, and part of an invoice', () => {
    const w = work({ method: 'ach', reference: '  ', memo: '', amountCents: 10000, applied: [{ invoiceId: '8990', cents: 10000 }] });
    expect(w.problems).toEqual([]);
    expect(w).toMatchObject({ method: 'ach', reference: null, memo: null, netsuiteMemo: 'ACH', amountCents: 10000, appliedCents: 10000 });
  });

  it('needs a real day, not after today and not more than a year back', () => {
    expect(problemsOf({ date: '' })).toEqual(['Fill in the day it was received.']);
    expect(problemsOf({ date: '2026-02-30' })).toEqual(["2026-02-30 isn't a day on the calendar."]);
    expect(problemsOf({ date: '10/30/2026' })).toEqual(["10/30/2026 isn't a day on the calendar."]);
    expect(problemsOf({ date: TODAY })).toEqual([]);
    expect(problemsOf({ date: '2026-11-01' })).toEqual(["A payment can't be dated after today."]);
    expect(problemsOf({ date: '2025-10-30' })).toEqual([]);
    expect(problemsOf({ date: '2025-10-29' })).toEqual(["A payment can't be dated more than a year back."]);
  });

  it("needs check or ACH, a check's number, and a short reference and memo", () => {
    const cash = work({ method: 'cash' });
    expect(cash.problems).toEqual(['Pick check or ACH.']);
    expect(cash.method).toBe('check');
    expect(problemsOf({ reference: '' })).toEqual(["Fill in the check's number."]);
    expect(problemsOf({ reference: '1'.repeat(40) })).toEqual([]);
    expect(problemsOf({ reference: '1'.repeat(41) })).toEqual(['The check number is 40 characters at most.']);
    expect(problemsOf({ method: 'ach', reference: '1'.repeat(41) })).toEqual(['The reference is 40 characters at most.']);
    expect(problemsOf({ method: '', reference: '1'.repeat(41) })).toEqual(['Pick check or ACH.', 'The reference is 40 characters at most.']);
    expect(problemsOf({ memo: `${'m'.repeat(300)}   ` })).toEqual([]);
    expect(problemsOf({ memo: 'm'.repeat(301) })).toEqual(['The memo is 300 characters at most.']);
  });

  it('needs an amount in whole cents above $0 and no more than $10,000,000', () => {
    for (const amountCents of [0, -500, 650.1, Number.NaN]) {
      const w = work({ amountCents });
      expect(w.problems).toEqual(["Fill in the payment's amount."]);
      expect(w.amountCents).toBe(0);
    }
    const big = work({ amountCents: MAX_PAYMENT_CENTS + 1 });
    expect(big.problems).toEqual(['One payment is $10,000,000.00 at most.']);
    expect(big.amountCents).toBe(0);
    const most = { id: '1', number: 'INV1', date: '2026-10-01', dueDate: null, po: null, totalCents: MAX_PAYMENT_CENTS, openCents: MAX_PAYMENT_CENTS };
    expect(problemsOf({ amountCents: MAX_PAYMENT_CENTS, applied: [{ invoiceId: '1', cents: MAX_PAYMENT_CENTS }] }, [most])).toEqual([]);
  });

  it('pays only open invoices of the customer, each once, never more than NetSuite has open on it', () => {
    expect(problemsOf({ applied: [{ invoiceId: '7777', cents: 65010 }] }))
      .toEqual(["Invoice 7777 isn't open for this customer in NetSuite now, so nothing can be paid on it."]);
    expect(problemsOf({ amountCents: 50000, applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '9001', cents: 25000 }] }))
      .toEqual(['INV2001 is ticked twice.', 'It pays $250.00 of the $500.00: put the other $250.00 on an invoice, or change the amount.']);
    expect(problemsOf({ applied: [{ invoiceId: '7777', cents: 100 }, { invoiceId: '7777', cents: 100 }] })).toEqual([
      "Invoice 7777 isn't open for this customer in NetSuite now, so nothing can be paid on it.",
      'Invoice 7777 is ticked twice.',
    ]);
    expect(problemsOf({ amountCents: 25000, applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '8995', cents: 0 }] }))
      .toEqual(['Fill in what it pays on INV1995, or untick it.']);
    expect(problemsOf({ amountCents: 25000, applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '8995', cents: 0.5 }] }))
      .toEqual(['Fill in what it pays on INV1995, or untick it.']);
    expect(problemsOf({ amountCents: 8000, applied: [{ invoiceId: '8995', cents: 8000 }] }))
      .toEqual(['INV1995 has $75.00 open in NetSuite now, less than the $80.00 it pays.']);
    expect(problemsOf({ amountCents: 7501, applied: [{ invoiceId: '8995', cents: 7501 }] }))
      .toEqual(['INV1995 has $75.00 open in NetSuite now, less than the $75.01 it pays.']);
    expect(problemsOf({ amountCents: 7500, applied: [{ invoiceId: '8995', cents: 7500 }] })).toEqual([]);
  });

  it('pays at least one invoice and no more than 50', () => {
    expect(problemsOf({ applied: [] })).toEqual(['Tick the invoices it pays.']);
    const many: OpenInvoice[] = Array.from({ length: MAX_APPLIED + 1 }, (_, i) => ({
      id: String(100 + i), number: `INV${100 + i}`, date: '2026-10-01', dueDate: null, po: null, totalCents: 100, openCents: 100,
    }));
    const all = many.map((i) => ({ invoiceId: i.id, cents: 100 }));
    expect(problemsOf({ amountCents: 5100, applied: all }, many)).toEqual(['One payment pays 50 invoices at most.']);
    expect(problemsOf({ amountCents: 5000, applied: all.slice(0, MAX_APPLIED) }, many)).toEqual([]);
  });

  it('puts every dollar received on an invoice, and no more', () => {
    expect(problemsOf({ amountCents: 70000 }))
      .toEqual(['It pays $650.10 of the $700.00: put the other $49.90 on an invoice, or change the amount.']);
    expect(problemsOf({ amountCents: 60000 })).toEqual(['It pays $650.10 on the invoices, more than the $600.00 received.']);
    expect(problemsOf({ amountCents: 0 })).toEqual(["Fill in the payment's amount."]);
  });

  it('lists the invoices it pays as NetSuite does: by date, then number', () => {
    const sameDay = OPEN.map((i) => ({ ...i, date: '2026-10-01' }));
    const w = work({ amountCents: 72510, applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '8995', cents: 7500 }, { invoiceId: '8990', cents: 40010 }] }, sameDay);
    expect(w.applied.map((a) => a.number)).toEqual(['INV1990', 'INV1995', 'INV2001']);

    // By number, whichever of the two NetSuite made first.
    const renumbered: OpenInvoice[] = [
      { id: '100', number: 'INV2', date: '2026-10-01', dueDate: null, po: null, totalCents: 100, openCents: 100 },
      { id: '200', number: 'INV1', date: '2026-10-01', dueDate: null, po: null, totalCents: 100, openCents: 100 },
    ];
    const both = work({ amountCents: 200, applied: [{ invoiceId: '100', cents: 100 }, { invoiceId: '200', cents: 100 }] }, renumbered);
    expect(both.applied.map((a) => a.number)).toEqual(['INV1', 'INV2']);
    expect(applyOldestFirst(100, renumbered)).toEqual(new Map([['200', 100]]));
  });
});

describe('applyOldestFirst', () => {
  it('pays the oldest invoices in full, then part of the next', () => {
    expect(applyOldestFirst(45000, OPEN)).toEqual(new Map([['8990', 40010], ['8995', 4990]]));
    expect(applyOldestFirst(40010, OPEN)).toEqual(new Map([['8990', 40010]]));
    expect(applyOldestFirst(100000, OPEN)).toEqual(new Map([['8990', 40010], ['8995', 7500], ['9001', 25000]]));
  });

  it('pays nothing on an invoice with nothing open, and nothing at all for an amount that isn\'t one', () => {
    const paid = [{ ...OPEN[1], openCents: 0 }, OPEN[2]];
    expect(applyOldestFirst(1000, paid)).toEqual(new Map([['8995', 1000]]));
    expect(applyOldestFirst(0, OPEN)).toEqual(new Map());
    expect(applyOldestFirst(-100, OPEN)).toEqual(new Map());
    expect(applyOldestFirst(10.5, OPEN)).toEqual(new Map());
  });
});

describe('what is kept and sent', () => {
  const worked = work({});

  it("names a payment in NetSuite by the press it came from", () => {
    expect(paymentExternalId('6b0c1d2e-0000-4000-8000-000000000001')).toBe('fleetsuite-cp-6b0c1d2e-0000-4000-8000-000000000001');
  });

  it("writes NetSuite's memo from the method, its number or reference, and the memo typed", () => {
    expect(netsuiteMemo('check', '10442', 'September')).toBe('Check 10442 · September');
    expect(netsuiteMemo('ach', '0187', null)).toBe('ACH 0187');
    expect(netsuiteMemo('ach', null, 'Remit 55')).toBe('ACH · Remit 55');
  });

  it('sends dollars, the check number only for a check, and each invoice it pays', () => {
    expect(netsuitePayment(worked, { pressId: 'p1', customerId: '501', subsidiaryId: '2' })).toEqual({
      externalId: 'fleetsuite-cp-p1',
      customerId: '501',
      subsidiaryId: '2',
      tranDate: '2026-10-30',
      amount: 650.1,
      checkNumber: '10442',
      memo: 'Check 10442 · September and October',
      apply: [{ invoiceId: '8990', amount: 400.1 }, { invoiceId: '9001', amount: 250 }],
    });
    const ach = work({ method: 'ach', reference: '0187' });
    expect(netsuitePayment(ach, { pressId: 'p2', customerId: '501', subsidiaryId: '2' })).toMatchObject({ checkNumber: null, memo: 'ACH 0187 · September and October' });
  });

  it('keeps what it pays on each invoice, and reads back only what it can', () => {
    const kept = appliedToKeep([...worked.applied, { invoiceId: '8995', number: '', cents: 100, openCents: 7500 }]);
    expect(kept).toEqual([
      { invoice_netsuite_id: '8990', invoice_number: 'INV1990', cents: 40010 },
      { invoice_netsuite_id: '9001', invoice_number: 'INV2001', cents: 25000 },
      { invoice_netsuite_id: '8995', invoice_number: null, cents: 100 },
    ]);
    expect(keptApplied(kept)).toEqual([
      { invoiceId: '8990', number: 'INV1990', cents: 40010 },
      { invoiceId: '9001', number: 'INV2001', cents: 25000 },
      { invoiceId: '8995', number: '', cents: 100 },
    ]);
    expect(keptApplied(null)).toEqual([]);
    expect(keptApplied({ invoice_netsuite_id: '1', cents: 1 })).toEqual([]);
    expect(keptApplied([
      null, { invoice_netsuite_id: 8990, cents: 100 }, { invoice_netsuite_id: 'x1', cents: 100 },
      { invoice_netsuite_id: '8990', cents: 0 }, { invoice_netsuite_id: '8990', cents: 1.5 }, { invoice_netsuite_id: '8990', cents: '100' },
    ])).toEqual([]);
  });
});

describe('sameReference', () => {
  it('sees one check however its number is written', () => {
    expect(sameReference('10442', '#10442')).toBe(true);
    expect(sameReference('No. 1044-2', '10442')).toBe(true);
    expect(sameReference('no10442', ' 10442 ')).toBe(true);
    expect(sameReference('ab-1', 'AB1')).toBe(true);
  });

  it('tells different checks apart, and never matches a blank one', () => {
    expect(sameReference('10442', '10443')).toBe(false);
    expect(sameReference('NOV2026', 'V2026')).toBe(false);
    expect(sameReference('NOV2026', 'nov 2026')).toBe(true);
    expect(sameReference('10442A', '10442')).toBe(false);
    expect(sameReference('', '')).toBe(false);
    expect(sameReference('#', '-')).toBe(false);
    expect(sameReference(null, null)).toBe(false);
    expect(sameReference(undefined, '10442')).toBe(false);
  });
});

describe('appliedAsSent', () => {
  const applied = [
    { invoiceId: '8990', number: 'INV1990', cents: 40010, openCents: 40010 },
    { invoiceId: '9001', number: 'INV2001', cents: 20000, openCents: 25000 },
    { invoiceId: '8995', number: 'INV1995', cents: 7500, openCents: 7500 },
  ];

  it('says nothing when each invoice has what was open less what the payment paid', () => {
    expect(appliedAsSent(applied, new Map([['8990', 0], ['9001', 5000], ['8995', 0]]))).toBeNull();
    expect(appliedAsSent(applied, new Map([['9001', 5000]]))).toBeNull();
  });

  it("says which invoice NetSuite shows differently, and how many more", () => {
    const look = 'Look at the payment in NetSuite: it may not be applied the way FleetSuite sent it.';
    expect(appliedAsSent(applied, new Map([['8990', 0], ['9001', 25000], ['8995', 0]])))
      .toBe(`NetSuite shows INV2001 with $250.00 open now, not the $50.00 this payment leaves. ${look}`);
    expect(appliedAsSent(applied, new Map([['8990', 40010], ['9001', 25000], ['8995', 0]])))
      .toBe(`NetSuite shows INV1990 with $400.10 open now, not the $0.00 this payment leaves, and 1 more invoice too. ${look}`);
    expect(appliedAsSent(applied, new Map([['8990', 40010], ['8995', 7500]])))
      .toBe(`NetSuite shows INV1990 with $400.10 open now, not the $0.00 this payment leaves, and 2 more invoices too. ${look}`);
  });
});
