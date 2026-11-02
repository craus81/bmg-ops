// Filing the 1099s (part 70, src/lib/books/1099-filing.ts): each year's
// minimums, who gets which form, a payee's name and address from its NetSuite
// record, tax IDs read on the device and held against the four digits NetSuite
// has, the IRS's IRIS template read heading by heading, and the file filled
// in. Made-up vendors, addresses and tax IDs only.
import { describe, it, expect } from 'vitest';
import type { Payee1099, Year1099 } from './1099s';
import {
  amountText, boxOf, checkTin, cityName, csvRecords, due1099, fileProblems, filedBox, fillChoices, fillFromKey, fillKey,
  fillLabel, formName, isTinHeading, makeFiles, maskedTin, matchTins, minimumFor, nameLine, payeeDetails, payerProblems,
  personName, phoneOf, previewColumn, readHeadings, readTaxIds, readTemplate, readTin, stateCode, streetLine, tinTypeOf,
  zipOf, FORMS_PER_FILE, type ColumnFill, type FileRow, type Payer, type PayeeDetails, type Template,
} from './1099-filing';

const payee = (id: string, name: string, boxes: Record<string, number>, extra: Partial<Payee1099> = {}): Payee1099 => {
  const total = Object.values(boxes).reduce((n, c) => n + c, 0);
  return {
    payee: id, name, legalName: null, entityId: null, vendor: true, marked: true, paid: total, boxes, total,
    unsplit: 0, byCard: 0, payments: [], ...extra,
  };
};

const year = (forms: Payee1099[], extra: Partial<Year1099> = {}): Year1099 => ({
  categories: [], forms, notMarked: [], nothingCounted: [], byCard: [], unsplit: [], notCopied: [], accounts: [],
  totals: { boxes: {}, total: 0 }, flagsCopied: true, ...extra,
});

describe('minimums', () => {
  it('is $600 to 2025, $2,000 for 2026, and the last known from 2027 until the raised amount is put in', () => {
    expect(minimumFor(2024)).toEqual({ cents: 600_00, known: true });
    expect(minimumFor(2025)).toEqual({ cents: 600_00, known: true });
    expect(minimumFor(2026)).toEqual({ cents: 2000_00, known: true });
    expect(minimumFor(2027)).toEqual({ cents: 2000_00, known: false });
    expect(minimumFor(2030)).toEqual({ cents: 2000_00, known: false });
  });

  it('fills in nonemployee compensation on the NEC, and rents, royalties, other income, medical and attorneys on the MISC', () => {
    expect(filedBox('Nonemployee Compensation')).toMatchObject({ form: 'NEC', box: '1' });
    expect(filedBox('nonemployee compensation (box 1)')).toMatchObject({ form: 'NEC', box: '1' });
    expect(filedBox('Rents')).toMatchObject({ form: 'MISC', box: '1' });
    expect(filedBox('Royalties')?.minimum(2026)).toEqual({ cents: 10_00, known: true });
    expect(filedBox('Other Income')).toMatchObject({ form: 'MISC', box: '3' });
    expect(filedBox('Medical and Health Care Payments')).toMatchObject({ form: 'MISC', box: '6' });
    expect(filedBox('Gross Proceeds Paid to an Attorney')?.minimum(2026)).toEqual({ cents: 600_00, known: true });
    expect(filedBox('Gross Proceeds Paid to an Attorney')?.minimum(2031)).toEqual({ cents: 600_00, known: true });
    expect(filedBox('Fishing Boat Proceeds')).toBeNull();
    expect(filedBox('Federal Income Tax Withheld')).toBeNull();
    expect(boxOf('MISC', '10')?.label).toBe('Gross proceeds paid to an attorney');
    expect(boxOf('NEC', '2')).toBeNull();
  });
});

