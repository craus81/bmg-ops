import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PoLineRow } from '@/lib/three-way-match';
import type { BillRead } from './bill-reader';
import type { SnapPo } from './snap-po';
import {
  BILL_NUMBER_MAX,
  billToMarkSent,
  extraOf,
  formFromRead,
  formOfRow,
  matchFor,
  matchVendor,
  memoWords,
  nearCharges,
  NO_HISTORY,
  plainSendError,
  readAccounts,
  readTerms,
  rowOfForm,
  sendUnfinished,
  settleForm,
  shortDay,
  storedReadFrom,
  storedReadOf,
  suggestAccounts,
  suggestDue,
  suggestExtraAccount,
  suggestLocation,
  usualAccount,
  usualCompany,
  vendorWords,
  viewSnapForm,
  type HistoryBill,
  type NearbyDoc,
  type SameBill,
  type SnapAccount,
  type SnapCompany,
  type SnapFacts,
  type SnapForm,
  type SnappedBillRow,
  type SnapVendor,
} from './snap-a-bill';

// Everything here is made up: the electric bill Books Previews draws.

const TODAY = '2026-10-25';

const BMG: SnapCompany = { id: 'c-bmg', code: 'BMG', name: 'BMG Fleet Installations', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '7', name: 'Social Circle' }] };
const OTHER: SnapCompany = { id: 'c-1084', code: '1084', name: '1084 Holdings', subsidiaryId: '5', locations: [{ id: '9', name: 'Main' }] };

const account = (id: string, number: string, name: string, companies: string[], type = 'expense'): [string, SnapAccount] =>
  [id, { id, number, name, type, companies }];
const ACCOUNTS = new Map<string, SnapAccount>([
  account('623', '6230', 'Utilities', ['BMG', '1084']),
  account('640', '6400', 'Late fees', ['BMG']),
  account('611', '6110', 'Subcontractors', ['BMG', '1084']),
  account('120', '12000', 'Accounts Receivable', [], 'accounts_receivable'),
]);
const label = (id: string) => {
  const a = ACCOUNTS.get(id);
  return a ? `${a.number} ${a.name}` : `NetSuite account ${id}`;
};

const RIVERBEND: SnapVendor = { id: '77', name: 'Riverbend Electric Co-op', entityId: 'V-RIVERBEND', termsId: '3', expenseAccountId: '611' };
const VENDORS: SnapVendor[] = [
  RIVERBEND,
  { id: '78', name: 'Riverside Plumbing LLC', entityId: null, termsId: null, expenseAccountId: null },
  { id: '79', name: 'Harbor Freight Lines, Inc.', entityId: 'HFL', termsId: null, expenseAccountId: null },
  { id: '80', name: 'The Home Depot', entityId: null, termsId: '4', expenseAccountId: null },
];
const named = (id: string, name: string): SnapVendor => ({ id, name, entityId: null, termsId: null, expenseAccountId: null });

/** One of their earlier bills: newest first, as gl_vendor_bill_history gives them. */
const earlier = (i: number, over: Partial<HistoryBill> = {}): HistoryBill => ({
  netsuite_id: String(7000 + i),
  number: `8821${i}-10`,
  date: `2026-${String(9 - (i % 9)).padStart(2, '0')}-20`,
  total: '1150.00',
  lines: [{ account: '623', memo: `Electric service, Aug 18 to Sep 17`, amount: '1150.00' }],
  lines_known: true,
  companies: ['BMG'],
  locations: ['1'],
  ...over,
});
const ELEVEN = Array.from({ length: 11 }, (_, i) => earlier(i));

const READ: BillRead = {
  isBill: true,
  vendorName: 'Riverbend Electric Co-op',
  billNumber: '88213-10',
  billDate: '2026-10-20',
  dueDate: '2026-11-19',
  terms: 'Net 30',
  lines: [
    { description: 'Electric service, Sep 18 to Oct 17', cents: 128433 },
    { description: 'Late payment charge', cents: 1250 },
  ],
  totalCents: 129683,
  amountDueCents: 129683,
  poNumber: null,
};

const facts = (over: Partial<SnapFacts> = {}): SnapFacts => ({
  companies: [BMG, OTHER],
  accounts: ACCOUNTS,
  vendor: RIVERBEND,
  match: { vendor: RIVERBEND, how: 'exact', others: [] },
  terms: { name: 'Net 30', days: 30 },
  history: { bills: ELEVEN, same_number: [] },
  asked: { found: null },
  nearby: [],
  read: READ,
  defaultLocationId: null,
  link: (type, id) => `https://ns.example/${type}/${id}`,
  today: TODAY,
  po: null,
  ...over,
});

/** The form once checked: both lines filled in, the late charge's account still to pick. */
const form = (over: Partial<SnapForm> = {}): SnapForm => ({
  company: 'BMG',
  vendorId: '77',
  vendorName: 'Riverbend Electric Co-op',
  billNumber: '88213-10',
  billDate: '2026-10-20',
  dueDate: '2026-11-19',
  duePicked: false,
  totalCents: 129683,
  locationId: '1',
  lines: [
    { description: 'Electric service, Sep 18 to Oct 17', cents: 128433, accountId: '623', picked: false },
    { description: 'Late payment charge', cents: 1250, accountId: null, picked: false },
  ],
  poNumber: null,
  howBilled: null,
  overrideReason: null,
  extra: null,
  ...over,
});
const sendable = (over: Partial<SnapForm> = {}) => form({
  lines: [form().lines[0], { ...form().lines[1], accountId: '640', picked: true }],
  ...over,
});

describe('helpers', () => {
  it('writes days short, with the year only when it is not this one', () => {
    expect(shortDay('2026-10-20', TODAY)).toBe('Oct 20');
    expect(shortDay('2025-01-05', TODAY)).toBe('Jan 5, 2025');
  });

  it("compares vendors' names without Inc, LLC, Co or punctuation", () => {
    expect(vendorWords('Harbor Freight Lines, Inc.')).toEqual(['harbor', 'freight', 'lines']);
    expect(vendorWords('Smith & Sons Co.')).toEqual(['smith', 'sons']);
    expect(vendorWords(null)).toEqual([]);
  });

  it("compares what lines are for without dates, numbers or months", () => {
    expect(memoWords('Electric service, Sep 18 to Oct 17')).toEqual(['electric', 'service']);
    expect(memoWords('INV 5521 for the racks')).toEqual(['racks']);
  });
});

