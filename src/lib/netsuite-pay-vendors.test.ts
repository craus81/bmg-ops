import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVendorPayment, findVendorPayment, getBillsNow, getOpenBills, type VendorPaymentPayload } from './netsuite';

// What FleetSuite asks NetSuite to pay vendors in a payment run
// (src/lib/pay-vendors.ts): a company's open bills, bills as NetSuite has
// them now, the bill payment by FleetSuite's own name for it, and the bill
// payment itself. Every call is mocked; the requests and how the answers are
// read are what's held. Made-up data.

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
const queryOf = (call: number) => (JSON.parse(fetchMock.mock.calls[call][1].body).q as string).replace(/\s+/g, ' ').trim();

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

describe('getOpenBills', () => {
  const BILL = {
    id: 7001, tranid: 'B-4410', trandate: '9/20/2026', duedate: '10/20/2026', unpaid: '812.40', vendor_id: 31,
    vendor_name: 'Ozark Hose & Fitting', vendor_entity_id: 'V-031',
  };

  it("reads the subsidiary's open bills, vendor by vendor, oldest due first", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [BILL, { ...BILL, id: 7002, tranid: 'B-4471', trandate: '2026-10-06', duedate: '11/5/2026', unpaid: '1100' }] }));
    expect(await getOpenBills(' 2 ')).toEqual([
      { id: '7001', number: 'B-4410', date: '2026-09-20', dueDate: '2026-10-20', vendorId: '31', vendorName: 'Ozark Hose & Fitting', openCents: 81240 },
      { id: '7002', number: 'B-4471', date: '2026-10-06', dueDate: '2026-11-05', vendorId: '31', vendorName: 'Ozark Hose & Fitting', openCents: 110000 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(0)).toBe(
      'SELECT t.id, t.tranid, t.trandate, t.duedate, t.foreignamountunpaid AS unpaid, t.entity AS vendor_id, '
      + 'v.companyname AS vendor_name, v.entityid AS vendor_entity_id '
      + "FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' LEFT JOIN vendor v ON v.id = t.entity "
      + "WHERE t.type = 'VendBill' AND t.status = 'A' AND tl.subsidiary = 2 ORDER BY t.entity, t.duedate, t.id",
    );
  });

  it('keeps only bills with an id, a vendor and something open, each once, its sign dropped', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { ...BILL, id: 7101, unpaid: '0.00' },
      { ...BILL, id: 7102, unpaid: null },
      { ...BILL, id: 7103, unpaid: 'n/a' },
      { ...BILL, id: null },
      { ...BILL, id: 7105, vendor_id: null },
      { ...BILL, id: 7106, vendor_id: 'V-31' },
      { ...BILL, id: 7107, unpaid: '-48.5' },
      { ...BILL, id: 7107, unpaid: '-48.5' },
      { ...BILL, id: 7108, duedate: null, trandate: 'someday' },
    ] }));
    expect(await getOpenBills('2')).toEqual([
      { id: '7107', number: 'B-4410', date: '2026-09-20', dueDate: '2026-10-20', vendorId: '31', vendorName: 'Ozark Hose & Fitting', openCents: 4850 },
      { id: '7108', number: 'B-4410', date: null, dueDate: null, vendorId: '31', vendorName: 'Ozark Hose & Fitting', openCents: 81240 },
    ]);
  });

  it('names what NetSuite leaves out', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { ...BILL, tranid: null, vendor_name: null },
      { ...BILL, id: 7002, tranid: ' ', vendor_name: '', vendor_entity_id: null },
    ] }));
    expect(await getOpenBills('2')).toMatchObject([
      { id: '7001', number: 'Bill 7001', vendorName: 'V-031' },
      { id: '7002', number: 'Bill 7002', vendorName: 'Vendor 31' },
    ]);
  });

  it('reads every page', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: Array.from({ length: 1000 }, (_, i) => ({ ...BILL, id: 20000 + i })) }));
    fetchMock.mockResolvedValueOnce(json({ items: [BILL] }));
    expect(await getOpenBills('2')).toHaveLength(1001);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=1000`);
  });

  it("asks nothing for a subsidiary that isn't one, and throws when NetSuite can't answer", async () => {
    await expect(getOpenBills('2 OR 1=1')).rejects.toThrow("isn't a NetSuite subsidiary id");
    await expect(getOpenBills('')).rejects.toThrow("isn't a NetSuite subsidiary id");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Bad query', { status: 400 }));
    await expect(getOpenBills('2')).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('getBillsNow', () => {
  it('reads each bill as NetSuite has it now: open or not, what is open, and whose', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { id: 7001, status: 'A', vendor_id: 31, unpaid: '812.40' },
      { id: 7002, status: 'B', vendor_id: '31', unpaid: '0' },
      { id: 7003, status: 'D', vendor_id: null, unpaid: null },
      // A vendor that isn't NetSuite's id for one is no vendor.
      { id: 7005, status: 'A', vendor_id: 'Gateway Steel', unpaid: '10.00' },
    ] }));
    const now = await getBillsNow(['7001', '7002', ' 7003', '7003', '7002', 'B-4410', "7004) OR (1=1", '7003', '7005']);
    expect([...now]).toEqual([
      ['7001', { open: true, openCents: 81240, vendorId: '31' }],
      ['7002', { open: false, openCents: 0, vendorId: '31' }],
      ['7003', { open: false, openCents: 0, vendorId: null }],
      ['7005', { open: true, openCents: 1000, vendorId: null }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryOf(0)).toBe(
      "SELECT t.id, t.status, t.entity AS vendor_id, t.foreignamountunpaid AS unpaid FROM transaction t WHERE t.type = 'VendBill' AND t.id IN (7001, 7002, 7003, 7005) ORDER BY t.id",
    );
  });

  it('asks nothing for no bills, and asks 200 at a time', async () => {
    expect([...(await getBillsNow([]))]).toEqual([]);
    expect([...(await getBillsNow(['B-1', '']))]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 30000, status: 'A', vendor_id: 31, unpaid: '1' }] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 30200, status: 'A', vendor_id: 31, unpaid: '2' }] }));
    const now = await getBillsNow(Array.from({ length: 201 }, (_, i) => String(30000 + i)));
    expect([...now.keys()]).toEqual(['30000', '30200']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queryOf(0).match(/IN \(([^)]*)\)/)?.[1].split(', ')).toHaveLength(200);
    expect(queryOf(1)).toContain('t.id IN (30200)');
  });

  it("throws when NetSuite can't answer", async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad query', { status: 400 }));
    await expect(getBillsNow(['7001'])).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('findVendorPayment', () => {
  it('finds the bill payment NetSuite has under its External ID, with its total', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 8302, tranid: 'CHK-5521', total: '-1412.40' }] }));
    expect(await findVendorPayment(' fleetsuite-vp-f0000000-0000-4000-8000-000000000001 ')).toEqual({ paymentId: '8302', number: 'CHK-5521', totalCents: 141240 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(0)).toBe(
      "SELECT id, tranid, foreigntotal AS total FROM transaction WHERE type = 'VendPymt' AND externalid = 'fleetsuite-vp-f0000000-0000-4000-8000-000000000001' "
      + 'ORDER BY id FETCH FIRST 1 ROWS ONLY',
    );
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 8303, tranid: null, total: null }] }));
    expect(await findVendorPayment('fleetsuite-vp-x')).toEqual({ paymentId: '8303', number: '', totalCents: null });
  });

  it('says there is none only when NetSuite shows FleetSuite other bill payments', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 6001 }] }));
    expect(await findVendorPayment('fleetsuite-vp-x')).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1&offset=0`);
    expect(queryOf(1)).toBe("SELECT id FROM transaction WHERE type = 'VendPymt' FETCH FIRST 1 ROWS ONLY");
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await expect(findVendorPayment('fleetsuite-vp-x')).rejects.toThrow("FleetSuite can't see NetSuite's bill payments");
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer", async () => {
    await expect(findVendorPayment("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findVendorPayment('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findVendorPayment('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findVendorPayment('fleetsuite-vp-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createVendorPayment', () => {
  const PAYMENT: VendorPaymentPayload = {
    externalId: 'fleetsuite-vp-pay-1',
    vendorId: '31',
    subsidiaryId: '2',
    accountId: '211',
    tranDate: '2026-11-06',
    memo: 'November run',
    toBePrinted: true,
    amount: 1412.4,
    apply: [{ billId: '7001', amount: 812.4 }, { billId: '7002', amount: 600 }],
  };

  it("pays exactly the bills named, from the bank account named, in the vendor's currency", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ currency: 1 }] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/vendorPayment/8302` } }));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: true, paymentId: '8302' });
    expect(queryOf(0)).toBe('SELECT currency FROM vendor WHERE id = 31');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/rest/record/v1/vendorPayment`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(JSON.parse(init.body)).toEqual({
      externalId: 'fleetsuite-vp-pay-1',
      entity: { id: '31' },
      currency: { id: '1' },
      subsidiary: { id: '2' },
      account: { id: '211' },
      tranDate: '2026-11-06',
      memo: 'November run',
      toBePrinted: true,
      apply: { items: [{ doc: { id: '7001' }, apply: true, amount: 812.4 }, { doc: { id: '7002' }, apply: true, amount: 600 }] },
    });
  });

  it("sends an ACH payment not To Be Printed, with no memo when there's none, and reads the id from the answer", async () => {
    vi.stubEnv('NETSUITE_CURRENCY_ID', '1');
    fetchMock.mockResolvedValueOnce(json({ id: 8304 }));
    expect(await createVendorPayment({ ...PAYMENT, memo: '', toBePrinted: false })).toEqual({ success: true, paymentId: '8304' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('memo');
    expect(body).toMatchObject({ toBePrinted: false, currency: { id: '1' } });
  });

  it("lets NetSuite pick the currency when the vendor's can't be read", async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad query', { status: 400 }));
    fetchMock.mockResolvedValueOnce(json({ id: 8305 }));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: true, paymentId: '8305' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('currency');
  });

  it("sends nothing that doesn't add up, or doesn't name its bills and bank account by NetSuite's ids", async () => {
    expect(await createVendorPayment({ ...PAYMENT, apply: [] })).toEqual({ success: false, error: 'A bill payment needs a bill to pay' });
    const byId = { success: false, error: "A bill payment pays bills by NetSuite's id for them" };
    expect(await createVendorPayment({ ...PAYMENT, apply: [{ billId: 'B-4410', amount: 1412.4 }] })).toEqual(byId);
    expect(await createVendorPayment({ ...PAYMENT, apply: [{ billId: '', amount: 1412.4 }] })).toEqual(byId);
    const noAccount = { success: false, error: 'A bill payment needs the bank account it is paid from' };
    expect(await createVendorPayment({ ...PAYMENT, accountId: '' })).toEqual(noAccount);
    expect(await createVendorPayment({ ...PAYMENT, accountId: '10100 Operating' })).toEqual(noAccount);
    const aboveZero = { success: false, error: 'A bill payment, and what it pays on each bill, need to be above $0' };
    expect(await createVendorPayment({ ...PAYMENT, amount: 0, apply: [{ billId: '7001', amount: 0 }] })).toEqual(aboveZero);
    expect(await createVendorPayment({ ...PAYMENT, apply: [{ billId: '7001', amount: 1412.41 }, { billId: '7002', amount: -0.01 }] })).toEqual(aboveZero);
    expect(await createVendorPayment({ ...PAYMENT, amount: Number.NaN })).toEqual(aboveZero);
    expect(await createVendorPayment({ ...PAYMENT, amount: 1412.41 })).toEqual({
      success: false, error: "What the payment pays on its bills doesn't add up to its amount",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // To the cent, however the dollars add up in floating point.
    vi.stubEnv('NETSUITE_CURRENCY_ID', '1');
    fetchMock.mockResolvedValueOnce(json({ id: 8306 }));
    expect(await createVendorPayment({ ...PAYMENT, amount: 0.3, apply: [{ billId: '7001', amount: 0.1 }, { billId: '7002', amount: 0.2 }] }))
      .toEqual({ success: true, paymentId: '8306' });
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    vi.stubEnv('NETSUITE_CURRENCY_ID', '1');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid apply reference key 7002.' }] }, 400));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (400): Invalid apply reference key 7002.' });
    expect(logged.mock.calls[0][0]).toBe('NetSuite create bill payment error:');
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Not JSON', { status: 422 }));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (422): Not JSON' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Gateway', { status: 500 }));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (500): Gateway', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createVendorPayment(PAYMENT)).toEqual({
      success: false, error: "NetSuite said it made the bill payment but didn't say its id.", unsure: true,
    });
    fetchMock.mockResolvedValueOnce(json({ id: null }));
    expect((await createVendorPayment(PAYMENT)).unsure).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createVendorPayment(PAYMENT)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
