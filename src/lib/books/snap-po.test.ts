import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PoLineRow, PoMatchFacts } from '@/lib/three-way-match';
import {
  extraWords, findPo, linesBeyondPo, NO_PO, pickOpenPos, poLeftCents, poLinesBilled, poStatusWords, readOpenPos, readPoFacts, viewPo,
  type OpenPo, type PoFacts, type PoForm, type SnapPo,
} from './snap-po';

const TODAY = '2026-10-25';

/** A made-up PO: two racks' worth of parts from a made-up vendor. */
const ROWS: PoLineRow[] = [
  { line_id: '1', item_netsuite_id: '1201', item_number: 'RACK-48', description: 'Contractor rack, 8 ft bed', quantity: '4', quantity_received: '4', quantity_billed: '0', rate: '485', amount: '1940.00' },
  { line_id: '2', item_netsuite_id: '1388', item_number: 'CLAMP-ACX', description: 'Street side clamp kit', quantity: '4', quantity_received: '4', quantity_billed: '0', rate: '50', amount: '200.00' },
];

const matchFacts = (over: Partial<PoMatchFacts> = {}): PoMatchFacts => ({
  poTranid: 'PO453-ACME',
  poTotal: 2140,
  poIsOpen: true,
  poStatusLabel: 'Pending Bill',
  lines: [{ itemNumber: 'RACK-48', ordered: 4, received: 4 }, { itemNumber: 'CLAMP-ACX', ordered: 4, received: 4 }],
  priorBills: [],
  earlierBills: [],
  billedUnits: 0,
  rows: ROWS,
  ...over,
});

const acmePo = (over: Partial<SnapPo> = {}, facts: Partial<PoMatchFacts> = {}): SnapPo => ({
  copyId: 'po-1',
  netsuiteId: '45310',
  number: 'PO453-ACME',
  vendorId: '412',
  vendorName: 'Acme Truck Racks',
  date: '2026-10-14',
  status: 'F',
  statusLabel: 'Purchase Order : Pending Bill',
  totalCents: 214000,
  facts: matchFacts(facts),
  ...over,
});

const found = (po: SnapPo = acmePo()): PoFacts => ({ found: po, open: [] });

/** The bill's lines for the PO's: the racks and the clamps. */
const PO_LINES = [{ description: 'RACK-48 Contractor rack', cents: 194000 }, { description: 'CLAMP-ACX Street side clamp kit', cents: 20000 }];
const FREIGHT = { description: 'Freight', cents: 24000 };

const form = (over: Partial<PoForm> = {}): PoForm => ({
  vendorId: '412',
  totalCents: 214000,
  poNumber: 'PO453-ACME',
  howBilled: null,
  extra: null,
  lines: PO_LINES,
  ...over,
});

const view = (f: Partial<PoForm> = {}, facts: PoFacts | null = found()) => viewPo(form(f), facts, 'Acme Truck Racks', TODAY);
const leg = (v: ReturnType<typeof view>, title: string) => v.legs.find((l) => l.title === title);

describe('poStatusWords', () => {
  it("says a PO's status as NetSuite names it, from the label or the letter", () => {
    expect(poStatusWords({ status: 'G', statusLabel: 'Purchase Order : Fully Billed' })).toBe('fully billed');
    expect(poStatusWords({ status: 'H', statusLabel: null })).toBe('closed');
    expect(poStatusWords({ status: 'a', statusLabel: '' })).toBe('pending supervisor approval');
    expect(poStatusWords({ status: 'Z', statusLabel: null })).toBe('closed');
  });
});

describe('pickOpenPos', () => {
  const po = (number: string, status: string | null, date: string | null, totalCents: number | null): OpenPo => ({ number, status, date, totalCents });
  it("offers the one for the bill's total first, then received ones, newest first, and never one that can't take a bill", () => {
    const pos = [
      po('PO401', 'B', '2026-10-20', 61500),
      po('PO402', 'F', '2026-09-01', 99000),
      po('PO403', 'F', '2026-10-01', 12000),
      po('PO404', 'E', '2026-10-21', 5000),
      po('PO405', 'G', '2026-10-22', 214000),
      po('PO406', 'D', '2026-10-23', 214000),
      po('PO407', null, null, null),
    ];
    expect(pickOpenPos(pos, 214000).map((p) => p.number)).toEqual(['PO406', 'PO403', 'PO402', 'PO404', 'PO401']);
    expect(pickOpenPos(pos, null, 10).map((p) => p.number)).toEqual(['PO403', 'PO402', 'PO404', 'PO406', 'PO401', 'PO407']);
    expect(pickOpenPos([], 100)).toEqual([]);
  });
});