describe('matching the vendor', () => {
  it("matches the same name, once Inc, LLC and punctuation are left out, or NetSuite's vendor id", () => {
    expect(matchVendor('Harbor Freight Lines', VENDORS)).toEqual({ vendor: VENDORS[2], how: 'exact', others: [] });
    expect(matchVendor('RIVERBEND ELECTRIC CO-OP', VENDORS).how).toBe('exact');
    expect(matchVendor('v-riverbend', VENDORS)).toEqual({ vendor: RIVERBEND, how: 'exact', others: [] });
  });

  it('offers the nearest as close when it is clearly nearest, to check', () => {
    const close = matchVendor('Riverbend Electric Cooperative', VENDORS);
    expect(close).toMatchObject({ vendor: RIVERBEND, how: 'close' });
    expect(matchVendor('Home Depot Pro', VENDORS)).toMatchObject({ vendor: VENDORS[3], how: 'close' });
  });

  it("doesn't call a name close when only some of its words are theirs", () => {
    // Two of the five words: one it could be, to pick.
    const power = named('90', 'Riverbend Electric Power Supply');
    expect(matchVendor('Riverbend Electric Coop', [power])).toEqual({ vendor: null, how: null, others: [power] });
    // One of the five: not even that.
    expect(matchVendor('Riverbend Electric Coop', [named('91', 'Riverbend Water District')])).toEqual({ vendor: null, how: null, others: [] });
  });

  it("matches nothing when two are as near, or two have the name, and says which they could be", () => {
    const twins = [...VENDORS, { ...RIVERBEND, id: '81', entityId: null }];
    expect(matchVendor('Riverbend Electric Co-op', twins)).toEqual({ vendor: null, how: null, others: [RIVERBEND, twins[4]] });
    const tie = matchVendor('Riverbend Riverside', [named('1', 'Riverbend Supply'), named('2', 'Riverside Supply')]);
    expect(tie.vendor).toBeNull();
    expect(tie.others.map((v) => v.id)).toEqual(['1', '2']);
    const near = [named('1', 'Riverbend Supply East'), named('2', 'Riverbend Supply West')];
    expect(matchVendor('Riverbend Supply', near)).toEqual({ vendor: null, how: null, others: near });
  });

  it('matches nothing without a name, or with nothing near', () => {
    expect(matchVendor(null, VENDORS)).toEqual({ vendor: null, how: null, others: [] });
    expect(matchVendor('Inc.', VENDORS)).toEqual({ vendor: null, how: null, others: [] });
    expect(matchVendor('Lakeside Insurance Agency', VENDORS)).toEqual({ vendor: null, how: null, others: [] });
  });
});

describe('the due date', () => {
  it("is the bill's date plus the vendor's terms in NetSuite", () => {
    expect(suggestDue('2026-10-20', { name: 'Net 30', days: 30 }, null, true, TODAY)).toEqual({ date: '2026-11-19', text: 'Net 30, their terms in NetSuite.' });
    expect(suggestDue('2026-10-20', { name: 'Net 30', days: 30 }, '2026-11-19', true, TODAY).text).toBe('Net 30, their terms in NetSuite.');
    expect(suggestDue('2026-10-20', { name: 'Due on receipt', days: 0 }, null, true, TODAY).date).toBe('2026-10-20');
  });

  it('says so when the bill prints another date', () => {
    expect(suggestDue('2026-10-20', { name: 'Net 30', days: 30 }, '2026-11-20', true, TODAY))
      .toEqual({ date: '2026-11-19', text: 'Net 30, their terms in NetSuite. The bill itself says Nov 20.' });
  });

  it('is as printed when there are no terms, and empty, for NetSuite to work out, when there is nothing printed', () => {
    expect(suggestDue('2026-10-20', null, '2026-11-05', true, TODAY)).toEqual({ date: '2026-11-05', text: 'As printed on the bill: their vendor in NetSuite has no terms.' });
    expect(suggestDue('2026-10-20', null, '2026-11-05', false, TODAY)).toEqual({ date: '2026-11-05', text: 'As printed on the bill.' });
    expect(suggestDue(null, { name: 'Net 30', days: 30 }, '2026-11-05', true, TODAY).date).toBe('2026-11-05');
    expect(suggestDue('2026-10-20', null, null, true, TODAY))
      .toEqual({ date: null, text: 'Their vendor in NetSuite has no terms and the bill prints no due date. Left empty, NetSuite works it out.' });
    expect(suggestDue('2026-10-20', null, null, false, TODAY)).toEqual({ date: null, text: null });
  });
});

describe("where the vendor's bills keep going", () => {
  it("is the account of each bill's biggest line, when it's the same on each", () => {
    expect(usualAccount(ELEVEN)).toEqual({ accountId: '623', bills: 11, of: 11 });
    const twoLines = earlier(0, { lines: [{ account: '640', memo: 'Late', amount: '5.00' }, { account: '623', memo: 'Service', amount: '-900.00' }] });
    expect(usualAccount([twoLines])).toEqual({ accountId: '623', bills: 1, of: 1 });
  });

  it('is the one on two thirds of their latest twelve, else nothing', () => {
    const mixed = [earlier(0, { total: '1.00', lines: [{ account: '611', memo: null, amount: '1.00' }] }), ...ELEVEN];
    expect(usualAccount(mixed)).toEqual({ accountId: '623', bills: 11, of: 12 });
    const split = [...ELEVEN.slice(0, 6), ...ELEVEN.slice(0, 6).map((b) => ({ ...b, total: '1.00', lines: [{ account: '611', memo: null, amount: '1.00' }] }))];
    expect(usualAccount(split)).toBeNull();
    // Only the latest twelve count, however many older ones went elsewhere.
    const older = [...ELEVEN.slice(0, 8), ...Array.from({ length: 10 }, (_, i) => earlier(i, { total: '1.00', lines: [{ account: '611', memo: null, amount: '1.00' }] }))];
    expect(usualAccount(older)).toEqual({ accountId: '623', bills: 8, of: 12 });
    expect(usualAccount([earlier(0, { lines: [], lines_known: false })])).toBeNull();
    expect(usualAccount([])).toBeNull();
  });

  it("leaves out a bill whose expense lines are under half of it: a PO's bill, its items not in the copy", () => {
    const poBill = earlier(0, { total: '2380.00', lines: [{ account: '655', memo: 'Freight', amount: '-240.00' }] });
    expect(usualAccount([poBill])).toBeNull();
    expect(usualAccount([poBill, ...ELEVEN])).toEqual({ accountId: '623', bills: 11, of: 11 });
    // Half of it is enough.
    expect(usualAccount([earlier(0, { total: '480.00', lines: [{ account: '655', memo: 'Freight', amount: '-240.00' }] })])).toEqual({ accountId: '655', bills: 1, of: 1 });
  });
});

