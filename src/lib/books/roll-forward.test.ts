import { describe, it, expect } from 'vitest';
import { report, type ReportAccount, type ReportAmount, type ReportData } from './reports';
import { rollForward, ROLL_FORWARD_PARTS } from './roll-forward';
import type { TbAmount } from './trial-balance';

const INCOME_STATEMENT = new Set(['income', 'expense']);
const account = (id: string, ns: string | null, number: string | null, name: string, type: string, over: Partial<ReportAccount> = {}): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: null, ...over,
});
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const ns = (acct: string, month: string | undefined, cents: number): TbAmount => ({ netsuite_account_id: acct, ...sides(cents), ...(month ? { month } : {}) });
const fs = (acct: string, month: string, cents: number): ReportAmount => ({ account: acct, month, ...sides(cents) });
/** Both sides alike. */
const both = (acct: string, month: string, cents: number) => ({ netsuite: [ns(acct, month, cents)], fleetsuite: [fs(acct, month, cents)] });

/**
 * Made-up books for BMG in 2027: the shop truck from before 2025 and a box
 * van bought in June, their accumulated depreciation with the CPA's 9,600.00
 * for the year, and the truck loan, paid down 1,000.00 a month in June and
 * December, with the CPA's 412.50 of interest for the year in NetSuite's
 * books but not yet FleetSuite's.
 */
const ACCOUNTS = [
  account('a10', '10', '1010', 'First Bank checking', 'bank'),
  account('a150', '150', '1500', 'Shop truck', 'fixed_asset'),
  account('a151', '151', '1510', 'Box van', 'fixed_asset'),
  account('a159', '159', '1590', 'Accumulated depreciation', 'fixed_asset'),
  account('a152', '152', '1520', 'Trailer', 'fixed_asset'),
  account('a270', '270', '2700', 'Truck loan', 'long_term_liability'),
  account('a610', '610', '6100', 'Depreciation', 'expense'),
  account('a720', '720', '7200', 'Interest', 'expense'),
];
const MOVES = [
  both('151', '2027-06-01', 3000000), both('10', '2027-06-01', -3000000),
  both('159', '2027-12-01', -960000), both('610', '2027-12-01', 960000),
  both('270', '2027-06-01', 100000), both('10', '2027-06-01', -100000),
  both('270', '2027-12-01', 100000), both('10', '2027-12-01', -100000),
  // A month either side of 2027, on the truck.
  both('150', '2026-12-01', 50000), both('10', '2026-12-01', -50000),
  both('150', '2028-01-01', 70000), both('10', '2028-01-01', -70000),
];
const DATA: ReportData = {
  company: 'BMG',
  accounts: ACCOUNTS,
  opening: [ns('150', undefined, 4500000), ns('159', undefined, -1800000), ns('270', undefined, -3000000), ns('10', undefined, 300000)],
  netsuite: [...MOVES.flatMap((m) => m.netsuite), ns('270', '2027-12-01', -41250), ns('720', '2027-12-01', 41250)],
  fleetsuite: MOVES.flatMap((m) => m.fleetsuite),
};
const YEAR = { from: '2027-01-01', to: '2027-12-01' };

