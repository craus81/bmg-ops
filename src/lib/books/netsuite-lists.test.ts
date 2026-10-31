import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import {
  ITEM_ACCOUNTS_QUERY,
  LISTS,
  TAX_ACCOUNTS_QUERY,
  fieldQuery,
  joinWords,
  listQuery,
  mapItemAccounts,
  mapList,
  mapListRow,
  mapTaxAccounts,
  listTerms,
  namesField,
  noteItemAccountsChanged,
  noteTermsChanged,
  readList,
  recordNotFound,
  type ListDef,
  type ListKind,
} from './netsuite-lists';

const def = (kind: ListKind): ListDef => LISTS.find((d) => d.kind === kind)!;

/** A refusal shaped like SuiteQL's: HTTP 400 with NetSuite's own words. */
const refused = (detail: string) => Object.assign(
  new Error(`NetSuite SuiteQL error (400): {"o:errorDetails":[{"detail":"Invalid search query. Detailed unprocessed description follows. ${detail}"}]}`),
  { status: 400 },
);
/** What this account answers for some columns instead of refusing them. */
const unexpected = () => Object.assign(
  new Error('NetSuite SuiteQL error (500): {"title":"Internal Server Error","status":500,"o:errorDetails":[{"detail":"An unexpected error occurred. Error ID: abc123","o:errorCode":"UNEXPECTED_ERROR"}]}'),
  { status: 500 },
);

describe('the list queries', () => {
  it('reads every field, ordered by id so the pages neither skip nor repeat rows', () => {
    expect(listQuery(def('term'))).toBe(
      'SELECT r.id, r.name, r.isinactive, r.daysuntilnetdue, r.discountpercent, r.daysuntilexpiry FROM term r ORDER BY r.id',
    );
    expect(listQuery(def('class'))).toBe('SELECT r.id, r.name, r.isinactive, r.parent, r.fullname FROM classification r ORDER BY r.id');
  });

  it('leaves the tax items out of the items, but keeps the ones that never post, so the invoice rule knows them', () => {
    expect(listQuery(def('item'), [])).toBe(
      "SELECT r.id, r.itemid, r.itemtype, r.isinactive FROM item r WHERE r.itemtype NOT IN ('TaxItem', 'TaxGroup') ORDER BY r.id",
    );
  });

  it('doesn\'t ask for an item\'s COGS account, which NetSuite answers 500 for every time', () => {
    expect(listQuery(def('item'))).toBe(
      "SELECT r.id, r.itemid, r.itemtype, r.isinactive, r.displayname, r.incomeaccount, r.assetaccount, r.expenseaccount FROM item r WHERE r.itemtype NOT IN ('TaxItem', 'TaxGroup') ORDER BY r.id",
    );
  });

  it('reads one field on its own for the rows that have it', () => {
    const asset = def('item').optional.find((o) => o.field === 'assetaccount')!;
    expect(fieldQuery(def('item'), asset)).toBe(
      "SELECT r.id, r.assetaccount FROM item r WHERE (r.itemtype NOT IN ('TaxItem', 'TaxGroup')) AND r.assetaccount IS NOT NULL ORDER BY r.id",
    );
    expect(fieldQuery(def('term'), def('term').optional[0])).toBe(
      'SELECT r.id, r.daysuntilnetdue FROM term r WHERE r.daysuntilnetdue IS NOT NULL ORDER BY r.id',
    );
  });

  it('copies the lists in order, the items after the small ones and the customers last', () => {
    expect(LISTS.map((d) => d.kind)).toEqual(['location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item', 'customer']);
  });

  it('counts sales tax lines from the start of the GL copy', () => {
    expect(TAX_ACCOUNTS_QUERY).toContain("tl.taxline = 'T'");
    expect(TAX_ACCOUNTS_QUERY).toContain("t.trandate >= TO_DATE('01/01/2025', 'MM/DD/YYYY')");
    expect(TAX_ACCOUNTS_QUERY).toContain('GROUP BY tl.item, tal.account');
  });

  it('counts the invoice lines of items with no income account from the start of the GL copy, leaving out tax', () => {
    expect(ITEM_ACCOUNTS_QUERY).toContain("t.type = 'CustInvc'");
    expect(ITEM_ACCOUNTS_QUERY).toContain('i.incomeaccount IS NULL');
    expect(ITEM_ACCOUNTS_QUERY).toContain("tl.taxline = 'F'");
    expect(ITEM_ACCOUNTS_QUERY).toContain("t.trandate >= TO_DATE('01/01/2025', 'MM/DD/YYYY')");
    expect(ITEM_ACCOUNTS_QUERY).toContain('GROUP BY tl.item, i.itemid, tal.account');
  });
});

