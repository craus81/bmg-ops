import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChartAccount } from './invoice-check';
import { workOutBillMonth, type BillMonthData } from './bill-check';
import type { BillPairsData, NetsuiteBillData, OwnBillCheck, OwnBillData } from './own-bill-check';
import { BILL_BOOKS, OWN_BILL_RULE, ownBillLines, ownBillPick, readOwnBillCopies, readOwnBillSince, type OwnBillCopy } from './own-bill-posting';
import { chartNames } from './own-stock-posting';

// Made-up books: '200' and '201' payables, '611' and '612' expenses, '210' holds received stock until it's billed, '190' inventory.
const chartAccount = (id: string, number: string, name: string, type: string, company: string | null = null): ChartAccount => ({
  netsuite_account_id: id, number, name, account_type: type, company, active: true, is_summary: false,
});
const CHART: ChartAccount[] = [
  chartAccount('200', '20000', 'Accounts Payable', 'accounts_payable'),
  chartAccount('611', '61100', 'Subcontractors', 'expense'),
  chartAccount('612', '61200', 'Repairs', 'expense'),
  chartAccount('210', '21000', 'Received Not Billed', 'other_current_liability'),
  chartAccount('190', '19000', 'Inventory Asset', 'other_current_asset'),
];
const NAMES = chartNames(CHART);

const RACK = '9001';
const BIN = '9002';
const MADE_AT = '2026-10-21T15:00:00.000Z';

type MonthBill = BillMonthData['bills'][number];
type MonthLine = NonNullable<MonthBill['lines']>[number];
/** NetSuite's GL lines for a bill, debit positive. */
const gl = (...lines: Array<[string, string, number]>) => lines.map(([lineId, account, cents]) => ({
  line_id: lineId, account, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
}));
const nsLine = (lineId: string, item: string | null, account: string | null, amount: string, over: Partial<MonthLine> = {}): MonthLine => ({
  line_id: lineId, item, account, amount, quantity: null, memo: null, tax: false, ...over,
});

/** NetSuite's bill VI-1042 from a CNI vendor invoice: one line to Subcontractors. */
const monthBill = (over: Partial<MonthBill> = {}): MonthBill => ({
  netsuite_id: '8801', type: 'VendBill', number: 'VI-1042', date: '2026-10-21', posting_month: '2026-10-01', total: '1250.00', voided: false,
  status: 'Open', vendor: 'Northside Install Co.', vendor_netsuite_id: '412', vendor_payables: null, companies: ['BMG'],
  lines: [nsLine('1', null, '611', '1250.00', { memo: 'Install' })],
  links: [],
  netsuite: gl(['0', '200', -125000], ['1', '611', 125000]),
  ...over,
});

/** NetSuite's bill INV-5521 from PO453-ACME: 12 racks and 3 bins, held against 21000 until billed. */
const poBill = (over: Partial<MonthBill> = {}): MonthBill => monthBill({
  netsuite_id: '8802', number: 'INV-5521', total: '2199.97', vendor: 'Acme Truck Racks', vendor_netsuite_id: '77',
  lines: [nsLine('1', RACK, null, '2140.00', { quantity: '12' }), nsLine('2', BIN, null, '59.97', { quantity: '3' })],
  links: [{ netsuite_id: '5001', type: 'PurchOrd', number: 'PO453-ACME', amount: '2199.97' }],
  netsuite: gl(['0', '200', -219997], ['1', '210', 214000], ['2', '210', 5997]),
  ...over,
});

const ITEMS: BillMonthData['items'] = [
  { netsuite_id: RACK, name: 'RACK-48', item_type: 'InvtPart', asset_account: '190', expense_account: null, income_account: null },
  { netsuite_id: BIN, name: 'BIN-10', item_type: 'InvtPart', asset_account: '190', expense_account: null, income_account: null },
];

