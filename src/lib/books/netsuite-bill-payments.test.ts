import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { BILL_PAYMENT_IDS_QUERY, billPaymentHeaderQuery, billPaymentLinksQuery, mapBillPayments } from './netsuite-bill-payments';

describe('the copy\'s queries', () => {
  it('reads bill payments modified since the window opened, newest first, below the cursor', () => {
    const q = billPaymentHeaderQuery('2026-10-16T15:21:00Z', '8120', true);
    expect(q).toContain("WHERE t.type = 'VendPymt'");
    expect(q).toContain("t.lastmodifieddate >= TO_DATE('10/16/2026', 'MM/DD/YYYY')");
    expect(q).toContain('AND t.id < 8120');
    expect(q).toContain('t.foreigntotal AS total, t.entity AS vendor_id');
    expect(q).toContain('BUILTIN.DF(t.status) AS status_label, BUILTIN.DF(t.entity) AS vendor_name');
    expect(q).toContain('ORDER BY t.id DESC');
    const plain = billPaymentHeaderQuery('2026-10-16T15:21:00Z', null, false);
    expect(plain).not.toContain('BUILTIN.DF');
    expect(plain).not.toContain('t.id <');
    // A stored cursor that isn't a NetSuite id never reaches the SQL.
    expect(billPaymentHeaderQuery('2026-10-16T15:21:00Z', '1; DROP', false)).not.toContain('DROP');
  });

  it('reads what a page of payments paid, by NetSuite id only', () => {
    expect(billPaymentLinksQuery('nexttransactionlinelink', ['11', 'x', '12'])).toMatch(
      /SELECT previousdoc, nextdoc, foreignamount, linktype\s+FROM nexttransactionlinelink\s+WHERE nextdoc IN \(11, 12\)/,
    );
    expect(() => billPaymentLinksQuery('previoustransactionlinelink', ['x'])).toThrow('No NetSuite ids to read');
    expect(BILL_PAYMENT_IDS_QUERY).toBe("SELECT t.id FROM transaction t WHERE t.type = 'VendPymt' ORDER BY t.id");
  });
});

describe('mapBillPayments', () => {
  const header = (fields: Record<string, unknown> = {}) => ({
    id: 801, type: 'VendPymt', tranid: 'CHK1001', trandate: '9/15/2026', status: 'Y', status_label: 'Online Bill Pay', memo: 'September parts',
    total: '-650', vendor_id: 50, vendor_name: 'V-50 Sample Supply Co', ...fields,
  });

  it('keeps what the check needs, totals positive and in cents\' form', () => {
    const links = new Map([['801', [{ netsuite_id: '701', type: 'VendBill', number: 'B-701', amount: '650.00', link_type: 'Payment' }]]]);
    const { rows, unreadable } = mapBillPayments([
      header(),
      header({ id: 802, tranid: null, trandate: '2026-09-18', status: null, status_label: null, memo: null, total: 120, vendor_id: 'x', vendor_name: null }),
    ], links);
    expect(unreadable).toEqual([]);
    expect(rows).toEqual([
      {
        netsuite_id: '801', tran_type: 'VendPymt', tranid: 'CHK1001', trandate: '2026-09-15', vendor_netsuite_id: '50', vendor_name: 'V-50 Sample Supply Co',
        total: '650.00', status: 'Y', status_label: 'Online Bill Pay', voided: false, memo: 'September parts', links: links.get('801'),
      },
      // A vendor that isn't a NetSuite id is no vendor; a payment that paid nothing NetSuite listed has no links.
      {
        netsuite_id: '802', tran_type: 'VendPymt', tranid: null, trandate: '2026-09-18', vendor_netsuite_id: null, vendor_name: null,
        total: '120.00', status: null, status_label: null, voided: false, memo: null, links: [],
      },
    ]);
  });

  it('marks a voided one by NetSuite\'s status', () => {
    expect(mapBillPayments([header({ status_label: 'Voided', total: 0 })], null).rows[0]).toMatchObject({ voided: true, total: '0.00' });
    expect(mapBillPayments([header({ status_label: 'Void of CHK1001' })], null).rows[0].voided).toBe(true);
    // A status that merely contains the letters isn't voided.
    expect(mapBillPayments([header({ status_label: 'Avoidable' })], null).rows[0].voided).toBe(false);
  });

  it('leaves the links out when the run couldn\'t read them, so the copy keeps its own', () => {
    expect(mapBillPayments([header()], null).rows[0]).not.toHaveProperty('links');
  });

  it('names the documents it can\'t copy: no date, a total it can\'t read, or not a bill payment at all', () => {
    const { rows, unreadable } = mapBillPayments([
      header({ trandate: null }),
      header({ id: 805, tranid: null, total: 'lots' }),
      header({ id: 806, tranid: 'PMT6', type: 'CustPymt' }),
      header({ id: null, tranid: null }),
      header({ id: 807 }),
    ], null);
    expect(rows.map((r) => r.netsuite_id)).toEqual(['807']);
    expect(unreadable).toEqual(['CHK1001', 'NetSuite 805', 'PMT6', 'NetSuite document']);
  });
});
