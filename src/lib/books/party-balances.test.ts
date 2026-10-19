import { describe, it, expect } from 'vitest';
import {
  copyHoldsAccounts, isParty, partyBalances, partyDetail, partyName,
  type PartyBalanceData, type PartyBalancesData, type PartyDocumentsData,
} from './party-balances';

const ACME = 'c0000000-0000-4000-8000-00000000000a';
const BRAVO = 'c0000000-0000-4000-8000-00000000000b';
const ZULU = 'c0000000-0000-4000-8000-00000000000f';

const party = (over: Partial<PartyBalanceData>): PartyBalanceData => ({
  party: ACME, name: 'Acme Fleet', netsuite_ids: ['9001'], opening: '0', netsuite: '0', fleetsuite: '0',
  documents: 1, differing: 0, members: null, members_count: null, ...over,
});

const data = (parties: PartyBalanceData[], opening = { total: '0', named: '0', complete: true }): PartyBalancesData => ({
  accounts: [{ netsuite_account_id: '120', number: '1200', name: 'Receivables' }],
  opening,
  parties,
});

describe('partyBalances', () => {
  it('reads each balance from the opening and what each side moved since, those that differ first, the largest first', () => {
    const shown = partyBalances(data([
      party({ party: '', name: null, netsuite_ids: [], opening: '100.00', netsuite: '210.00', fleetsuite: '210.00', documents: 2 }),
      party({ party: ACME, opening: '700.00', netsuite: '140.00', fleetsuite: '40.00', documents: 4, differing: 1 }),
      party({ party: BRAVO, name: 'Bravo Transit', netsuite: '500.00', fleetsuite: '500.00', documents: 2 }),
      party({ party: ZULU, name: 'Zulu Logistics', netsuite_ids: [], fleetsuite: '75.00', differing: 1 }),
    ]), 'customer');
    expect(shown.parties.map((p) => [p.name, p.opening, p.fleetsuite, p.netsuite, p.differs])).toEqual([
      ['Acme Fleet', 70000, 74000, 84000, true],
      ['Zulu Logistics', 0, 7500, 0, true],
      ['Bravo Transit', 0, 50000, 50000, false],
      // The lines FleetSuite can't name come last.
      ['Not matched to a FleetSuite customer', 10000, 31000, 31000, false],
    ]);
    expect(shown).toMatchObject({ kind: 'customer', differing: 2, unsplit: 0, openingComplete: true, totals: { fleetsuite: 162500, netsuite: 165000 } });
    expect(shown.accounts).toEqual([{ number: '1200', name: 'Receivables' }]);
  });

  it('reads a vendor as what it is owed, and names one NetSuite has no name for by its id', () => {
    const shown = partyBalances(data([
      party({ party: '7001', name: 'Landlord LLC', netsuite_ids: ['7001'], opening: '-300.00', netsuite: '-150.00', fleetsuite: '0' }),
      party({ party: '7002', name: null, netsuite_ids: ['7002'], netsuite: '-90.00', fleetsuite: '-90.00' }),
    ], { total: '-300.00', named: '-300.00', complete: true }), 'vendor');
    expect(shown.parties.map((p) => [p.name, p.opening, p.fleetsuite, p.netsuite])).toEqual([
      ['Landlord LLC', 30000, 30000, 45000],
      ['NetSuite vendor 7002', 0, 9000, 9000],
    ]);
    expect(shown.totals).toEqual({ fleetsuite: 39000, netsuite: 54000 });
  });

  it("counts what of the starting entry isn't split by name in the totals, so they still come to the accounts' balance", () => {
    const shown = partyBalances(data([party({ opening: '100.00', netsuite: '50.00', fleetsuite: '50.00' })], { total: '800.00', named: '100.00', complete: false }), 'customer');
    expect(shown).toMatchObject({ unsplit: 70000, openingComplete: false, totals: { fleetsuite: 85000, netsuite: 85000 } });
  });

  it("lists NetSuite's names among the customers FleetSuite can't name, with what each owes there", () => {
    const [unnamed] = partyBalances(data([party({
      party: '', name: null, netsuite_ids: [], members_count: 3,
      members: [
        { entity_id: '9004', name: 'Charlie Cab', opening: '300.00', netsuite: '250.00' },
        { entity_id: '9005', name: null, opening: '0', netsuite: '-20.00' },
        { entity_id: '', name: null, opening: '-200.00', netsuite: '-40.00' },
      ],
    })]), 'customer').parties;
    expect(unnamed.members).toEqual([
      { entityId: '9004', name: 'Charlie Cab', balance: 55000 },
      { entityId: '9005', name: 'NetSuite customer 9005', balance: -2000 },
      { entityId: '', name: 'No customer named', balance: -24000 },
    ]);
    expect(unnamed.membersCount).toBe(3);
  });

  it('reads nothing as no one', () => {
    expect(partyBalances(null, 'customer')).toMatchObject({ parties: [], totals: { fleetsuite: 0, netsuite: 0 }, differing: 0, unsplit: 0 });
  });
});

