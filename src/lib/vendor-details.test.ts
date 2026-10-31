import { describe, it, expect } from 'vitest';
import {
  addressLine, billingLine, isEmail, parseDetailsVendor, planVendorDetails, taxIdOf, vendorFacts, withoutTaxId,
  type DetailsVendor, type TermsOption, type VendorAddressEdit, type VendorDetailsEdit,
} from './vendor-details';

// A vendor's details changed in FleetSuite and sent on to NetSuite (Books part 41): reading the vendor as NetSuite's
// REST GET gives it, its tax ID only ever as the four digits it ends with, and what a change sends NetSuite, keeps and
// says. Made-up data.

/** Ridge Supply Co as GET vendor/2207?expandSubResources=true answers it: two addresses, the first its billing one. */
const RECORD = {
  id: '2207', entityId: 'V-2207 Ridge Supply', companyName: 'Ridge Supply Co', isPerson: false, isInactive: false,
  email: 'ap@ridge.example', phone: '(555) 010-0100', terms: { id: '2', refName: 'Net 30' },
  is1099Eligible: false, legalName: '', taxIdNum: '98-7651111',
  addressBook: {
    items: [
      {
        id: '11', defaultBilling: true, defaultShipping: true, label: '1 Main St',
        addressBookAddress: {
          addressee: 'Ridge Supply Co', attention: '', addr1: '1 Main St', addr2: '', addr3: '', city: 'Springfield', state: 'MO',
          zip: '65801', addrPhone: '', country: { id: 'US', refName: 'United States' },
        },
      },
      {
        id: '12', defaultBilling: false, defaultShipping: false, label: 'Warehouse',
        addressBookAddress: {
          addressee: 'Ridge Supply Co', attention: 'Receiving', addr1: '9 Dock Rd', addr2: 'Bay 4', addr3: 'Gate B', city: 'Springfield',
          state: 'MO', zip: '65802', addrPhone: '555-010-0199', country: { id: 'US' },
        },
      },
    ],
  },
};
const TERMS: ReadonlyMap<string, TermsOption> = new Map([
  ['1', { id: '1', name: 'Due on receipt' }],
  ['2', { id: '2', name: 'Net 30' }],
  ['3', { id: '3', name: 'Net 45' }],
]);
const MAIN = 'Ridge Supply Co, 1 Main St, Springfield, MO 65801';
const DOCK = 'Ridge Supply Co, Attn Receiving, 9 Dock Rd, Bay 4, Springfield, MO 65802';

const vendor = parseDetailsVendor(RECORD);
const plan = (edit: Partial<VendorDetailsEdit>, v: DetailsVendor = vendor) => planVendorDetails(v, { reason: 'New W-9', ...edit }, { terms: TERMS });
/** The warehouse address as typed, its street changed. */
const DOCK_MOVED: VendorAddressEdit = {
  lineId: '12', addressee: 'Ridge Supply Co', attention: 'Receiving', addr1: '11 Dock Rd', addr2: 'Bay 4', city: 'Springfield', state: 'MO', zip: '65802',
};
/** The address added: its remit address. */
const PO_BOX: VendorAddressEdit = { lineId: 'new', addressee: '', attention: '', addr1: 'PO Box 100', addr2: '', city: 'Springfield', state: 'MO', zip: '65801' };