describe('who gets a 1099', () => {
  const NEC = 'Nonemployee Compensation';

  it('gives a form to whoever reaches a box minimum, the minimum itself included, by the year', () => {
    const y = year([
      payee('1', 'Sample Painting', { [NEC]: 2000_00 }),
      payee('2', 'Example Electric', { [NEC]: 1999_99 }),
      payee('3', 'Demo Rentals', { Rents: 2500_00, Royalties: 5_00 }),
      payee('4', 'Sample Songs', { Royalties: 10_00 }),
      payee('5', 'Example Law', { 'Gross Proceeds Paid to an Attorney': 600_00 }),
      payee('6', 'Demo Odd Jobs', { Rents: 1500_00, 'Other Income': 1900_00 }),
      payee('7', 'Sample Both', { [NEC]: 3000_00, Rents: 100_00 }),
      payee('8', 'Example Tiny Songs', { Royalties: 9_99, [NEC]: 0 }),
    ]);
    const d = due1099(y, 2026, { yearOver: true });
    expect(d.forms.map((f) => [f.form, f.name, f.boxes, f.total])).toEqual([
      ['NEC', 'Sample Both', { 1: 3000_00 }, 3000_00],
      ['NEC', 'Sample Painting', { 1: 2000_00 }, 2000_00],
      // Every box paid in goes on a form that's due, the $5 of royalties too.
      ['MISC', 'Demo Rentals', { 1: 2500_00, 2: 5_00 }, 2505_00],
      ['MISC', 'Example Law', { 10: 600_00 }, 600_00],
      ['MISC', 'Sample Songs', { 2: 10_00 }, 10_00],
    ]);
    // Each box is held against its own minimum: $1,500 of rents and $1,900 of other income make no form.
    expect(d.under.map((u) => [u.form, u.name, u.total])).toEqual([
      ['MISC', 'Demo Odd Jobs', 3400_00],
      ['NEC', 'Example Electric', 1999_99],
      ['MISC', 'Sample Both', 100_00],
      ['MISC', 'Example Tiny Songs', 9_99],
    ]);
    expect(d.counts).toEqual({ NEC: 2, MISC: 3 });
    expect(d.minimum).toEqual({ cents: 2000_00, known: true });
    expect(d.byHand).toEqual([]);
    expect(d.blockers).toEqual([]);
    expect(d.year).toBe(2026);

    // In 2025 the minimum was $600.
    const d25 = due1099(y, 2025, { yearOver: true });
    expect(d25.forms.find((f) => f.name === 'Example Electric')?.form).toBe('NEC');
    expect(d25.forms.find((f) => f.name === 'Demo Odd Jobs')?.boxes).toEqual({ 1: 1500_00, 3: 1900_00 });
    expect(d25.under.map((u) => u.name)).toEqual(['Sample Both', 'Example Tiny Songs']);
  });

  it('leaves to be filed by hand who it can\'t split, who was paid in a box it doesn\'t fill in, and a box below nothing', () => {
    const y = year([
      payee('1', 'Sample Painting', { [NEC]: 5000_00 }, { unsplit: 250_00 }),
      payee('2', 'Example Electric', { [NEC]: 5000_00, 'Federal Income Tax Withheld': 1200_00, 'Fishing Boat Proceeds': 1_00 }),
      payee('3', 'Demo Rentals', { Rents: -50_00, Royalties: 100_00 }),
      payee('4', 'Demo Two Below', { Rents: -50_00, Royalties: -1_00 }),
    ]);
    const d = due1099(y, 2026, { yearOver: true });
    expect(d.forms).toEqual([]);
    expect(d.under).toEqual([]);
    expect(d.byHand.map((b) => [b.name, b.why])).toEqual([
      ['Demo Rentals', 'Its rents comes to less than nothing.'],
      ['Demo Two Below', 'Its rents and royalties come to less than nothing.'],
      ['Example Electric', "It was paid in Federal Income Tax Withheld and Fishing Boat Proceeds, which FleetSuite doesn't fill in."],
      ['Sample Painting', "FleetSuite can't split $250.00 of what it was paid, so its boxes may be short."],
    ]);
    expect(d.byHand[3].total).toBe(5000_00);
  });

  it('says why no file can be made yet: the year isn\'t over, payments aren\'t copied, or the 1099 flags aren\'t', () => {
    const notCopied = [{ netsuite_id: '91', type: 'Check', number: 'CHK1', date: '2026-03-01' }];
    expect(due1099(year([]), 2026, { yearOver: false }).blockers).toEqual([
      "2026 isn't over yet, so who gets a 1099 can still change. Make the file in January.",
    ]);
    expect(due1099(year([], { notCopied }), 2026, { yearOver: true }).blockers).toEqual([
      "1 check or bill payment for 2026 isn't in FleetSuite's copies yet, so the totals may be short. The copies run every two hours.",
    ]);
    expect(due1099(year([], { notCopied: [notCopied[0], { ...notCopied[0], netsuite_id: '92' }] }), 2026, { yearOver: true }).blockers[0])
      .toMatch(/^2 checks and bill payments for 2026 aren't in/);
    expect(due1099(year([], { flagsCopied: false }), 2026, { yearOver: true }).blockers).toEqual([
      "NetSuite's vendors haven't been copied with their 1099 flags yet, so FleetSuite doesn't know who gets one.",
    ]);
  });
});

/** A made-up vendor record as NetSuite's REST GET gives one with its address book. */
const record = (extra: Record<string, unknown> = {}, address: Record<string, unknown> | null = {}) => ({
  id: '60',
  entityId: 'V-60',
  companyName: 'Example Electric',
  isPerson: false,
  legalName: 'Example Electric, LLC',
  taxIdNum: '***-**-6789',
  is1099Eligible: true,
  addressBook: {
    items: address === null ? [] : [{
      id: 7,
      defaultBilling: true,
      addressBookAddress: { addr1: '100 Sample St.', addr2: 'Suite #2', city: "O'Fallon", state: 'MO', zip: '63366-1234', country: { id: 'US' }, ...address },
    }],
  },
  ...extra,
});

describe("a payee's name and address as NetSuite has them", () => {
  it("takes a company's legal name, with its name when that differs, and its billing address", () => {
    const d = payeeDetails('60', record());
    expect(d).toEqual({
      payee: '60', person: false, first: '', middle: '', last: '', business: 'Example Electric, LLC', business2: 'Example Electric',
      address1: '100 Sample St.', address2: 'Suite #2', city: "O'Fallon", state: 'MO', zip: '633661234',
      hasTaxId: true, taxIdEnding: '6789', problems: [], notes: [],
    });
    expect(formName(d)).toBe('Example Electric, LLC');
    // A legal name that's its name over again isn't a second line.
    expect(payeeDetails('60', record({ legalName: 'EXAMPLE ELECTRIC' })).business2).toBe('');
    expect(payeeDetails('60', record({ legalName: '' }))).toMatchObject({ business: 'Example Electric', business2: '' });
    expect(payeeDetails('60', record({ legalName: '', companyName: '' })).problems).toEqual(['NetSuite has no company or legal name for it.']);
  });

  it("takes a person's names, and says when one is missing", () => {
    const d = payeeDetails('61', record({ isPerson: true, companyName: 'Sample Odd Jobs', firstName: 'Sam', middleName: 'Q', lastName: 'Sample' }));
    expect(d).toMatchObject({ person: true, first: 'Sam', middle: 'Q', last: 'Sample', business: '', business2: '', problems: [] });
    expect(formName(d)).toBe('Sam Q Sample');
    expect(payeeDetails('61', record({ isPerson: true, firstName: 'Sam', lastName: '' })).problems)
      .toEqual(["NetSuite doesn't have this person's first and last name."]);
    expect(payeeDetails('61', record({ isPerson: true, firstName: '', lastName: 'Sample' })).problems)
      .toEqual(["NetSuite doesn't have this person's first and last name."]);
  });

  it('says what stops an address going on a form', () => {
    expect(payeeDetails('60', record({}, null)).problems).toEqual(['NetSuite has no address for it.']);
    const two = record();
    two.addressBook.items.push({ ...two.addressBook.items[0], id: 8 });
    for (const item of two.addressBook.items) item.defaultBilling = false;
    expect(payeeDetails('60', two).problems).toEqual(['It has more than one address and none is its billing address.']);
    expect(payeeDetails('60', record({}, { country: { id: 'CA' } })).problems).toEqual(['Its billing address is outside the US: file it by hand in IRIS.']);
    expect(payeeDetails('60', record({}, { country: null })).problems).toEqual([]);
    expect(payeeDetails('60', record({}, { addr1: ' ', city: '', state: '', zip: '' })).problems).toEqual([
      'Its billing address has no street.', 'Its billing address has no city.', 'Its billing address has no state.', 'Its billing address has no ZIP.',
    ]);
    expect(payeeDetails('60', record({}, { state: 'Misouri', zip: '6336' })).problems).toEqual([
      "Its billing address's state, Misouri, isn't a US state.", "Its billing address's ZIP, 6336, isn't 5 or 9 digits.",
    ]);
    expect(payeeDetails('60', record({}, { state: 'Missouri', zip: '63366' }))).toMatchObject({ state: 'MO', zip: '63366', problems: [] });
  });

  it('says when NetSuite has no tax ID, doesn\'t say what it ends with, or no longer marks it', () => {
    expect(payeeDetails('60', record({ taxIdNum: '' })).problems).toEqual([
      'NetSuite has no tax ID for it: ask for its W-9 and put the tax ID in Vendor Details.',
    ]);
    const unsaid = payeeDetails('60', record({ taxIdNum: undefined }));
    expect(unsaid).toMatchObject({ hasTaxId: null, taxIdEnding: null, problems: [] });
    expect(unsaid.notes).toEqual(["NetSuite didn't say what its tax ID ends with, so the one used can't be checked against it."]);
    expect(payeeDetails('60', record({ is1099Eligible: false })).problems).toEqual(["NetSuite doesn't mark it to get a 1099 any more."]);
    // Only the four digits it ends with ever come back, whole or masked.
    expect(payeeDetails('60', record({ taxIdNum: '98-7654321' })).taxIdEnding).toBe('4321');
    expect(JSON.stringify(payeeDetails('60', record({ taxIdNum: '98-7654321' })))).not.toMatch(/765/);
  });
});

describe('tax IDs', () => {
  it('reads nine digits as an EIN, an SSN or an ITIN by how they are written', () => {
    expect(readTin('12-3456780')).toEqual({ digits: '123456780', looks: 'EIN' });
    expect(readTin(' 234-56-7890 ')).toEqual({ digits: '234567890', looks: 'SSN' });
    expect(readTin('912-70-1234')).toEqual({ digits: '912701234', looks: 'ITIN' });
    expect(readTin('987654320')).toEqual({ digits: '987654320', looks: null });
    for (const bad of ['12345678', '1234567890', '12-34567800', 'ab-cdefghi', '***-**-6789', '111111111', '123456789', '12-3456-789', '']) {
      expect(readTin(bad)).toBeNull();
    }
  });

  it("files nine digits alone as a person's SSN or ITIN, or a company's EIN", () => {
    expect(tinTypeOf({ digits: '234567890', looks: null }, true)).toBe('SSN');
    expect(tinTypeOf({ digits: '934567890', looks: null }, true)).toBe('ITIN');
    expect(tinTypeOf({ digits: '934567890', looks: null }, false)).toBe('EIN');
    expect(tinTypeOf({ digits: '234567890', looks: 'EIN' }, true)).toBe('EIN');
    expect(tinTypeOf({ digits: '234567890', looks: 'SSN' }, false)).toBe('SSN');
    expect(maskedTin('234567890')).toBe('•••••7890');
  });

  it("holds one against the four digits NetSuite has it ending with", () => {
    const d = payeeDetails('60', record());
    expect(checkTin(null, d)).toEqual({ ok: false, why: 'No tax ID yet: type it, or drop a NetSuite export with it.' });
    expect(checkTin({ digits: '987656789', looks: 'EIN' }, null)).toEqual({ ok: false, why: 'Check it in NetSuite first.' });
    expect(checkTin({ digits: '987656789', looks: 'EIN' }, d)).toEqual({ ok: true, why: "Ends 6789, as NetSuite's does." });
    expect(checkTin({ digits: '987651234', looks: 'EIN' }, d)).toEqual({ ok: false, why: 'It ends 1234, and the one NetSuite has ends 6789.' });
    expect(checkTin({ digits: '987651234', looks: 'EIN' }, { ...d, taxIdEnding: null }))
      .toEqual({ ok: true, why: "Ends 1234. NetSuite didn't say what its ends with." });
  });

  it('knows a tax ID heading', () => {
    for (const h of ['Tax ID', 'TIN', 'SSN/EIN', 'Federal ID', 'Taxpayer ID Number', 'Tax Number', 'Recipient TIN', 'FEIN', 'Tax ID No.']) expect(isTinHeading(h)).toBe(true);
    for (const h of ['Vendor ID', 'Tax Year', 'Name', 'Entity ID', 'Federal Income Tax Withheld']) expect(isTinHeading(h)).toBe(false);
  });

  it("reads them from NetSuite's 1099 report, a masked one or a short one aside", () => {
    const cells = [
      ['Sample Fleet 1099-MISC Report'],
      ['January 2026 - December 2026'],
      ['Vendor', 'Legal Name', 'Tax ID', 'Nonemployee Compensation'],
      ['Example Electric', 'Example Electric, LLC', '98-7656789', '$2,500.00'],
      ['V-61 Sam Sample', '', '234-56-7890', '$3,000.00'],
      ['Demo Rentals', '', '***-**-1111', '$4,000.00'],
      ['Demo Leading Zero', '', '1234567', '$4,000.00'],
      ['Sample Typo', '', '12-345', '$100.00'],
      ['', '', '', '$9,600.00'],
    ];
    const read = readTaxIds(cells);
    expect(read.problems).toEqual([]);
    expect(read.column).toBe('Tax ID');
    expect(read.rows).toEqual([
      { label: 'Example Electric', names: ['Example Electric, LLC'], tin: { digits: '987656789', looks: 'EIN' } },
      { label: 'V-61 Sam Sample', names: [], tin: { digits: '234567890', looks: 'SSN' } },
      { label: 'Demo Leading Zero', names: [], tin: { digits: '001234567', looks: null } },
    ]);
    expect(read.unreadable).toBe(2);
    expect(read.padded).toBe(1);
  });

  it('finds a column of tax IDs no heading names, and says when it can\'t find any', () => {
    const read = readTaxIds([
      ['Name', 'Number', 'Other'],
      ['Example Electric', '98-7656789', 'x'],
      ['Demo Rentals', '***-**-1111', ''],
      ['Sample Painting', '', 'y'],
    ]);
    expect(read.column).toBe('Number');
    expect(read.rows.map((r) => r.tin.digits)).toEqual(['987656789']);

    expect(readTaxIds([['Amount', 'Tax ID'], ['1', '98-7656789']]).problems[0]).toMatch(/^Couldn't find a vendor and its tax ID/);
    expect(readTaxIds([['Vendor', 'Amount'], ['Example Electric', '12']]).problems[0]).toMatch(/^Couldn't find a vendor and its tax ID/);
    expect(readTaxIds([['Vendor', 'Tax ID'], ['Example Electric', '***-**-6789'], ['Demo Rentals', 'XX-XXX1111']]).problems)
      .toEqual(['None of its 2 tax IDs is nine digits: NetSuite may have given them masked, as ***-**-6789. Type them instead.']);
    expect(readTaxIds([['Vendor', 'Tax ID']]).problems).toEqual(['It lists no tax IDs.']);
  });

  it('finds whose each is among the year\'s payees, keeping those getting a 1099, and drops one given two', () => {
    const y = year([
      payee('60', 'Example Electric', {}, { legalName: 'Example Electric, LLC' }),
      payee('61', 'Sam Sample', {}, { entityId: 'V-61' }),
      payee('62', 'Demo Rentals', {}),
    ], { notMarked: [payee('70', 'Sample Not Marked', {})] });
    const found = matchTins({
      rows: [
        { label: 'EXAMPLE ELECTRIC LLC', names: [], tin: { digits: '987656789', looks: 'EIN' } },
        { label: 'V-61 Sam Sample', names: [], tin: { digits: '234567890', looks: 'SSN' } },
        { label: 'Sam Sample', names: [], tin: { digits: '234567890', looks: 'SSN' } },
        { label: 'Demo Rentals', names: [], tin: { digits: '987650001', looks: 'EIN' } },
        { label: 'Demo Rentals', names: [], tin: { digits: '987650002', looks: 'EIN' } },
        { label: 'Demo Rentals', names: [], tin: { digits: '987650003', looks: 'EIN' } },
        { label: 'Sample Not Marked', names: [], tin: { digits: '987650004', looks: 'EIN' } },
        { label: 'Nobody Known', names: [], tin: { digits: '987650005', looks: 'EIN' } },
      ],
      column: 'Tax ID', unreadable: 0, padded: 0, problems: [],
    }, y, new Set(['60', '61', '62']));
    expect([...found.byPayee]).toEqual([['60', { digits: '987656789', looks: 'EIN' }], ['61', { digits: '234567890', looks: 'SSN' }]]);
    expect(found.twice).toEqual(['62']);
    expect(found.unmatched).toBe(2);
  });
});

describe('what the IRS takes', () => {
  it('cleans names, streets and cities to the letters the IRS takes', () => {
    expect(nameLine('  Example Electric, L.L.C. #2 / Sons & Co (MO) ')).toBe("Example Electric LLC 2 Sons & Co (MO)");
    expect(nameLine("Café O'Brien")).toBe("Cafe O'Brien");
    expect(personName('Mary-Jo  O\'Neil Jr.')).toBe("Mary-Jo O'Neil Jr");
    expect(personName('Sam2')).toBe('Sam');
    expect(streetLine('100 Sample St., Suite #2')).toBe('100 Sample St Suite 2');
    expect(streetLine('12 1/2 Main Rd · Unit B-4')).toBe('12 1/2 Main Rd Unit B-4');
    expect(cityName("O'Fallon")).toBe('O Fallon');
    expect(cityName('St. Louis')).toBe('St Louis');
    expect(cityName('Winston-Salem 2')).toBe('Winston Salem');
  });

  it('knows states, ZIPs, phones and amounts', () => {
    expect(stateCode('mo')).toBe('MO');
    expect(stateCode(' Missouri ')).toBe('MO');
    expect(stateCode('New York')).toBe('NY');
    expect(stateCode('District of Columbia')).toBe('DC');
    expect(stateCode('Puerto Rico')).toBe('PR');
    expect(stateCode('ZZ')).toBeNull();
    expect(stateCode('Ontario')).toBeNull();
    expect(stateCode('')).toBeNull();
    expect(zipOf('63366')).toBe('63366');
    expect(zipOf('63366-1234')).toBe('633661234');
    expect(zipOf('6336')).toBeNull();
    expect(zipOf('63366-12')).toBeNull();
    expect(phoneOf('+1 (636) 555-0100')).toBe('6365550100');
    expect(phoneOf('636.555.0100')).toBe('6365550100');
    expect(phoneOf('555-0100')).toBeNull();
    expect(phoneOf('2 636 555 0100')).toBeNull();
    expect(amountText(0)).toBe('0.00');
    expect(amountText(5)).toBe('0.05');
    expect(amountText(123456)).toBe('1234.56');
  });
});

const NEC_HEADINGS = [
  'Form Type', 'Tax Year', 'Payer TIN Type', 'Payer TIN', 'Payer Business or Entity Name Line 1', 'Payer Business or Entity Name Line 2',
  'Payer First Name', 'Payer Middle Name', 'Payer Last Name (Surname)', 'Payer Suffix', 'Payer Address Line 1', 'Payer Address Line 2',
  'Payer City/Town', 'Payer State/Province/Territory', 'Payer ZIP/Postal Code', 'Payer Country', 'Payer Phone Number', 'Payer Email Address',
  'Recipient TIN Type', 'Recipient TIN', 'Recipient Business or Entity Name Line 1', 'Recipient Business or Entity Name Line 2',
  'Recipient First Name', 'Recipient Middle Name', 'Recipient Last Name (Surname)', 'Recipient Suffix', 'Recipient Country',
  'Recipient Address Line 1', 'Recipient Address Line 2', 'Recipient City/Town', 'Recipient State/Province/Territory',
  'Recipient ZIP/Postal Code', 'Office Code', 'Account Number', '2nd TIN Notice', 'Box 1 - Nonemployee Compensation',
  'Box 2 - Payer made direct sales totaling $5,000 or more', 'Box 3 - Excess Golden Parachute Payments', 'Box 4 - Federal Income Tax Withheld',
  'Box 5 - State Tax Withheld', "Box 6 - State/Payer's State No.", 'Box 7 - State Income',
];

const keys = (fills: ColumnFill[]) => fills.map(fillKey);

describe("reading the IRS's template", () => {
  it('reads what goes under each heading of a 1099-NEC template', () => {
    expect(keys(readHeadings(NEC_HEADINGS, 'NEC'))).toEqual([
      'form', 'year', 'payer.tinType', 'payer.tin', 'payer.name1', 'payer.name2',
      'payer.first', 'payer.middle', 'payer.last', 'payer.suffix', 'payer.address1', 'payer.address2',
      'payer.city', 'payer.state', 'payer.zip', 'payer.country', 'payer.phone', 'payer.email',
      'recipient.tinType', 'recipient.tin', 'recipient.name1', 'recipient.name2',
      'recipient.first', 'recipient.middle', 'recipient.last', 'recipient.suffix', 'recipient.country',
      'recipient.address1', 'recipient.address2', 'recipient.city', 'recipient.state',
      'recipient.zip', 'blank', 'account', 'blank', 'box.1',
      'blank', 'blank', 'blank',
      'blank', 'blank', 'blank',
    ]);
  });

  it("reads a 1099-MISC template's boxes by what they're for, whatever their numbers", () => {
    const fills = readHeadings([
      'Box 1 - Rents', 'Box 2 - Royalties', 'Box 3 - Other Income', 'Box 4 - Federal Income Tax Withheld', 'Box 5 - Fishing Boat Proceeds',
      'Box 6 - Medical & Health Care Payments', 'Box 7 - Payer made direct sales', 'Box 9 - Crop Insurance Proceeds',
      'Box 11 - Gross Proceeds Paid to an Attorney', 'FATCA Filing Requirement', 'Box 12 - Section 409A Deferrals', 'Rents Amount',
      'Nonemployee Compensation',
    ], 'MISC');
    expect(keys(fills)).toEqual([
      'box.1', 'box.2', 'box.3', 'blank', 'blank', 'box.6', 'blank', 'blank', 'box.10', 'blank', 'blank', 'box.1', 'blank',
    ]);
  });

  it('matches a box by its number when the heading has nothing else, or cuts its name short', () => {
    expect(keys(readHeadings(['Box 1', 'Box 1 Nonemployee comp.', 'Box 2', 'Box 1 Something else', 'Nonemployee Comp'], 'NEC')))
      .toEqual(['box.1', 'box.1', 'blank', 'blank', 'box.1']);
    expect(keys(readHeadings(['Box 10', 'Box 6 medical', 'Rent'], 'MISC'))).toEqual(['box.10', 'box.6', 'blank']);
  });

  it('takes a heading naming no party as the party before it, or the recipient', () => {
    expect(keys(readHeadings(['Name', 'Address', 'City', 'State', 'ZIP', 'TIN'], 'NEC'))).toEqual([
      'recipient.name1', 'recipient.address1', 'recipient.city', 'recipient.state', 'recipient.zip', 'recipient.tin',
    ]);
    expect(keys(readHeadings(["Filer's Name", 'Street Address', 'City', "Payee's Name", 'Address Line 2', 'E-mail', 'Telephone'], 'NEC'))).toEqual([
      'payer.name1', 'payer.address1', 'payer.city', 'recipient.name1', 'recipient.address2', 'recipient.email', 'recipient.phone',
    ]);
    expect(keys(readHeadings(['Issuer TIN', 'Payee TIN', 'Payee Taxpayer Identification Number', 'Recipient Tax ID'], 'NEC')))
      .toEqual(['payer.tin', 'recipient.tin', 'recipient.tin', 'recipient.tin']);
  });

  it('leaves blank what it knows and leaves alone, and what it can\'t tell', () => {
    const fills = readHeadings([
      'Corrected', 'Void', 'Foreign Address Indicator', 'Payer Address Type', 'Recipient Name Control', 'Payer Phone Type',
      "Payer's State No.", 'State Income', 'State Tax ID', 'Recipient Foreign Country', 'Form', 'Something Else', '', 'Combined Federal/State Filing',
    ], 'NEC');
    expect(fills).toEqual([
      { kind: 'blank', read: true }, { kind: 'blank', read: true }, { kind: 'blank', read: true }, { kind: 'blank', read: true },
      { kind: 'blank', read: true }, { kind: 'blank', read: true }, { kind: 'blank', read: true }, { kind: 'blank', read: true },
      { kind: 'blank', read: true }, { kind: 'party', party: 'recipient', field: 'country' }, { kind: 'form' },
      { kind: 'blank', read: false }, { kind: 'blank', read: false }, { kind: 'blank', read: true },
    ]);
  });

  it('finds the headings, with whatever is above them, and keeps the rows under them out', () => {
    const t = 'Download this template from IRIS\r\n"Form Type","Tax Year","Recipient TIN","Recipient Name","Recipient City, Town","Recipient ZIP"\r\n1099-NEC,2026,,,,\r\n,,,,,\r\n';
    const { template, problems } = readTemplate(t, 'nec.csv', true);
    expect(problems).toEqual([]);
    expect(template).toEqual({
      name: 'nec.csv',
      head: 'Download this template from IRIS\r\n"Form Type","Tax Year","Recipient TIN","Recipient Name","Recipient City, Town","Recipient ZIP"\r\n',
      headings: ['Form Type', 'Tax Year', 'Recipient TIN', 'Recipient Name', 'Recipient City, Town', 'Recipient ZIP'],
      below: [['1099-NEC', '2026', '', '', '', '']],
      newline: '\r\n',
      bom: true,
    });
    const bare = readTemplate('Recipient TIN,Recipient Name,Recipient ZIP', 'x.csv', false).template;
    expect(bare?.head).toBe('Recipient TIN,Recipient Name,Recipient ZIP\n');
    expect(bare?.below).toEqual([]);
    expect(readTemplate('a,b,c\n1,2,3\n', 'x.csv', false)).toEqual({
      template: null,
      problems: ["Couldn't find the template's headings: a row naming the recipient's tax ID, name and address. Use the CSV template IRIS gives for the form."],
    });
    // Three columns read, none of them the recipient's, isn't the headings.
    expect(readTemplate('Payer TIN,Payer Name,Payer ZIP\n', 'x.csv', false).template).toBeNull();
    expect(readTemplate('Recipient TIN,Recipient Name\n', 'x.csv', false).template).toBeNull();
  });

  it('reads CSV records with quotes and line endings, and where each ends', () => {
    const t = 'a,"b,c","say ""hi"""\r\nd,"two\nlines"\ne,';
    expect(csvRecords(t)).toEqual([
      { cells: ['a', 'b,c', 'say "hi"'], end: 22 },
      { cells: ['d', 'two\nlines'], end: 36 },
      { cells: ['e', ''], end: 38 },
    ]);
    expect(csvRecords('')).toEqual([]);
    expect(csvRecords('x\n')).toEqual([{ cells: ['x'], end: 2 }]);
  });
});

const PAYER: Payer = {
  name: 'Sample Fleet Installations, LLC', name2: '', address1: '100 Example Dr.', address2: '', city: "O'Fallon", state: 'MO',
  zip: '63366', phone: '(636) 555-0100', email: 'books@example.com', tin: '98-7600001',
};

const details = (extra: Partial<PayeeDetails> = {}): PayeeDetails => ({
  payee: '60', person: false, first: '', middle: '', last: '', business: 'Example Electric, LLC', business2: 'Example Electric',
  address1: '100 Sample St.', address2: 'Suite #2', city: "O'Fallon", state: 'MO', zip: '633661234',
  hasTaxId: true, taxIdEnding: '6789', problems: [], notes: [], ...extra,
});

const COMPANY: FileRow = {
  form: { form: 'NEC', payee: '60', name: 'Example Electric', legalName: 'Example Electric, LLC', boxes: { 1: 2500_00 }, total: 2500_00 },
  details: details(),
  tin: { digits: '987656789', looks: 'EIN' },
  tinType: 'EIN',
};
const PERSON: FileRow = {
  form: { form: 'NEC', payee: '61', name: 'Sam Sample', legalName: null, boxes: { 1: 3000_05 }, total: 3000_05 },
  details: details({ payee: '61', person: true, first: 'Sam', middle: 'Q.', last: "O'Sample", business: '', business2: '', address1: '2 Demo Rd', address2: '', city: 'St. Peters', zip: '63376' }),
  tin: { digits: '234567890', looks: 'SSN' },
  tinType: 'SSN',
};

const templateOf = (headings: string[], extra: Partial<Template> = {}): Template => ({
  name: 'nec.csv', head: `${headings.map((h) => (h.includes(',') ? `"${h}"` : h)).join(',')}\n`, headings, below: [], newline: '\n', bom: false, ...extra,
});

describe('filling in the template', () => {
  it('fills each column for each form, the template\'s own headings first, exactly as they came', () => {
    const t = templateOf(NEC_HEADINGS);
    const fills = readHeadings(t.headings, 'NEC');
    const { files, problems } = makeFiles(t, fills, 'NEC', 2026, PAYER, [COMPANY, PERSON], { dashes: false }, '2026-1099-NEC-SAMPLE');
    expect(problems).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('2026-1099-NEC-SAMPLE.csv');
    expect(files[0].forms).toBe(2);
    const lines = files[0].text.split('\n');
    expect(lines[0]).toBe(t.head.trimEnd());
    expect(lines[3]).toBe('');
    expect(lines).toHaveLength(4);
    const row = (i: number) => Object.fromEntries(csvRecords(lines[i])[0].cells.map((c, n) => [NEC_HEADINGS[n], c]));
    expect(row(1)).toEqual({
      'Form Type': '1099-NEC', 'Tax Year': '2026', 'Payer TIN Type': 'EIN', 'Payer TIN': '987600001',
      'Payer Business or Entity Name Line 1': 'Sample Fleet Installations LLC', 'Payer Business or Entity Name Line 2': '',
      'Payer First Name': '', 'Payer Middle Name': '', 'Payer Last Name (Surname)': '', 'Payer Suffix': '',
      'Payer Address Line 1': '100 Example Dr', 'Payer Address Line 2': '', 'Payer City/Town': 'O Fallon',
      'Payer State/Province/Territory': 'MO', 'Payer ZIP/Postal Code': '63366', 'Payer Country': '', 'Payer Phone Number': '6365550100',
      'Payer Email Address': 'books@example.com',
      'Recipient TIN Type': 'EIN', 'Recipient TIN': '987656789', 'Recipient Business or Entity Name Line 1': 'Example Electric LLC',
      'Recipient Business or Entity Name Line 2': 'Example Electric', 'Recipient First Name': '', 'Recipient Middle Name': '',
      'Recipient Last Name (Surname)': '', 'Recipient Suffix': '', 'Recipient Country': '', 'Recipient Address Line 1': '100 Sample St',
      'Recipient Address Line 2': 'Suite 2', 'Recipient City/Town': 'O Fallon', 'Recipient State/Province/Territory': 'MO',
      'Recipient ZIP/Postal Code': '633661234', 'Office Code': '', 'Account Number': '60', '2nd TIN Notice': '',
      'Box 1 - Nonemployee Compensation': '2500.00', 'Box 2 - Payer made direct sales totaling $5,000 or more': '',
      'Box 3 - Excess Golden Parachute Payments': '', 'Box 4 - Federal Income Tax Withheld': '', 'Box 5 - State Tax Withheld': '',
      "Box 6 - State/Payer's State No.": '', 'Box 7 - State Income': '',
    });
    // A person goes in the name columns of their own, the business name lines blank.
    expect(row(2)).toMatchObject({
      'Recipient TIN Type': 'SSN', 'Recipient TIN': '234567890', 'Recipient Business or Entity Name Line 1': '',
      'Recipient Business or Entity Name Line 2': '', 'Recipient First Name': 'Sam', 'Recipient Middle Name': 'Q',
      'Recipient Last Name (Surname)': "O'Sample", 'Recipient City/Town': 'St Peters', 'Recipient ZIP/Postal Code': '63376',
      'Box 1 - Nonemployee Compensation': '3000.05', 'Account Number': '61',
    });
  });

  it("writes dashes when asked, the template's line endings and byte order mark, and a person's whole name where there are no name columns", () => {
    const t = templateOf(['Recipient TIN', 'Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient State', 'Recipient ZIP', 'Payer TIN', 'Payer Name', 'Payer Address', 'Payer City', 'Payer State', 'Payer ZIP', 'Box 1', 'Note'], { newline: '\r\n', bom: true });
    const fills = readHeadings(t.headings, 'NEC');
    fills[13] = { kind: 'same', value: 'Made, by "FleetSuite"' };
    const { files } = makeFiles(t, fills, 'NEC', 2026, { ...PAYER, zip: '63366-0001' }, [COMPANY, PERSON], { dashes: true }, 'f');
    expect(files[0].text.startsWith(`﻿${t.head}`)).toBe(true);
    const rows = files[0].text.slice(1 + t.head.length).split('\r\n');
    expect(rows).toEqual([
      '98-7656789,Example Electric LLC,100 Sample St,O Fallon,MO,63366-1234,98-7600001,Sample Fleet Installations LLC,100 Example Dr,O Fallon,MO,63366-0001,2500.00,"Made, by ""FleetSuite"""',
      '234-56-7890,Sam Q O\'Sample,2 Demo Rd,St Peters,MO,63376,98-7600001,Sample Fleet Installations LLC,100 Example Dr,O Fallon,MO,63366-0001,3000.05,"Made, by ""FleetSuite"""',
      '',
    ]);
  });

  it('makes a file for each 100 forms', () => {
    const t = templateOf(['Recipient TIN', 'Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient State', 'Recipient ZIP', 'Box 1']);
    const rows = Array.from({ length: FORMS_PER_FILE + 1 }, (_, i) => ({ ...COMPANY, form: { ...COMPANY.form, payee: String(100 + i) } }));
    const { files } = makeFiles(t, readHeadings(t.headings, 'NEC'), 'NEC', 2026, PAYER, rows, { dashes: false }, 'f');
    expect(files.map((f) => [f.name, f.forms, f.text.split('\n').length])).toEqual([['f-1-of-2.csv', 100, 102], ['f-2-of-2.csv', 1, 3]]);
  });

  it("refuses without the recipient's columns, the payer's when it has payer columns, or a box in use", () => {
    const t = templateOf(['Payer TIN', 'Recipient Name', 'Box 2 - Royalties']);
    const fills = readHeadings(t.headings, 'NEC');
    expect(fileProblems(t, fills, 'NEC', { ...PAYER, tin: '', state: 'Ontario' }, [COMPANY, PERSON])).toEqual([
      "No column is filled with the recipient's tax ID: pick it under Columns.",
      "No column is filled with the recipient's street: pick it under Columns.",
      "No column is filled with the recipient's city: pick it under Columns.",
      "No column is filled with the recipient's state: pick it under Columns.",
      "No column is filled with the recipient's ZIP: pick it under Columns.",
      "No column is filled with the payer's name: pick it under Columns.",
      "No column is filled with the payer's street: pick it under Columns.",
      "No column is filled with the payer's city: pick it under Columns.",
      "No column is filled with the payer's state: pick it under Columns.",
      "No column is filled with the payer's ZIP: pick it under Columns.",
      "Type the payer's EIN: nine digits, as 12-3456789.",
      "The payer's state isn't a US state.",
      "No column is filled with box 1, nonemployee compensation: is this the IRS's 1099-NEC template?",
    ]);
    const full = templateOf(['Recipient TIN', 'Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient State', 'Recipient ZIP', 'Box 1']);
    expect(fileProblems(full, readHeadings(full.headings, 'NEC'), 'NEC', { ...PAYER, tin: '' }, [])).toEqual(['No forms are ready to go in the file.']);
    expect(fileProblems(full, [], 'NEC', PAYER, [COMPANY])).toEqual(["The template's columns changed: drop it again."]);
    // Payer columns aren't needed when the template has none.
    expect(fileProblems(full, readHeadings(full.headings, 'NEC'), 'NEC', { ...PAYER, tin: '' }, [COMPANY, PERSON])).toEqual([]);
    expect(makeFiles(full, readHeadings(full.headings, 'NEC'), 'NEC', 2026, PAYER, [], { dashes: false }, 'f').files).toEqual([]);
    // A company needs a name line; a person their first and last names, or a name line.
    const names = templateOf(['Recipient TIN', 'Recipient First Name', 'Recipient Last Name', 'Recipient Address', 'Recipient City', 'Recipient State', 'Recipient ZIP', 'Box 1']);
    expect(fileProblems(names, readHeadings(names.headings, 'NEC'), 'NEC', PAYER, [PERSON])).toEqual([]);
    expect(fileProblems(names, readHeadings(names.headings, 'NEC'), 'NEC', PAYER, [COMPANY]))
      .toEqual(["No column is filled with the recipient's name: pick it under Columns."]);
  });

  it("goes by the template's example row for what the form and tax ID types are called, and refuses another form's", () => {
    const headings = ['Form Type', 'Recipient TIN Type', 'Recipient TIN', 'Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient State', 'Recipient ZIP', 'Box 1'];
    const t = templateOf(headings, { below: [['Form 1099-NEC', 'BUSINESS_TIN', '', '', '', '', '', '', '']] });
    const fills = readHeadings(headings, 'NEC');
    const { files } = makeFiles(t, fills, 'NEC', 2026, PAYER, [COMPANY, PERSON], { dashes: false }, 'f');
    const rows = files[0].text.split('\n').slice(1, 3).map((l) => l.split(',').slice(0, 2));
    expect(rows).toEqual([['Form 1099-NEC', 'BUSINESS_TIN'], ['Form 1099-NEC', 'INDIVIDUAL_TIN']]);
    const misc = templateOf(headings, { below: [['1099-MISC', '', '', '', '', '', '', '', '']] });
    expect(fileProblems(misc, fills, 'NEC', PAYER, [COMPANY]))
      .toEqual(["The template's example is a 1099-MISC form, and this is the 1099-NEC file: use the 1099-NEC template."]);
    const plain = templateOf(headings, { below: [['Sample', 'EIN', '', '', '', '', '', '', '']] });
    expect(makeFiles(plain, fills, 'NEC', 2026, PAYER, [PERSON], { dashes: false }, 'f').files[0].text.split('\n')[1].split(',').slice(0, 2))
      .toEqual(['1099-NEC', 'SSN']);
  });
});

describe('the columns on the page', () => {
  it('keys each fill for the pick list and back', () => {
    for (const f of [
      { kind: 'form' }, { kind: 'year' }, { kind: 'account' }, { kind: 'box', box: '10' }, { kind: 'party', party: 'payer', field: 'zip' },
      { kind: 'party', party: 'recipient', field: 'tinType' },
    ] as ColumnFill[]) expect(fillFromKey(fillKey(f))).toEqual(f);
    expect(fillKey({ kind: 'blank', read: false })).toBe('blank');
    expect(fillFromKey('blank')).toEqual({ kind: 'blank', read: true });
    expect(fillFromKey('same', 'US')).toEqual({ kind: 'same', value: 'US' });
    expect(fillFromKey('payer.nonsense')).toEqual({ kind: 'blank', read: true });
    expect(fillFromKey('box')).toEqual({ kind: 'blank', read: true });
    expect(fillFromKey('other')).toEqual({ kind: 'blank', read: true });
  });

  it('says what each puts in its column', () => {
    expect(fillLabel({ kind: 'box', box: '1' }, 'MISC')).toBe('Box 1, rents');
    expect(fillLabel({ kind: 'box', box: '9' }, 'MISC')).toBe('Box 9, its amount');
    expect(fillLabel({ kind: 'party', party: 'payer', field: 'tin' }, 'NEC')).toBe("The payer's tax ID");
    expect(fillLabel({ kind: 'party', party: 'recipient', field: 'name2' }, 'NEC')).toBe("The recipient's second name line");
    expect(fillLabel({ kind: 'blank', read: true }, 'NEC')).toBe('Left blank');
    expect(fillLabel({ kind: 'blank', read: false }, 'NEC')).toBe("Left blank: FleetSuite can't tell what it is");
    expect(fillLabel({ kind: 'same', value: 'x' }, 'NEC')).toBe('The same in every row');
    expect(fillLabel({ kind: 'form' }, 'NEC')).toBe('The form');
    expect(fillLabel({ kind: 'year' }, 'NEC')).toBe('The tax year');
    expect(fillLabel({ kind: 'account' }, 'NEC')).toBe("NetSuite's id for the vendor, as its account number");
    const choices = fillChoices('NEC').map((c) => c.key);
    expect(choices.slice(0, 5)).toEqual(['blank', 'same', 'form', 'year', 'box.1']);
    expect(choices).toContain('recipient.tin');
    expect(choices).toContain('payer.email');
    expect(choices).not.toContain('box.2');
    expect(fillChoices('MISC').filter((c) => c.key.startsWith('box.')).map((c) => c.key)).toEqual(['box.1', 'box.2', 'box.3', 'box.6', 'box.10']);
    expect(new Set(fillChoices('MISC').map((c) => c.key)).size).toBe(fillChoices('MISC').length);
  });

  it('shows the first form in each column, a tax ID only by the four digits it ends with', () => {
    const t = templateOf(['Recipient TIN', 'Recipient Name', 'Payer TIN', 'Box 1', 'Tax Year']);
    const fills = readHeadings(t.headings, 'NEC');
    const show = (row: FileRow | null) => fills.map((f) => previewColumn(f, row, t, fills, 'NEC', 2026, PAYER, { dashes: true }));
    expect(show(COMPANY)).toEqual(['•••••6789', 'Example Electric LLC', '•••••0001', '2500.00', '2026']);
    expect(show(null)).toEqual(['', '', '•••••0001', '', '2026']);
    expect(fills.map((f) => previewColumn(f, COMPANY, t, fills, 'NEC', 2026, { ...PAYER, tin: '' }, { dashes: true }))[2]).toBe('');
  });
});

describe('the payer', () => {
  it('says what is wrong with it as typed', () => {
    expect(payerProblems(PAYER)).toEqual([]);
    expect(payerProblems({ ...PAYER, phone: '' })).toEqual([]);
    expect(payerProblems({ name: ' ', name2: '', address1: '', address2: '', city: '', state: '', zip: '', phone: '555', email: '', tin: '12' })).toEqual([
      "Type the payer's EIN: nine digits, as 12-3456789.",
      "The payer's legal name is blank.",
      "The payer's street is blank.",
      "The payer's city is blank.",
      "The payer's state isn't a US state.",
      "The payer's ZIP isn't 5 or 9 digits.",
      "The payer's phone isn't 10 digits.",
    ]);
  });
});