describe('poLinesBilled', () => {
  it("is each line with some still to bill, its open quantity at the PO's price, and what they come to", () => {
    expect(poLinesBilled(acmePo())).toEqual({
      lines: [
        { item: 'RACK-48', description: 'Contractor rack, 8 ft bed', quantity: 4, rate: 485, cents: 194000 },
        { item: 'CLAMP-ACX', description: 'Street side clamp kit', quantity: 4, rate: 50, cents: 20000 },
      ],
      cents: 214000,
    });
    const part = acmePo({}, { rows: [{ ...ROWS[0], quantity_billed: '1' }, { ...ROWS[1], quantity_billed: '4' }] });
    expect(poLinesBilled(part)).toEqual({ lines: [{ item: 'RACK-48', description: 'Contractor rack, 8 ft bed', quantity: 3, rate: 485, cents: 145500 }], cents: 145500 });
    expect(poLinesBilled(acmePo({}, { rows: [{ ...ROWS[0], rate: null, amount: null }] })).cents).toBeNull();
  });
});

describe('poLeftCents', () => {
  it("is the PO's total less what's billed on its lines, at the PO's prices", () => {
    expect(poLeftCents(acmePo())).toBe(214000);
    expect(poLeftCents(acmePo({}, { rows: [{ ...ROWS[0], quantity_billed: '1' }, ROWS[1]] }))).toBe(165500);
    // No price on the line: its amount over its quantity.
    expect(poLeftCents(acmePo({}, { rows: [{ ...ROWS[0], rate: null, quantity_billed: '2' }, ROWS[1]] }))).toBe(117000);
  });
  it("is nothing to go on without the PO's total, or a price for a line that's billed", () => {
    expect(poLeftCents(acmePo({ totalCents: null }))).toBeNull();
    expect(poLeftCents(acmePo({}, { rows: [{ ...ROWS[0], rate: null, amount: null, quantity_billed: '1' }, ROWS[1]] }))).toBeNull();
    // One still to bill needs no price for this.
    expect(poLeftCents(acmePo({}, { rows: [{ ...ROWS[0], rate: null, amount: null }, ROWS[1]] }))).toBe(214000);
  });
});

describe('extraWords', () => {
  const po = poLinesBilled(acmePo()).lines;
  it("names the extra line from the bill's own line for the difference, else its lines that aren't on the PO", () => {
    const read = [
      { description: 'RACK-48 Contractor rack', cents: 194000 },
      { description: 'CLAMP-ACX', cents: 20000 },
      { description: 'Freight', cents: 24000 },
    ];
    expect(extraWords(read, po, 24000)).toBe('Freight');
    expect(extraWords([...read.slice(0, 2), { description: 'Freight', cents: 21000 }, { description: ' Fuel surcharge ', cents: 3000 }], po, 24000))
      .toBe('Freight, Fuel surcharge');
    // A line for one of the PO's amounts is on the PO, whatever it says.
    expect(extraWords([{ description: 'Racks', cents: 194000 }, { description: 'Clamps', cents: 20000 }, { description: 'Liftgate', cents: 24000 }], po, 24000)).toBe('Liftgate');
    expect(extraWords([{ description: 'Freight', cents: 20000 }, { description: 'Handling', cents: 20000 }], po, 40000)).toBeNull();
    // Two lines for the difference: it's neither, unless they're all that isn't on the PO and add up to it.
    expect(extraWords([...read.slice(0, 2), { description: 'Freight', cents: 24000 }, { description: 'Handling', cents: 24000 }], po, 24000)).toBeNull();
    expect(extraWords([{ description: 'Racks and clamps', cents: 238000 }], po, 24000)).toBeNull();
    expect(extraWords([{ description: '', cents: 24000 }], po, 24000)).toBeNull();
    expect(extraWords(read, po, 0)).toBeNull();
    // The one for the difference among those that aren't on the PO, when the PO's lines are one line on the bill.
    expect(extraWords([{ description: 'Racks and clamps', cents: 214000 }, { description: 'Freight', cents: 24000 }], po, 24000)).toBe('Freight');
    // One naming a PO item is on it, whatever its amount; one with no amount is nothing.
    expect(extraWords([...read.slice(0, 2), { description: 'CLAMP-ACX extra clamps', cents: 24000 }], po, 24000)).toBeNull();
    expect(extraWords([...read.slice(0, 2), { description: 'Freight', cents: 21000 }, { description: 'Fuel surcharge', cents: 3000 }, { description: 'Thank you', cents: null }], po, 24000))
      .toBe('Freight, Fuel surcharge');
  });
});