describe("each line's account", () => {
  const ctx = (over: Partial<Parameters<typeof suggestAccounts>[2]> = {}) => ({
    company: 'BMG', vendorKnown: true, vendorDefault: null, usable: (id: string) => !!ACCOUNTS.get(id)?.companies.includes('BMG'), label, ...over,
  });

  it("puts the biggest line where their bills keep going, and asks for the account of one that's new for them", () => {
    expect(suggestAccounts(form().lines, ELEVEN, ctx())).toEqual([
      { accountId: '623', text: 'Their last 11 bills went to 6230 Utilities.' },
      { accountId: null, text: 'New for this vendor, so pick the account.' },
    ]);
    expect(suggestAccounts(form().lines.slice(0, 1), ELEVEN.slice(0, 1), ctx())[0].text).toBe('Their last bill went to 6230 Utilities.');
    const mixed = [earlier(0, { total: '1.00', lines: [{ account: '611', memo: null, amount: '1.00' }] }), ...ELEVEN];
    expect(suggestAccounts(form().lines.slice(0, 1), mixed, ctx())[0].text).toBe('11 of their last 12 bills went to 6230 Utilities.');
    // The biggest line, wherever it is on the bill.
    expect(suggestAccounts([form().lines[1], form().lines[0]], ELEVEN, ctx())).toEqual([
      { accountId: null, text: 'New for this vendor, so pick the account.' },
      { accountId: '623', text: 'Their last 11 bills went to 6230 Utilities.' },
    ]);
  });

  it('puts a line like an earlier one where that one went', () => {
    const withLate = [earlier(0, { lines: [{ account: '623', memo: 'Electric service', amount: '1150.00' }, { account: '640', memo: 'Late payment charge Sep', amount: '9.00' }] }), ...ELEVEN.slice(1)];
    expect(suggestAccounts(form().lines, withLate, ctx())).toEqual([
      { accountId: '623', text: 'Their last 11 bills went to 6230 Utilities.' },
      { accountId: '640', text: 'Like their earlier line "Late payment charge Sep", which went to 6400 Late fees.' },
    ]);
    const long = [earlier(0, { lines: [{ account: '623', memo: 'Electric service', amount: '1150.00' }, { account: '640', memo: `Late payment charge ${'x'.repeat(80)}`, amount: '9.00' }] })];
    const [, late] = suggestAccounts(form().lines, long, ctx());
    expect(late.text).toMatch(/^Like their earlier line "Late payment charge x+…", which went to 6400 Late fees\.$/);
    expect(late.text).toHaveLength('Like their earlier line "", which went to 6400 Late fees.'.length + 58);
    // Half the words the same is like enough.
    const fee = [earlier(0, { lines: [{ account: '623', memo: 'Electric service', amount: '1150.00' }, { account: '640', memo: 'Late payment fee', amount: '9.00' }] })];
    expect(suggestAccounts(form().lines, fee, ctx())[1]).toEqual({ accountId: '640', text: 'Like their earlier line "Late payment fee", which went to 6400 Late fees.' });
  });

  it("asks without a vendor, and for an account the company can't use", () => {
    expect(suggestAccounts(form().lines, ELEVEN, ctx({ vendorKnown: false })).map((s) => s.text))
      .toEqual(Array(2).fill('Pick the account. FleetSuite suggests one once it knows the vendor.'));
    const toLate = ELEVEN.map((b) => ({ ...b, companies: [], total: '1.00', lines: [{ account: '640', memo: 'Service', amount: '1.00' }] }));
    expect(suggestAccounts(form().lines.slice(0, 1), toLate, ctx({ company: '1084', usable: (id) => !!ACCOUNTS.get(id)?.companies.includes('1084') }))[0])
      .toEqual({ accountId: null, text: "Their earlier bills went to 6400 Late fees, which 1084 can't use on a bill, so pick the account." });
  });

  it("uses the vendor's default expense account for a vendor with no bills yet", () => {
    expect(suggestAccounts(form().lines, [], ctx({ vendorDefault: '611' }))).toEqual([
      { accountId: '611', text: 'Their default expense account in NetSuite.' },
      { accountId: null, text: 'No earlier bills from them, so pick the account.' },
    ]);
    expect(suggestAccounts(form().lines.slice(0, 1), [], ctx())[0]).toEqual({ accountId: null, text: 'No earlier bills from them, so pick the account.' });
    // Not once they have bills, even ones that go all over.
    const split = [...ELEVEN.slice(0, 6), ...ELEVEN.slice(0, 6).map((b) => ({ ...b, total: '1.00', lines: [{ account: '611', memo: null, amount: '1.00' }] }))];
    expect(suggestAccounts([{ description: 'Pole rental', cents: 5000 }], split, ctx({ vendorDefault: '640' }))).toEqual([
      { accountId: null, text: 'New for this vendor, so pick the account.' },
    ]);
  });

  it("leaves out their bills booked to the other company", () => {
    const at1084 = ELEVEN.map((b) => ({ ...b, companies: ['1084'] }));
    expect(suggestAccounts(form().lines.slice(0, 1), at1084, ctx())[0]).toEqual({ accountId: null, text: 'No earlier bills from them, so pick the account.' });
  });
});

describe('company and location', () => {
  it("is the company their bills go to, when it's clearly one", () => {
    expect(usualCompany(ELEVEN)).toBe('BMG');
    expect(usualCompany([earlier(0, { companies: ['1084'] }), earlier(1, { companies: ['1084'] }), earlier(2)])).toBe('1084');
    expect(usualCompany([earlier(0, { companies: ['1084'] }), earlier(1)])).toBeNull();
    expect(usualCompany([earlier(0, { companies: ['BMG', '1084'] })])).toBeNull();
  });

  it("is where their bills usually go, else the default, else O'Fallon", () => {
    const atCircle = [earlier(0, { locations: ['7'] }), earlier(1, { locations: ['7'] }), earlier(2)];
    expect(suggestLocation(BMG, atCircle, null)).toEqual({ id: '7', text: 'Where their bills usually go.' });
    expect(suggestLocation(BMG, [], '7')).toEqual({ id: '7', text: null });
    expect(suggestLocation(BMG, [], '9')).toEqual({ id: '1', text: null });
    expect(suggestLocation(OTHER, ELEVEN, null)).toEqual({ id: '9', text: null });
    expect(suggestLocation({ ...BMG, locations: [{ id: '3', name: 'Body shop' }, ...BMG.locations] }, [], null)).toEqual({ id: '1', text: null });
    expect(suggestLocation({ ...BMG, locations: [] }, ELEVEN, null)).toEqual({ id: null, text: null });
    // Their bills booked to the other company don't count.
    const elsewhere = [earlier(0, { companies: ['1084'], locations: ['7'] }), earlier(1, { companies: ['1084'], locations: ['7'] })];
    expect(suggestLocation(BMG, elsewhere, null)).toEqual({ id: '1', text: null });
  });
});

describe('a charge to them for the same amount', () => {
  const doc = (over: Partial<NearbyDoc> = {}): NearbyDoc => ({
    netsuite_id: '9001', type: 'Check', number: '1042', date: '2026-10-22', party: '77', total: '1296.83', voided: false, ...over,
  });

  it('is a bill, check or card charge to the vendor for the amount within a week, nearest first', () => {
    const docs = [
      doc(),
      doc({ netsuite_id: '9002', type: 'CardChrg', date: '2026-10-20' }),
      doc({ netsuite_id: '9003', date: '2026-10-28' }),
      doc({ netsuite_id: '9004', type: 'VendCred' }),
      doc({ netsuite_id: '9005', party: '78' }),
      doc({ netsuite_id: '9006', total: '1296.84' }),
      doc({ netsuite_id: '9007', voided: true }),
      doc({ netsuite_id: '9008', type: 'VendBill', date: '2026-10-13' }),
      doc({ netsuite_id: '9009', type: 'VendBill', date: '2026-10-12' }),
    ];
    expect(nearCharges(docs, '77', 129683, '2026-10-20').map((n) => [n.netsuiteId, n.days])).toEqual([
      ['9002', 0], ['9001', 2], ['9008', 7],
    ]);
  });
});

