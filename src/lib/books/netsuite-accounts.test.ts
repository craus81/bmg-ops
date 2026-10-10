import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: vi.fn() }));
const heartbeats: Array<{ syncType: string; result: any }> = [];
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async (_svc: unknown, syncType: string, result: unknown) => {
    heartbeats.push({ syncType, result });
    return { ok: true };
  }),
}));

import {
  ACCOUNTS_QUERY,
  ACCOUNT_SUBSIDIARIES_QUERY,
  BOOKS_ACCOUNTS_SYNC,
  SUBSIDIARIES_QUERY,
  companyFor,
  findSubsidiaryLinks,
  mapNetSuiteAccounts,
  subsidiariesByAccount,
  syncBooksAccounts,
  type CompanyRow,
} from './netsuite-accounts';

const COMPANIES: CompanyRow[] = [
  { code: 'BMG', name: 'BMG Fleet Installations', netsuite_subsidiary_id: '2' },
  { code: '1084', name: '1084 Cool Springs', netsuite_subsidiary_id: null },
];

// SuiteQL's shapes: ids as numbers or strings, booleans as 'T' / 'F'.
const ACCOUNT_ROWS = [
  { id: 110, acctnumber: '10000', acctname: 'Cash', accttype: 'Bank', parent: null, isinactive: 'F', issummary: 'T', description: null },
  { id: '111', acctnumber: '10100', acctname: 'First Bank Operating', accttype: 'Bank', parent: 110, isinactive: 'F', issummary: 'F' },
  { id: 120, acctnumber: '11000', acctname: 'Accounts Receivable', accttype: 'AcctRec', parent: null, isinactive: 'F', issummary: 'F' },
  { id: 910, acctnumber: '10900', acctname: '1084 Operating', accttype: 'Bank', parent: '', isinactive: 'T', issummary: 'F', description: ' Building account ' },
  { id: 300, acctnumber: '', acctname: '', accttype: 'Expense', parent: null, isinactive: 'F', issummary: 'F' },
  { id: 800, acctnumber: '90000', acctname: 'Estimates', accttype: 'NonPosting', parent: null, isinactive: 'F', issummary: 'F' },
  { id: 801, acctnumber: '90001', acctname: 'Purchase Orders', accttype: 'NonPosting', parent: null, isinactive: 'F', issummary: 'F' },
  { id: 850, acctnumber: '95000', acctname: 'Headcount', accttype: 'Stat', parent: null, isinactive: 'F', issummary: 'F' },
  { id: 860, acctnumber: '96000', acctname: 'Mystery', accttype: 'Brokerage', parent: null, isinactive: 'F', issummary: 'F' },
];
const MAP_ROWS = [
  { account: 110, subsidiary: 1 }, { account: 111, subsidiary: 1 }, { account: 120, subsidiary: '2' },
  { account: 120, subsidiary: '5' }, { account: 910, subsidiary: 5 }, { account: 910, subsidiary: 5 },
];
const SUBSIDIARY_ROWS = [
  { id: 1, name: 'BMG Holdings (Parent)', isinactive: 'F' },
  { id: 2, name: 'BMG Fleet Installations', isinactive: 'F' },
  { id: 5, name: '1084 Cool Springs, LLC', isinactive: 'F' },
  { id: 6, name: '1084 Cool Springs (old)', isinactive: 'T' },
];

describe('subsidiariesByAccount', () => {
  it('groups the map rows by account, once each', () => {
    expect(Object.fromEntries(subsidiariesByAccount(MAP_ROWS))).toEqual({ 110: ['1'], 111: ['1'], 120: ['2', '5'], 910: ['5'] });
  });
});