describe('fixed assets and loans for the year-end package', () => {
  it("rolls each fixed asset and long term liability account forward over the year, as the balance sheet shows it, by number", () => {
    expect(rollForward(DATA, YEAR)).toEqual([
      {
        label: 'Fixed assets',
        lines: [
          {
            key: '150', number: '1500', name: 'Shop truck', starting: { fleetsuite: 4550000, netsuite: 4550000 }, debits: 0, credits: 0,
            ending: { fleetsuite: 4550000, netsuite: 4550000 },
          },
          {
            key: '151', number: '1510', name: 'Box van', starting: { fleetsuite: 0, netsuite: 0 }, debits: 3000000, credits: 0,
            ending: { fleetsuite: 3000000, netsuite: 3000000 },
          },
          {
            key: '159', number: '1590', name: 'Accumulated depreciation', starting: { fleetsuite: -1800000, netsuite: -1800000 }, debits: 0, credits: 960000,
            ending: { fleetsuite: -2760000, netsuite: -2760000 },
          },
        ],
        total: { starting: { fleetsuite: 2750000, netsuite: 2750000 }, debits: 3000000, credits: 960000, ending: { fleetsuite: 4790000, netsuite: 4790000 } },
      },
      {
        label: 'Long term liabilities',
        lines: [{
          key: '270', number: '2700', name: 'Truck loan', starting: { fleetsuite: 3000000, netsuite: 3000000 }, debits: 200000, credits: 0,
          ending: { fleetsuite: 2800000, netsuite: 2841250 },
        }],
        total: { starting: { fleetsuite: 3000000, netsuite: 3000000 }, debits: 200000, credits: 0, ending: { fleetsuite: 2800000, netsuite: 2841250 } },
      },
    ]);
  });

  it("comes to the balance sheet's own parts at both ends", () => {
    const parts = rollForward(DATA, YEAR);
    const line = (label: string, to: string) => report(DATA, 'balance_sheet', { to }).lines.find((l) => l.label === label)!;
    for (const [part, label] of [[parts[0], 'Total fixed assets'], [parts[1], 'Total long term liabilities']] as const) {
      expect([label, part.total.ending]).toEqual([label, { fleetsuite: line(label, '2027-12-01').fleetsuite, netsuite: line(label, '2027-12-01').netsuite }]);
      expect([label, part.total.starting]).toEqual([label, { fleetsuite: line(label, '2026-12-01').fleetsuite, netsuite: line(label, '2026-12-01').netsuite }]);
    }
  });

  it('counts only the months asked for, from where the account stood before them', () => {
    const june = rollForward(DATA, { from: '2027-06-01', to: '2027-06-01' });
    expect(june[0].lines.map((l) => [l.name, l.starting.fleetsuite, l.debits, l.credits, l.ending.fleetsuite])).toEqual([
      ['Shop truck', 4550000, 0, 0, 4550000],
      ['Box van', 0, 3000000, 0, 3000000],
      ['Accumulated depreciation', -1800000, 0, 0, -1800000],
    ]);
    expect(june[1].lines[0]).toMatchObject({ starting: { fleetsuite: 3000000 }, debits: 100000, ending: { fleetsuite: 2900000, netsuite: 2900000 } });
    const truck = (range: { from: string; to: string }) => rollForward(DATA, range)[0].lines[0];
    expect(truck({ from: '2026-12-01', to: '2026-12-01' })).toMatchObject({ starting: { fleetsuite: 4500000 }, debits: 50000, ending: { fleetsuite: 4550000 } });
    expect(truck({ from: '2028-01-01', to: '2028-01-01' })).toMatchObject({ starting: { fleetsuite: 4550000 }, debits: 70000, ending: { fleetsuite: 4620000 } });
  });

  it("adds up every month's debits and credits in the range", () => {
    const data: ReportData = {
      ...DATA,
      fleetsuite: [...DATA.fleetsuite, fs('159', '2027-06-01', -480000), fs('159', '2027-09-01', 30000), fs('159', '2027-10-01', 20000)],
    };
    expect(rollForward(data, YEAR)[0].lines.find((l) => l.name === 'Accumulated depreciation')).toMatchObject({
      starting: { fleetsuite: -1800000 }, debits: 50000, credits: 1440000, ending: { fleetsuite: -3190000, netsuite: -2760000 },
    });
  });

  it("keeps a debit and a credit in the same month apart, and an account they leave where it was", () => {
    const data: ReportData = {
      ...DATA,
      fleetsuite: [...DATA.fleetsuite, { account: '152', month: '2027-03-01', debit: '800.00', credit: '800.00' }],
    };
    const trailer = rollForward(data, YEAR)[0].lines.find((l) => l.name === 'Trailer');
    expect(trailer).toEqual({
      key: '152', number: '1520', name: 'Trailer', starting: { fleetsuite: 0, netsuite: 0 }, debits: 80000, credits: 80000,
      ending: { fleetsuite: 0, netsuite: 0 },
    });
  });

  it('shows an account with a balance on one side only, at either end, and leaves out one with nothing', () => {
    const shows = (data: Partial<ReportData>) => rollForward({ ...DATA, ...data }, YEAR)[0].lines.map((l) => l.name);
    expect(shows({})).not.toContain('Trailer');
    expect(shows({ opening: [...DATA.opening, ns('152', undefined, 1)] })).toContain('Trailer');
    expect(shows({ netsuite: [...DATA.netsuite, ns('152', '2026-06-01', 1)] })).toContain('Trailer');
    // NetSuite had it when the months began and let it go in them; FleetSuite never had it.
    expect(shows({ netsuite: [...DATA.netsuite, ns('152', '2026-06-01', 1), ns('152', '2027-06-01', -1)] })).toContain('Trailer');
    expect(shows({ netsuite: [...DATA.netsuite, ns('152', '2027-06-01', 1)] })).toContain('Trailer');
    expect(shows({ fleetsuite: [...DATA.fleetsuite, fs('152', '2026-06-01', 1)] })).toContain('Trailer');
    expect(shows({ fleetsuite: [...DATA.fleetsuite, fs('152', '2027-06-01', -1)] })).toContain('Trailer');
    // Moved after the months only.
    expect(shows({ fleetsuite: [...DATA.fleetsuite, fs('152', '2028-02-01', 1)] })).not.toContain('Trailer');
  });

  it('has other assets between the two, and leaves out a part with nothing in it', () => {
    expect(ROLL_FORWARD_PARTS.map((p) => p.label)).toEqual(['Fixed assets', 'Other assets', 'Long term liabilities']);
    const data: ReportData = {
      ...DATA,
      accounts: [...ACCOUNTS, account('a180', '180', '1800', 'Loan costs', 'other_asset')],
      opening: [...DATA.opening, ns('180', undefined, 120000)],
    };
    expect(rollForward(data, YEAR).map((p) => [p.label, p.lines.map((l) => l.name)])).toEqual([
      ['Fixed assets', ['Shop truck', 'Box van', 'Accumulated depreciation']],
      ['Other assets', ['Loan costs']],
      ['Long term liabilities', ['Truck loan']],
    ]);
    expect(rollForward({ ...DATA, accounts: ACCOUNTS.filter((a) => a.account_type !== 'long_term_liability') }, YEAR).map((p) => p.label)).toEqual(['Fixed assets']);
    // A loan's current part, kept in a current liability account, is the balance sheet's current liabilities: not here.
    const current: ReportData = {
      ...DATA,
      accounts: [...ACCOUNTS, account('a210', '210', '2100', 'Truck loan, current part', 'other_current_liability')],
      opening: [...DATA.opening, ns('210', undefined, -1200000)],
    };
    expect(rollForward(current, YEAR).flatMap((p) => p.lines.map((l) => l.name))).not.toContain('Truck loan, current part');
    expect(rollForward({ ...DATA, accounts: [] }, YEAR)).toEqual([]);
  });

  it("orders accounts by number, a number's digits as a number, then by name, those with no number last", () => {
    const data: ReportData = {
      ...DATA,
      accounts: [
        account('x1', null, null, 'Land', 'fixed_asset'),
        account('x2', '902', '1500', 'Equipment', 'fixed_asset'),
        account('x3', '903', '950', 'Building', 'fixed_asset'),
        account('x4', '904', null, 'Fence', 'fixed_asset'),
        account('x5', '905', '1500', 'Computers', 'fixed_asset'),
      ],
      opening: ['902', '903', '904', '905'].map((id) => ns(id, undefined, 100)),
      fleetsuite: [fs('fs:x1', '2027-02-01', 500)],
    };
    expect(rollForward(data, YEAR)[0].lines.map((l) => [l.key, l.number, l.name])).toEqual([
      ['903', '950', 'Building'], ['905', '1500', 'Computers'], ['902', '1500', 'Equipment'], ['904', null, 'Fence'], ['fs:x1', null, 'Land'],
    ]);
    // One NetSuite doesn't have, by FleetSuite's own key.
    expect(rollForward(data, YEAR)[0].lines.at(-1)).toMatchObject({ starting: { fleetsuite: 0 }, debits: 500, ending: { fleetsuite: 500, netsuite: 0 } });
  });

  it('starts from nothing on one the chart keeps on the income statement, as the trial balance has it', () => {
    const data: ReportData = {
      ...DATA,
      accounts: [account('a155', '155', '1550', 'Tools', 'fixed_asset', { statement: 'income_statement' })],
      opening: [ns('155', undefined, 99999)],
      fleetsuite: [fs('155', '2027-04-01', 25000)],
      netsuite: [ns('155', '2027-04-01', 25000)],
    };
    expect(rollForward(data, YEAR)[0].lines).toEqual([{
      key: '155', number: '1550', name: 'Tools', starting: { fleetsuite: 0, netsuite: 0 }, debits: 25000, credits: 0,
      ending: { fleetsuite: 25000, netsuite: 25000 },
    }]);
  });
});