describe('what the page shows', () => {
  it('shows the drawing: matched, the lines adding up, not in NetSuite yet, and the account still to pick', () => {
    const view = viewSnapForm(form(), facts());
    expect(view.vendor).toEqual({ tone: 'green', text: 'Matched to Riverbend Electric Co-op in NetSuite.', others: [] });
    expect(view.due).toEqual({ date: '2026-11-19', text: 'Net 30, their terms in NetSuite.' });
    expect(view.accounts.map((a) => a.text)).toEqual(['Their last 11 bills went to 6230 Utilities.', 'New for this vendor, so pick the account.']);
    expect(view.notes).toEqual([
      { tone: 'green', text: "The lines add up to $1,296.83, the bill's total." },
      { tone: 'green', text: 'Not in NetSuite yet: no Riverbend Electric Co-op bill 88213-10, and no bill, check or card charge to them for $1,296.83 within a week.' },
      { tone: 'red', text: 'Pick an account for the late payment charge before sending.' },
    ]);
    expect(view.problems).toEqual(['Pick an account for the late payment charge before sending.']);
    expect(view.canSend).toBe(false);
    expect(view.stop).toBeNull();
    expect(view.location).toEqual({ id: '1', text: 'Where their bills usually go.' });
    expect(view.company).toBeNull();
  });

  it('can be sent once every box is filled in', () => {
    const view = viewSnapForm(sendable(), facts());
    expect(view.problems).toEqual([]);
    expect(view.canSend).toBe(true);
  });

  it("stops a bill NetSuite already has from the vendor under that number, with the copy's date and amount", () => {
    const asked = viewSnapForm(sendable(), facts({
      asked: { found: { netsuiteId: '8801', number: '88213-10', date: null, cents: null } },
      history: { bills: ELEVEN, same_number: [{ netsuite_id: '8801', number: '88213-10', date: '2026-10-20', total: '1296.83' }] },
    }));
    expect(asked.stop).toEqual({
      netsuiteId: '8801', number: '88213-10', date: '2026-10-20', cents: 129683, url: 'https://ns.example/VendBill/8801',
      text: "NetSuite already has Riverbend Electric Co-op's bill 88213-10 for $1,296.83, dated Oct 20. Sending this one would enter it twice.",
    });
    expect(asked.canSend).toBe(false);
    expect(asked.problems).toEqual([]);
    // NetSuite found it, and the copy hasn't got it yet.
    expect(viewSnapForm(sendable(), facts({ asked: { found: { netsuiteId: '8805', number: '88213-10', date: null, cents: null } } })).stop?.text)
      .toBe("NetSuite already has Riverbend Electric Co-op's bill 88213-10. Sending this one would enter it twice.");
    // Only the copy has it, typed another way.
    const copied = viewSnapForm(sendable({ billNumber: '8821310' }), facts({
      history: { bills: ELEVEN, same_number: [{ netsuite_id: '8801', number: '88213-10', date: '2025-10-20', total: '99.00' }] },
    }));
    expect(copied.stop?.text).toBe("NetSuite already has Riverbend Electric Co-op's bill 88213-10 for $99.00, dated Oct 20, 2025. Sending this one would enter it twice.");
  });

  it("warns, without stopping, of a bill, check or card charge to them for the same amount within a week", () => {
    const view = viewSnapForm(sendable(), facts({
      nearby: [
        { netsuite_id: '9001', type: 'Check', number: '1042', date: '2026-10-22', party: '77', total: '1296.83', voided: false },
        { netsuite_id: '9002', type: 'VendBill', number: 'R-7', date: '2026-10-20', party: '77', total: '1296.83', voided: false },
      ],
      history: { bills: ELEVEN, same_number: [] },
    }));
    expect(view.notes.filter((n) => n.tone === 'amber')).toEqual([
      {
        tone: 'amber',
        text: 'Riverbend Electric Co-op has a bill (R-7) for $1,296.83 dated Oct 20, the same day. It may be this bill already entered. Check before sending.',
        link: { label: 'The bill in NetSuite', url: 'https://ns.example/VendBill/9002' },
      },
      {
        tone: 'amber',
        text: 'Riverbend Electric Co-op has a check for $1,296.83 dated Oct 22, 2 days after this bill. It may be this bill already entered. Check before sending.',
        link: { label: 'The check in NetSuite', url: 'https://ns.example/Check/9001' },
      },
    ]);
    expect(view.notes.some((n) => n.text.startsWith('Not in NetSuite yet'))).toBe(false);
    expect(view.canSend).toBe(true);
    const noLink = viewSnapForm(sendable(), facts({ link: () => null, nearby: [{ netsuite_id: '9001', type: 'CardChrg', number: null, date: '2026-10-17', party: '77', total: '1296.83', voided: false }] }));
    expect(noLink.notes.find((n) => n.tone === 'amber')).toEqual({
      tone: 'amber',
      text: 'Riverbend Electric Co-op has a card charge for $1,296.83 dated Oct 17, 3 days before this bill. It may be this bill already entered. Check before sending.',
      link: null,
    });
    // Once NetSuite has the bill, the stop says so instead.
    const stopped = viewSnapForm(sendable(), facts({
      nearby: [{ netsuite_id: '9001', type: 'Check', number: '1042', date: '2026-10-22', party: '77', total: '1296.83', voided: false }],
      history: { bills: ELEVEN, same_number: [{ netsuite_id: '8801', number: '88213-10', date: '2026-10-20', total: '1296.83' }] },
    }));
    expect(stopped.stop?.netsuiteId).toBe('8801');
    expect(stopped.notes.filter((n) => n.tone === 'amber')).toEqual([]);
  });

  it("says when NetSuite couldn't be asked, and that Send asks again", () => {
    const view = viewSnapForm(sendable(), facts({ asked: { error: 'NetSuite credentials not configured' } }));
    expect(view.notes).toContainEqual({ tone: 'amber', text: "Couldn't ask NetSuite whether it already has bill 88213-10: NetSuite credentials not configured. Send to NetSuite asks again before it enters anything." });
    expect(view.notes.some((n) => n.text.startsWith('Not in NetSuite yet'))).toBe(false);
    expect(view.canSend).toBe(true);
  });

  it("says what each still-empty or wrong box needs", () => {
    const empty = viewSnapForm({
      company: 'BMG', vendorId: null, vendorName: 'Riverbend', billNumber: ' ', billDate: null, dueDate: null, duePicked: false,
      totalCents: null, locationId: null, lines: [], poNumber: null, howBilled: null, overrideReason: null, extra: null,
    }, facts({ vendor: null, match: null, asked: null, history: NO_HISTORY }));
    expect(empty.problems).toEqual([
      "Pick the vendor from NetSuite's list before sending.",
      'Fill in the bill number.',
      'Fill in the bill date.',
      'Pick a location.',
      "Fill in the bill's total.",
      'Add a line.',
    ]);
    expect(empty.vendor).toEqual({ tone: null, text: null, others: [] });

    const wrong = viewSnapForm(sendable({
      billNumber: 'X'.repeat(BILL_NUMBER_MAX + 1), dueDate: '2026-10-01', locationId: '9', totalCents: 0,
      lines: [
        { description: 'Electric service', cents: null, accountId: '120', picked: true },
        { description: '', cents: 0, accountId: null, picked: false },
        { description: 'AT&T', cents: 5, accountId: null, picked: false },
      ],
    }), facts());
    expect(wrong.problems).toEqual([
      'NetSuite takes a bill number of up to 40 characters.',
      'The due date is before the bill date.',
      "Pick one of BMG's locations.",
      "A bill's total must be more than $0.",
      "Fill in each line's amount.",
      'Pick an account for 2 lines before sending.',
      "12000 Accounts Receivable can't be used on BMG's bills: pick another account for the electric service.",
    ]);
    expect(viewSnapForm(sendable({ lines: [{ description: '', cents: 129683, accountId: null, picked: false }] }), facts()).problems)
      .toEqual(['Pick an account for line 1 before sending.']);
    expect(viewSnapForm(sendable({ lines: [{ description: 'AT&T service', cents: 129683, accountId: null, picked: false }] }), facts()).problems)
      .toEqual(['Pick an account for the AT&T service before sending.']);
    expect(viewSnapForm(sendable({ totalCents: 128433, lines: [sendable().lines[0], { ...sendable().lines[1], cents: 0 }] }), facts()).problems)
      .toEqual(["Fill in each line's amount."]);
  });

  it("says how far the lines are from the bill's total", () => {
    expect(viewSnapForm(sendable({ totalCents: 130000 }), facts()).problems)
      .toEqual(["The lines add up to $1,296.83, $3.17 less than the bill's total of $1,300.00."]);
    expect(viewSnapForm(sendable({ totalCents: 129000 }), facts()).problems)
      .toEqual(["The lines add up to $1,296.83, $6.83 more than the bill's total of $1,290.00."]);
    expect(viewSnapForm(sendable({ totalCents: 129684 }), facts()).problems)
      .toEqual(["The lines add up to $1,296.83, $0.01 less than the bill's total of $1,296.84."]);
  });

  it("notes a bill that says more is due than its own charges", () => {
    const view = viewSnapForm(sendable(), facts({ read: { ...READ, amountDueCents: 251041 } }));
    expect(view.notes).toContainEqual({
      tone: 'amber',
      text: 'The bill says $2,510.41 is due, more than its own charges: it likely carries an earlier balance. Only this bill\'s charges go into NetSuite.',
    });
    expect(view.canSend).toBe(true);
    // Green first, then amber, then red, whatever order they're worked out in.
    expect(viewSnapForm(form(), facts({ read: { ...READ, amountDueCents: 251041 } })).notes.map((n) => n.tone)).toEqual(['green', 'green', 'amber', 'red']);
  });

  it("can't send for a company FleetSuite doesn't know, or one not linked to NetSuite", () => {
    expect(viewSnapForm(sendable({ company: 'ACME' }), facts()).problems[0]).toBe("FleetSuite doesn't know the company ACME.");
    const unlinked = viewSnapForm(sendable({ company: '1084', locationId: null }), facts({ companies: [BMG, { ...OTHER, subsidiaryId: null, locations: [] }] }));
    expect(unlinked.problems[0]).toBe("1084 isn't linked to a NetSuite subsidiary yet, so its bills can't be sent.");
  });

  it("checks a close match, offers the others it could be, and notes when their bills go to the other company", () => {
    const close = viewSnapForm(sendable(), facts({ match: { vendor: RIVERBEND, how: 'close', others: [VENDORS[1]] } }));
    expect(close.vendor).toEqual({ tone: 'amber', text: "Closest in NetSuite: Riverbend Electric Co-op. Check it's the same vendor.", others: [{ id: '78', name: 'Riverside Plumbing LLC' }] });
    const unsure = viewSnapForm(sendable({ vendorId: null }), facts({ vendor: null, match: { vendor: null, how: null, others: [RIVERBEND, VENDORS[1]] } }));
    expect(unsure.vendor).toEqual({ tone: 'amber', text: 'Not sure which vendor in NetSuite this is. Pick one.', others: [{ id: '77', name: 'Riverbend Electric Co-op' }, { id: '78', name: 'Riverside Plumbing LLC' }] });
    expect(viewSnapForm(sendable({ company: '1084', locationId: '9' }), facts()).company).toBe('Their earlier bills went to BMG.');
  });
});