/** The bill as the bill rule works it out for the month's posting run. */
const worked = (bill: MonthBill, opts: { chart?: ChartAccount[]; company?: string } = {}) => workOutBillMonth(
  { bills: [bill], items: ITEMS, receipt_accounts: [{ account: '210', documents: 12 }], not_copied: [] },
  { company: opts.company ?? 'BMG', chart: opts.chart ?? CHART },
).bills[0];

type OwnLine = OwnBillData['lines'][number];
const ownLine = (lineNo: number, over: Partial<OwnLine> = {}): OwnLine => ({
  line_no: lineNo, account_id: '611', item_id: null, item_number: null, description: 'Install', quantity: null, rate: null, amount: '1250.00',
  po_line_id: null, ...over,
});

/** Books' own copy of VI-1042, billing what NetSuite's does. */
const own = (over: Partial<OwnBillData> = {}): OwnBillData => ({
  netsuite_id: '8801', number: 'VI-1042', company: 'BMG', made_from: 'vendor_invoice', made_from_id: 'inv-1', vendor_id: '412',
  vendor_name: 'Northside Install Co.', reference_no: 'VI-1042', date: '2026-10-21', po_id: null, po_number: null, location_id: '1',
  invoice_total: null, unknowns: [], made_at: MADE_AT, lines: [ownLine(1)], ...over,
});

/** Books' own copy of INV-5521, made by Parts Mail from the PO. */
const poOwn = (over: Partial<OwnBillData> = {}): OwnBillData => own({
  netsuite_id: '8802', number: 'INV-5521', made_from: 'parts_mail', made_from_id: 'parts-1', vendor_id: '77', vendor_name: 'Acme Truck Racks',
  reference_no: 'INV-5521', po_id: '5001', po_number: 'PO453-ACME', location_id: null, invoice_total: '2199.97',
  lines: [
    ownLine(1, { account_id: null, item_id: RACK, item_number: 'RACK-48', description: 'Ladder rack', quantity: '12.0000', rate: '178.3333', amount: '2140.00', po_line_id: '2' }),
    ownLine(2, { account_id: null, item_id: BIN, item_number: 'BIN-10', description: null, quantity: '3.0000', rate: '19.9900', amount: '59.97', po_line_id: '3' }),
  ],
  ...over,
});

/** A copy as Own bills checked it: only its status, and what it didn't know, matter here. */
const copy = (data: OwnBillData = own(), status = 'matches', more: { unknowns?: string[]; summary?: string } = {}): OwnBillCopy => ({
  own: data, check: { status, unknowns: more.unknowns ?? [], summary: more.summary ?? '' } as unknown as OwnBillCheck,
});

/** What the books post for a bill, given Books' copy of it. */
const pick = (c: OwnBillCopy | undefined = copy(), bill: MonthBill = monthBill(), opts: { chart?: ChartAccount[]; company?: string } = {}) =>
  ownBillPick(worked(bill, opts), c, { company: opts.company ?? 'BMG', names: opts.chart ? chartNames(opts.chart) : NAMES });

const PAYABLES = (cents: number, account = '200') => ({ account, cents: -cents, lineId: 'payables', itemNumber: null, division: null, role: 'payables' });
const INSTALL = { account: '611', cents: 125000, lineId: 'own:1', itemNumber: null, division: null, role: 'expense' };
const NOTHING = { entry: null, why: null, own: null, differs: null };
const DIFFERS = "FleetSuite's own copy matches NetSuite's bill, but its entry doesn't match NetSuite's, so the books post NetSuite's: ";
const CANT = "FleetSuite's own copy matches NetSuite's bill, but its entry can't be worked out, so the books post NetSuite's. ";

