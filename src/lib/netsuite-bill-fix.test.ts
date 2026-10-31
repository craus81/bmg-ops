import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getBillPostings, getOrderLineIds, getVendorBillAmounts, getVendorBillRecord, patchVendorBill } from './netsuite';

// What FleetSuite asks NetSuite for and sends it to fix a bill
// (src/lib/bill-fix.ts) and to undo all of one with a vendor credit
// (src/lib/vendor-credit.ts creditAllOfBill), and how it reads the answers:
// NetSuite's refusal in its own words, and a timeout or a fault on NetSuite's
// side as unsure, since the change may have gone in. Every call is mocked.
// Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const queryOf = (call: number) => (JSON.parse(fetchMock.mock.calls[call][1].body).q as string).replace(/\s+/g, ' ');

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getVendorBillRecord', () => {
  it('reads the bill live, both its lists of lines with it', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: '3001', tranId: 'B-100', expense: { items: [] }, item: { items: [] } }));
    expect(await getVendorBillRecord('3001')).toEqual({
      success: true, record: { id: '3001', tranId: 'B-100', expense: { items: [] }, item: { items: [] } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/vendorBill/3001?expandSubResources=true`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
  });

  it("says when NetSuite has no such bill, and why it couldn't read one", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Not Found', 'o:errorDetails': [{ detail: 'The record instance does not exist.' }] }, 404));
    expect(await getVendorBillRecord('3001')).toEqual({ success: false, error: 'NetSuite 404: The record instance does not exist.', notFound: true });
    fetchMock.mockResolvedValueOnce(new Response('Invalid login attempt.', { status: 401 }));
    expect(await getVendorBillRecord('3001')).toEqual({ success: false, error: 'NetSuite 401: Invalid login attempt.' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await getVendorBillRecord('3001')).toEqual({ success: false, error: 'fetch failed' });
  });

  it('gives up after 25 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = getVendorBillRecord('3001');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ success: false, error: 'NetSuite request timed out' });
  });

  it('asks nothing for an id that is not a number', async () => {
    expect(await getVendorBillRecord('3001/../1')).toEqual({ success: false, error: 'Bad bill id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getVendorBillAmounts', () => {
  it("reads the bill's total, what's still owed on it and its status, in cents", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: '3001', total: '-245.10', unpaid: '-100.05', status_label: 'Bill : Open' }] }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: true, totalCents: 24510, owedCents: 10005, status: 'Bill : Open', voided: false });
    const q = queryOf(0);
    expect(q).toContain('t.foreigntotal AS total, t.foreignamountunpaid AS unpaid, BUILTIN.DF(t.status) AS status_label');
    expect(q).toContain("WHERE t.id = 3001 AND t.type = 'VendBill'");
  });

  it('knows a voided bill by its status, and a paid one by nothing owed', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: '3001', total: 0, unpaid: 0, status_label: 'Bill : Voided' }] }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: true, totalCents: 0, owedCents: 0, status: 'Bill : Voided', voided: true });
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: '3001', total: 80, unpaid: '0.00', status_label: null }] }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: true, totalCents: 8000, owedCents: 0, status: null, voided: false });
  });

  it("says when there's no such bill, or NetSuite sent what it can't read", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: false, error: 'NetSuite has no bill with id 3001.', notFound: true });
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: '3001', total: null, unpaid: '1' }] }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: false, error: "NetSuite sent a total or an amount owed FleetSuite can't read" });
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: '3001', total: '1', unpaid: 'n/a' }] }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: false, error: "NetSuite sent a total or an amount owed FleetSuite can't read" });
    fetchMock.mockResolvedValueOnce(new Response('Invalid search query', { status: 400 }));
    expect(await getVendorBillAmounts('3001')).toEqual({ success: false, error: 'NetSuite SuiteQL error (400): Invalid search query' });
  });

  it('asks nothing for an id that is not a number', async () => {
    expect(await getVendorBillAmounts('3001 OR 1=1')).toEqual({ success: false, error: 'Bad bill id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('patchVendorBill', () => {
  const BODY = { tranId: 'B-101', expense: { items: [{ line: 1, amount: 120 }] } };

  it('changes the lines sent by their keys, and only those', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await patchVendorBill('3001', BODY, { replace: [] })).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/vendorBill/3001`);
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it('makes each list a line is taken off exactly the lines sent', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await patchVendorBill('3001', BODY, { replace: ['expense'] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/record/v1/vendorBill/3001?replace=expense`);
    await patchVendorBill('3001', BODY, { replace: ['expense', 'item'] });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/record/v1/vendorBill/3001?replace=expense,item`);
  });

  it('says why NetSuite refused, and that nothing changed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'The period is closed.' }] }, 400));
    expect(await patchVendorBill('3001', BODY, { replace: [] })).toEqual({ success: false, error: 'NetSuite error (400): The period is closed.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await patchVendorBill('3001', BODY, { replace: [] })).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Invalid login attempt.', { status: 401 }));
    expect(await patchVendorBill('3001', BODY, { replace: [] })).toEqual({ success: false, error: 'NetSuite error (401): Invalid login attempt.' });
  });

  it("can't tell whether it went in when NetSuite faults, times out or can't be reached", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Internal Server Error', 'o:errorDetails': [{ detail: 'An unexpected error occurred.' }] }, 500));
    expect(await patchVendorBill('3001', BODY, { replace: [] }))
      .toEqual({ success: false, error: 'NetSuite error (500): An unexpected error occurred.', unsure: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await patchVendorBill('3001', BODY, { replace: [] })).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await patchVendorBill('3001', BODY, { replace: [] })).toEqual({ success: false, error: "Couldn't reach NetSuite: fetch failed", unsure: true });
  });

  it('gives up after 25 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = patchVendorBill('3001', BODY, { replace: [] });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
  });

  it('sends nothing for an id that is not a number', async () => {
    expect(await patchVendorBill('3001; DROP', BODY, { replace: [] })).toEqual({ success: false, error: 'Bad bill id' });
    expect(await patchVendorBill('', BODY, { replace: ['item'] })).toEqual({ success: false, error: 'Bad bill id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getOrderLineIds', () => {
  it("maps each line's sequence number to its id, skipping what isn't a line", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { id: '91', linesequencenumber: '1' },
      { id: 92, linesequencenumber: 2 },
      { id: '93', linesequencenumber: null },
      { id: 'x', linesequencenumber: '4' },
    ] }));
    expect([...await getOrderLineIds('2001')]).toEqual([[1, '91'], [2, '92']]);
    const q = queryOf(0);
    expect(q).toContain('SELECT tl.id, tl.linesequencenumber FROM transactionline tl');
    expect(q).toContain("WHERE tl.transaction = 2001 AND tl.mainline = 'F'");
  });

  it("throws when it can't ask, so the caller keeps no ids", async () => {
    await expect(getOrderLineIds('PO123')).rejects.toThrow('NetSuite order id "PO123" isn\'t a number');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(getOrderLineIds('2001')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('getBillPostings', () => {
  it('reads every line the bill posted: its account, debit and credit in cents, and which is the payables line', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { line_id: '0', account_id: '111', debit: null, credit: '245.10', mainline: 'T', memo: null },
      { line_id: '1', account_id: '610', debit: '200.05', credit: null, mainline: 'F', memo: ' Shelving ' },
      { line_id: '2', account_id: '620', debit: '45.05', credit: '', mainline: 'F', memo: '' },
      { line_id: '3', account_id: null, debit: '9', credit: null, mainline: 'F', memo: null },
      { line_id: '4', account_id: ' 140 ', debit: '-12.50', credit: null, mainline: 't', memo: null },
      { line_id: '5', account_id: '200', debit: null, credit: '1', mainline: true, memo: null },
    ] }));
    expect(await getBillPostings('3001')).toEqual({
      success: true,
      rows: [
        { lineId: '0', accountId: '111', debitCents: 0, creditCents: 24510, payables: true, memo: null },
        { lineId: '1', accountId: '610', debitCents: 20005, creditCents: 0, payables: false, memo: 'Shelving' },
        { lineId: '2', accountId: '620', debitCents: 4505, creditCents: 0, payables: false, memo: null },
        // A debit given as less than nothing counts against its account, as everywhere else in Books.
        { lineId: '4', accountId: '140', debitCents: -1250, creditCents: 0, payables: true, memo: null },
        { lineId: '5', accountId: '200', debitCents: 0, creditCents: 100, payables: true, memo: null },
      ],
    });
    const q = queryOf(0);
    expect(q).toContain('FROM transactionaccountingline tal JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline');
    expect(q).toContain("WHERE tal.transaction = 3001 AND tal.posting = 'T' AND tal.account IS NOT NULL");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
  });

  it("says when NetSuite can't answer, and asks nothing for an id that is not a number", async () => {
    expect(await getBillPostings('bill')).toEqual({ success: false, error: 'Bad bill id' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Invalid search query', { status: 400 }));
    expect(await getBillPostings('3001')).toEqual({ success: false, error: 'NetSuite SuiteQL error (400): Invalid search query' });
  });
});