describe('the form FleetSuite fills in', () => {
  it('starts from the read: the vendor, its terms, where their bills go, and the accounts', () => {
    expect(formFromRead(READ, facts())).toEqual({
      company: 'BMG',
      vendorId: '77',
      vendorName: 'Riverbend Electric Co-op',
      billNumber: '88213-10',
      billDate: '2026-10-20',
      dueDate: '2026-11-19',
      duePicked: false,
      totalCents: 129683,
      locationId: '1',
      lines: [
        { description: 'Electric service, Sep 18 to Oct 17', cents: 128433, accountId: '623', picked: false },
        { description: 'Late payment charge', cents: 1250, accountId: null, picked: false },
      ],
      poNumber: null,
      howBilled: null,
      overrideReason: null,
      extra: null,
    });
  });

  it("keeps the name read when there's no vendor, leaves a total it couldn't read empty, and goes to the vendor's usual company", () => {
    const at1084 = ELEVEN.map((b) => ({ ...b, companies: ['1084'], locations: ['9'] }));
    const started = formFromRead({ ...READ, totalCents: null }, facts({ history: { bills: at1084, same_number: [] } }));
    expect(started).toMatchObject({ company: '1084', locationId: '9', totalCents: null });
    // So the lines are checked against the bill, not against themselves.
    expect(viewSnapForm(started, facts({ history: { bills: at1084, same_number: [] } })).problems).toContain("Fill in the bill's total.");
    const unknown = formFromRead({ ...READ, vendorName: 'Lakeside Insurance', lines: [], totalCents: null, dueDate: null },
      facts({ vendor: null, terms: null, history: NO_HISTORY }));
    expect(unknown).toMatchObject({ company: 'BMG', vendorId: null, vendorName: 'Lakeside Insurance', totalCents: null, dueDate: null, locationId: '1', lines: [] });
    // A close match goes by NetSuite's name for them.
    expect(formFromRead({ ...READ, vendorName: 'Riverbend Electric Cooperative' }, facts()).vendorName).toBe('Riverbend Electric Co-op');
  });

  it('follows the vendor, lines and company with its suggestions, but never replaces what someone chose', () => {
    const chosen = form({
      company: '1084', locationId: '1', dueDate: '2026-12-01', duePicked: true,
      lines: [{ ...form().lines[0], accountId: '623', picked: true }, { ...form().lines[1], accountId: '640', picked: false }],
    });
    expect(settleForm(chosen, facts())).toEqual({
      ...chosen,
      // O'Fallon is BMG's: the company was just switched.
      locationId: '9',
      lines: [chosen.lines[0], { ...chosen.lines[1], accountId: null }],
    });
    expect(settleForm(form({ dueDate: null }), facts()).dueDate).toBe('2026-11-19');
    expect(settleForm(form({ billDate: '2026-10-01' }), facts()).dueDate).toBe('2026-10-31');
    // An unknown company is left for the red note to name.
    expect(settleForm(form({ company: 'ACME', locationId: '1' }), facts()).locationId).toBe('1');
  });
});

// ── A bill for a PO: a made-up parts bill, two racks' worth of parts and the freight on them ──

const ACME: SnapVendor = { id: '412', name: 'Acme Truck Racks', entityId: null, termsId: null, expenseAccountId: '611' };
const PO_ACCOUNTS = new Map<string, SnapAccount>([
  ...ACCOUNTS,
  account('655', '6550', 'Freight in', ['BMG']),
  account('656', '6560', 'Freight out', ['1084']),
  account('130', '13000', 'Inventory', ['BMG'], 'other_current_asset'),
]);
/** One of Acme's earlier bills: the parts to inventory, the freight to freight in. */
const acmeBill = (i: number): HistoryBill => earlier(i, {
  number: `INV-55${10 + i}`,
  total: '2380.00',
  lines: [
    { account: '130', memo: 'Contractor rack, 8 ft bed', amount: '1940.00' },
    { account: '130', memo: 'Street side clamp kit', amount: '200.00' },
    { account: '655', memo: 'Freight', amount: '240.00' },
  ],
});
const PO_ROWS: PoLineRow[] = [
  { line_id: '1', item_netsuite_id: '1201', item_number: 'RACK-48', description: 'Contractor rack, 8 ft bed', quantity: '4', quantity_received: '4', quantity_billed: '0', rate: '485', amount: '1940.00' },
  { line_id: '2', item_netsuite_id: '1388', item_number: 'CLAMP-ACX', description: 'Street side clamp kit', quantity: '4', quantity_received: '4', quantity_billed: '0', rate: '50', amount: '200.00' },
];
const PO453: SnapPo = {
  copyId: 'po-1', netsuiteId: '45310', number: 'PO453-ACME', vendorId: '412', vendorName: 'Acme Truck Racks', date: '2026-10-14',
  status: 'F', statusLabel: 'Purchase Order : Pending Bill', totalCents: 214000,
  facts: {
    poTranid: 'PO453-ACME', poTotal: 2140, poIsOpen: true, poStatusLabel: 'Pending Bill',
    lines: [{ itemNumber: 'RACK-48', ordered: 4, received: 4 }, { itemNumber: 'CLAMP-ACX', ordered: 4, received: 4 }],
    priorBills: [], earlierBills: [], billedUnits: 0, rows: PO_ROWS,
  },
};
const ACME_READ: BillRead = {
  isBill: true, vendorName: 'Acme Truck Racks', billNumber: 'INV-5531', billDate: '2026-10-20', dueDate: null, terms: null,
  lines: [
    { description: 'RACK-48 Contractor rack, 8 ft bed', cents: 194000 },
    { description: 'CLAMP-ACX Street side clamp kit', cents: 20000 },
    { description: 'Freight', cents: 24000 },
  ],
  totalCents: 238000, amountDueCents: 238000, poNumber: 'PO453-ACME',
};
const poFacts = (over: Partial<SnapFacts> = {}): SnapFacts => facts({
  accounts: PO_ACCOUNTS, vendor: ACME, match: { vendor: ACME, how: 'exact', others: [] }, terms: null,
  history: { bills: [acmeBill(0), acmeBill(1)], same_number: [] }, read: ACME_READ, po: { found: PO453, open: [] },
  ...over,
});
const FREIGHT = { description: 'Freight', accountId: '655', picked: false, leftOff: false };
const poForm = (over: Partial<SnapForm> = {}): SnapForm => ({
  company: 'BMG', vendorId: '412', vendorName: 'Acme Truck Racks', billNumber: 'INV-5531', billDate: '2026-10-20', dueDate: null,
  duePicked: false, totalCents: 238000, locationId: null,
  lines: ACME_READ.lines.map((l) => ({ description: l.description, cents: l.cents, accountId: null, picked: false })),
  poNumber: 'PO453-ACME', howBilled: null, overrideReason: null, extra: FREIGHT,
  ...over,
});
const WHY = 'Freight is on the bill, not the PO';