describe('parseDetailsVendor', () => {
  it('reads the vendor, its tax ID only as the four digits it ends with', () => {
    expect(vendor).toEqual({
      id: '2207', name: 'Ridge Supply Co', entityId: 'V-2207 Ridge Supply', isPerson: false, inactive: false,
      email: 'ap@ridge.example', phone: '(555) 010-0100', termsId: '2', termsName: 'Net 30', is1099: false, legalName: '',
      hasTaxId: true, taxIdEnding: '1111',
      addresses: [
        {
          lineId: '11', defaultBilling: true, defaultShipping: true, label: '1 Main St', addressee: 'Ridge Supply Co', attention: '',
          addr1: '1 Main St', addr2: '', city: 'Springfield', state: 'MO', zip: '65801', addr3: '', addrPhone: '', country: 'US',
        },
        {
          lineId: '12', defaultBilling: false, defaultShipping: false, label: 'Warehouse', addressee: 'Ridge Supply Co', attention: 'Receiving',
          addr1: '9 Dock Rd', addr2: 'Bay 4', city: 'Springfield', state: 'MO', zip: '65802', addr3: 'Gate B', addrPhone: '555-010-0199', country: 'US',
        },
      ],
    });
    expect(JSON.stringify(vendor)).not.toMatch(/98-?765/);
  });

  it('reads a person, the flags NetSuite writes as T and F, and what NetSuite leaves out', () => {
    expect(parseDetailsVendor({
      id: 2208, isPerson: 'T', firstName: ' Pat ', lastName: 'Example', entityId: 'Pat Example', isInactive: 'T', is1099Eligible: 'T',
      taxIdNum: '***-**-4321', email: null, phone: { value: '5550100' },
    })).toEqual({
      id: '2208', name: 'Pat Example', entityId: 'Pat Example', isPerson: true, inactive: true, email: '', phone: '',
      termsId: null, termsName: null, is1099: true, legalName: '', hasTaxId: true, taxIdEnding: '4321', addresses: [],
    });
    const plain = parseDetailsVendor({ id: '2209', entityId: 'V-2209', isPerson: 'F', isInactive: 'F', is1099Eligible: 'F', taxIdNum: '' });
    expect(plain).toMatchObject({ name: 'V-2209', isPerson: false, inactive: false, is1099: false, hasTaxId: false, taxIdEnding: null });
    expect(parseDetailsVendor({ id: '2210', is1099Eligible: 'yes', taxIdNum: null })).toMatchObject({
      name: 'Vendor 2210', is1099: null, hasTaxId: false, taxIdEnding: null,
    });
    expect(parseDetailsVendor({ id: '2211' })).toMatchObject({ is1099: null, hasTaxId: null, taxIdEnding: null });
    // Masked out altogether it has one, and no four digits to show; read whole, the four it ends with.
    expect(parseDetailsVendor({ id: '2211', taxIdNum: '*********' })).toMatchObject({ hasTaxId: true, taxIdEnding: null });
    expect(parseDetailsVendor({ id: '2211', taxIdNum: '***-**-*789' })).toMatchObject({ hasTaxId: true, taxIdEnding: null });
    expect(parseDetailsVendor({ id: '2211', taxIdNum: '12-34567-89 ' })).toMatchObject({ hasTaxId: true, taxIdEnding: '6789' });
    expect(parseDetailsVendor({ id: '2212', firstName: 'Pat' }).name).toBe('Pat');
    expect(parseDetailsVendor(null)).toMatchObject({ id: '', name: 'Vendor ', entityId: '', addresses: [] });
  });

  it('reads its terms as NetSuite gives them, or none', () => {
    expect(parseDetailsVendor({ id: '2213', terms: '3' })).toMatchObject({ termsId: '3', termsName: null });
    expect(parseDetailsVendor({ id: '2213', terms: { id: 3 } })).toMatchObject({ termsId: '3', termsName: null });
    expect(parseDetailsVendor({ id: '2213', terms: { id: 'x', refName: 'Net 30' } })).toMatchObject({ termsId: null, termsName: 'Net 30' });
    expect(parseDetailsVendor({ id: '2213', terms: null })).toMatchObject({ termsId: null, termsName: null });
  });

  it('reads each address, whichever way NetSuite spells it, and knows a line it gave no id', () => {
    const v = parseDetailsVendor({
      id: '2214',
      addressBook: {
        items: [
          { internalId: 21, addressbookAddress: { addr1: '5 Elm St', city: 'Joplin', state: { id: 'MO', refName: 'MO' }, country: 'US' } },
          { defaultBilling: 'T', defaultShipping: 'F', addressbookaddress: { addr1: '7 Oak St', city: 'Rolla', zip: 65401 } },
          { id: ' ', label: 'Old', addressBookAddress: { addr1: { text: '9 Ash St' }, city: 'Lebanon' } },
          { id: '24', defaultBilling: 'F', defaultShipping: 'T' },
        ],
      },
    });
    expect(v.addresses).toEqual([
      {
        lineId: '21', defaultBilling: false, defaultShipping: false, label: '', addressee: '', attention: '', addr1: '5 Elm St', addr2: '',
        city: 'Joplin', state: 'MO', zip: '', addr3: '', addrPhone: '', country: 'US',
      },
      {
        lineId: null, defaultBilling: true, defaultShipping: false, label: '', addressee: '', attention: '', addr1: '7 Oak St', addr2: '',
        city: 'Rolla', state: '', zip: '65401', addr3: '', addrPhone: '', country: null,
      },
      {
        lineId: null, defaultBilling: false, defaultShipping: false, label: 'Old', addressee: '', attention: '', addr1: '', addr2: '',
        city: 'Lebanon', state: '', zip: '', addr3: '', addrPhone: '', country: null,
      },
      {
        lineId: '24', defaultBilling: false, defaultShipping: true, label: '', addressee: '', attention: '', addr1: '', addr2: '',
        city: '', state: '', zip: '', addr3: '', addrPhone: '', country: null,
      },
    ]);
    expect(parseDetailsVendor({ id: '2215', addressBook: { items: 'none' } }).addresses).toEqual([]);
    expect(parseDetailsVendor({ id: '2215', addressBook: null }).addresses).toEqual([]);
  });
});

