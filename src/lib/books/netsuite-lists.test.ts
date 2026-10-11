import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import {
  LISTS,
  TAX_ACCOUNTS_QUERY,
  fieldQuery,
  joinWords,
  listQuery,
  mapList,
  mapListRow,
  mapTaxAccounts,
  namesField,
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

  it('leaves the items that never post, and the tax items, out of the items', () => {
    expect(listQuery(def('item'), [])).toBe(
      "SELECT r.id, r.itemid, r.itemtype, r.isinactive FROM item r WHERE r.itemtype NOT IN ('Description', 'Subtotal', 'Group', 'EndGroup', 'TaxItem', 'TaxGroup') ORDER BY r.id",
    );
  });

  it('reads one field on its own for the rows that have it', () => {
    const cogs = def('item').optional.find((o) => o.field === 'cogsaccount')!;
    expect(fieldQuery(def('item'), cogs)).toBe(
      "SELECT r.id, r.cogsaccount FROM item r WHERE (r.itemtype NOT IN ('Description', 'Subtotal', 'Group', 'EndGroup', 'TaxItem', 'TaxGroup')) AND r.cogsaccount IS NOT NULL ORDER BY r.id",
    );
    expect(fieldQuery(def('term'), def('term').optional[0])).toBe(
      'SELECT r.id, r.daysuntilnetdue FROM term r WHERE r.daysuntilnetdue IS NOT NULL ORDER BY r.id',
    );
  });

  it('copies the lists in order, the items last', () => {
    expect(LISTS.map((d) => d.kind)).toEqual(['location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item']);
  });

  it('counts sales tax lines from the start of the GL copy', () => {
    expect(TAX_ACCOUNTS_QUERY).toContain("tl.taxline = 'T'");
    expect(TAX_ACCOUNTS_QUERY).toContain("t.trandate >= TO_DATE('01/01/2025', 'MM/DD/YYYY')");
    expect(TAX_ACCOUNTS_QUERY).toContain('GROUP BY tl.item, tal.account');
  });
});

describe('reading a list NetSuite only partly gives', () => {
  it('knows the field a refusal names, quoted or after an alias, and not a word in the message', () => {
    expect(namesField(refused("Search error occurred: Field 'cogsaccount' for record 'item' was not found."), 'cogsaccount')).toBe(true);
    expect(namesField(refused("Unknown identifier 'r.rate'."), 'rate')).toBe(true);
    expect(namesField(refused("Search error occurred: Field 'cogsaccount' for record 'item' was not found."), 'description')).toBe(false);
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
      if (q.includes('r.cogsaccount')) throw refused("Search error occurred: Field 'cogsaccount' for record 'item' was not found.");
      if (q.includes('r.expenseaccount')) throw refused("Unknown identifier 'r.expenseaccount'.");
      return [{ id: 1, itemid: 'A-1' }];
    });
    const { rows, dropped } = await readList(query, def('item'));
    expect(rows).toEqual([{ id: 1, itemid: 'A-1' }]);
    expect(dropped.map((o) => o.field)).toEqual(['cogsaccount', 'expenseaccount']);
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain('r.incomeaccount, r.assetaccount FROM item');
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
      if (q.includes('r.cogsaccount')) throw unexpected();
      if (q.startsWith('SELECT r.id, r.incomeaccount ')) return [{ id: 900, incomeaccount: 40 }, { id: 901, incomeaccount: 41 }, { id: 999, incomeaccount: 49 }];
      if (q.startsWith('SELECT r.id, r.assetaccount ')) return [{ id: 900, assetaccount: 12 }];
      if (q.includes('IS NOT NULL')) return [];
      return [{ id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F' }, { id: 901, itemid: 'LABOR', itemtype: 'Service', isinactive: 'F' }];
    });
    const { rows, dropped } = await readList(query, def('item'));
    expect(dropped.map((o) => o.field)).toEqual(['cogsaccount']);
    // An id only a field read lists (added in between) isn't invented.
    expect(rows).toEqual([
      { id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F', incomeaccount: 40, assetaccount: 12 },
      { id: 901, itemid: 'LABOR', itemtype: 'Service', isinactive: 'F', incomeaccount: 41 },
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

  it('keeps an item\'s type and every account it posts to', () => {
    expect(mapListRow(def('item'), {
      id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F', displayname: 'Roof rack',
      incomeaccount: '401', cogsaccount: '501', assetaccount: '121', expenseaccount: null,
    })).toEqual({
      netsuite_id: '900', name: 'RD-100', parent_netsuite_id: null, active: true,
      details: { item_type: 'InvtPart', display_name: 'Roof rack', income_account: '401', cogs_account: '501', asset_account: '121' },
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

  it('joins words the way the notes read', () => {
    expect(joinWords(['rates'])).toBe('rates');
    expect(joinWords(['rates', 'tax agencies'])).toBe('rates and tax agencies');
    expect(joinWords(['names', 'rates', 'tax agencies'])).toBe('names, rates and tax agencies');
  });
});
