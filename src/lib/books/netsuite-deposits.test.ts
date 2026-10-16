import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import {
  DEPOSIT_IDS_QUERY, depositHeaderQuery, depositLinksQuery, linkedDocumentsQuery, linksByDocument, mapDeposits,
} from './netsuite-deposits';

describe('the copy\'s queries', () => {
  it('reads deposits and applications modified since the window opened, newest first, below the cursor', () => {
    const q = depositHeaderQuery('2026-10-14T13:16:00Z', '5120', true);
    expect(q).toContain("WHERE t.type IN ('CustDep', 'DepAppl')");
    expect(q).toContain("t.lastmodifieddate >= TO_DATE('10/14/2026', 'MM/DD/YYYY')");
    expect(q).toContain('AND t.id < 5120');
    expect(q).toContain('BUILTIN.DF(t.status) AS status_label');
    expect(q).toContain('ORDER BY t.id DESC');
    const plain = depositHeaderQuery('2026-10-14T13:16:00Z', null, false);
    expect(plain).not.toContain('status_label');
    expect(plain).not.toContain('t.id <');
    // A stored cursor that isn't a NetSuite id never reaches the SQL.
    expect(depositHeaderQuery('2026-10-14T13:16:00Z', '1; DROP', false)).not.toContain('DROP');
  });

  it('reads what a page of documents applies, and the documents linked, by NetSuite id only', () => {
    expect(depositLinksQuery('previoustransactionlinelink', ['11', '12'])).toMatch(
      /SELECT previousdoc, nextdoc, foreignamount, linktype\s+FROM previoustransactionlinelink\s+WHERE nextdoc IN \(11, 12\)/,
    );
    expect(linkedDocumentsQuery(['7', 'x', '9'])).toMatch(/SELECT t\.id, t\.type, t\.tranid\s+FROM transaction t\s+WHERE t\.id IN \(7, 9\)/);
    expect(() => linkedDocumentsQuery(['x'])).toThrow('No NetSuite ids to read');
    expect(DEPOSIT_IDS_QUERY).toBe("SELECT t.id FROM transaction t WHERE t.type IN ('CustDep', 'DepAppl') ORDER BY t.id");
  });
});

describe('linksByDocument', () => {
  const names = new Map([
    ['301', { type: 'CustDep', number: 'DEP1' }],
    ['501', { type: 'CustInvc', number: 'INV501' }],
  ]);

  it('gives each document what it applies, named, in NetSuite id order, amounts positive', () => {
    const links = linksByDocument([
      { previousdoc: 501, nextdoc: 311, foreignamount: '-300', linktype: 'Payment' },
      { previousdoc: 301, nextdoc: 311, foreignamount: 300, linktype: 'Deposit Application' },
      { previousdoc: 90, nextdoc: 301, foreignamount: null, linktype: null },
    ], names);
    expect(Object.fromEntries(links)).toEqual({
      311: [
        { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '300.00', link_type: 'Deposit Application' },
        { netsuite_id: '501', type: 'CustInvc', number: 'INV501', amount: '300.00', link_type: 'Payment' },
      ],
      // A document NetSuite didn't name, and a link with no amount.
      301: [{ netsuite_id: '90', type: null, number: null, amount: null, link_type: null }],
    });
  });

  it('adds up two rows linking the same documents, whatever order NetSuite lists them in', () => {
    const rows = [
      { previousdoc: 501, nextdoc: 311, foreignamount: '100.00', linktype: 'Payment' },
      { previousdoc: 501, nextdoc: 311, foreignamount: '200.00', linktype: 'Payment' },
    ];
    expect(linksByDocument(rows, names).get('311')).toEqual([
      { netsuite_id: '501', type: 'CustInvc', number: 'INV501', amount: '300.00', link_type: 'Payment' },
    ]);
    expect(linksByDocument([...rows].reverse(), names)).toEqual(linksByDocument(rows, names));
    // An amount it can't read makes the total unknown rather than wrong.
    expect(linksByDocument([...rows, { previousdoc: 501, nextdoc: 311, foreignamount: 'n/a' }], names).get('311')![0].amount).toBeNull();
  });

  it('says which of the document\'s own lines each link is on, when asked', () => {
    const rows = [
      { previousdoc: 501, nextdoc: 311, nextline: 10, foreignamount: '100.00', linktype: 'Payment' },
      { previousdoc: 501, nextdoc: 311, nextline: '2', foreignamount: '200.00', linktype: 'Payment' },
      // Twice on one line, and a row without its line.
      { previousdoc: 501, nextdoc: 311, nextline: 2, foreignamount: 0, linktype: 'Payment' },
      { previousdoc: 301, nextdoc: 311, nextline: null, foreignamount: 50, linktype: 'Deposit Application' },
    ];
    expect(linksByDocument(rows, names, { lines: true }).get('311')).toEqual([
      { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '50.00', link_type: 'Deposit Application', lines: [] },
      { netsuite_id: '501', type: 'CustInvc', number: 'INV501', amount: '300.00', link_type: 'Payment', lines: ['2', '10'] },
    ]);
    // Not asked: nothing about lines, as the deposits copy keeps them.
    expect(linksByDocument(rows, names).get('311')!.every((l) => !('lines' in l))).toBe(true);
  });

  it('leaves out rows without both ids, and a document linked to itself', () => {
    expect(linksByDocument([
      { previousdoc: null, nextdoc: 311, foreignamount: 1 },
      { previousdoc: 'x', nextdoc: 311, foreignamount: 1 },
      { previousdoc: 311, nextdoc: 311, foreignamount: 1 },
    ], names).size).toBe(0);
  });
});