describe('a bill for a PO', () => {
  it("starts from the read as BMG's, the freight its own line, named from the bill and put where their freight goes", () => {
    expect(formFromRead(ACME_READ, poFacts())).toMatchObject({ company: 'BMG', poNumber: 'PO453-ACME', howBilled: null, overrideReason: null, extra: FREIGHT });
    // The PO's bill is BMG's, whatever the vendor's usual company.
    const at1084 = { bills: [acmeBill(0), acmeBill(1)].map((b) => ({ ...b, companies: ['1084'] })), same_number: [] };
    expect(formFromRead(ACME_READ, poFacts({ history: at1084 })).company).toBe('BMG');
    // No extra line for a bill that's the PO's total, and none when there's no PO.
    expect(formFromRead({ ...ACME_READ, totalCents: 214000, lines: ACME_READ.lines.slice(0, 2) }, poFacts()).extra).toBeNull();
    expect(formFromRead(ACME_READ, poFacts({ po: { found: null, open: [] } })).extra).toBeNull();
  });

  it("suggests the extra line's account only from a line like it on their earlier bills, never where their parts go", () => {
    expect(suggestExtraAccount('Freight', 24000, poFacts())).toEqual({ accountId: '655', text: 'Like their earlier line "Freight", which went to 6550 Freight in.' });
    expect(suggestExtraAccount('Liftgate', 24000, poFacts())).toEqual({ accountId: null, text: 'New for this vendor, so pick the account.' });
    expect(suggestExtraAccount('', 24000, poFacts())).toMatchObject({ accountId: null });
    // Their freight went where BMG can't put it: pick another.
    const elsewhere = { bills: [{ ...acmeBill(0), lines: [{ account: '656', memo: 'Freight', amount: '240.00' }] }], same_number: [] };
    expect(suggestExtraAccount('Freight', 24000, poFacts({ history: elsewhere })).accountId).toBeNull();
    // A vendor with no bills yet gets no default for it: it's what the PO left out, not what they sell.
    expect(suggestExtraAccount('Freight', 24000, poFacts({ history: NO_HISTORY }))).toEqual({ accountId: null, text: 'No earlier bills from them, so pick the account.' });
    // The plain lines still go where their bills keep going.
    expect(suggestAccounts([{ description: 'Liftgate', cents: 24000 }], [acmeBill(0), acmeBill(1)], {
      company: 'BMG', vendorKnown: true, vendorDefault: null, usable: () => true, label: (id) => id,
    })[0].accountId).toBe('130');
  });

  it("bills the PO and its freight with one tap: the PO's lines, not the bill's, and no location to pick", () => {
    const v = viewSnapForm(poForm(), poFacts());
    expect(v.po).toMatchObject({ billing: true, number: 'PO453-ACME', extraCents: 24000, billsCents: 238000, verdict: 'green', needsReason: false });
    expect(v.extra).toEqual({ accountId: '655', text: 'Like their earlier line "Freight", which went to 6550 Freight in.' });
    expect(v).toMatchObject({ problems: [], canSend: true });
    expect(v.notes.some((n) => n.text.startsWith('The lines add up'))).toBe(false);
    // A bill for the PO's total needs no reason and has no extra line.
    const exact = viewSnapForm(poForm({ totalCents: 214000, lines: poForm().lines.slice(0, 2), extra: null }), poFacts());
    expect(exact).toMatchObject({ extra: null, problems: [], canSend: true });
    expect(exact.po).toMatchObject({ needsReason: false, extraCents: 0, verdict: 'green' });
  });

  it("bills the PO once the reason is in, when the bill's lines don't say what's beyond it or it's left off", () => {
    const lumped = { lines: [{ description: 'Racks, clamps and freight', cents: 238000, accountId: null, picked: false }] };
    expect(viewSnapForm(poForm(lumped), poFacts()).problems).toEqual(['Say why PO453-ACME is billed anyway, or enter it as a plain bill.']);
    expect(viewSnapForm(poForm({ ...lumped, overrideReason: WHY }), poFacts())).toMatchObject({ problems: [], canSend: true });
    expect(viewSnapForm(poForm({ ...lumped, overrideReason: '   ' }), poFacts()).canSend).toBe(false);
    expect(viewSnapForm(poForm({ extra: { ...FREIGHT, leftOff: true } }), poFacts()).problems).toEqual(['Say why PO453-ACME is billed anyway, or enter it as a plain bill.']);
  });

  it("asks for the extra line's account, one BMG can use, and nothing for a line left off", () => {
    const noAccount = viewSnapForm(poForm({ extra: { ...FREIGHT, accountId: null } }), poFacts());
    expect(noAccount.problems).toEqual(['Pick an account for the freight before sending.']);
    expect(viewSnapForm(poForm({ extra: null }), poFacts()).problems).toEqual(['Pick an account for the line not on the PO before sending.']);
    expect(viewSnapForm(poForm({ extra: { ...FREIGHT, accountId: '656', picked: true } }), poFacts()).problems)
      .toEqual(["6560 Freight out can't be used on BMG's bills: pick another account for the freight."]);
    const leftOff = viewSnapForm(poForm({ overrideReason: WHY, extra: { ...FREIGHT, accountId: null, leftOff: true } }), poFacts());
    expect(leftOff).toMatchObject({ extra: null, problems: [], canSend: true });
    expect(leftOff.po).toMatchObject({ overCents: 24000, extraCents: 0, billsCents: 214000 });
  });

  it("keeps a PO's bill BMG's, and checks a plain one as any other bill", () => {
    expect(viewSnapForm(poForm({ company: '1084' }), poFacts()).problems)
      .toEqual(["A PO's bill is BMG's. To enter it for 1084, make it a plain bill."]);
    const plain = viewSnapForm(poForm({ howBilled: 'plain' }), poFacts());
    expect(plain.po).toMatchObject({ billing: false, canBill: true });
    expect(plain.extra).toBeNull();
    expect(plain.problems).toEqual(['Pick a location.', 'Pick an account for 3 lines before sending.']);
    expect(plain.notes[0]).toEqual({ tone: 'green', text: "The lines add up to $2,380.00, the bill's total." });
  });

  it("offers the PO's vendor while the form has none", () => {
    const v = viewSnapForm(poForm({ vendorId: null }), poFacts({ vendor: null, match: null }));
    expect(v.vendor).toEqual({ tone: 'amber', text: 'Not sure which vendor in NetSuite this is. Pick one.', others: [{ id: '412', name: 'Acme Truck Racks' }] });
    expect(v.po).toMatchObject({ billing: false, text: "PO453-ACME is Acme Truck Racks's PO. Pick the vendor to bill it." });
    // Not twice, when the read's match offers them too.
    const offered = viewSnapForm(poForm({ vendorId: null }), poFacts({ vendor: null, match: { vendor: null, how: null, others: [ACME, RIVERBEND] } }));
    expect(offered.vendor.others).toEqual([{ id: '412', name: 'Acme Truck Racks' }, { id: '77', name: 'Riverbend Electric Co-op' }]);
  });

  it('settles a PO bill: BMG, the extra line worked out once, and never what someone chose', () => {
    expect(settleForm(poForm({ company: '1084', extra: null }), poFacts())).toMatchObject({ company: 'BMG', extra: FREIGHT });
    // What someone typed for it is kept, its account suggested from that.
    expect(settleForm(poForm({ extra: { ...FREIGHT, description: 'Liftgate' } }), poFacts()).extra).toEqual({ ...FREIGHT, description: 'Liftgate', accountId: null });
    const picked = { ...FREIGHT, accountId: '611', picked: true };
    expect(settleForm(poForm({ extra: picked }), poFacts()).extra).toEqual(picked);
    const leftOff = { ...FREIGHT, leftOff: true };
    expect(settleForm(poForm({ extra: leftOff }), poFacts()).extra).toEqual(leftOff);
    // Added back, it's suggested again.
    expect(settleForm(poForm({ extra: { ...FREIGHT, accountId: null } }), poFacts()).extra).toEqual(FREIGHT);
    // The bill's lines don't say what it is: it's to be named.
    expect(settleForm(poForm({ extra: null, lines: [{ description: 'Racks and freight', cents: 238000, accountId: null, picked: false }] }), poFacts()).extra)
      .toEqual({ description: '', accountId: null, picked: false, leftOff: false });
    // A plain bill keeps its company, and gets no extra line.
    expect(settleForm(poForm({ howBilled: 'plain', company: '1084', locationId: '9', extra: null }), poFacts())).toMatchObject({ company: '1084', extra: null });
  });
});