describe('companyFor', () => {
  const links = new Map([['2', 'BMG' as const], ['5', '1084' as const]]);
  it('limits an account to a company only when that company alone may use it', () => {
    expect(companyFor(['5'], links)).toBe('1084');
    expect(companyFor(['2'], links)).toBe('BMG');
    expect(companyFor(['2', '5'], links)).toBeNull();
    expect(companyFor(['1'], links)).toBeNull(); // the parent covers both
    expect(companyFor(['1', '5'], links)).toBeNull();
    expect(companyFor([], links)).toBeNull();
  });
});

describe('findSubsidiaryLinks', () => {
  it('links 1084 by name, skipping inactive and already-linked subsidiaries', () => {
    expect(findSubsidiaryLinks(SUBSIDIARY_ROWS, COMPANIES)).toEqual([{ company: '1084', subsidiary_id: '5' }]);
  });

  it('links by a numeric code alone, as a whole word', () => {
    expect(findSubsidiaryLinks([{ id: 9, name: 'Building LLC 1084', isinactive: 'F' }], COMPANIES)).toEqual([{ company: '1084', subsidiary_id: '9' }]);
    expect(findSubsidiaryLinks([{ id: 9, name: 'Unit 10845', isinactive: 'F' }], COMPANIES)).toEqual([]);
  });

  it('links nothing when the match is ambiguous or the company is already linked', () => {
    expect(findSubsidiaryLinks([
      { id: 5, name: '1084 Cool Springs LLC', isinactive: 'F' },
      { id: 7, name: '1084 Cool Springs Holdings', isinactive: 'F' },
    ], COMPANIES)).toEqual([]);
    expect(findSubsidiaryLinks(SUBSIDIARY_ROWS, COMPANIES.map((c) => ({ ...c, netsuite_subsidiary_id: c.netsuite_subsidiary_id ?? '5' })))).toEqual([]);
  });
});

describe('mapNetSuiteAccounts', () => {
  const links = new Map([['2', 'BMG' as const], ['5', '1084' as const]]);

  it('maps types, flags and parents, and leaves out non-posting and unknown types', () => {
    const { accounts, skipped, unknownTypes } = mapNetSuiteAccounts(ACCOUNT_ROWS, subsidiariesByAccount(MAP_ROWS), links);
    expect(skipped).toEqual({ NonPosting: 2, Stat: 1 });
    expect(unknownTypes).toEqual(['Brokerage']);
    expect(accounts.map((a) => a.netsuite_id)).toEqual(['110', '111', '120', '910', '300']);
    expect(accounts[0]).toEqual({
      netsuite_id: '110', number: '10000', name: 'Cash', account_type: 'bank', netsuite_type: 'Bank',
      parent_netsuite_id: null, active: true, summary: true, description: null, company: null, subsidiary_ids: ['1'],
    });
    expect(accounts[1]).toMatchObject({ parent_netsuite_id: '110', summary: false });
    expect(accounts[2]).toMatchObject({ account_type: 'accounts_receivable', company: null, subsidiary_ids: ['2', '5'] });
    expect(accounts[3]).toMatchObject({ active: false, company: '1084', parent_netsuite_id: null, description: 'Building account' });
    // No name or number in NetSuite still gives a name, and no subsidiary rows means both companies.
    expect(accounts[4]).toMatchObject({ number: null, name: 'NetSuite account 300', company: null, subsidiary_ids: [] });
  });

  it('sends no company at all when NetSuite wouldn\'t say', () => {
    const { accounts } = mapNetSuiteAccounts(ACCOUNT_ROWS, null, links);
    for (const a of accounts) {
      expect(a).not.toHaveProperty('company');
      expect(a).not.toHaveProperty('subsidiary_ids');
    }
  });
});

