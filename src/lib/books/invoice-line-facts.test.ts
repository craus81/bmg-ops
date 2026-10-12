import { describe, it, expect } from 'vitest';
import { factsQuery, readLineFacts } from './invoice-line-facts';

const suiteqlError = (status: number, detail: string) =>
  Object.assign(new Error(`NetSuite SuiteQL error (${status}): ${detail}`), { status });

/** A made-up NetSuite: two invoices' lines, answering whichever columns it's asked for. */
const LINES: Record<string, unknown>[] = [
  { txn_id: 101, line_id: 1, iscogs: 'F', transactiondiscount: 'F', foreignamount: -100 },
  { txn_id: 101, line_id: 2, iscogs: 'F', transactiondiscount: 'T', foreignamount: '-4.5' },
  { txn_id: 102, line_id: 1, iscogs: 'T', transactiondiscount: false, foreignamount: null },
];

function fakeNetSuite(refuse: (columns: string[]) => Error | null = () => null) {
  const asked: string[] = [];
  const query = async (sql: string) => {
    asked.push(sql);
    const columns = [...sql.matchAll(/, tl\.(\w+)/g)].map((m) => m[1]).filter((c) => c !== 'id');
    const ids = sql.match(/IN \(([^)]*)\)/)![1].split(', ').map(Number);
    const err = refuse(columns);
    if (err) throw err;
    return LINES.filter((l) => ids.includes(l.txn_id as number))
      .map((l) => Object.fromEntries(['txn_id', 'line_id', ...columns].map((c) => [c, l[c]])));
  };
  return { query, asked };
}

describe('factsQuery', () => {
  it('reads every line but the invoice\'s own, in a fixed order', () => {
    expect(factsQuery(['101', '102'], ['iscogs', 'foreignamount'])).toBe(`
      SELECT tl.transaction AS txn_id, tl.id AS line_id, tl.iscogs, tl.foreignamount
      FROM transactionline tl
      WHERE tl.transaction IN (101, 102)
        AND tl.mainline = 'F'
      ORDER BY tl.transaction, tl.id
    `);
  });

  it('takes nothing but NetSuite ids into the SQL', () => {
    expect(() => factsQuery(['101', '1) OR (1=1'], [])).toThrow();
    expect(() => factsQuery([], [])).toThrow();
  });
});

describe('readLineFacts', () => {
  it('says, line by line, which lines are cost of goods, which is the discount at the top, and each one\'s own amount', async () => {
    const ns = fakeNetSuite();
    const read = await readLineFacts(ns.query, ['101', '102', '101', 'CustInvc/9']);
    expect(ns.asked).toHaveLength(1);
    expect(read).toEqual({
      lines: new Map([
        ['101:1', { cogs: false, topDiscount: false, amount: '-100' }],
        ['101:2', { cogs: false, topDiscount: true, amount: '-4.5' }],
        ['102:1', { cogs: true, topDiscount: false, amount: null }],
      ]),
      missing: [],
    });
  });

  it('asks about a hundred invoices at a time, and not at all without any', async () => {
    const ns = fakeNetSuite();
    await readLineFacts(ns.query, Array.from({ length: 150 }, (_, i) => String(i + 1)));
    expect(ns.asked.map((sql) => sql.match(/IN \(([^)]*)\)/)![1].split(', ').length)).toEqual([100, 50]);
    const none = fakeNetSuite();
    expect(await readLineFacts(none.query, [])).toEqual({ lines: new Map(), missing: [] });
    expect(none.asked).toEqual([]);
  });

  it('drops a column NetSuite names in refusing, and asks again without it', async () => {
    const ns = fakeNetSuite((columns) => (columns.includes('transactiondiscount')
      ? suiteqlError(400, "Invalid search query. Field 'transactiondiscount' for record 'transactionLine' was not found.")
      : null));
    const read = await readLineFacts(ns.query, ['101']);
    expect(read.missing).toEqual(['topDiscount']);
    expect(read.lines.get('101:2')).toEqual({ cogs: false, amount: '-4.5' });
    expect(ns.asked).toHaveLength(2);
  });

  it('asks for each column on its own when NetSuite fails without naming one, so only the failing one is missing', async () => {
    const ns = fakeNetSuite((columns) => (columns.length > 1 || columns.includes('iscogs') ? suiteqlError(500, 'UNEXPECTED_ERROR') : null));
    const read = await readLineFacts(ns.query, ['101', '102']);
    expect(read.missing).toEqual(['cogs']);
    expect(read.lines.get('101:2')).toEqual({ topDiscount: true, amount: '-4.5' });
    expect(ns.asked).toHaveLength(4);
  });

  it('fails on anything else', async () => {
    const ns = fakeNetSuite(() => suiteqlError(401, 'INVALID_LOGIN'));
    await expect(readLineFacts(ns.query, ['101'])).rejects.toThrow('INVALID_LOGIN');
  });
});