describe('linesBeyondPo', () => {
  const po = poLinesBilled(acmePo()).lines;
  it("is the bill's own lines that are what it has beyond the PO", () => {
    const fuel = { description: 'Fuel surcharge', cents: 3000 };
    const freight = { description: 'Freight', cents: 21000 };
    expect(linesBeyondPo([...PO_LINES, FREIGHT], po, 24000)).toEqual([FREIGHT]);
    expect(linesBeyondPo([...PO_LINES, freight, fuel], po, 24000)).toEqual([freight, fuel]);
    expect(linesBeyondPo([...PO_LINES, freight, fuel], po, 21000)).toEqual([freight]);
    expect(linesBeyondPo([...PO_LINES, freight, fuel], po, 25000)).toBeNull();
    expect(linesBeyondPo(PO_LINES, po, 24000)).toBeNull();
    expect(linesBeyondPo([...PO_LINES, FREIGHT], po, 0)).toBeNull();
  });
});

describe('viewPo', () => {
  it("offers the vendor's open POs while the bill names none", () => {
    const v = view({ poNumber: null }, { found: null, open: [{ number: 'PO453-ACME', status: 'F', date: '2026-10-14', totalCents: 214000 }, { number: 'PO458-ACME', status: 'B', date: null, totalCents: null }] });
    expect(v).toMatchObject({ tone: null, text: null, canBill: false, billing: false, number: null, legs: [] });
    expect(v.open).toEqual([{ number: 'PO453-ACME', label: 'PO453-ACME · $2,140.00' }, { number: 'PO458-ACME', label: 'PO458-ACME' }]);
    expect(view({ poNumber: '  ' }, null).open).toEqual([]);
  });

  it("says when FleetSuite's copy has no PO by that number", () => {
    expect(view({ poNumber: 'PO999' }, NO_PO)).toMatchObject({
      tone: 'amber', canBill: false, billing: false,
      text: "No PO999 in FleetSuite's copy of NetSuite's POs, which catches up every two hours. Check the number, or enter it as a plain bill.",
    });
  });

  it("offers the PO's vendor while the form has none, and bills nothing until it's picked", () => {
    expect(view({ vendorId: null })).toMatchObject({
      tone: 'amber', canBill: false, billing: false, number: 'PO453-ACME', vendor: { id: '412', name: 'Acme Truck Racks' },
      text: "PO453-ACME is Acme Truck Racks's PO. Pick the vendor to bill it.",
    });
  });

  it("won't bill another vendor's PO, a PO NetSuite won't bill, or one with nothing left to bill", () => {
    expect(viewPo(form({ vendorId: '77' }), found(), 'Riverbend Electric Co-op', TODAY)).toMatchObject({
      tone: 'red', canBill: false, billing: false,
      text: "PO453-ACME is Acme Truck Racks's PO, not Riverbend Electric Co-op's. Check the PO number or the vendor.",
    });
    const billed = acmePo({ status: 'G', statusLabel: 'Purchase Order : Fully Billed' }, { poIsOpen: false });
    expect(view({}, found(billed))).toMatchObject({
      tone: 'red', canBill: false, billing: false,
      text: "PO453-ACME is fully billed in NetSuite, so it can't take another bill. If this is an extra charge, enter it as a plain bill.",
    });
    const nothingLeft = acmePo({ status: 'E' }, { rows: ROWS.map((r) => ({ ...r, quantity_billed: r.quantity })) });
    expect(view({}, found(nothingLeft))).toMatchObject({
      tone: 'red', canBill: false, text: 'Everything on PO453-ACME is billed already. If this is an extra charge, enter it as a plain bill.',
    });
  });

  it("bills a PO that matches with one tap: what NetSuite bills, and all three checks green", () => {
    const v = view();
    expect(v).toMatchObject({
      tone: 'green', canBill: true, billing: true, number: 'PO453-ACME', overCents: 0, extraCents: 0, billsCents: 214000,
      verdict: 'green', needsReason: false, variances: [],
      text: 'PO453-ACME is open in NetSuite: Acme Truck Racks, $2,140.00, ordered Oct 14.',
      how: { tone: null, text: "NetSuite bills the PO's open lines at its prices. That settles what Receiving booked for them, and the PO shows billed." },
    });
    expect(v.lines.map((l) => [l.item, l.quantity, l.cents])).toEqual([['RACK-48', 4, 194000], ['CLAMP-ACX', 4, 20000]]);
    expect(v.legs).toEqual([
      { title: 'Totals', tone: 'green', text: "The bill's $2,140.00 is the PO's total." },
      { title: 'Received', tone: 'green', text: 'All 8 units are in.' },
      { title: 'Earlier bills', tone: 'green', text: 'None on PO453-ACME.' },
    ]);
    expect(viewPo(form(), found(acmePo({ date: '2025-12-02' })), 'Acme Truck Racks', TODAY).text).toContain('ordered Dec 2, 2025.');
  });

  it('leaves the PO open when someone picks a plain bill, and says what that leaves', () => {
    expect(view({ howBilled: 'plain' })).toMatchObject({
      tone: 'green', canBill: true, billing: false, legs: [], verdict: null, needsReason: false,
      how: { tone: 'amber', text: 'A plain bill leaves PO453-ACME open, and what Receiving booked for it stays unsettled. Bill the PO unless this is a separate charge.' },
    });
    expect(view({ howBilled: 'po' }).billing).toBe(true);
  });

  it('puts what the bill is more than the PO on its own line, and still asks why past what the match lets through', () => {
    // The bill's lines don't say what the $240.00 is.
    const over = view({ totalCents: 238000 });
    expect(over).toMatchObject({ overCents: 24000, extraCents: 24000, billsCents: 238000, verdict: 'red', needsReason: true });
    expect(leg(over, 'Totals')).toEqual({ title: 'Totals', tone: 'red', text: "The bill is $240.00 more than the PO's $2,140.00. The $240.00 goes on its own line." });
    expect(over.how?.text).toContain("What the bill has beyond them goes on its own line.");
    expect(over.variances[0]).toContain('Invoice $2,380.00 vs PO $2,140.00');
    // Within what the match lets through, it's still a line of its own, and green.
    const near = view({ totalCents: 215200 });
    expect(near).toMatchObject({ extraCents: 1200, billsCents: 215200, verdict: 'green', needsReason: false });
    expect(leg(near, 'Totals')?.text).toBe("The bill is $12.00 more than the PO's $2,140.00, within the $42.80 let through. The $12.00 goes on its own line.");
    // Left off, NetSuite bills the PO's amount and says so.
    const leftOff = view({ totalCents: 238000, extra: { leftOff: true } });
    expect(leftOff).toMatchObject({ overCents: 24000, extraCents: 0, billsCents: 214000 });
    expect(leg(leftOff, 'Totals')?.text).toBe("The bill is $240.00 more than the PO's $2,140.00. Billing the PO enters $2,140.00, not the bill's $2,380.00.");
    expect(leftOff.how?.text).not.toContain('beyond');
  });

  it("checks the totals without lines the bill prints that aren't on the PO, so its freight needs no reason", () => {
    const freight = view({ totalCents: 238000, lines: [...PO_LINES, FREIGHT] });
    expect(freight).toMatchObject({ overCents: 24000, extraCents: 24000, billsCents: 238000, verdict: 'green', needsReason: false, variances: [] });
    expect(leg(freight, 'Totals')).toEqual({ title: 'Totals', tone: 'green', text: "The bill is the PO's $2,140.00 plus $240.00 for freight, which goes on its own line." });
    expect(freight.how?.text).toContain('What the bill has beyond them goes on its own line.');
    const lines = (...extra: Array<{ description: string; cents: number }>) => view({ totalCents: 238000, lines: [...PO_LINES, ...extra] });
    expect(leg(lines({ description: 'Freight', cents: 21000 }, { description: 'Fuel surcharge', cents: 3000 }), 'Totals')?.text)
      .toBe("The bill is the PO's $2,140.00 plus $240.00 for freight and fuel surcharge, which goes on its own line.");
    expect(leg(lines({ description: 'Freight', cents: 19000 }, { description: 'Fuel surcharge', cents: 3000 }, { description: 'UPS liftgate', cents: 2000 }), 'Totals')?.text)
      .toBe("The bill is the PO's $2,140.00 plus $240.00 for freight, fuel surcharge and UPS liftgate, which goes on its own line.");
    // The PO's lines as one line on the bill, and its freight.
    expect(view({ totalCents: 238000, lines: [{ description: 'Racks and clamps', cents: 214000 }, FREIGHT] })).toMatchObject({ verdict: 'green', needsReason: false });
    // The other checks still count.
    const short = view({ totalCents: 238000, lines: [...PO_LINES, FREIGHT] }, found(acmePo({}, { lines: [{ itemNumber: 'RACK-48', ordered: 4, received: 2 }, { itemNumber: 'CLAMP-ACX', ordered: 4, received: 4 }] })));
    expect(short).toMatchObject({ verdict: 'amber', needsReason: true });
    expect(leg(short, 'Totals')?.tone).toBe('green');
  });

  it("asks why when the bill is beyond the PO by more than lines it prints, or the line is left off", () => {
    const red = (f: Partial<PoForm>, facts?: PoFacts) => expect(view({ totalCents: 238000, ...f }, facts)).toMatchObject({ verdict: 'red', needsReason: true });
    // Left off, NetSuite bills less than the bill says.
    red({ lines: [...PO_LINES, FREIGHT], extra: { leftOff: true } });
    // A price that went up, and the freight.
    red({ totalCents: 239000, lines: [{ description: 'RACK-48 Contractor rack', cents: 195000 }, PO_LINES[1], FREIGHT] });
    // A line that doesn't say what it is.
    red({ lines: [...PO_LINES, { description: '  ', cents: 24000 }] });
    expect(leg(view({ totalCents: 238000, lines: [...PO_LINES, { description: '  ', cents: 24000 }] }), 'Totals')?.text)
      .toBe("The bill is $240.00 more than the PO's $2,140.00. The $240.00 goes on its own line.");
    // More of one of the PO's items.
    red({ lines: [...PO_LINES, { description: 'CLAMP-ACX extra clamps', cents: 24000 }] });
    // A PO with some billed already keeps every check.
    const second = acmePo({ status: 'E' }, { rows: [{ ...ROWS[0], quantity_billed: '4' }, ROWS[1]], earlierBills: ['INV-5521'], priorBills: ['INV-5521'] });
    red({ totalCents: 24000, lines: [PO_LINES[1], { description: 'Freight', cents: 4000 }] }, found(second));
    const again = view({ totalCents: 24000, lines: [PO_LINES[1], { description: 'Freight', cents: 4000 }] }, found(second));
    expect(again.variances).toEqual([expect.stringContaining('already has a bill'), expect.stringContaining('Invoice $240.00 vs PO $2,140.00')]);
    expect(leg(again, 'Totals')?.text)
      .toBe("The bill is $1,900.00 less than the PO's $2,140.00. $200.00 of the PO is left to bill, so the other $40.00 goes on its own line.");
  });

  it("sets a second bill on a PO against what's left to bill on it", () => {
    const second = acmePo({ status: 'E' }, {
      rows: [{ ...ROWS[0], quantity_billed: '4' }, ROWS[1]],
      earlierBills: ['INV-5521'],
      priorBills: ['INV-5521'],
    });
    const v = view({ totalCents: 24000 }, found(second));
    expect(v).toMatchObject({ overCents: 4000, extraCents: 4000, billsCents: 24000, verdict: 'red', needsReason: true });
    expect(v.lines.map((l) => [l.item, l.quantity, l.cents])).toEqual([['CLAMP-ACX', 4, 20000]]);
    expect(leg(v, 'Totals')?.text)
      .toBe("The bill is $1,900.00 less than the PO's $2,140.00. $200.00 of the PO is left to bill, so the other $40.00 goes on its own line.");
    // With no price for what's billed, it's set against the PO's total.
    const unpriced = acmePo({ status: 'E' }, { rows: [{ ...ROWS[0], rate: null, amount: null, quantity_billed: '4' }, ROWS[1]] });
    expect(view({ totalCents: 24000 }, found(unpriced))).toMatchObject({ overCents: 0, extraCents: 0, billsCents: 20000 });
    expect(view({ totalCents: 238000 }, found(unpriced))).toMatchObject({ overCents: 24000, extraCents: 24000 });
  });

  it("says when the bill is less than the PO, or there's no total to check", () => {
    const less = view({ totalCents: 210000 });
    expect(less).toMatchObject({ overCents: 0, extraCents: 0, verdict: 'green' });
    expect(leg(less, 'Totals')?.text).toBe("The bill is $40.00 less than the PO's $2,140.00, within the $42.80 let through. Billing the PO enters $2,140.00, not the bill's $2,100.00.");
    expect(leg(view({ totalCents: null }), 'Totals')).toEqual({ title: 'Totals', tone: 'amber', text: "Fill in the bill's total to check it against the PO." });
    expect(leg(view({}, found(acmePo({ totalCents: null }, { poTotal: null }))), 'Totals'))
      .toEqual({ title: 'Totals', tone: 'amber', text: 'The copy of PO453-ACME has no total, so compare the amounts by hand.' });
  });

  it('says what Receiving has had, short lines first', () => {
    const part = view({}, found(acmePo({}, { lines: [{ itemNumber: 'RACK-48', ordered: 4, received: 2 }, { itemNumber: 'CLAMP-ACX', ordered: 4, received: 4 }] })));
    expect(part).toMatchObject({ verdict: 'amber', needsReason: true });
    expect(leg(part, 'Received')).toEqual({ title: 'Received', tone: 'amber', text: '6 of 8 units are in so far (RACK-48 2 of 4). Billing the PO bills all 8.' });
    const none = view({}, found(acmePo({}, { lines: [{ itemNumber: 'RACK-48', ordered: 4, received: 0 }] })));
    expect(leg(none, 'Received')).toEqual({ title: 'Received', tone: 'red', text: 'Nothing on PO453-ACME has been received yet.' });
    const many = Array.from({ length: 6 }, (_, i) => ({ itemNumber: `P-${i}`, ordered: 2.5, received: i === 0 ? 1 : 0.5 }));
    expect(leg(view({}, found(acmePo({}, { lines: many }))), 'Received')?.text)
      .toBe('3.5 of 15 units are in so far (P-0 1 of 2.5, P-1 0.5 of 2.5, P-2 0.5 of 2.5, P-3 0.5 of 2.5, and 2 more). Billing the PO bills all 15.');
    expect(leg(view({}, found(acmePo({}, { lines: [{ itemNumber: 'RACK-48', ordered: 1, received: 1 }] }))), 'Received')?.text).toBe('The 1 unit is in.');
  });

  it('names the bills already on the PO, and what NetSuite shows billed', () => {
    const both = view({}, found(acmePo({}, { earlierBills: ['VB-90', 'INV-5521'], billedUnits: 3, priorBills: ['VB-90', 'INV-5521', 'NetSuite shows 3 units'] })));
    expect(leg(both, 'Earlier bills')).toEqual({
      title: 'Earlier bills', tone: 'red',
      text: 'PO453-ACME already has 2 bills (VB-90, INV-5521), and NetSuite shows 3 units billed on it. Billing it again pays twice.',
    });
    expect(both).toMatchObject({ verdict: 'red', needsReason: true });
    expect(leg(view({}, found(acmePo({}, { earlierBills: ['VB-90'], priorBills: ['VB-90'] }))), 'Earlier bills')?.text)
      .toBe('PO453-ACME already has a bill: VB-90. Billing it again pays twice.');
    expect(leg(view({}, found(acmePo({}, { billedUnits: 1, priorBills: ['NetSuite shows 1 unit'] }))), 'Earlier bills')?.text)
      .toBe("NetSuite shows 1 unit on PO453-ACME billed already. Check this bill isn't one of them.");
  });
});