describe('vendorFacts', () => {
  it('changes with anything a change is worked out from', () => {
    const facts = vendorFacts(vendor);
    expect(vendorFacts(parseDetailsVendor(RECORD))).toBe(facts);
    const line = (i: number, over: Record<string, unknown>) => ({ ...vendor, addresses: vendor.addresses.map((a, j) => (j === i ? { ...a, ...over } : a)) });
    const changed: DetailsVendor[] = [
      { ...vendor, id: '2208' }, { ...vendor, name: 'Ridge Supply' }, { ...vendor, email: 'sales@ridge.example' }, { ...vendor, phone: '555-010-0200' },
      { ...vendor, termsId: '3' }, { ...vendor, is1099: true }, { ...vendor, is1099: null }, { ...vendor, legalName: 'Ridge Supply LLC' },
      { ...vendor, hasTaxId: null }, { ...vendor, taxIdEnding: '2222' }, { ...vendor, addresses: vendor.addresses.slice(1) },
      line(0, { lineId: '13' }), line(0, { defaultBilling: false }), line(0, { defaultShipping: false }), line(1, { addressee: 'Ridge' }),
      line(1, { attention: 'Pat' }), line(1, { addr1: '11 Dock Rd' }), line(1, { addr2: 'Bay 5' }), line(1, { city: 'Joplin' }),
      line(1, { state: 'KS' }), line(1, { zip: '65803' }), line(1, { addr3: 'Gate C' }), line(1, { addrPhone: '' }), line(1, { country: 'CA' }),
    ];
    for (const v of changed) expect(vendorFacts(v)).not.toBe(facts);
    // A label alone, or its terms' name, changes nothing a change sends.
    expect(vendorFacts(line(1, { label: 'Dock' }))).toBe(facts);
    expect(vendorFacts({ ...vendor, termsName: 'Net 30 days' })).toBe(facts);
  });

  it('holds its tax ID only as the four digits it ends with', () => {
    expect(vendorFacts(vendor)).toContain('"1111"');
    expect(vendorFacts(parseDetailsVendor({ ...RECORD, taxIdNum: '123456789' }))).not.toMatch(/12345/);
  });
});

describe('addressLine', () => {
  it('says an address on one line, leaving out what it has none of', () => {
    expect(addressLine(vendor.addresses[0])).toBe(MAIN);
    expect(addressLine(vendor.addresses[1])).toBe(DOCK);
    expect(addressLine({ addr1: 'PO Box 100', city: 'Springfield', zip: '65801' })).toBe('PO Box 100, Springfield, 65801');
    expect(addressLine({ addr1: 'PO Box 100', state: 'MO' })).toBe('PO Box 100, MO');
    expect(addressLine({ attention: 'Pat' })).toBe('Attn Pat');
    expect(addressLine({})).toBe('(blank)');
  });
});

describe('billingLine', () => {
  it('is the address marked, or the only one, and none when it can\'t be told', () => {
    expect(billingLine(vendor)?.lineId).toBe('11');
    const unmarked = vendor.addresses.map((a) => ({ ...a, defaultBilling: false }));
    expect(billingLine({ ...vendor, addresses: unmarked })).toBeNull();
    expect(billingLine({ ...vendor, addresses: unmarked.slice(1) })?.lineId).toBe('12');
    expect(billingLine({ ...vendor, addresses: vendor.addresses.map((a) => ({ ...a, defaultBilling: true })) })).toBeNull();
    expect(billingLine({ ...vendor, addresses: [] })).toBeNull();
  });
});

