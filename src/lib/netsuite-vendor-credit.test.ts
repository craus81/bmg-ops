import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVendorCredit, findVendorCredit, getVendorOpenBills, type VendorCreditPayload } from './netsuite';

// What FleetSuite asks NetSuite for and sends it to make a vendor credit and
// apply it to the vendor's open bills (src/lib/vendor-credit.ts). Every call
// is mocked; the requests and how the answers are read are what's held.
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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const queryOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body).q as string;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv('NETSUITE_CURRENCY_ID', '');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getVendorOpenBills', () => {
  it("reads the vendor's open bills and credits, oldest first, for the company's subsidiary", async () => {
    fetchMock.mockResolvedValueOnce(json({
      items: [
        { id: '3002', type: 'VendBill', tranid: 'B-101', trandate: '8/15/2026', duedate: '9/15/2026', unpaid: '50.00', subsidiary_id: '2' },
        { id: '3001', type: 'VendBill', tranid: 'B-100', trandate: '2026-09-01', duedate: null, unpaid: 200, subsidiary_id: '2' },
        { id: '3001', type: 'VendBill', tranid: 'B-100', trandate: '2026-09-01', duedate: null, unpaid: 200, subsidiary_id: '2' },
        { id: '3005', type: 'VendBill', tranid: 'B-102', trandate: '2026-09-02', duedate: null, unpaid: 75, subsidiary_id: '3' },
        { id: '3006', type: 'VendBill', tranid: null, trandate: '2026-09-03', duedate: null, unpaid: '0', subsidiary_id: '2' },
        { id: '6001', type: 'VendCred', tranid: 'VC-1', trandate: '2026-09-04', duedate: null, unpaid: '-12.34', subsidiary_id: '2' },
        { id: 'x', type: 'VendBill', tranid: 'BAD', trandate: '2026-09-05', unpaid: 5, subsidiary_id: '2' },
        { id: '3007', type: 'VendBill', tranid: 'NODATE', trandate: '', unpaid: 5, subsidiary_id: '2' },
      ],
    }));
    expect(await getVendorOpenBills('4001', '2')).toEqual({
      success: true,
      bills: [
        { id: '3002', number: 'B-101', date: '2026-08-15', dueDate: '2026-09-15', openCents: 5000 },
        { id: '3001', number: 'B-100', date: '2026-09-01', dueDate: null, openCents: 20000 },
      ],
      credits: [{ id: '6001', number: 'VC-1', date: '2026-09-04', dueDate: null, openCents: 1234 }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(init.method).toBe('POST');
    const q = queryOf(0).replace(/\s+/g, ' ');
    expect(q).toContain("WHERE t.type IN ('VendBill', 'VendCred') AND t.status = 'A' AND t.entity = 4001");
    expect(q).toContain("JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T'");
    expect(q).toContain('t.foreignamountunpaid AS unpaid');
    expect(q).toContain('ORDER BY t.trandate, t.id');
  });

  it('reads every subsidiary when none is given', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { id: '3001', type: 'VendBill', tranid: 'B-100', trandate: '2026-09-01', unpaid: 200, subsidiary_id: '2' },
      { id: '3005', type: 'VendBill', tranid: 'B-102', trandate: '2026-09-02', unpaid: 75, subsidiary_id: '3' },
    ] }));
    const res = await getVendorOpenBills(4001);
    expect(res.success && res.bills.map((b) => b.id)).toEqual(['3001', '3005']);
  });

  it("asks nothing for a vendor id that isn't a number, and says when NetSuite can't answer", async () => {
    expect(await getVendorOpenBills('40 01')).toEqual({ success: false, error: 'Bad vendor id' });
    expect(await getVendorOpenBills("1 OR 1=1")).toEqual({ success: false, error: 'Bad vendor id' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Invalid search query', { status: 400 }));
    expect(await getVendorOpenBills('4001')).toEqual({ success: false, error: 'NetSuite SuiteQL error (400): Invalid search query' });
  });
});

