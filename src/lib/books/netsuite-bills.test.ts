import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { BILL_IDS_QUERY, billHeaderQuery, billLinesQuery, linesByBill, mapBills } from './netsuite-bills';

describe('the copy\'s queries', () => {
  it('reads bills and bill credits modified since the window opened, newest first, below the cursor', () => {
    const q = billHeaderQuery('2026-10-14T13:39:00Z', '7120', true);
    expect(q).toContain("WHERE t.type IN ('VendBill', 'VendCred')");
    expect(q).toContain("t.lastmodifieddate >= TO_DATE('10/14/2026', 'MM/DD/YYYY')");
    expect(q).toContain('AND t.id < 7120');
    expect(q).toContain('t.foreigntotal AS total, t.entity AS vendor_id');
    expect(q).toContain('BUILTIN.DF(t.status) AS status_label, BUILTIN.DF(t.entity) AS vendor_name');
    expect(q).toContain('ORDER BY t.id DESC');
    const plain = billHeaderQuery('2026-10-14T13:39:00Z', null, false);
    expect(plain).not.toContain('BUILTIN.DF');
    expect(plain).not.toContain('t.id <');
    // A stored cursor that isn't a NetSuite id never reaches the SQL.
    expect(billHeaderQuery('2026-10-14T13:39:00Z', '1; DROP', false)).not.toContain('DROP');
  });

  it('reads a page\'s lines but the payables line, with each expense line\'s account when asked, by NetSuite id only', () => {
    expect(billLinesQuery(['11', 'x', '12'], true)).toMatch(
      /SELECT tl\.transaction AS bill_id, tl\.id AS line_id, tl\.item, tl\.expenseaccount AS account, tl\.netamount AS amount, tl\.quantity, tl\.memo, tl\.taxline\s+FROM transactionline tl\s+WHERE tl\.transaction IN \(11, 12\)\s+AND tl\.mainline = 'F'\s+ORDER BY tl\.transaction, tl\.id/,
    );
    expect(billLinesQuery(['11'], false)).toContain('SELECT tl.transaction AS bill_id, tl.id AS line_id, tl.item, tl.netamount AS amount,');
    expect(() => billLinesQuery(['x'], true)).toThrow('No NetSuite ids to read');
    expect(BILL_IDS_QUERY).toBe("SELECT t.id FROM transaction t WHERE t.type IN ('VendBill', 'VendCred') ORDER BY t.id");
  });
});

describe('linesByBill', () => {
  it('gives each document its lines in NetSuite\'s order, amounts signed as NetSuite gives them', () => {
    const { lines, unreadable } = linesByBill([
      { bill_id: 701, line_id: 3, item: 901, account: null, amount: '-30', quantity: -1, memo: null, taxline: 'F' },
      { bill_id: 701, line_id: 1, item: null, account: 530, amount: -500, quantity: null, memo: 'Labor', taxline: 'F' },
      { bill_id: 702, line_id: 1, item: 902, account: '610', amount: '120.5', quantity: '4', memo: ' ', taxline: 'T' },
      // NetSuite's own lines carry item ids below 1; anything else that isn't an id is no item.
      { bill_id: 702, line_id: 2, item: -2, amount: 0 },
      { bill_id: 702, line_id: 3, item: 'n/a', amount: null },
    ]);
    expect(unreadable).toEqual(new Set());
    expect(Object.fromEntries(lines)).toEqual({
      701: [
        { line_id: '1', item: null, account: '530', amount: '-500.00', quantity: null, memo: 'Labor', tax: false },
        { line_id: '3', item: '901', account: null, amount: '-30.00', quantity: '-1', memo: null, tax: false },
      ],
      702: [
        { line_id: '1', item: '902', account: '610', amount: '120.50', quantity: '4', memo: null, tax: true },
        { line_id: '2', item: '-2', account: null, amount: '0.00', quantity: null, memo: null, tax: false },
        { line_id: '3', item: null, account: null, amount: '0.00', quantity: null, memo: null, tax: false },
      ],
    });
  });

  it('keeps an amount it can\'t read as unknown, and copies no lines of a document with a line it can\'t tell apart', () => {
    const { lines, unreadable } = linesByBill([
      { bill_id: 701, line_id: 1, amount: 'lots' },
      { bill_id: 702, line_id: 1, amount: '5' },
      { bill_id: 702, line_id: null, amount: '5' },
      { bill_id: null, line_id: 1, amount: '5' },
    ]);
    expect(lines.get('701')).toEqual([{ line_id: '1', item: null, account: null, amount: null, quantity: null, memo: null, tax: false }]);
    expect(lines.has('702')).toBe(false);
    expect(unreadable).toEqual(new Set(['702']));
  });
});

describe('mapBills', () => {
  const header = (fields: Record<string, unknown> = {}) => ({
    id: 701, type: 'VendBill', tranid: 'B-701', trandate: '9/8/2026', status: 'A', status_label: 'Open', memo: 'Parts for the shop',
    total: '-650', vendor_id: 50, vendor_name: 'V-50 Sample Supply Co', ...fields,
  });
  const LINES = [{ line_id: '1', item: null, account: '530', amount: '-650.00', quantity: null, memo: null, tax: false }];

  it('keeps what the check needs, totals positive and in cents\' form', () => {
    const links = new Map([['701', [{ netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '650.00', link_type: 'Bill' }]]]);
    const { rows, unreadable } = mapBills([
      header(),
      header({ id: 702, type: 'VendCred', tranid: null, trandate: '2026-09-12', status: null, status_label: null, memo: null, total: 120, vendor_name: null }),
    ], new Map([['701', LINES], ['702', []]]), links);
    expect(unreadable).toEqual([]);
    expect(rows).toEqual([
      {
        netsuite_id: '701', tran_type: 'VendBill', tranid: 'B-701', trandate: '2026-09-08', vendor_netsuite_id: '50', vendor_name: 'V-50 Sample Supply Co',
        total: '650.00', status: 'A', status_label: 'Open', voided: false, memo: 'Parts for the shop', lines: LINES, links: links.get('701'),
      },
      {
        netsuite_id: '702', tran_type: 'VendCred', tranid: null, trandate: '2026-09-12', vendor_netsuite_id: '50', vendor_name: null,
        total: '120.00', status: null, status_label: null, voided: false, memo: null, lines: [], links: [],
      },
    ]);
  });

  it('marks a voided one by NetSuite\'s status', () => {
    expect(mapBills([header({ status_label: 'Voided', total: 0 })], null, null).rows[0]).toMatchObject({ voided: true, total: '0.00' });
  });

  it('leaves the lines and links out when the run couldn\'t read them, so the copy keeps its own', () => {
    const [row] = mapBills([header()], null, null).rows;
    expect(row).not.toHaveProperty('lines');
    expect(row).not.toHaveProperty('links');
    // A document whose lines couldn't be told apart isn't in the lines read: it keeps its own too.
    expect(mapBills([header()], new Map(), null).rows[0]).not.toHaveProperty('lines');
  });

  it('names the documents it can\'t copy: no date, a total it can\'t read, or not a bill at all', () => {
    const { rows, unreadable } = mapBills([
      header({ trandate: null }),
      header({ id: 705, tranid: null, total: 'lots' }),
      header({ id: 706, tranid: 'PO6', type: 'PurchOrd' }),
      header({ id: 707 }),
    ], null, null);
    expect(rows.map((r) => r.netsuite_id)).toEqual(['707']);
    expect(unreadable).toEqual(['B-701', 'NetSuite 705', 'PO6']);
  });
});