describe('taxIdOf and isEmail', () => {
  it('takes a tax ID as nine digits, written as an EIN, an SSN or plain', () => {
    expect(taxIdOf('12-3456789')).toBe('12-3456789');
    expect(taxIdOf('123-45-6789')).toBe('123-45-6789');
    expect(taxIdOf(' 123 456 789 ')).toBe('123456789');
    for (const typed of ['1234-56789', '12-345678', '12-34567890', '12345678', '1234567890', 'ab-cdefghi', '12--3456789', '']) {
      expect(taxIdOf(typed)).toBeNull();
    }
  });

  it('knows an email address', () => {
    expect(isEmail('ap@ridge.example')).toBe(true);
    for (const typed of ['ap@ridge', 'ap ridge@x.example', '@ridge.example', 'ap@.example', 'ap@ridge.']) expect(isEmail(typed)).toBe(false);
  });
});

describe('withoutTaxId', () => {
  it("takes the tax ID sent out of NetSuite's words, however they write it", () => {
    expect(withoutTaxId('Invalid value 12-3456789 for taxIdNum.', '12-3456789')).toBe('Invalid value (the tax ID) for taxIdNum.');
    expect(withoutTaxId('123456789 and 123-45-6789 and 12 3456789', '12-3456789')).toBe('(the tax ID) and (the tax ID) and (the tax ID)');
    expect(withoutTaxId('Vendor 2207 is locked.', '12-3456789')).toBe('Vendor 2207 is locked.');
    // With no tax ID sent there's nothing to take out.
    expect(withoutTaxId('Invalid value 123456789.', undefined)).toBe('Invalid value 123456789.');
    expect(withoutTaxId('Invalid value 123456789.', '(ending 6789)')).toBe('Invalid value 123456789.');
  });
});

