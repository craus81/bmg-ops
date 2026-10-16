import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { SPENDING_IDS_QUERY, mapSpending, spendingHeaderQuery } from './netsuite-spending';

describe('the copy\'s queries', () => {
  it('reads checks and card charges and refunds modified since the window opened, newest first, below the cursor', () => {
    const q = spendingHeaderQuery('2026-10-16T20:33:00Z', '9120', true);
    expect(q).toContain("WHERE t.type IN ('Check', 'CardChrg', 'CardRfnd')");
    expect(q).toContain("t.lastmodifieddate >= TO_DATE('10/16/2026', 'MM/DD/YYYY')");
    expect(q).toContain('AND t.id < 9120');
    expect(q).toContain('t.foreigntotal AS total, t.entity AS payee_id');
    expect(q).toContain('BUILTIN.DF(t.status) AS status_label, BUILTIN.DF(t.entity) AS payee_name');
    expect(q).toContain('ORDER BY t.id DESC');
    const plain = spendingHeaderQuery('2026-10-16T20:33:00Z', null, false);
    expect(plain).not.toContain('BUILTIN.DF');
    expect(plain).not.toContain('t.id <');
    // A stored cursor that isn't a NetSuite id never reaches the SQL.
    expect(spendingHeaderQuery('2026-10-16T20:33:00Z', '1; DROP', false)).not.toContain('DROP');
    expect(SPENDING_IDS_QUERY).toBe("SELECT t.id FROM transaction t WHERE t.type IN ('Check', 'CardChrg', 'CardRfnd') ORDER BY t.id");
  });
});

describe('mapSpending', () => {
  const header = (fields: Record<string, unknown> = {}) => ({
    id: 801, type: 'Check', tranid: '10234', trandate: '9/3/2026', status: null, status_label: null, memo: 'Lunch and gloves',
    total: '-165.12', payee_id: 50, payee_name: 'V-50 Sample Supply Co', ...fields,
  });
  const LINES = [{ line_id: '1', item: null, account: '640', amount: '-45.12', own_amount: '-45.12', quantity: null, memo: null, tax: false }];

  it('keeps what the check needs, totals positive and in cents\' form', () => {
    const { rows, unreadable } = mapSpending([
      header(),
      header({ id: 802, type: 'CardChrg', tranid: null, trandate: '2026-09-10', memo: null, total: 330, payee_id: null, payee_name: null }),
      header({ id: 803, type: 'CardRfnd', tranid: 'R-803', trandate: '2026-09-15', total: '25.99', payee_id: 'x', payee_name: ' Uline ' }),
    ], new Map([['801', LINES], ['802', []], ['803', []]]));
    expect(unreadable).toEqual([]);
    expect(rows).toEqual([
      {
        netsuite_id: '801', tran_type: 'Check', tranid: '10234', trandate: '2026-09-03', payee_netsuite_id: '50', payee_name: 'V-50 Sample Supply Co',
        total: '165.12', status: null, status_label: null, voided: false, memo: 'Lunch and gloves', lines: LINES,
      },
      {
        netsuite_id: '802', tran_type: 'CardChrg', tranid: null, trandate: '2026-09-10', payee_netsuite_id: null, payee_name: null,
        total: '330.00', status: null, status_label: null, voided: false, memo: null, lines: [],
      },
      // A payee id that isn't a NetSuite id is none.
      {
        netsuite_id: '803', tran_type: 'CardRfnd', tranid: 'R-803', trandate: '2026-09-15', payee_netsuite_id: null, payee_name: 'Uline',
        total: '25.99', status: null, status_label: null, voided: false, memo: 'Lunch and gloves', lines: [],
      },
    ]);
  });

  it('marks a voided one by NetSuite\'s status', () => {
    expect(mapSpending([header({ status: 'V', status_label: 'Voided', total: 0 })], null).rows[0]).toMatchObject({
      status: 'V', status_label: 'Voided', voided: true, total: '0.00',
    });
  });

  it('leaves the lines out when the run couldn\'t read them, so the copy keeps its own', () => {
    expect(mapSpending([header()], null).rows[0]).not.toHaveProperty('lines');
    // A document whose lines couldn't be told apart isn't in the lines read: it keeps its own too.
    expect(mapSpending([header()], new Map()).rows[0]).not.toHaveProperty('lines');
  });

  it('names the documents it can\'t copy: no date, a total it can\'t read, or not a check or a card at all', () => {
    const { rows, unreadable } = mapSpending([
      header({ trandate: null }),
      header({ id: 805, tranid: null, total: 'lots' }),
      header({ id: 806, tranid: 'B-806', type: 'VendBill' }),
      header({ id: 'x', tranid: null }),
      header({ id: 807 }),
    ], null);
    expect(rows.map((r) => r.netsuite_id)).toEqual(['807']);
    expect(unreadable).toEqual(['10234', 'NetSuite 805', 'B-806', 'NetSuite x']);
  });
});