describe("the copy's lines", () => {
  it('are its own, by line number, each from its purchase order line when it has one', () => {
    expect(ownBillLines(poOwn({ lines: [...poOwn().lines, ownLine(3, { amount: null }), ownLine(4, { amount: '0.00' })] }))).toEqual([
      { lineId: 'own:1', itemId: RACK, account: null, cents: 214000, tax: false, ordered: true },
      { lineId: 'own:2', itemId: BIN, account: null, cents: 5997, tax: false, ordered: true },
      { lineId: 'own:3', itemId: null, account: '611', cents: null, tax: false, ordered: null },
      { lineId: 'own:4', itemId: null, account: '611', cents: 0, tax: false, ordered: null },
    ]);
    expect(ownBillLines(own({ lines: null as unknown as OwnLine[] }))).toEqual([]);
    expect(BILL_BOOKS).toEqual({ fn: 'gl_bill_postings', list: 'bills', sourceType: 'vendor_bill', ownRule: OWN_BILL_RULE });
    expect(OWN_BILL_RULE).toBe('own_bill@1');
  });
});

describe('what the books post for a bill FleetSuite made', () => {
  it("posts the copy's entry when it moves each account as NetSuite's does, for the same vendor and on the same day", () => {
    const entry = { lines: [PAYABLES(125000), INSTALL], date: '2026-10-21', vendorRef: '412' };
    expect(pick()).toEqual({ entry, why: null, own: entry, differs: null });
  });

  it("holds stock from a purchase order against where NetSuite holds it, as NetSuite's bill does", () => {
    const entry = pick(copy(poOwn()), poBill())?.entry;
    expect(entry?.lines).toEqual([
      PAYABLES(219997),
      { account: '210', cents: 214000, lineId: 'own:1', itemNumber: 'RACK-48', division: null, role: 'received' },
      { account: '210', cents: 5997, lineId: 'own:2', itemNumber: 'BIN-10', division: null, role: 'received' },
    ]);
    expect(entry?.vendorRef).toBe('77');
    // Its lines not tied to the order's one by one: the bill's purchase order says.
    const untied = poOwn({ lines: poOwn().lines.map((l) => ({ ...l, po_line_id: null })) });
    expect(pick(copy(untied), poBill())?.entry?.lines.map((l) => l.account)).toEqual(['200', '210', '210']);
    // Without one, stock goes onto its asset account, which isn't where NetSuite's went.
    expect(pick(copy(poOwn({ lines: untied.lines, po_id: null })), poBill())?.differs).toBe('it posts differently to 19000 Inventory Asset and 21000 Received Not Billed');
  });

  it("takes the payables account NetSuite's bill is worked out with, the vendor's own", () => {
    const chart = [...CHART, chartAccount('201', '20100', 'Payables Other', 'accounts_payable')];
    const bill = monthBill({ vendor_payables: '201', netsuite: gl(['0', '201', -125000], ['1', '611', 125000]) });
    expect(pick(copy(), bill, { chart })?.entry?.lines).toEqual([PAYABLES(125000, '201'), INSTALL]);
  });

  it("dates it as NetSuite's, in the month NetSuite booked it into", () => {
    expect(pick(copy(own({ date: '2026-11-02' })), monthBill({ date: '2026-11-02' }))?.entry?.date).toBe('2026-10-31');
    expect(pick(copy(own({ date: '2026-09-29' })), monthBill({ date: '2026-09-29' }))?.entry?.date).toBe('2026-10-01');
  });

  it("posts NetSuite's when the copy's entry would move the books, naming the accounts, the day or the vendor", () => {
    const repairs = copy(own({ lines: [ownLine(1, { account_id: '612' })] }));
    expect(pick(repairs)).toEqual({
      entry: null,
      why: `${DIFFERS}it posts differently to 61100 Subcontractors and 61200 Repairs.`,
      own: { lines: [PAYABLES(125000), { ...INSTALL, account: '612' }], date: '2026-10-21', vendorRef: '412' },
      differs: 'it posts differently to 61100 Subcontractors and 61200 Repairs',
    });
    expect(pick(copy(own({ lines: [ownLine(1, { amount: '1200.00' })] })))?.differs)
      .toBe('it posts differently to 20000 Accounts Payable and 61100 Subcontractors');
    expect(pick(copy(own({ date: '2026-10-22' })))?.why).toBe(`${DIFFERS}it's dated Oct 22, 2026, and NetSuite's Oct 21, 2026.`);
    expect(pick(copy(own({ vendor_id: '413' })))?.why).toBe(`${DIFFERS}its payables are for another vendor.`);
    expect(pick(copy(own({ vendor_id: null })))?.why).toBe(`${DIFFERS}its payables are for no vendor.`);
    expect(pick(copy(own({ vendor_id: '412' })), monthBill({ vendor_netsuite_id: null }))?.why).toBe(`${DIFFERS}its payables are for another vendor.`);
    expect(pick(copy(own({ date: '2026-10-22', vendor_id: '413' })))?.differs).toBe("it's dated Oct 22, 2026, and NetSuite's Oct 21, 2026; its payables are for another vendor");
    // The accounts say it, the vendor then going without saying.
    expect(pick(copy(own({ vendor_id: '413', lines: [ownLine(1, { account_id: '612' })] })))?.differs).toBe('it posts differently to 61100 Subcontractors and 61200 Repairs');
  });

  it("posts NetSuite's when the copy's entry can't be worked out, saying why", () => {
    expect(pick(copy(own({ lines: [ownLine(1, { account_id: null })] })))).toEqual({
      ...NOTHING, why: `${CANT}An expense line on the bill has no account: NetSuite didn't say which account it goes to.`,
    });
    expect(pick(copy(own({ lines: [ownLine(1, { amount: null })] })))?.why).toBe(`${CANT}A line's amount couldn't be read from the copy of the bill.`);
    expect(pick(copy(own({ lines: [ownLine(1, { account_id: null, item_id: '9009' })] })))?.why)
      .toBe(`${CANT}Item 9009 isn't in the copy of NetSuite's items yet. Sync now on the NetSuite lists page copies it.`);
  });

  it("posts NetSuite's, saying why, when the copy doesn't match or isn't complete", () => {
    expect(pick(copy(own(), 'waiting'))).toEqual({ ...NOTHING, why: "FleetSuite's own copy is waiting for NetSuite's bill to be copied, so the books post NetSuite's for now." });
    expect(pick(copy(own(), 'differs'))).toEqual({ ...NOTHING, why: "FleetSuite's own copy differs from NetSuite's bill, so the books post NetSuite's." });
    expect(pick(copy(own(), 'incomplete', { unknowns: ['its lines', 'their prices'] }))?.why)
      .toBe("FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's bill: FleetSuite didn't know its lines and their prices.");
    expect(pick(copy(own(), 'incomplete', { summary: "NetSuite's ledger copy doesn't say which company it's for yet." }))?.why)
      .toBe("FleetSuite's own copy is incomplete, so the books post NetSuite's bill. NetSuite's ledger copy doesn't say which company it's for yet.");
  });

  it("says nothing when NetSuite voided its bill, or its own entry can't be worked out yet", () => {
    expect(pick(copy(own(), 'voided'))).toEqual(NOTHING);
    // Not in the copy of NetSuite's GL yet; its lines not copied yet; a tax line the bill rule doesn't post.
    expect(pick(copy(), monthBill({ netsuite: [] }))).toEqual(NOTHING);
    expect(pick(copy(), monthBill({ lines: null }))).toEqual(NOTHING);
    expect(pick(copy(), monthBill({ lines: [nsLine('1', null, '611', '1250.00'), nsLine('2', null, '230', '80.00', { tax: true })] }))).toEqual(NOTHING);
  });

  it('posts nothing when neither entry has anything in it', () => {
    const zero = copy(own({ lines: [ownLine(1, { amount: '0.00' })] }));
    expect(pick(zero, monthBill({ total: '0.00', lines: [nsLine('1', null, '611', '0.00')], netsuite: [] })))
      .toEqual({ ...NOTHING, own: { lines: [], date: '2026-10-21', vendorRef: '412' } });
    // With no payables, there's no vendor to differ on.
    expect(pick(copy(own({ lines: [ownLine(1, { amount: '0.00' })], vendor_id: '413' })), monthBill({ total: '0.00', lines: [nsLine('1', null, '611', '0.00')], netsuite: [] }))?.differs)
      .toBeNull();
  });

  it("has no say when there's no copy, or it's a bill credit, or another company's or more than one company's", () => {
    expect(ownBillPick(worked(monthBill()), undefined, { company: 'BMG', names: NAMES })).toBeNull();
    expect(pick(copy(), monthBill({ type: 'VendCred' }))).toBeNull();
    expect(pick(copy(own({ company: '1084' })))).toBeNull();
    expect(pick(copy(), monthBill({ companies: ['BMG', '1084'] }))).toBeNull();
    expect(pick(copy(), monthBill({ companies: ['1084'] }))).toBeNull();
    expect(pick(copy(), monthBill({ companies: [] }))).toBeNull();
    expect(pick(copy(own({ company: '1084' })), monthBill({ companies: ['1084'] }), { company: '1084' })?.entry).not.toBeNull();
  });
});