describe('partyDetail', () => {
  it('reads the balance and its documents as the balance reads, each document named and linked to its check', () => {
    const docs: PartyDocumentsData = {
      party: '7001', name: 'Landlord LLC', netsuite_ids: ['7001'], opening: '-300.00',
      documents: 2, differing: 1, netsuite: '-150.00', fleetsuite: '0',
      rows: [
        { doc: '4002', netsuite: '-150.00', fleetsuite: '0', kind: null, type: 'VendBill', number: 'BILL4002', month: '2026-09-01', date: '2026-09-06', name: 'Landlord LLC', memo: null, entry_no: null, entries: 0 },
        { doc: '4001', netsuite: '-800.00', fleetsuite: '-800.00', kind: 'vendor_bill', type: 'VendBill', number: 'BILL4001', month: '2026-09-01', date: '2026-09-05', name: 'Landlord LLC', memo: null, entry_no: 12, entries: 1 },
      ],
    };
    const shown = partyDetail(docs, 'vendor');
    expect(shown).toMatchObject({
      name: 'Landlord LLC', opening: 30000, moved: { fleetsuite: 0, netsuite: 15000 }, balance: { fleetsuite: 30000, netsuite: 45000 },
      documents: 2, differing: 1,
    });
    expect(shown.rows.map((d) => [d.type, d.number, d.fleetsuite, d.netsuite, d.only])).toEqual([
      ['Bill', 'BILL4002', 0, 15000, 'netsuite'],
      ['Bill', 'BILL4001', 80000, 80000, null],
    ]);
    expect(shown.rows[0].check).toEqual({ kind: expect.any(String), month: expect.stringMatching(/^2026-/) });
  });
});

describe('names and ids', () => {
  it('names the lines FleetSuite can\'t name, and a customer with none', () => {
    expect(partyName('customer', '', null)).toBe('Not matched to a FleetSuite customer');
    expect(partyName('vendor', '', 'ignored')).toBe('No vendor named');
    expect(partyName('customer', ACME, '  ')).toBe('Customer with no name');
    expect(partyName('customer', ACME, ' Acme ')).toBe('Acme');
  });

  it('takes a customer by its FleetSuite id and a vendor by its NetSuite id, and nothing else', () => {
    expect(isParty('customer', ACME)).toBe(true);
    expect(isParty('customer', '')).toBe(true);
    expect(isParty('customer', '9001')).toBe(false);
    expect(isParty('vendor', '7001')).toBe(true);
    expect(isParty('vendor', ACME)).toBe(false);
    expect(isParty('vendor', "7001' OR 1=1")).toBe(false);
  });
});

describe('copyHoldsAccounts', () => {
  const totals = {
    netsuite: [
      { netsuite_account_id: '120', month: '2026-09-01', debit: '500.00', credit: '0' },
      { netsuite_account_id: '400', month: '2026-09-01', debit: '0', credit: '500.00' },
    ],
    copied: [{ netsuite_account_id: '120', month: '2026-09-01', debit: '500.00', credit: '0' }],
  };

  it("holds when the copy has what NetSuite's totals say moved the accounts, whatever the other accounts", () => {
    expect(copyHoldsAccounts(totals, ['120'])).toBe(true);
    expect(copyHoldsAccounts(totals, ['120', '400'])).toBe(false);
    expect(copyHoldsAccounts({ ...totals, copied: [] }, ['120', null])).toBe(false);
    expect(copyHoldsAccounts({ netsuite: [] }, ['120'])).toBeNull();
    expect(copyHoldsAccounts(null, ['120'])).toBeNull();
  });
});