describe('findVendorCredit', () => {
  it("finds the vendor's credit by its number, whatever its case", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: '6001', tranid: 'VC-77' }] }));
    expect(await findVendorCredit('4001', ' vc-77 ')).toEqual({ vendorCreditId: '6001', number: 'VC-77' });
    const q = queryOf(0).replace(/\s+/g, ' ');
    expect(q).toContain("WHERE type = 'VendCred' AND entity = 4001 AND UPPER(tranid) = UPPER('vc-77')");
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await findVendorCredit(4001, 'VC-78')).toBeNull();
  });

  it("keeps a quote in the number from breaking the query", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await findVendorCredit('4001', "O'NEIL-1");
    expect(queryOf(0)).toContain("UPPER('O''NEIL-1')");
  });

  it("throws when it can't ask, so the caller sends nothing", async () => {
    await expect(findVendorCredit('vendor', 'VC-77')).rejects.toThrow('NetSuite vendor id "vendor" isn\'t a number');
    await expect(findVendorCredit('4001', '  ')).rejects.toThrow('No credit number to look for');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findVendorCredit('4001', 'VC-77')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createVendorCredit', () => {
  const CREDIT: VendorCreditPayload = {
    vendorId: '4001', tranId: 'VC-77', tranDate: '2026-10-30', subsidiaryId: '2', locationId: '1', memo: 'Returned shelf',
    expenses: [{ accountId: '610', amount: 20, memo: 'Restock fee back' }, { accountId: '620', amount: 5 }],
    items: [{ itemId: '55', quantity: 1, rate: 125.5, amount: 125.5 }],
    apply: [{ billId: '3002', amount: 50 }],
  };

  it("makes it in the vendor's currency, with its lines, at the header location, applied to the bills", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ currency: '1' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/vendorCredit/6002` } }));
    expect(await createVendorCredit(CREDIT)).toEqual({ success: true, vendorCreditId: '6002' });
    expect(queryOf(0)).toBe('SELECT currency FROM vendor WHERE id = 4001');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/rest/record/v1/vendorCredit`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(JSON.parse(init.body)).toEqual({
      entity: { id: '4001' },
      currency: { id: '1' },
      tranId: 'VC-77',
      tranDate: '2026-10-30',
      subsidiary: { id: '2' },
      location: { id: '1' },
      memo: 'Returned shelf',
      expense: { items: [{ account: { id: '610' }, amount: 20, memo: 'Restock fee back' }, { account: { id: '620' }, amount: 5 }] },
      item: { items: [{ item: { id: '55' }, quantity: 1, rate: 125.5, amount: 125.5 }] },
      apply: { items: [{ doc: { id: '3002' }, apply: true, amount: 50 }] },
    });
  });

  it("leaves out what isn't there: no location, no parts, nothing applied, and the currency when the vendor has none", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ id: 6003 }, 200));
    expect(await createVendorCredit({ ...CREDIT, locationId: null, items: [], apply: [] })).toEqual({ success: true, vendorCreditId: '6003' });
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(Object.keys(sent)).toEqual(['entity', 'tranId', 'tranDate', 'subsidiary', 'memo', 'expense']);
  });

  it('sends a part with no account lines', async () => {
    vi.stubEnv('NETSUITE_CURRENCY_ID', '7');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/vendorCredit/6004` } }));
    expect(await createVendorCredit({ ...CREDIT, expenses: [] })).toEqual({ success: true, vendorCreditId: '6004' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.currency).toEqual({ id: '7' });
    expect(sent.expense).toBeUndefined();
    expect(sent.item.items).toHaveLength(1);
  });

  it("says why NetSuite refused, sends nothing with nothing to credit, and won't call it made without an id", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NETSUITE_CURRENCY_ID', '1');
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid apply reference key 3002.' }] }, 400));
    expect(await createVendorCredit(CREDIT)).toEqual({ success: false, error: 'NetSuite error (400): Invalid apply reference key 3002.' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createVendorCredit(CREDIT)).toEqual({ success: false, error: 'NetSuite error (503): Server busy' });
    expect(await createVendorCredit({ ...CREDIT, expenses: [], items: [] })).toEqual({ success: false, error: 'Nothing to credit' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createVendorCredit(CREDIT)).toEqual({
      success: false, error: "NetSuite said it made the vendor credit but didn't say its id. Look for it in NetSuite before trying again.",
    });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createVendorCredit(CREDIT)).toEqual({ success: false, error: 'Failed to create the vendor credit: socket hang up' });
  });
});