describe('reading the copies', () => {
  type Answer = { data: unknown; error: { message: string } | null };
  const service = (answers: Record<string, Answer>, calls: unknown[] = []) =>
    ({
      rpc: async (fn: string, args?: unknown) => {
        calls.push(args === undefined ? [fn] : [fn, args]);
        return answers[fn] ?? { data: null, error: null };
      },
    }) as unknown as SupabaseClient;
  const failing = (message: string): Answer => ({ data: null, error: { message } });

  const netsuite: NetsuiteBillData = {
    number: 'VI-1042', type: 'VendBill', date: '2026-10-21', vendor_id: '412', vendor_name: 'Northside Install Co.', total: '1250.00',
    status: 'A', voided: false, gone: false, companies: ['BMG'],
    lines: [{ line_id: '1', item: null, account: '611', amount: '-1250.00', own_amount: '-1250.00', quantity: null, memo: 'Install', tax: false }],
  };
  const PAIRS: BillPairsData = {
    // VI-1043 made after the copy of NetSuite's bills last ran.
    bills: [{ own: own(), netsuite }, { own: own({ netsuite_id: '8803', number: 'VI-1043', made_at: '2026-10-21T18:00:00.000Z' }), netsuite: null }],
    accounts: { 611: { number: '61100', name: 'Subcontractors' } },
    items: {},
  };
  const THROUGH = { bills: '2026-10-21T17:00:00.000Z', ledger: '2026-10-21T17:00:00.000Z' };

  it("checks each copy of the days asked for against NetSuite's bill, by NetSuite's id", async () => {
    const calls: unknown[] = [];
    const copies = await readOwnBillCopies(service({ gl_own_bill_pairs: { data: PAIRS, error: null } }, calls), '2026-10-01', '2026-10-31', THROUGH);
    expect(calls).toEqual([['gl_own_bill_pairs', { p_from: '2026-10-01', p_to: '2026-10-31', p_netsuite_id: null }]]);
    expect([...copies].map(([id, c]) => [id, c.own.number, c.check.status])).toEqual([['8801', 'VI-1042', 'matches'], ['8803', 'VI-1043', 'waiting']]);
    expect((await readOwnBillCopies(service({}), '2026-10-01', '2026-10-31', THROUGH)).size).toBe(0);
    await expect(readOwnBillCopies(service({ gl_own_bill_pairs: failing('statement timeout') }), '2026-10-01', '2026-10-31', THROUGH))
      .rejects.toThrow('statement timeout');
  });

  it('finds the first month Books has a copy of a bill in', async () => {
    const calls: unknown[] = [];
    expect(await readOwnBillSince(service({ gl_own_bill_months: { data: [{ month: '2026-10-01' }, { month: '2026-08-01' }], error: null } }, calls))).toBe('2026-08-01');
    expect(calls).toEqual([['gl_own_bill_months']]);
    expect(await readOwnBillSince(service({}))).toBeNull();
    await expect(readOwnBillSince(service({ gl_own_bill_months: failing('permission denied') }))).rejects.toThrow('permission denied');
  });
});
