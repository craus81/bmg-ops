import { describe, it, expect } from 'vitest';
import {
  CREDIT_NUMBER_MAX, MAX_APPLIED_BILLS, MAX_VENDOR_CREDIT_LINES, VENDOR_CREDIT_RULE, accountName, applyOldestFirst,
  keptApplied, keptVendorCreditLines, netsuiteVendorCredit, workOutVendorCredit,
  type CreditAccount, type CreditCompany, type CreditPart, type OpenBill, type VendorCreditDraft, type VendorCreditFacts,
} from './vendor-credit';

// Made-up companies, accounts, parts and a vendor's open bills.
const BMG: CreditCompany = { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '5', name: 'Mobile' }] };
const OTHER: CreditCompany = { code: '1084', name: '1084 Cool Springs', subsidiaryId: '3', locations: [{ id: '7', name: 'Cool Springs' }] };
const NOSUB: CreditCompany = { code: 'NEW', name: 'New Co', subsidiaryId: null, locations: [] };

const ACCOUNTS = new Map<string, CreditAccount>([
  ['610', { id: '610', number: '5100', name: 'Shop supplies', companies: ['BMG', '1084'] }],
  ['620', { id: '620', number: null, name: 'Freight in', companies: ['BMG'] }],
]);
const PARTS = new Map<string, CreditPart>([
  ['55', { id: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', stock: true, cost: 125.5, onHand: 4 }],
  ['70', { id: '70', itemNumber: 'DECAL-9', description: null, stock: false, cost: null, onHand: null }],
]);
const BILLS: OpenBill[] = [
  { id: '3001', number: 'B-100', date: '2026-09-01', dueDate: '2026-10-01', openCents: 20000 },
  { id: '3002', number: 'B-101', date: '2026-08-15', dueDate: '2026-09-15', openCents: 5000 },
  { id: '3003', number: null, date: '2026-10-05', dueDate: null, openCents: 100000 },
];
const FACTS: VendorCreditFacts = {
  today: '2026-10-31', companies: [BMG, OTHER, NOSUB], accounts: ACCOUNTS, parts: PARTS,
  vendor: { id: '4001', name: 'Acme Racks' }, openBills: BILLS,
};
/** One shelf unit going back at what it cost, and $20 of restocking fee back to Shop supplies: $145.50. */
const DRAFT: VendorCreditDraft = {
  company: 'BMG', vendorId: '4001', number: 'VC-77', date: '2026-10-30', locationId: '1', reason: 'Returned shelf',
  lines: [
    { kind: 'part', itemId: '55', quantity: 1, rate: 125.5 },
    { kind: 'account', accountId: '610', amount: 20, memo: ' Restock fee back ' },
  ],
  applied: [],
};

const work = (over: Partial<VendorCreditDraft> = {}, facts: Partial<VendorCreditFacts> = {}) =>
  workOutVendorCredit({ ...DRAFT, ...over }, { ...FACTS, ...facts });
const problemsOf = (over: Partial<VendorCreditDraft> = {}, facts: Partial<VendorCreditFacts> = {}) => work(over, facts).problems;
const account = (amount: number, accountId: string | null = '610') => ({ kind: 'account' as const, accountId, amount });
const part = (quantity: number, rate: number, itemId: string | null = '55') => ({ kind: 'part' as const, itemId, quantity, rate });

describe('workOutVendorCredit', () => {
  it('works out each line, the total, and what stays open on the vendor', () => {
    const w = work();
    expect(w.problems).toEqual([]);
    expect(w.company).toBe(BMG);
    expect(w.lines).toEqual([
      {
        lineNo: 1, kind: 'part', accountId: null, accountName: null, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit',
        quantity: 1, rate: 125.5, stock: true, cents: 12550, memo: null,
      },
      {
        lineNo: 2, kind: 'account', accountId: '610', accountName: '5100 Shop supplies', itemId: null, itemNumber: null, description: null,
        quantity: null, rate: null, stock: false, cents: 2000, memo: 'Restock fee back',
      },
    ]);
    expect(w).toMatchObject({ totalCents: 14550, appliedCents: 0, leftCents: 14550, applied: [] });
    expect(VENDOR_CREDIT_RULE).toBe('vendor_credit@1');
  });

  it("rounds a part line's quantity times rate half to even, to the cent", () => {
    expect(work({ lines: [part(2, 3.3325, '70')] }).lines[0].cents).toBe(666);
    expect(work({ lines: [part(2, 3.3375, '70')] }).lines[0].cents).toBe(668);
    expect(work({ lines: [part(3, 33.333, '70')] }).totalCents).toBe(10000);
    expect(work({ lines: [account(19.999)] }).totalCents).toBe(2000);
  });

  it('needs a company with a NetSuite subsidiary', () => {
    expect(problemsOf({ company: '' })).toContain('Pick which company the credit is for.');
    expect(problemsOf({ company: 'NOPE' })).toContain('Pick which company the credit is for.');
    const w = work({ company: 'NEW', lines: [account(5)], locationId: null });
    expect(w.problems).toEqual(["New Co has no NetSuite subsidiary, so its vendor credits can't be made yet.", "Line 1: 5100 Shop supplies isn't one of New Co's accounts."]);
    expect(w.company).toBe(NOSUB);
  });

  it("needs the vendor, as FleetSuite's copy of NetSuite's vendors has it", () => {
    expect(problemsOf({ vendorId: null })).toEqual(['Pick the vendor.']);
    const gone = "That vendor isn't in FleetSuite's copy of NetSuite's vendors. Pick it again.";
    expect(problemsOf({}, { vendor: null })).toEqual([gone]);
    expect(problemsOf({ vendorId: '4002' })).toEqual([gone]);
  });

  it("needs the vendor's credit number, up to 40 characters", () => {
    expect(problemsOf({ number: '  ' })).toEqual(["Enter the vendor's credit number."]);
    expect(problemsOf({ number: 'x'.repeat(CREDIT_NUMBER_MAX) })).toEqual([]);
    expect(problemsOf({ number: ` ${'x'.repeat(CREDIT_NUMBER_MAX)} ` })).toEqual([]);
    expect(problemsOf({ number: 'x'.repeat(CREDIT_NUMBER_MAX + 1) })).toEqual(["The vendor's credit number can be up to 40 characters."]);
  });

  it("needs a real date on the credit, no later than today", () => {
    const enter = "Enter the date on the vendor's credit.";
    for (const date of ['', '2026-02-30', '10/30/2026', '2026-13-01', '2026-10-3']) expect(problemsOf({ date })).toEqual([enter]);
    expect(problemsOf({ date: '2026-10-31' })).toEqual([]);
    expect(problemsOf({ date: '2026-11-01' })).toEqual(["The credit's date can't be after today."]);
  });

  it('needs a reason, for the memo', () => {
    expect(problemsOf({ reason: ' \n ' })).toEqual(['Say why the vendor gave the credit.']);
  });

  it("books it at one of the company's locations, or none", () => {
    expect(problemsOf({ locationId: '7' })).toEqual([
      "That location isn't one of BMG Fleet's.",
      "A stock part goes back out of O'Fallon, the only place that keeps stock. Pick O'Fallon as the location.",
    ]);
    expect(problemsOf({ locationId: null, lines: [account(5)] })).toEqual([]);
    expect(problemsOf({ locationId: '5', lines: [account(5)] })).toEqual([]);
    expect(problemsOf({ company: '1084', locationId: '7', lines: [account(5)] })).toEqual([]);
    expect(problemsOf({ company: '1084', locationId: '1', lines: [account(5)] })).toEqual(["That location isn't one of 1084 Cool Springs's."]);
  });

  it("checks each account line's account and amount", () => {
    expect(problemsOf({ lines: [account(5, null)] })).toEqual(['Line 1: pick the account the money goes back to.']);
    expect(problemsOf({ lines: [account(5, '999')] })).toEqual(["Line 1: that account can't take a vendor credit."]);
    expect(problemsOf({ company: '1084', locationId: null, lines: [account(5, '620')] })).toEqual(["Line 1: Freight in isn't one of 1084 Cool Springs's accounts."]);
    for (const amount of [0, -5, Number.NaN, 0.004]) {
      expect(problemsOf({ lines: [account(1), account(amount)] })).toEqual(['Line 2: enter an amount above $0.']);
    }
    const w = work({ lines: [account(5, null)] });
    expect(w.lines[0]).toMatchObject({ accountId: null, accountName: null, cents: 500, memo: null });
  });

  it("checks each part line's part, quantity and rate", () => {
    expect(problemsOf({ lines: [part(1, 5, null)] })).toEqual(['Line 1: pick the part going back.']);
    expect(problemsOf({ lines: [part(1, 5, '999')] })).toEqual(["Line 1: that part isn't in FleetSuite's copy of NetSuite's items."]);
    expect(problemsOf({ lines: [part(0, 125.5)] })).toEqual(['SHELF-1: enter a quantity above 0.']);
    expect(problemsOf({ lines: [part(-1, 125.5)] })).toEqual(['SHELF-1: enter a quantity above 0.']);
    expect(problemsOf({ lines: [part(Number.NaN, 125.5)] })).toEqual(['SHELF-1: enter a quantity above 0.']);
    expect(problemsOf({ lines: [part(1, 0)] })).toEqual(['SHELF-1: enter a rate above $0.']);
    expect(problemsOf({ lines: [part(1, -2)] })).toEqual(['SHELF-1: enter a rate above $0.']);
    expect(problemsOf({ lines: [account(1), part(0, 0, null)] })).toEqual([
      'Line 2: pick the part going back.', 'Line 2: enter a quantity above 0.', 'Line 2: enter a rate above $0.',
    ]);
    expect(problemsOf({ lines: [part(1, 0.004)] })).toEqual(['SHELF-1: that comes to less than a cent.']);
    const w = work({ lines: [part(0, 0)] });
    expect(w.lines[0]).toMatchObject({ quantity: null, rate: null, cents: 0, stock: true });
    expect(work({ lines: [part(1, 5, '999')] }).lines[0]).toMatchObject({ itemNumber: null, description: null, stock: false });
  });

  it('needs at least one line, and no more than 50', () => {
    expect(problemsOf({ lines: [] })).toEqual(['Add a line: money back to an account, or a part going back.']);
    const many = Array.from({ length: MAX_VENDOR_CREDIT_LINES }, () => account(1));
    expect(problemsOf({ lines: many })).toEqual([]);
    expect(problemsOf({ lines: [...many, account(1)] })).toEqual(['A vendor credit can have up to 50 lines.']);
  });

  it("sends parts back only on BMG's vendor credits, and a stock part only out of O'Fallon", () => {
    expect(problemsOf({ company: '1084', locationId: null, lines: [part(1, 5, '70')] })).toEqual(["Parts go back only on BMG's vendor credits; 1084 Cool Springs keeps no stock."]);
    const ofallon = "A stock part goes back out of O'Fallon, the only place that keeps stock. Pick O'Fallon as the location.";
    expect(problemsOf({ locationId: '5' })).toEqual([ofallon]);
    expect(problemsOf({ locationId: null })).toEqual([ofallon]);
    expect(problemsOf({ locationId: '5', lines: [part(2, 1.5, '70')] })).toEqual([]);
    expect(problemsOf({ locationId: null, lines: [part(2, 1.5, '70')] })).toEqual([]);
  });

  it('applies it to the bills picked, never more than a bill has open nor more than the credit', () => {
    const w = work({ applied: [{ billId: '3001', amount: 100 }, { billId: '3002', amount: 45.5 }] });
    expect(w.problems).toEqual([]);
    expect(w.applied).toEqual([{ billId: '3001', billNumber: 'B-100', cents: 10000 }, { billId: '3002', billNumber: 'B-101', cents: 4550 }]);
    expect(w).toMatchObject({ appliedCents: 14550, leftCents: 0 });
    expect(work({ applied: [{ billId: '3002', amount: 50 }] })).toMatchObject({ problems: [], appliedCents: 5000, leftCents: 9550 });

    expect(problemsOf({ applied: [{ billId: '3002', amount: 50.01 }] })).toEqual(['Bill B-101 has $50.00 open, so no more than that can be applied to it.']);
    expect(problemsOf({ applied: [{ billId: '3001', amount: 145.51 }] })).toEqual(["That applies $145.51 to bills, more than the credit's $145.50."]);
    expect(problemsOf({ applied: [{ billId: '3001', amount: 100 }, { billId: '3002', amount: 50 }] })).toEqual(["That applies $150.00 to bills, more than the credit's $145.50."]);
    for (const amount of [0, -1, Number.NaN]) {
      expect(problemsOf({ applied: [{ billId: '3001', amount }] })).toEqual(['Bill B-100: apply more than $0, or leave it unpicked.']);
    }
    expect(problemsOf({ applied: [{ billId: '3003', amount: 0 }] })).toEqual(['NetSuite bill 3003: apply more than $0, or leave it unpicked.']);
    expect(work({ applied: [{ billId: '3003', amount: 1 }] }).applied).toEqual([{ billId: '3003', billNumber: null, cents: 100 }]);
  });

  it("won't apply it to a bill twice, or to one NetSuite no longer has open", () => {
    expect(problemsOf({ applied: [{ billId: '3002', amount: 10 }, { billId: '3002', amount: 10 }] })).toEqual(['Bill B-101 was picked twice.']);
    expect(work({ applied: [{ billId: '3002', amount: 10 }, { billId: '3002', amount: 10 }] }).appliedCents).toBe(1000);
    expect(problemsOf({ applied: [{ billId: '3999', amount: 10 }] })).toEqual(["NetSuite bill 3999 isn't open in NetSuite any more. Reload and try again."]);
    expect(work({ applied: [{ billId: '3999', amount: 10 }] }).applied).toEqual([]);
  });

  it("can't apply it when the vendor's open bills couldn't be read, and can leave it open", () => {
    expect(problemsOf({ applied: [{ billId: '3001', amount: 10 }, { billId: '3002', amount: 10 }] }, { openBills: null })).toEqual([
      "Couldn't read the vendor's open bills from NetSuite, so the credit can't be applied to them now. Leave it unapplied, or reload and try again.",
    ]);
    expect(work({}, { openBills: null })).toMatchObject({ problems: [], applied: [], leftCents: 14550 });
  });

  it('applies it to up to 100 bills', () => {
    const bills = Array.from({ length: MAX_APPLIED_BILLS + 1 }, (_, i): OpenBill => ({ id: String(5000 + i), number: `B${i}`, date: '2026-10-01', dueDate: null, openCents: 100 }));
    const lines = [account(200)];
    const applied = bills.map((b) => ({ billId: b.id, amount: 1 }));
    expect(problemsOf({ lines, applied: applied.slice(0, MAX_APPLIED_BILLS) }, { openBills: bills })).toEqual([]);
    expect(problemsOf({ lines, applied }, { openBills: bills })).toEqual(['A vendor credit can be applied to up to 100 bills.']);
  });

  it('never leaves less than nothing open', () => {
    expect(work({ applied: [{ billId: '3003', amount: 500 }] })).toMatchObject({ appliedCents: 50000, leftCents: 0 });
  });
});

describe('applyOldestFirst', () => {
  it("applies the credit to the vendor's oldest open bills first, as far as it goes", () => {
    expect(applyOldestFirst(BILLS, 14550)).toEqual([{ billId: '3002', amount: 50 }, { billId: '3001', amount: 95.5 }]);
    expect(applyOldestFirst(BILLS, 25000)).toEqual([{ billId: '3002', amount: 50 }, { billId: '3001', amount: 200 }]);
    expect(applyOldestFirst(BILLS, 25001)).toEqual([{ billId: '3002', amount: 50 }, { billId: '3001', amount: 200 }, { billId: '3003', amount: 0.01 }]);
    expect(applyOldestFirst(BILLS, 4000)).toEqual([{ billId: '3002', amount: 40 }]);
    expect(applyOldestFirst(BILLS, 0)).toEqual([]);
    expect(applyOldestFirst([], 100)).toEqual([]);
  });

  it('takes bills of the same day in NetSuite order, skips any with nothing open, and leaves the list alone', () => {
    const sameDay: OpenBill[] = [
      { id: '10', number: 'B', date: '2026-10-01', dueDate: null, openCents: 300 },
      { id: '9', number: 'A', date: '2026-10-01', dueDate: null, openCents: 0 },
      { id: '8', number: 'C', date: '2026-10-01', dueDate: null, openCents: 300 },
    ];
    expect(applyOldestFirst(sameDay, 500)).toEqual([{ billId: '8', amount: 3 }, { billId: '10', amount: 2 }]);
    expect(sameDay.map((b) => b.id)).toEqual(['10', '9', '8']);
  });

  it('comes out right by the rules', () => {
    const picked = applyOldestFirst(BILLS, 14550);
    expect(work({ applied: picked })).toMatchObject({ problems: [], appliedCents: 14550, leftCents: 0 });
  });
});

describe('netsuiteVendorCredit', () => {
  it('sends account lines as expenses and parts as items, applied to the bills, booked at the location', () => {
    const d = { ...DRAFT, number: ' VC-77 ', reason: ' Returned shelf ', applied: [{ billId: '3002', amount: 50 }] };
    expect(netsuiteVendorCredit(workOutVendorCredit(d, FACTS), d)).toEqual({
      vendorId: '4001', tranId: 'VC-77', tranDate: '2026-10-30', subsidiaryId: '2', locationId: '1', memo: 'Returned shelf',
      expenses: [{ accountId: '610', amount: 20, memo: 'Restock fee back' }],
      items: [{ itemId: '55', quantity: 1, rate: 125.5, amount: 125.5 }],
      apply: [{ billId: '3002', amount: 50 }],
    });
  });

  it('sends the amount FleetSuite worked out with the quantity and rate, and no memo on a line without one', () => {
    const d = { ...DRAFT, locationId: null, lines: [part(2, 3.3325, '70'), account(5)] };
    const sent = netsuiteVendorCredit(workOutVendorCredit(d, FACTS), d);
    expect(sent.items).toEqual([{ itemId: '70', quantity: 2, rate: 3.3325, amount: 6.66 }]);
    expect(sent.expenses).toEqual([{ accountId: '610', amount: 5 }]);
    expect(sent).toMatchObject({ locationId: null, apply: [] });
  });

  it('sends nothing for a vendor credit with problems', () => {
    const d = { ...DRAFT, reason: '' };
    expect(() => netsuiteVendorCredit(workOutVendorCredit(d, FACTS), d)).toThrow('The vendor credit has problems; nothing to send.');
  });
});

describe('what typed_vendor_credits keeps', () => {
  it('keeps each line and each bill it was applied to', () => {
    const w = work({ applied: [{ billId: '3002', amount: 50 }] });
    expect(keptVendorCreditLines(w)).toEqual([
      { kind: 'part', accountId: null, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 1, rate: 125.5, cents: 12550 },
      { kind: 'account', accountId: '610', itemId: null, itemNumber: null, description: 'Restock fee back', quantity: null, rate: null, cents: 2000 },
    ]);
    expect(keptApplied(w)).toEqual([{ billId: '3002', billNumber: 'B-101', cents: 5000 }]);
  });
});

describe('accountName', () => {
  it('names an account by its number and name', () => {
    expect(accountName({ number: '5100', name: 'Shop supplies' })).toBe('5100 Shop supplies');
    expect(accountName({ number: null, name: 'Freight in' })).toBe('Freight in');
  });
});