describe('the saved row', () => {
  const row = (over: Partial<SnappedBillRow> = {}): SnappedBillRow => ({
    id: 'snap-1', company_id: 'c-bmg', file_path: '0b9e3c1a-5d2f-4e8b-9a71-3c6d2f1e8b40.jpg', file_type: 'image/jpeg', file_name: 'IMG_1042.jpg',
    read_result: null, read_at: null, read_error: null, vendor_netsuite_id: '77', vendor_name: 'Riverbend Electric Co-op', bill_number: '88213-10',
    bill_date: '2026-10-20', due_date: '2026-11-19', total: '1296.83', location_netsuite_id: '1',
    lines: [
      { description: 'Electric service, Sep 18 to Oct 17', amount: '1284.33', account_netsuite_id: '623', picked: false },
      { description: 'Late payment charge', amount: '12.50', account_netsuite_id: null, picked: true },
    ],
    due_picked: false, status: 'draft', bill_claimed_at: null, send_error: null, netsuite_id: null, netsuite_number: null, sent_at: null,
    sent_by: null, thrown_away_at: null, thrown_away_by: null, made_by: 'u-1', made_at: '2026-10-25T05:00:00Z', saved_at: '2026-10-25T05:00:00Z',
    po_number: null, how_billed: null, override_reason: null, extra_line: null, billed_po_netsuite_id: null, billed_po_number: null,
    billed_extra: null,
    ...over,
  });

  it('holds the form, and is saved back as it was read', () => {
    const f = formOfRow(row(), [BMG, OTHER]);
    expect(f).toEqual(form({ lines: [form().lines[0], { ...form().lines[1], picked: true }] }));
    expect(rowOfForm(f, 'c-bmg')).toEqual({
      company_id: 'c-bmg', vendor_netsuite_id: '77', vendor_name: 'Riverbend Electric Co-op', bill_number: '88213-10', bill_date: '2026-10-20',
      due_date: '2026-11-19', due_picked: false, total: '1296.83', location_netsuite_id: '1', lines: row().lines,
      po_number: null, how_billed: null, override_reason: null, extra_line: null,
    });
    expect(formOfRow(row({ company_id: 'c-1084', total: 12.5, lines: null }), [BMG, OTHER])).toMatchObject({ company: '1084', totalCents: 1250, lines: [] });
    expect(rowOfForm(form({ totalCents: 129680 }), 'c-bmg').total).toBe('1296.80');
  });

  it("holds a PO bill's PO, how it's billed, the reason, and the extra line", () => {
    const po = row({
      po_number: 'PO453-ACME', how_billed: 'po', override_reason: WHY,
      extra_line: { description: 'Freight', account_netsuite_id: '655', picked: true, left_off: false },
    });
    const f = formOfRow(po, [BMG, OTHER]);
    expect(f).toMatchObject({ poNumber: 'PO453-ACME', howBilled: 'po', overrideReason: WHY, extra: { ...FREIGHT, picked: true } });
    expect(rowOfForm(f, 'c-bmg')).toMatchObject({
      po_number: 'PO453-ACME', how_billed: 'po', override_reason: WHY,
      extra_line: { description: 'Freight', account_netsuite_id: '655', picked: true, left_off: false },
    });
    expect(rowOfForm(form({ poNumber: '  ', overrideReason: ` ${WHY} `, extra: { ...FREIGHT, description: ' Freight ' } }), 'c-bmg')).toMatchObject({
      po_number: null, override_reason: WHY, extra_line: { description: 'Freight' },
    });
    expect(formOfRow(row({ how_billed: 'maybe' }), [BMG]).howBilled).toBeNull();
  });

  it('keeps an extra line only when it is one, and nothing that is not a NetSuite id as its account', () => {
    expect(extraOf(null)).toBeNull();
    expect(extraOf('Freight')).toBeNull();
    expect(extraOf([{ description: 'Freight' }])).toBeNull();
    expect(extraOf({ description: 5, account_netsuite_id: 'Freight in', picked: 'yes', left_off: 1 })).toEqual({ description: '', accountId: null, picked: false, leftOff: false });
    expect(extraOf({ description: 'Freight', account_netsuite_id: '655', left_off: true })).toEqual({ description: 'Freight', accountId: '655', picked: false, leftOff: true });
  });

  it('keeps nothing blank as a value, and nothing that is not a NetSuite id as an account', () => {
    expect(formOfRow(row({ lines: [{ description: 7, amount: null, account_netsuite_id: 'Utilities', picked: 'yes' }] }), [BMG]).lines)
      .toEqual([{ description: '', cents: null, accountId: null, picked: false }]);
    expect(rowOfForm(form({ vendorName: '  ', billNumber: ' 88213-10 ', totalCents: null, lines: [{ description: ' Late ', cents: null, accountId: null, picked: false }] }), 'c-bmg'))
      .toMatchObject({ vendor_name: null, bill_number: '88213-10', total: null, lines: [{ description: 'Late', amount: null, account_netsuite_id: null, picked: false }] });
  });

  it('keeps the read with the vendor it matched, and reads it back only when it is one', () => {
    const stored = storedReadOf(READ, { vendor: RIVERBEND, how: 'close', others: [VENDORS[1]] });
    expect(stored).toEqual({ read: READ, match: { vendorId: '77', how: 'close', others: [{ id: '78', name: 'Riverside Plumbing LLC' }] } });
    expect(storedReadFrom(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    // One kept before migration 444 has no PO number.
    const { poNumber: _none, ...before444 } = READ;
    expect(storedReadFrom({ ...stored, read: before444 })?.read).toEqual(READ);
    expect(storedReadFrom({ ...stored, read: { ...READ, poNumber: 453 } })?.read.poNumber).toBeNull();
    expect(storedReadFrom(storedReadOf(ACME_READ, { vendor: ACME, how: 'exact', others: [] }))?.read.poNumber).toBe('PO453-ACME');
    expect(storedReadFrom(null)).toBeNull();
    expect(storedReadFrom({ read: { lines: 'x' }, match: {} })).toBeNull();
    expect(storedReadFrom({ read: READ, match: { vendorId: 77, how: 'maybe', others: [{ id: 1 }, { id: '78', name: 'Riverside' }] } }))
      .toEqual({ read: READ, match: { vendorId: null, how: null, others: [{ id: '78', name: 'Riverside' }] } });
  });

  it("says how the form's vendor was found", () => {
    const stored = storedReadOf(READ, { vendor: RIVERBEND, how: 'close', others: [VENDORS[1]] });
    expect(matchFor('77', RIVERBEND, stored)).toEqual({ vendor: RIVERBEND, how: 'close', others: [{ id: '78', name: 'Riverside Plumbing LLC', entityId: null, termsId: null, expenseAccountId: null }] });
    expect(matchFor('78', VENDORS[1], stored)).toEqual({ vendor: VENDORS[1], how: 'exact', others: [] });
    expect(matchFor(null, null, stored)).toMatchObject({ vendor: null, how: null, others: [{ id: '78' }] });
    expect(matchFor('77', RIVERBEND, storedReadOf(READ, { vendor: RIVERBEND, how: 'exact', others: [] }))).toEqual({ vendor: RIVERBEND, how: 'exact', others: [] });
    expect(matchFor('77', RIVERBEND, null)).toEqual({ vendor: RIVERBEND, how: 'exact', others: [] });
    expect(matchFor(null, null, null)).toBeNull();
  });
});

describe('marking it sent', () => {
  const KEPT: SameBill = { netsuiteId: '8803', number: '88213-10', date: null, cents: null };

  it("is only for a bill whose Send didn't finish: one that failed, or kept its claim", () => {
    expect(sendUnfinished({ send_error: null, bill_claimed_at: null })).toBe(false);
    expect(sendUnfinished({ send_error: 'NetSuite error (502): Bad gateway', bill_claimed_at: null })).toBe(true);
    expect(sendUnfinished({ send_error: null, bill_claimed_at: '2026-10-25T05:00:00Z' })).toBe(true);
    expect(billToMarkSent(false, { problems: [] }, { found: KEPT }, '88213-10')).toEqual({ error: "Only a bill whose Send didn't finish can be marked sent." });
  });

  it('keeps it as the bill NetSuite itself names, once nothing is left in red', () => {
    const view = viewSnapForm(sendable(), facts({ asked: { found: KEPT } }));
    expect(view.stop?.netsuiteId).toBe('8803');
    expect(billToMarkSent(true, view, { found: KEPT }, '88213-10')).toEqual({ bill: KEPT });
    expect(billToMarkSent(true, { problems: ['Fill in the bill date.'] }, { found: KEPT }, '88213-10')).toEqual({ error: 'Fill in the bill date.' });
  });

  it("marks nothing when NetSuite has no such bill, or can't be asked", () => {
    expect(billToMarkSent(true, { problems: [] }, { found: null }, '88213-10')).toEqual({ error: 'NetSuite has no bill 88213-10 from them, so nothing was marked sent.' });
    expect(billToMarkSent(true, { problems: [] }, { error: 'NetSuite credentials not configured' }, '88213-10'))
      .toEqual({ error: "Couldn't ask NetSuite for it (NetSuite credentials not configured), so nothing was marked sent." });
  });
});

describe("NetSuite's refusal, as the page says it", () => {
  it("is NetSuite's own words, without the body FleetSuite sent", () => {
    const sent = ' | sent: {"entity":{"id":"77"}}';
    expect(plainSendError(`NetSuite error (400): {"type":"x","o:errorDetails":[{"detail":"Invalid value for the field \\"account\\".","o:errorCode":"INVALID_VALUE"}]}${sent}`))
      .toBe('NetSuite didn\'t take the bill: Invalid value for the field "account".');
    expect(plainSendError(`NetSuite error (400): {"detail":"Please enter value(s) for: Currency"} — NetSuite won't accept a currency for vendor 77. Open that vendor in NetSuite.${sent}`))
      .toBe("NetSuite didn't take the bill: Please enter value(s) for: Currency — NetSuite won't accept a currency for vendor 77. Open that vendor in NetSuite.");
    expect(plainSendError(`NetSuite error (502): Bad gateway${sent}`)).toBe('NetSuite error (502): Bad gateway');
    // FleetSuite's own words pass through.
    expect(plainSendError('A bill for this is already being made, or was just made. Wait a moment and refresh.'))
      .toBe('A bill for this is already being made, or was just made. Wait a moment and refresh.');
    expect(plainSendError(`Couldn't ask NetSuite whether it already has bill 1, so nothing was billed. Try again. ("detail":"x")`)).toMatch(/^Couldn't ask/);
    expect(plainSendError('x'.repeat(700))).toHaveLength(600);
  });
});

/** Just enough of the service client for a read: each table answers its rows, filtered by eq. */
function fakeService(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let page: [number, number] | null = null;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        not: () => q,
        is: () => q,
        order: () => q,
        range: (from: number, to: number) => { page = [from, to]; return q; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: page ? rows().slice(page[0], page[1] + 1) : rows(), error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe('reading what the rules read', () => {
  it('lets a line go only to an active, posting account of a kind a bill can be for, in the companies its subsidiaries allow', async () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      netsuite_account_id: id, number: id, name: `Account ${id}`, account_type: 'expense', company_id: null, netsuite_subsidiary_ids: null,
      active: true, is_summary: false, ...over,
    });
    const service = fakeService({
      gl_accounts: [
        row('1'),
        row('2', { netsuite_subsidiary_ids: ['5'] }),
        row('3', { company_id: 'c-bmg' }),
        row('4', { active: false }),
        row('5', { is_summary: true }),
        row('6', { account_type: 'bank' }),
        row('7', { account_type: 'fixed_asset' }),
      ],
    });
    const accounts = await readAccounts(service, [BMG, OTHER, { ...OTHER, id: 'c-x', code: 'X', subsidiaryId: null }]);
    expect([...accounts.values()].map((a) => [a.id, a.companies])).toEqual([
      ['1', ['BMG', '1084']], ['2', ['1084']], ['3', ['BMG']], ['4', []], ['5', []], ['6', []], ['7', ['BMG', '1084']],
    ]);
  });

  it("reads a vendor's terms as their name and days, and nothing without days", async () => {
    const service = fakeService({
      gl_netsuite_lists: [
        { kind: 'term', netsuite_id: '3', name: 'Net 30', details: { days_until_net_due: '30' } },
        { kind: 'term', netsuite_id: '4', name: '2% 10 Net 30', details: {} },
      ],
    });
    expect(await readTerms(service, '3')).toEqual({ name: 'Net 30', days: 30 });
    expect(await readTerms(service, '4')).toBeNull();
    expect(await readTerms(service, '9')).toBeNull();
    expect(await readTerms(service, null)).toBeNull();
  });
});