describe('reading a list NetSuite only partly gives', () => {
  it('knows the field a refusal names, quoted or after an alias, and not a word in the message', () => {
    expect(namesField(refused("Search error occurred: Field 'assetaccount' for record 'item' was not found."), 'assetaccount')).toBe(true);
    expect(namesField(refused("Unknown identifier 'r.rate'."), 'rate')).toBe(true);
    expect(namesField(refused("Search error occurred: Field 'assetaccount' for record 'item' was not found."), 'description')).toBe(false);
    expect(namesField(refused("Field 'expenseaccount' was not found."), 'account')).toBe(false);
  });

  it('knows when the role can\'t see the record at all', () => {
    expect(recordNotFound(refused("Search error occurred: Record 'classification' was not found."))).toBe(true);
    expect(recordNotFound(refused("Field 'rate' for record 'salestaxitem' was not found."))).toBe(false);
  });

  it('drops the fields NetSuite refuses one by one and reads the rest', async () => {
    const asked: string[] = [];
    const query = vi.fn(async (q: string) => {
      asked.push(q);
      if (q.includes('r.assetaccount')) throw refused("Search error occurred: Field 'assetaccount' for record 'item' was not found.");
      if (q.includes('r.expenseaccount')) throw refused("Unknown identifier 'r.expenseaccount'.");
      return [{ id: 1, itemid: 'A-1' }];
    });
    const { rows, dropped } = await readList(query, def('item'));
    expect(rows).toEqual([{ id: 1, itemid: 'A-1' }]);
    expect(dropped.map((o) => o.field)).toEqual(['assetaccount', 'expenseaccount']);
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain('r.displayname, r.incomeaccount FROM item');
  });

  it('reads field by field when the refusal names no field, and fails if the required fields are refused too', async () => {
    const query = vi.fn(async (q: string) => {
      if (q.includes('r.parent')) throw refused('Something NetSuite does not explain.');
      if (q.includes('r.fullname')) return [{ id: 7, fullname: 'Shop : Upfit' }];
      return [{ id: 7, name: 'Upfit', isinactive: 'F' }];
    });
    const { rows, dropped } = await readList(query, def('class'));
    expect(dropped.map((o) => o.field)).toEqual(['parent']);
    expect(rows).toEqual([{ id: 7, name: 'Upfit', isinactive: 'F', fullname: 'Shop : Upfit' }]);

    const never = vi.fn(async () => { throw refused("Field 'name' for record 'term' was not found."); });
    await expect(readList(never, def('term'))).rejects.toThrow(/'name'/);
    expect(never).toHaveBeenCalledTimes(2);
  });

  it('reads field by field when NetSuite answers 500, keeping every field that works on its own', async () => {
    const asked: string[] = [];
    const query = vi.fn(async (q: string) => {
      asked.push(q);
      if (q.includes('r.assetaccount')) throw unexpected();
      if (q.startsWith('SELECT r.id, r.incomeaccount ')) return [{ id: 900, incomeaccount: 40 }, { id: 901, incomeaccount: 41 }, { id: 999, incomeaccount: 49 }];
      if (q.startsWith('SELECT r.id, r.expenseaccount ')) return [{ id: 901, expenseaccount: 61 }];
      if (q.includes('IS NOT NULL')) return [];
      return [{ id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F' }, { id: 901, itemid: 'LABOR', itemtype: 'Service', isinactive: 'F' }];
    });
    const { rows, dropped } = await readList(query, def('item'));
    expect(dropped.map((o) => o.field)).toEqual(['assetaccount']);
    // An id only a field read lists (added in between) isn't invented.
    expect(rows).toEqual([
      { id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F', incomeaccount: 40 },
      { id: 901, itemid: 'LABOR', itemtype: 'Service', isinactive: 'F', incomeaccount: 41, expenseaccount: 61 },
    ]);
    // The whole read, the required fields, then each optional field once.
    expect(asked).toHaveLength(2 + def('item').optional.length);
    expect(asked[1]).toBe(listQuery(def('item'), []));
  });

  it('fails the list when NetSuite answers 500 even for the required fields', async () => {
    const query = vi.fn(async () => { throw unexpected(); });
    await expect(readList(query, def('vendor'))).rejects.toThrow(/UNEXPECTED_ERROR/);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('gives up at once when the role can\'t see the record, or NetSuite fails for another reason', async () => {
    const hidden = vi.fn(async () => { throw refused("Search error occurred: Record 'classification' was not found."); });
    await expect(readList(hidden, def('class'))).rejects.toThrow(/Record 'classification'/);
    expect(hidden).toHaveBeenCalledTimes(1);

    const down = vi.fn(async () => { throw Object.assign(new Error('NetSuite SuiteQL error (503): busy'), { status: 503 }); });
    await expect(readList(down, def('location'))).rejects.toThrow(/503/);
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe('mapping NetSuite rows', () => {
  it('keeps a location\'s parent, full name and subsidiary', () => {
    expect(mapListRow(def('location'), { id: 3, name: 'Kansas City', parent: '9', isinactive: 'F', fullname: 'Plants : Kansas City', subsidiary: 2 }))
      .toEqual({ netsuite_id: '3', name: 'Kansas City', parent_netsuite_id: '9', active: true, details: { full_name: 'Plants : Kansas City', subsidiary_id: '2' } });
    expect(mapListRow(def('location'), { id: 1, name: "O'Fallon", fullname: "O'Fallon", isinactive: 'T' }))
      .toEqual({ netsuite_id: '1', name: "O'Fallon", parent_netsuite_id: null, active: false, details: {} });
  });

  it('reads terms\' days and discount as numbers', () => {
    expect(mapListRow(def('term'), { id: '4', name: '2% 10 Net 30', isinactive: 'F', daysuntilnetdue: '30', discountpercent: '2%', daysuntilexpiry: 10 }))
      .toMatchObject({ name: '2% 10 Net 30', details: { days_until_net_due: 30, discount_percent: 2, discount_days: 10 } });
    expect(mapListRow(def('term'), { id: '5', name: 'Due on receipt', daysuntilnetdue: '', discountpercent: 'n/a' })!.details).toEqual({});
  });

  it('names a tax code by its name, or its description when SuiteQL hides the name', () => {
    expect(mapListRow(def('tax_code'), { id: 12, itemid: 'MO-SAMPLE', description: 'Sample County', rate: '6.5%', taxagency: '88', isinactive: 'F' }))
      .toEqual({
        netsuite_id: '12', name: 'MO-SAMPLE', parent_netsuite_id: null, active: true,
        details: { description: 'Sample County', rate: '6.5%', tax_agency_id: '88' },
      });
    expect(mapListRow(def('tax_code'), { id: 13, description: 'Georgia exempt' })).toMatchObject({ name: 'Georgia exempt', details: {}, active: true });
    expect(mapListRow(def('tax_code'), { id: 14 })!.name).toBe('Tax code 14');
  });

  it('keeps a vendor\'s accounts and terms', () => {
    expect(mapListRow(def('vendor'), { id: 50, entityid: 'V-50', companyname: 'Sample Supply Co', isinactive: 'F', expenseaccount: '601', payablesaccount: '200', terms: '4' }))
      .toEqual({
        netsuite_id: '50', name: 'Sample Supply Co', parent_netsuite_id: null, active: true,
        details: { entity_id: 'V-50', expense_account: '601', payables_account: '200', terms_id: '4' },
      });
    expect(mapListRow(def('vendor'), { id: 51, entityid: 'Pat Example', isinactive: 'F' })).toMatchObject({ name: 'Pat Example', details: {} });
  });

  it('names a customer by its company, keeping its terms and how NetSuite taxes it', () => {
    expect(mapListRow(def('customer'), { id: 9001, entityid: 'C-9001', companyname: 'Sample Fleet Co', isinactive: 'F', terms: '4', taxable: 'T', taxitem: '77' }))
      .toEqual({
        netsuite_id: '9001', name: 'Sample Fleet Co', parent_netsuite_id: null, active: true,
        details: { entity_id: 'C-9001', terms_id: '4', taxable: 'T', tax_item_id: '77' },
      });
    expect(mapListRow(def('customer'), { id: 9002, entityid: 'Pat Example', isinactive: 'T', taxable: 'F' }))
      .toEqual({ netsuite_id: '9002', name: 'Pat Example', parent_netsuite_id: null, active: false, details: { taxable: 'F' } });
    expect(mapListRow(def('customer'), { id: 9003, entityid: 'Same Name', companyname: 'Same Name', terms: 'x' })!.details).toEqual({});
  });

  it('keeps an item\'s type and the accounts it posts to', () => {
    expect(mapListRow(def('item'), {
      id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F', displayname: 'Roof rack',
      incomeaccount: '401', assetaccount: '121', expenseaccount: null,
    })).toEqual({
      netsuite_id: '900', name: 'RD-100', parent_netsuite_id: null, active: true,
      details: { item_type: 'InvtPart', display_name: 'Roof rack', income_account: '401', asset_account: '121' },
    });
  });

  it('skips rows with no id and keeps one row per id', () => {
    const rows = mapList(def('department'), [
      { id: 1, name: 'Shop' }, { id: null, name: 'Nothing' }, { id: 'x', name: 'Bad' }, { id: 2, name: 'Office' }, { id: 1, name: 'Shop floor' },
    ]);
    expect(rows.map((r) => [r.netsuite_id, r.name])).toEqual([['1', 'Shop floor'], ['2', 'Office']]);
  });

  it('counts where sales tax posted, most lines first, keeping lines with no tax code', () => {
    expect(mapTaxAccounts([
      { tax_code_id: '12', account_id: '230', line_count: '40' },
      { tax_code_id: null, account_id: '230', line_count: 3 },
      { tax_code_id: '13', account_id: null, line_count: 9 },
      { tax_code_id: '12', account_id: '231', line_count: 100 },
    ])).toEqual([
      { tax_code_id: '12', account_id: '231', lines: 100 },
      { tax_code_id: '12', account_id: '230', lines: 40 },
      { tax_code_id: null, account_id: '230', lines: 3 },
    ]);
  });

  it('counts where items with no income account posted, most lines first, skipping rows with no item or account', () => {
    expect(mapItemAccounts([
      { item_id: '16', item_name: 'PREPAYMENT', account_id: '110', line_count: '2' },
      { item_id: '17', item_name: ' DEPOSIT ', account_id: '111', line_count: 5 },
      { item_id: '16', item_name: 'PREPAYMENT', account_id: '112', line_count: 2 },
      { item_id: null, item_name: '', account_id: '110', line_count: 9 },
      { item_id: '18', item_name: 'ODD', account_id: null, line_count: 9 },
    ])).toEqual([
      { item_id: '17', item_name: 'DEPOSIT', account_id: '111', lines: 5 },
      { item_id: '16', item_name: 'PREPAYMENT', account_id: '110', lines: 2 },
      { item_id: '16', item_name: 'PREPAYMENT', account_id: '112', lines: 2 },
    ]);
  });

  it('joins words the way the notes read', () => {
    expect(joinWords(['rates'])).toBe('rates');
    expect(joinWords(['rates', 'tax agencies'])).toBe('rates and tax agencies');
    expect(joinWords(['names', 'rates', 'tax agencies'])).toBe('names, rates and tax agencies');
  });
});

describe('terms and accounts FleetSuite changes in NetSuite', () => {
  /** A stand-in for the service client: what its one read answers, what the list's apply answers, and everything asked. */
  const fake = (read: { data?: unknown; error?: { message: string } }, applyError?: { message: string }) => {
    const asked: Array<[string, unknown[]]> = [];
    const called: Array<[string, unknown]> = [];
    const answer = () => ({ data: read.data ?? null, error: read.error ?? null });
    const builder: any = new Proxy({}, {
      get: (_t, name: string) => {
        if (name === 'then') return (resolve: (v: unknown) => unknown) => resolve(answer());
        if (name === 'maybeSingle') return async () => answer();
        return (...args: unknown[]) => { asked.push([name, args]); return builder; };
      },
    });
    const service = {
      from: (table: string) => { asked.push(['from', [table]]); return builder; },
      rpc: async (fn: string, args: unknown) => { called.push([fn, args]); return { data: null, error: applyError ?? null }; },
    };
    return { service: service as any, asked, called };
  };
  // Made-up data.
  const ROW = {
    netsuite_id: '2207', name: 'Ridge Supply Co', parent_netsuite_id: null, active: true, details: { entity_id: 'V-2207', terms_id: '2' },
  };

  it("puts a record's new terms in its row of the copy, keeping the rest of it", async () => {
    const { service, asked, called } = fake({ data: { ...ROW, kind: 'vendor', gone_at: null } });
    expect(await noteTermsChanged(service, 'vendor', '2207', '3')).toEqual({ noted: true });
    expect(asked).toEqual([
      ['from', ['gl_netsuite_lists']],
      ['select', ['netsuite_id, name, parent_netsuite_id, active, details']],
      ['eq', ['kind', 'vendor']],
      ['eq', ['netsuite_id', '2207']],
      ['is', ['gone_at', null]],
    ]);
    expect(called).toEqual([['gl_netsuite_lists_apply', { p: { kind: 'vendor', rows: [{ ...ROW, details: { entity_id: 'V-2207', terms_id: '3' } }] } }]]);

    const bare = fake({ data: { ...ROW, netsuite_id: '4410', details: null } });
    await noteTermsChanged(bare.service, 'customer', '4410', '1');
    expect(bare.called).toEqual([['gl_netsuite_lists_apply', { p: { kind: 'customer', rows: [{ ...ROW, netsuite_id: '4410', details: { terms_id: '1' } }] } }]]);
  });

  it("writes nothing when the copy has no row for the record, and says what couldn't be read or written", async () => {
    const none = fake({});
    expect(await noteTermsChanged(none.service, 'customer', '4410', '2')).toEqual({ noted: false });
    expect(none.called).toEqual([]);
    await expect(noteTermsChanged(fake({ error: { message: 'gl_netsuite_lists is busy' } }).service, 'customer', '4410', '2'))
      .rejects.toThrow('gl_netsuite_lists is busy');
    await expect(noteTermsChanged(fake({ data: ROW }, { message: 'apply refused' }).service, 'vendor', '2207', '2')).rejects.toThrow('apply refused');
  });

  it("puts an item's new accounts in its row of the copy, keeping the rest of it", async () => {
    const ITEM = {
      netsuite_id: '501', name: '51-2002', parent_netsuite_id: null, active: true,
      details: { item_type: 'InvtPart', display_name: 'Hitch ball mount', income_account: '101', asset_account: '105' },
    };
    const { service, asked, called } = fake({ data: ITEM });
    expect(await noteItemAccountsChanged(service, '501', { asset_account: '106', expense_account: '108' })).toEqual({ noted: true });
    expect(asked).toEqual([
      ['from', ['gl_netsuite_lists']],
      ['select', ['netsuite_id, name, parent_netsuite_id, active, details']],
      ['eq', ['kind', 'item']],
      ['eq', ['netsuite_id', '501']],
      ['is', ['gone_at', null]],
    ]);
    expect(called).toEqual([['gl_netsuite_lists_apply', { p: { kind: 'item', rows: [{
      ...ITEM, details: { item_type: 'InvtPart', display_name: 'Hitch ball mount', income_account: '101', asset_account: '106', expense_account: '108' },
    }] } }]]);
    const none = fake({});
    expect(await noteItemAccountsChanged(none.service, '501', { income_account: '102' })).toEqual({ noted: false });
    expect(none.called).toEqual([]);
  });

  it("lists NetSuite's active terms by name", async () => {
    const { service, asked } = fake({ data: [{ netsuite_id: '1', name: 'Due on receipt' }, { netsuite_id: '2', name: 'Net 30' }] });
    expect(await listTerms(service)).toEqual([{ id: '1', name: 'Due on receipt' }, { id: '2', name: 'Net 30' }]);
    expect(asked).toEqual([
      ['from', ['gl_netsuite_lists']],
      ['select', ['netsuite_id, name']],
      ['eq', ['kind', 'term']],
      ['eq', ['active', true]],
      ['is', ['gone_at', null]],
      ['order', ['name', { ascending: true }]],
      ['order', ['netsuite_id', { ascending: true }]],
      ['limit', [500]],
    ]);
    expect(await listTerms(fake({}).service)).toEqual([]);
    await expect(listTerms(fake({ error: { message: 'timeout' } }).service)).rejects.toThrow("couldn't read NetSuite's terms (timeout)");
  });
});
