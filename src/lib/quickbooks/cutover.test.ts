import { describe, it, expect, vi, afterEach } from 'vitest';
import * as netsuite from '@/lib/netsuite';
import { deriveCutover, netsuiteFirstInvoiceDate } from './cutover';
import { makeFakeService } from './test-fake-service';

afterEach(() => vi.restoreAllMocks());

describe('deriveCutover', () => {
  it('proposes the NetSuite first-invoice date and measures the overlap', () => {
    const c = deriveCutover({
      qboLastByType: { Invoice: '2021-04-10', Payment: '2021-05-02', Bill: '2021-03-01' },
      netsuiteFirstTrandate: '2021-04-01',
    });
    expect(c.qboLastTxnDate).toBe('2021-05-02');
    expect(c.proposedCutoverDate).toBe('2021-04-01');
    expect(c.overlapDays).toBe(31);
  });

  it('overlapDays is NULL when QuickBooks refused the date probe', () => {
    // A number from one side would look like a measurement and be a guess.
    const c = deriveCutover({
      qboLastByType: { Invoice: null, Payment: null },
      netsuiteFirstTrandate: '2021-04-01',
      orderByTxnDateSupported: false,
    });
    expect(c.qboLastTxnDate).toBeNull();
    expect(c.overlapDays).toBeNull();
    expect(c.proposedCutoverDate).toBe('2021-04-01');
    expect(c.orderByTxnDateSupported).toBe(false);
  });

  it('overlapDays is NULL when NetSuite has no date either', () => {
    const c = deriveCutover({ qboLastByType: { Invoice: '2021-04-10' }, netsuiteFirstTrandate: null });
    expect(c.overlapDays).toBeNull();
    expect(c.proposedCutoverDate).toBeNull();
    expect(c.netsuiteSource).toBe('none');
  });

  it('a NEGATIVE overlap (a clean handover with a gap) is reported as it is', () => {
    const c = deriveCutover({ qboLastByType: { Invoice: '2021-03-01' }, netsuiteFirstTrandate: '2021-04-01' });
    expect(c.overlapDays).toBe(-31);
  });

  it('carries the post-cutover counts through untouched', () => {
    const c = deriveCutover({
      qboLastByType: {}, netsuiteFirstTrandate: '2021-04-01',
      postCutoverCounts: { Invoice: 12, Payment: null },
    });
    expect(c.postCutoverCounts).toEqual({ Invoice: 12, Payment: null });
  });
});

describe('netsuiteFirstInvoiceDate', () => {
  it('prefers SuiteQL and says so', async () => {
    vi.spyOn(netsuite, 'suiteqlQuery').mockResolvedValue({ items: [{ d: '2021-04-01' }] });
    const svc = makeFakeService({ netsuite_sales_orders: [] });
    expect(await netsuiteFirstInvoiceDate(svc as any)).toEqual({ date: '2021-04-01', source: 'suiteql' });
  });

  it('falls back to the SO mirror and WARNS that it is a weaker number', async () => {
    // A first-SO date is not a first-invoice date; presenting one as the
    // other would be the report stating something it does not know.
    vi.spyOn(netsuite, 'suiteqlQuery').mockRejectedValue(new Error('role cannot read transaction'));
    const svc = makeFakeService({
      netsuite_sales_orders: [{ trandate: '2021-05-15' }, { trandate: '2021-04-20' }],
    });
    const result = await netsuiteFirstInvoiceDate(svc as any);
    expect(result.date).toBe('2021-04-20');
    expect(result.source).toBe('so_mirror');
    expect(result.warning).toMatch(/not from invoices/);
  });

  it('reports "none" with a warning when neither side can answer', async () => {
    vi.spyOn(netsuite, 'suiteqlQuery').mockRejectedValue(new Error('down'));
    const svc = makeFakeService({ netsuite_sales_orders: [] });
    const result = await netsuiteFirstInvoiceDate(svc as any);
    expect(result).toMatchObject({ date: null, source: 'none' });
    expect(result.warning).toMatch(/confirm the cutover by hand/);
  });
});