describe('syncBooksAccounts', () => {
  beforeEach(() => { heartbeats.length = 0; });

  const fakeService = (opts: { rpcError?: string } = {}) => {
    const rpc = vi.fn(async (_fn: string, _args: { p: any }) => (opts.rpcError
      ? { data: null, error: { message: opts.rpcError } }
      : { data: { received: 5, added: 5, changed: 0, gone: 0, issues: [] }, error: null }));
    const service = {
      from: (table: string) => {
        expect(table).toBe('gl_companies');
        return { select: async () => ({ data: COMPANIES, error: null }) };
      },
      rpc,
    };
    return { service: service as any, rpc };
  };

  const answers = (overrides: Record<string, () => any[]> = {}) => async (q: string) => {
    const table: Record<string, () => any[]> = {
      [ACCOUNTS_QUERY]: () => ACCOUNT_ROWS,
      [ACCOUNT_SUBSIDIARIES_QUERY]: () => MAP_ROWS,
      [SUBSIDIARIES_QUERY]: () => SUBSIDIARY_ROWS,
      ...overrides,
    };
    if (!table[q]) throw new Error(`unexpected query ${q}`);
    return table[q]();
  };

  it('links 1084, sends the mapped list as complete, and records the run', async () => {
    const { service, rpc } = fakeService();
    const r = await syncBooksAccounts(service, { query: answers() });
    expect(r).toMatchObject({ received: 5, added: 5, linked: [{ company: '1084', subsidiary_id: '5' }], skipped: { NonPosting: 2, Stat: 1 }, unknownTypes: ['Brokerage'] });
    expect(r.notes).toBeUndefined();
    const [, args] = rpc.mock.calls[0];
    expect(rpc.mock.calls[0][0]).toBe('gl_sync_netsuite_accounts');
    expect(args.p.complete).toBe(true);
    expect(args.p.company_subsidiaries).toEqual([{ company: '1084', subsidiary_id: '5' }]);
    expect(args.p.accounts.find((a: any) => a.netsuite_id === '910').company).toBe('1084');
    expect(heartbeats).toEqual([{ syncType: BOOKS_ACCOUNTS_SYNC, result: expect.objectContaining({ received: 5 }) }]);
  });

  it('carries on without company limits when the subsidiary reads are refused', async () => {
    const { service, rpc } = fakeService();
    const refused = () => { throw new Error('Record type AccountSubsidiaryMap not found'); };
    const r = await syncBooksAccounts(service, { query: answers({ [ACCOUNT_SUBSIDIARIES_QUERY]: refused, [SUBSIDIARIES_QUERY]: refused }) });
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([
      expect.stringMatching(/wouldn't say which subsidiaries.*AccountSubsidiaryMap not found.*stay as they were/),
      expect.stringMatching(/wouldn't list its subsidiaries/),
    ]);
    const [, args] = rpc.mock.calls[0];
    expect(args.p.company_subsidiaries).toEqual([]);
    expect(args.p.accounts[0]).not.toHaveProperty('company');
  });

  it('says when a company still isn\'t linked to a subsidiary', async () => {
    const { service } = fakeService();
    const r = await syncBooksAccounts(service, { query: answers({ [SUBSIDIARIES_QUERY]: () => [] }) });
    expect(r.notes).toEqual([expect.stringMatching(/^1084 Cool Springs isn't linked to a NetSuite subsidiary yet/)]);
  });

  it('records a refused account read or a failed apply as the run\'s error', async () => {
    const refusedAll = fakeService();
    const r1 = await syncBooksAccounts(refusedAll.service, {
      query: answers({ [ACCOUNTS_QUERY]: () => { throw new Error('INSUFFICIENT_PERMISSION'); } }),
    });
    expect(r1.error).toBe('INSUFFICIENT_PERMISSION');
    expect(refusedAll.rpc).not.toHaveBeenCalled();

    const failed = fakeService({ rpcError: 'gl: NetSuite account 111 is in the list twice' });
    const r2 = await syncBooksAccounts(failed.service, { query: answers() });
    expect(r2.error).toMatch(/in the list twice/);
    expect(heartbeats.map((h) => h.result.error)).toEqual(['INSUFFICIENT_PERMISSION', 'gl: NetSuite account 111 is in the list twice']);
  });
});