describe('mapDeposits', () => {
  const header = (fields: Record<string, unknown> = {}) => ({
    id: 301, type: 'CustDep', tranid: 'DEP1', trandate: '9/10/2026', status: 'B', status_label: 'Deposited', memo: 'Ahead of the job',
    total: '500', customer_id: 77, customer_name: 'A Customer', customer_entity_id: 'C-77', ...fields,
  });

  it('keeps what the check needs, totals positive and in cents\' form', () => {
    const links = new Map([['311', [{ netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '300.00', link_type: null }]]]);
    const { rows, unreadable } = mapDeposits([
      header(),
      header({ id: 311, type: 'DepAppl', tranid: null, trandate: '2026-09-20', status: null, status_label: null, memo: null, total: -300 }),
    ], links);
    expect(unreadable).toEqual([]);
    expect(rows).toEqual([
      {
        netsuite_id: '301', tran_type: 'CustDep', tranid: 'DEP1', trandate: '2026-09-10', customer_netsuite_id: '77', customer_name: 'A Customer',
        total: '500.00', status: 'B', status_label: 'Deposited', voided: false, memo: 'Ahead of the job', links: [],
      },
      {
        netsuite_id: '311', tran_type: 'DepAppl', tranid: null, trandate: '2026-09-20', customer_netsuite_id: '77', customer_name: 'A Customer',
        total: '300.00', status: null, status_label: null, voided: false, memo: null, links: links.get('311'),
      },
    ]);
  });

  it('marks a voided one by NetSuite\'s status, and names the customer as the ledger mirror does', () => {
    const [voided, entity, bare, nobody] = mapDeposits([
      header({ status_label: 'Voided', total: 0 }),
      header({ id: 302, customer_name: null }),
      header({ id: 303, customer_name: ' ', customer_entity_id: null }),
      header({ id: 304, customer_id: null, customer_name: null, customer_entity_id: null }),
    ], null).rows;
    expect(voided).toMatchObject({ voided: true, total: '0.00' });
    expect([entity.customer_name, bare.customer_name, nobody.customer_name]).toEqual(['C-77', 'Customer 77', null]);
  });

  it('leaves the links out when the run couldn\'t read them, so the copy keeps its own', () => {
    expect(mapDeposits([header()], null).rows[0]).not.toHaveProperty('links');
  });

  it('names the documents it can\'t copy: no date, an amount it can\'t read, or not a deposit at all', () => {
    const { rows, unreadable } = mapDeposits([
      header({ trandate: null }),
      header({ id: 305, tranid: null, total: 'lots' }),
      header({ id: 306, tranid: 'PMT6', type: 'CustPymt' }),
      header({ id: 307 }),
    ], null);
    expect(rows.map((r) => r.netsuite_id)).toEqual(['307']);
    expect(unreadable).toEqual(['DEP1', 'NetSuite 305', 'PMT6']);
  });
});
