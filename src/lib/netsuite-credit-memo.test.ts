import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCreditMemoFromInvoice, getInvoiceCreditMemos, getInvoiceRecord } from './netsuite';

// What FleetSuite asks NetSuite for and sends it to make a credit memo
// against an invoice (src/lib/credit-memo.ts). Every call is mocked; the
// requests and how the answers are read are what's held. Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getInvoiceRecord', () => {
  it('reads the invoice with its lines', async () => {
    fetchMock.mockResolvedValue(json({ id: '7001', tranId: 'INV9001' }));
    expect(await getInvoiceRecord('7001')).toEqual({ success: true, record: { id: '7001', tranId: 'INV9001' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/invoice/7001?expandSubResources=true`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
  });

  it("says when NetSuite has no such invoice, or doesn't answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Not Found', 'o:errorDetails': [{ detail: 'The record instance does not exist.' }] }, 404));
    expect(await getInvoiceRecord('7002')).toEqual({ success: false, error: 'NetSuite 404: The record instance does not exist.', notFound: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await getInvoiceRecord('7001')).toEqual({ success: false, error: 'NetSuite request timed out' });
  });
});

describe('createCreditMemoFromInvoice', () => {
  const LINES = [{ item: { id: '55' }, quantity: 1, price: { id: '-1' }, rate: 125.5, isTaxable: true }];

  it("credits the invoice through NetSuite's own transform, with exactly the lines sent", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/creditMemo/8001` } }))
      .mockResolvedValueOnce(json({ items: [{ tranid: 'CM1001' }] }));
    expect(await createCreditMemoFromInvoice({ invoiceId: '7001', lines: LINES, memo: 'Returned' }))
      .toEqual({ success: true, creditMemoId: '8001', creditMemoNumber: 'CM1001' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/invoice/7001/!transform/creditMemo?replace=item`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ memo: 'Returned', item: { items: LINES } });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).q).toBe('SELECT tranid FROM transaction WHERE id = 8001');
  });

  it("says why NetSuite refused, and sends nothing with nothing to credit", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid item reference key 55.' }] }, 400));
    expect(await createCreditMemoFromInvoice({ invoiceId: '7001', lines: LINES, memo: 'Returned' }))
      .toEqual({ success: false, error: 'NetSuite error (400): Invalid item reference key 55.' });
    expect(await createCreditMemoFromInvoice({ invoiceId: '7001', lines: [], memo: 'Returned' })).toEqual({ success: false, error: 'Nothing to credit' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getInvoiceCreditMemos', () => {
  it("lists the credit memos linked to the invoice, through whichever link table NetSuite answers", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('Invalid search query: unknown table nexttransactionlinelink', { status: 400 }))
      .mockResolvedValueOnce(json({ items: [{ nextdoc: '8001' }, { nextdoc: '8001' }, { nextdoc: '9100' }], hasMore: false }))
      .mockResolvedValueOnce(json({ items: [{ id: '8001', tranid: 'CM1001', trandate: '10/31/2026', foreigntotal: '-136.15' }], hasMore: false }));
    expect(await getInvoiceCreditMemos('7001')).toEqual({
      success: true, creditMemos: [{ id: '8001', number: 'CM1001', date: '2026-10-31', total: 136.15 }],
    });
    const queries = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).q as string);
    expect(queries[0]).toBe('SELECT DISTINCT nextdoc FROM nexttransactionlinelink WHERE previousdoc = 7001');
    expect(queries[1]).toBe('SELECT DISTINCT nextdoc FROM previoustransactionlinelink WHERE previousdoc = 7001');
    expect(queries[2]).toContain("t.type = 'CustCred' AND t.id IN (8001, 9100)");
  });

  it('has none to list without links, and says when it can read neither table', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], hasMore: false }));
    expect(await getInvoiceCreditMemos('7001')).toEqual({ success: true, creditMemos: [] });
    fetchMock.mockResolvedValue(new Response('Invalid search query', { status: 400 }));
    const refused = await getInvoiceCreditMemos('7001');
    expect(refused.success).toBe(false);
    expect(await getInvoiceCreditMemos('7001; DROP')).toEqual({ success: false, error: 'Bad invoice id' });
  });
});