describe('planVendorDetails', () => {
  it('changes its email and phone, or takes them off', () => {
    expect(plan({ email: ' sales@ridge.example ', phone: ' 555 010 0200 ' })).toEqual({
      body: { email: 'sales@ridge.example', phone: '555 010 0200' },
      keptBody: { email: 'sales@ridge.example', phone: '555 010 0200' },
      changes: ['Email ap@ridge.example → sales@ridge.example', 'Phone (555) 010-0100 → 555 010 0200'],
      problems: [],
      notes: [],
    });
    const off = plan({ email: ' ', phone: '' });
    expect(off.body).toEqual({ email: '', phone: '' });
    expect(off.changes).toEqual(['Email ap@ridge.example → (none)', 'Phone (555) 010-0100 → (none)']);
    const blank = { ...vendor, email: '', phone: '' };
    expect(plan({ email: 'ap@ridge.example', phone: '5550100' }, blank).changes).toEqual(['Email (none) → ap@ridge.example', 'Phone (none) → 5550100']);
    expect(plan({ email: 'ap@ridge.example ', phone: ' (555) 010-0100' }).problems).toEqual(['Nothing has changed yet.']);
  });

  it("won't send what isn't an email or a phone number", () => {
    expect(plan({ email: 'ap at ridge' }).problems).toEqual(['"ap at ridge" doesn\'t look like an email address.']);
    expect(plan({ email: `${'a'.repeat(244)}@ridge.example` }).problems).toEqual(['The email takes 254 characters at most.']);
    expect(plan({ email: `${'a'.repeat(240)}@ridge.example` }).problems).toEqual([]);
    expect(plan({ phone: '555-010' }).problems).toEqual(['"555-010" is too short to be a phone number.']);
    expect(plan({ phone: '555-0100' }).problems).toEqual([]);
    expect(plan({ phone: '5'.repeat(33) }).problems).toEqual(['The phone takes 32 characters at most.']);
    expect(plan({ phone: '5'.repeat(32) }).problems).toEqual([]);
    expect(plan({ email: 'nope', phone: '1' }).body).toEqual({});
  });

  it("changes its terms to one of NetSuite's, and won't take them off", () => {
    const net45 = plan({ termsId: '3' });
    expect(net45.body).toEqual({ terms: { id: '3' } });
    expect(net45.changes).toEqual(['Terms Net 30 → Net 45']);
    expect(plan({ termsId: '' }).problems).toEqual(["Terms can't be taken off here: pick the terms it should have."]);
    expect(plan({ termsId: '9' }).problems).toEqual(["Pick terms from NetSuite's list of them."]);
    expect(plan({ termsId: '2' }).problems).toEqual(['Nothing has changed yet.']);

    const none = { ...vendor, termsId: null, termsName: null };
    expect(plan({ termsId: '' }, none).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ termsId: '1' }, none).changes).toEqual(['Terms (none) → Due on receipt']);
    // Terms it has that the list doesn't name are said by NetSuite's name for them, the list's, or their id.
    expect(plan({ termsId: '3' }, { ...vendor, termsName: null }).changes).toEqual(['Terms Net 30 → Net 45']);
    expect(plan({ termsId: '3' }, { ...vendor, termsId: '8', termsName: 'Net 10' }).changes).toEqual(['Terms Net 10 → Net 45']);
    expect(plan({ termsId: '3' }, { ...vendor, termsId: '8', termsName: null }).changes).toEqual(['Terms Terms 8 → Net 45']);
  });

  it('changes its 1099 details, a tax ID kept only as the four digits it ends with', () => {
    const w9 = plan({ is1099: true, legalName: ' Ridge Supply LLC ', taxId: ' 12-3456789 ' });
    expect(w9.body).toEqual({ is1099Eligible: true, legalName: 'Ridge Supply LLC', taxIdNum: '12-3456789' });
    expect(w9.keptBody).toEqual({ is1099Eligible: true, legalName: 'Ridge Supply LLC', taxIdNum: '(ending 6789)' });
    expect(w9.changes).toEqual(['Gets a 1099: no → yes', 'Legal name (none) → Ridge Supply LLC', 'Tax ID ending 1111 → one ending 6789']);
    expect(w9.problems).toEqual([]);
    expect(JSON.stringify([w9.keptBody, w9.changes, w9.notes])).not.toMatch(/345/);

    expect(plan({ taxId: '123-45-6789' }).body).toEqual({ taxIdNum: '123-45-6789' });
    expect(plan({ taxId: '123-45-6789' }, { ...vendor, hasTaxId: false, taxIdEnding: null }).changes).toEqual(['Tax ID (none) → one ending 6789']);
    expect(plan({ taxId: '123-45-6789' }, { ...vendor, hasTaxId: null, taxIdEnding: null }).changes).toEqual(['Tax ID (none) → one ending 6789']);
    expect(plan({ taxId: '123-45-6789' }, { ...vendor, taxIdEnding: null }).changes).toEqual(['Tax ID on file → one ending 6789']);
    expect(plan({ taxId: '1234-56789' }).problems).toEqual(['A tax ID is nine digits, as 12-3456789 or 123-45-6789.']);
    expect(plan({ taxId: '1234-56789' }).body).toEqual({});
    expect(plan({ taxId: '  ' }).problems).toEqual(['Nothing has changed yet.']);

    expect(plan({ is1099: false }, { ...vendor, is1099: true }).changes).toEqual(['Gets a 1099: yes → no']);
    expect(plan({ is1099: true }, { ...vendor, is1099: null }).changes).toEqual(['Gets a 1099: not said → yes']);
    expect(plan({ is1099: false }).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ legalName: '' }, { ...vendor, legalName: 'Ridge Supply LLC' }).changes).toEqual(['Legal name Ridge Supply LLC → (none)']);
    expect(plan({ legalName: 'R'.repeat(101) }).problems).toEqual(['The legal name takes 100 characters at most.']);
    expect(plan({ legalName: 'R'.repeat(100) }).problems).toEqual([]);
  });

  it('says when a vendor that gets a 1099 has no tax ID for it', () => {
    const NOTE = 'It gets a 1099 and NetSuite has no tax ID for it: its 1099 needs one, from its W-9.';
    const none = { ...vendor, hasTaxId: false, taxIdEnding: null };
    expect(plan({ is1099: true }, none).notes).toEqual([NOTE]);
    expect(plan({ email: 'x@ridge.example' }, { ...none, is1099: true }).notes).toEqual([NOTE]);
    expect(plan({ is1099: true, taxId: '12-3456789' }, none).notes).toEqual([]);
    expect(plan({ is1099: false }, { ...none, is1099: true }).notes).toEqual([]);
    expect(plan({ email: 'x@ridge.example' }, none).notes).toEqual([]);
    expect(plan({ is1099: true }).notes).toEqual([]);
    // NetSuite not saying isn't NetSuite having none.
    expect(plan({ is1099: true }, { ...vendor, hasTaxId: null, taxIdEnding: null }).notes).toEqual([]);
  });

  it('changes an address by its line, sending back everything NetSuite has on it', () => {
    const moved = plan({ addresses: [DOCK_MOVED] });
    expect(moved.body).toEqual({
      addressBook: {
        items: [{
          id: '12',
          addressBookAddress: {
            addressee: 'Ridge Supply Co', attention: 'Receiving', addr1: '11 Dock Rd', addr2: 'Bay 4', city: 'Springfield', state: 'MO', zip: '65802',
            addr3: 'Gate B', addrPhone: '555-010-0199', country: { id: 'US' },
          },
        }],
      },
    });
    expect(moved.changes).toEqual([`Address ${DOCK} → Ridge Supply Co, Attn Receiving, 11 Dock Rd, Bay 4, Springfield, MO 65802`]);
    expect(moved.problems).toEqual([]);

    // Its fields typed with spaces round them are as NetSuite has them: nothing changes.
    const spaced = Object.fromEntries(Object.entries({ ...DOCK_MOVED, addr1: '9 Dock Rd' }).map(([k, v]) => [k, k === 'lineId' ? v : ` ${v} `]));
    expect(plan({ addresses: [spaced as unknown as VendorAddressEdit] }).problems).toEqual(['Nothing has changed yet.']);
    // A line NetSuite gave no country goes back without one.
    const countryless = { ...vendor, addresses: [vendor.addresses[0], { ...vendor.addresses[1], country: null }] };
    expect((plan({ addresses: [DOCK_MOVED] }, countryless).body.addressBook as any).items[0].addressBookAddress).not.toHaveProperty('country');
  });

  it("won't send an address without its street and city, too long, gone, or twice", () => {
    expect(plan({ addresses: [{ ...DOCK_MOVED, addr1: ' ' }] }).problems).toEqual([`${DOCK}: an address needs its street and city.`]);
    expect(plan({ addresses: [{ ...DOCK_MOVED, city: '' }] }).problems).toEqual([`${DOCK}: an address needs its street and city.`]);
    expect(plan({ addresses: [{ ...DOCK_MOVED, lineId: '99' }] }).problems).toEqual(['An address changed in NetSuite since this page opened. Reload it and try again.']);
    expect(plan({ addresses: [{ ...DOCK_MOVED, city: 'S'.repeat(51) }] }).problems).toEqual(["An address's city takes 50 characters at most."]);
    expect(plan({ addresses: [{ ...DOCK_MOVED, city: 'S'.repeat(50) }] }).problems).toEqual([]);
    expect(plan({ addresses: [{ ...DOCK_MOVED, zip: '6'.repeat(21) }] }).problems).toEqual(["An address's zip takes 20 characters at most."]);
    expect(plan({ addresses: [{ ...DOCK_MOVED, addressee: 'R'.repeat(101) }] }).problems).toEqual(["An address's name takes 100 characters at most."]);
    expect(plan({ addresses: [DOCK_MOVED, DOCK_MOVED] }).problems).toEqual(['An address was sent twice.']);
    expect(plan({ addresses: [DOCK_MOVED, { ...DOCK_MOVED, addr1: '1 Main St' }] }).changes).toHaveLength(1);
    expect(plan({ addresses: [{ ...DOCK_MOVED, lineId: '99' }] }).body).toEqual({});
  });

  it("adds one address, a vendor's first its billing and shipping address", () => {
    const added = plan({ addresses: [PO_BOX] });
    expect(added.body).toEqual({
      addressBook: {
        items: [{
          addressBookAddress: { addressee: '', attention: '', addr1: 'PO Box 100', addr2: '', city: 'Springfield', state: 'MO', zip: '65801', country: { id: 'US' } },
        }],
      },
    });
    expect(added.changes).toEqual(['New address: PO Box 100, Springfield, MO 65801']);

    const first = plan({ addresses: [PO_BOX] }, { ...vendor, addresses: [] });
    expect((first.body.addressBook as any).items).toEqual([{
      defaultBilling: true, defaultShipping: true,
      addressBookAddress: { addressee: '', attention: '', addr1: 'PO Box 100', addr2: '', city: 'Springfield', state: 'MO', zip: '65801', country: { id: 'US' } },
    }]);
    expect(plan({ addresses: [PO_BOX, { ...PO_BOX, addr1: 'PO Box 200' }] }).problems).toEqual(['One change adds one address at most.']);
    expect(plan({ addresses: [{ ...PO_BOX, city: ' ' }] }).problems).toEqual(['A new address needs its street and city.']);
    expect(plan({ addresses: [{ ...PO_BOX, addr1: '' }] }).problems).toEqual(['A new address needs its street and city.']);
  });

  it('marks which address is its billing address, unmarking the one before', () => {
    const dock = plan({ billingLineId: '12' });
    expect(dock.body).toEqual({ addressBook: { items: [{ id: '12', defaultBilling: true }, { id: '11', defaultBilling: false }] } });
    expect(dock.changes).toEqual([`Billing address ${MAIN} → ${DOCK}`]);

    // The line being changed too is said as typed.
    const both = plan({ addresses: [DOCK_MOVED], billingLineId: '12' });
    expect((both.body.addressBook as any).items).toEqual([
      { id: '12', addressBookAddress: expect.objectContaining({ addr1: '11 Dock Rd' }), defaultBilling: true },
      { id: '11', defaultBilling: false },
    ]);
    expect(both.changes[1]).toBe(`Billing address ${MAIN} → Ridge Supply Co, Attn Receiving, 11 Dock Rd, Bay 4, Springfield, MO 65802`);

    const box = plan({ addresses: [PO_BOX], billingLineId: 'new' });
    expect((box.body.addressBook as any).items).toEqual([
      { addressBookAddress: expect.objectContaining({ addr1: 'PO Box 100' }), defaultBilling: true },
      { id: '11', defaultBilling: false },
    ]);
    expect(box.changes).toEqual(['New address: PO Box 100, Springfield, MO 65801', `Billing address ${MAIN} → PO Box 100, Springfield, MO 65801`]);

    expect(plan({ billingLineId: 'new' }).problems).toEqual(['Add the new address to make it the billing address.']);
    expect(plan({ billingLineId: '99' }).problems).toEqual(['An address changed in NetSuite since this page opened. Reload it and try again.']);
    expect(plan({ billingLineId: '11' }).problems).toEqual(['Nothing has changed yet.']);
  });

  it("marks a billing address where none is marked, and leaves a line it can't change as it is", () => {
    const unmarked = { ...vendor, addresses: vendor.addresses.map((a) => ({ ...a, defaultBilling: false })) };
    const picked = plan({ billingLineId: '12' }, unmarked);
    expect(picked.body).toEqual({ addressBook: { items: [{ id: '12', defaultBilling: true }] } });
    expect(picked.changes).toEqual([`Billing address (none) → ${DOCK}`]);
    // Its only address, not marked: marking it says so in NetSuite.
    const only = { ...vendor, addresses: [unmarked.addresses[0]] };
    expect(plan({ billingLineId: '11' }, only).body).toEqual({ addressBook: { items: [{ id: '11', defaultBilling: true }] } });
    // Its first address, added, is its billing address already.
    const first = plan({ addresses: [PO_BOX], billingLineId: 'new' }, { ...vendor, addresses: [] });
    expect(first.changes).toEqual(['New address: PO Box 100, Springfield, MO 65801']);
    expect((first.body.addressBook as any).items).toHaveLength(1);
    // A marked line NetSuite gave no id isn't sent.
    const idless = { ...vendor, addresses: [{ ...vendor.addresses[0], lineId: null }, vendor.addresses[1]] };
    expect(plan({ billingLineId: '12' }, idless).body).toEqual({ addressBook: { items: [{ id: '12', defaultBilling: true }] } });
  });

  it('needs why, and something changed', () => {
    expect(plan({ reason: ' ', email: 'x@ridge.example' }).problems).toEqual(["Say why it's being changed."]);
    expect(plan({ reason: 'W'.repeat(301), email: 'x@ridge.example' }).problems).toEqual(["Why it's being changed takes 300 characters at most."]);
    expect(plan({ reason: ` ${'W'.repeat(300)} `, email: 'x@ridge.example' }).problems).toEqual([]);
    expect(plan({}).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ reason: '' }).problems).toEqual(["Say why it's being changed."]);
  });

  it('keeps a copy of what NetSuite is sent, not the same object', () => {
    const p = plan({ email: 'x@ridge.example' });
    expect(p.keptBody).toEqual(p.body);
    expect(p.keptBody).not.toBe(p.body);
  });
});