// ── The readers, against a fake of the tables they read ──────────────────────

type Row = Record<string, unknown>;
const likeRe = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');

function fakeService(tables: Record<string, Row[] | { error: { message: string } }>) {
  const reads: Array<{ table: string; calls: string[] }> = [];
  const service = {
    from(table: string) {
      const tests: Array<(r: Row) => boolean> = [];
      const read = { table, calls: [] as string[] };
      reads.push(read);
      let range: [number, number] | null = null;
      let limit: number | null = null;
      const result = () => {
        const t = tables[table];
        if (t && !Array.isArray(t)) return { data: null, error: t.error };
        let rows = (t ?? []).filter((r) => tests.every((ok) => ok(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit !== null) rows = rows.slice(0, limit);
        return { data: rows, error: null };
      };
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { read.calls.push(`eq ${k} ${v}`); tests.push((r) => r[k] === v); return q; },
        ilike: (k: string, p: string) => { read.calls.push(`ilike ${k} ${p}`); tests.push((r) => likeRe(p).test(String(r[k] ?? ''))); return q; },
        not: (k: string, op: string, v: string) => {
          read.calls.push(`not ${k} ${op} ${v}`);
          const list = v.replace(/[()]/g, '').split(',');
          tests.push((r) => r[k] !== null && r[k] !== undefined && !list.includes(String(r[k])));
          return q;
        },
        order: () => q,
        limit: (n: number) => { limit = n; return q; },
        range: (a: number, b: number) => { range = [a, b]; return q; },
        maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
      };
      return q;
    },
  };
  return { service: service as unknown as SupabaseClient, reads };
}

const poRow = (over: Row = {}): Row => ({
  id: 'po-1', netsuite_id: '45310', tranid: 'PO453-ACME', vendor_netsuite_id: '412', vendor_name: 'Acme Truck Racks', trandate: '2026-10-14',
  status: 'F', status_label: 'Purchase Order : Pending Bill', total: '2140.00', ...over,
});

describe('findPo', () => {
  const POS = [
    poRow(),
    poRow({ id: 'po-2', netsuite_id: '45800', tranid: 'PO458-ACME', trandate: '2026-10-20', total: '615.00' }),
    poRow({ id: 'po-3', netsuite_id: '45900', tranid: 'PO-453', vendor_netsuite_id: '77', vendor_name: 'Riverbend Electric Co-op', trandate: '2025-01-03' }),
    poRow({ id: 'po-4', netsuite_id: '46000', tranid: 'PO4530', trandate: '2026-10-21' }),
  ];
  const { service } = fakeService({ netsuite_vendor_pos: POS });

  it('finds the PO by its number, case aside, else the vendor\'s by the same digits, else the one PO anyone has with them', async () => {
    expect((await findPo(service, ' po453-acme ', '412'))?.id).toBe('po-1');
    expect((await findPo(service, 'PO-453', '412'))?.id).toBe('po-3');
    expect((await findPo(service, 'P.O. #453', '412'))?.id).toBe('po-1');
    expect((await findPo(service, '453', '77'))?.id).toBe('po-3');
    // Two vendors have a 453: with no vendor, it's neither.
    expect(await findPo(service, '453', null)).toBeNull();
    expect((await findPo(service, '458', null))?.id).toBe('po-2');
    // 4530 is its own number, not 453's.
    expect((await findPo(service, '4530', '412'))?.id).toBe('po-4');
    expect(await findPo(service, 'ACME', '412')).toBeNull();
    expect(await findPo(service, '   ', '412')).toBeNull();
  });

  it("takes the vendor's when two vendors' POs have the same number", async () => {
    const same = [poRow({ id: 'po-5', netsuite_id: '47000', tranid: 'PO100', vendor_netsuite_id: '77' }), poRow({ id: 'po-6', netsuite_id: '47100', tranid: 'po100' })];
    const { service: s } = fakeService({ netsuite_vendor_pos: same });
    expect((await findPo(s, 'PO100', '412'))?.id).toBe('po-6');
    expect((await findPo(s, 'PO100', '77'))?.id).toBe('po-5');
    expect((await findPo(s, 'PO100', null))?.id).toBe('po-5');
  });

  it("never lets a typed wildcard match a PO, and fails closed when the copy can't be read", async () => {
    const { service: s, reads } = fakeService({ netsuite_vendor_pos: POS });
    expect(await findPo(s, 'PO%', '412')).toBeNull();
    expect(reads.every((r) => r.calls.every((c) => !c.startsWith('ilike tranid PO%')))).toBe(true);
    expect((await findPo(s, 'PO45_-ACME*', '412'))?.id).toBeUndefined();
    await expect(findPo(fakeService({ netsuite_vendor_pos: { error: { message: 'timeout' } } }).service, 'PO453-ACME', null)).rejects.toThrow("couldn't look for PO PO453-ACME (timeout)");
  });
});

describe('readOpenPos and readPoFacts', () => {
  const tables = {
    netsuite_vendor_pos: [
      poRow(),
      poRow({ id: 'po-2', netsuite_id: '45800', tranid: 'PO458-ACME', trandate: '2026-10-20', total: '615.00', status: 'B' }),
      poRow({ id: 'po-5', netsuite_id: '44000', tranid: 'PO440-ACME', trandate: '2026-08-01', status: 'G' }),
      poRow({ id: 'po-6', netsuite_id: '44100', tranid: null, status: 'F' }),
    ],
    netsuite_vendor_po_lines: ROWS.map((r) => ({ ...r, po_id: 'po-1' })),
  };

  it("reads the vendor's POs that can take a bill", async () => {
    const { service, reads } = fakeService(tables);
    expect(await readOpenPos(service, '412')).toEqual([
      { number: 'PO453-ACME', status: 'F', date: '2026-10-14', totalCents: 214000 },
      { number: 'PO458-ACME', status: 'B', date: '2026-10-20', totalCents: 61500 },
    ]);
    expect(reads[0].calls).toEqual(['eq vendor_netsuite_id 412', 'not status in (A,C,G,H,P)']);
  });

  it('offers them for a bill that names no PO, and nothing without a vendor', async () => {
    const { service } = fakeService(tables);
    expect(await readPoFacts(service, { poNumber: null, vendorId: '412', totalCents: 61500 }, 'snap-1'))
      .toEqual({ found: null, open: [{ number: 'PO458-ACME', status: 'B', date: '2026-10-20', totalCents: 61500 }, { number: 'PO453-ACME', status: 'F', date: '2026-10-14', totalCents: 214000 }] });
    expect(await readPoFacts(service, { poNumber: null, vendorId: null, totalCents: 61500 }, 'snap-1')).toEqual(NO_PO);
    expect(await readPoFacts(service, { poNumber: 'PO999', vendorId: '412', totalCents: 61500 }, 'snap-1')).toEqual(NO_PO);
  });

  it('reads the PO a bill names with what the three-way match reads, leaving out the snapped bill itself', async () => {
    const { service, reads } = fakeService({
      ...tables,
      gl_snapped_bills: [
        { id: 'snap-1', billed_po_netsuite_id: '45310', status: 'sent', netsuite_number: 'INV-5521', bill_number: 'INV-5521' },
        { id: 'snap-9', billed_po_netsuite_id: '45310', status: 'sent', netsuite_number: 'INV-5530', bill_number: 'INV-5530' },
      ],
    });
    const facts = await readPoFacts(service, { poNumber: '453', vendorId: '412', totalCents: 214000 }, 'snap-1');
    expect(facts.open).toEqual([]);
    expect(facts.found).toMatchObject({
      copyId: 'po-1', netsuiteId: '45310', number: 'PO453-ACME', vendorId: '412', vendorName: 'Acme Truck Racks', date: '2026-10-14',
      status: 'F', statusLabel: 'Purchase Order : Pending Bill', totalCents: 214000,
    });
    expect(facts.found?.facts).toMatchObject({ poIsOpen: true, earlierBills: ['INV-5530'], billedUnits: 0 });
    expect(facts.found?.facts.rows).toHaveLength(2);
    expect(reads.find((r) => r.table === 'gl_snapped_bills')?.calls).toEqual(['eq billed_po_netsuite_id 45310', 'eq status sent']);
  });
});
