import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCustomerDeposit, findCustomerDeposit, getDepositSalesOrder, type CustomerDepositPayload } from './netsuite';

// What FleetSuite asks NetSuite to take a customer's check or ACH deposit on a
// sales order (src/lib/take-deposit.ts): the order as NetSuite has it now, the
// deposit by FleetSuite's own name for it, and the deposit itself. Every call
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
const queryOf = (call: number) => (JSON.parse(fetchMock.mock.calls[call][1].body).q as string).replace(/\s+/g, ' ').trim();

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

describe('getDepositSalesOrder', () => {
  const ROW = {
    id: 4521, tranid: 'SO1450', trandate: '10/2/2026', customer_id: 501, customer_name: 'Acme Plumbing', customer_entity_id: 'C-501',
    status: 'B', status_name: 'Sales Order : Pending Fulfillment', total: '12500.40', subsidiary_id: 2,
  };

  it('reads the order, its customer, its company, its status and its total', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [ROW] }));
    expect(await getDepositSalesOrder(' 4521 ')).toEqual({
      id: '4521', number: 'SO1450', customerId: '501', customerName: 'Acme Plumbing', subsidiaryId: '2', date: '2026-10-02',
      status: 'B', statusName: 'Pending Fulfillment', totalCents: 1250040,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=5&offset=0`);
    expect(queryOf(0)).toContain('t.status, BUILTIN.DF(t.status) AS status_name, t.foreigntotal AS total, tl.subsidiary AS subsidiary_id');
    expect(queryOf(0)).toContain("FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' LEFT JOIN customer c ON c.id = t.entity");
    expect(queryOf(0)).toContain("WHERE t.type = 'SalesOrd' AND t.id = 4521");
  });

  it('names what NetSuite leaves out, and says when it has no such order', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...ROW, customer_name: null, status_name: 'Pending Billing' }] }));
    expect(await getDepositSalesOrder('4521')).toMatchObject({ customerName: 'C-501', statusName: 'Pending Billing' });
    fetchMock.mockResolvedValueOnce(json({ items: [{
      ...ROW, tranid: null, trandate: null, customer_name: '', customer_entity_id: null, subsidiary_id: null, status_name: null, total: null,
    }] }));
    expect(await getDepositSalesOrder('4521')).toEqual({
      id: '4521', number: 'Sales order 4521', customerId: '501', customerName: 'Customer 501', subsidiaryId: null, date: null,
      status: 'B', statusName: '', totalCents: 0,
    });
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await getDepositSalesOrder('4522')).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...ROW, customer_id: null }] }));
    expect(await getDepositSalesOrder('4523')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("asks nothing for an id that isn't one, and throws when NetSuite can't answer", async () => {
    await expect(getDepositSalesOrder('4521 OR 1=1')).rejects.toThrow("isn't a NetSuite sales order id");
    await expect(getDepositSalesOrder('')).rejects.toThrow("isn't a NetSuite sales order id");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Bad query', { status: 400 }));
    await expect(getDepositSalesOrder('4521')).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('findCustomerDeposit', () => {
  it('finds the deposit NetSuite has under its External ID', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7301, tranid: 'DEP-41' }] }));
    expect(await findCustomerDeposit(' fleetsuite-cd-6b0c1d2e-0000-4000-8000-000000000001 ')).toEqual({ depositId: '7301', number: 'DEP-41' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(0)).toBe(
      "SELECT id, tranid FROM transaction WHERE type = 'CustDep' AND externalid = 'fleetsuite-cd-6b0c1d2e-0000-4000-8000-000000000001' "
      + 'ORDER BY id FETCH FIRST 1 ROWS ONLY',
    );
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7302, tranid: null }] }));
    expect(await findCustomerDeposit('fleetsuite-cd-x')).toEqual({ depositId: '7302', number: '' });
  });

  it('says there is none only when NetSuite shows FleetSuite other customer deposits', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 6001 }] }));
    expect(await findCustomerDeposit('fleetsuite-cd-x')).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1&offset=0`);
    expect(queryOf(1)).toBe("SELECT id FROM transaction WHERE type = 'CustDep' FETCH FIRST 1 ROWS ONLY");
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await expect(findCustomerDeposit('fleetsuite-cd-x')).rejects.toThrow("FleetSuite can't see NetSuite's customer deposits");
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer", async () => {
    await expect(findCustomerDeposit("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findCustomerDeposit('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findCustomerDeposit('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findCustomerDeposit('fleetsuite-cd-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createCustomerDeposit', () => {
  const DEPOSIT: CustomerDepositPayload = {
    externalId: 'fleetsuite-cd-press-1',
    customerId: '501',
    subsidiaryId: '2',
    salesOrderId: '4521',
    tranDate: '2026-10-30',
    amount: 2500.5,
    checkNumber: '10442',
    memo: 'Check 10442 · half down',
  };

  it('makes it on the order named, in Undeposited Funds', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/customerDeposit/7303` } }));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: true, depositId: '7303' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/customerDeposit`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(JSON.parse(init.body)).toEqual({
      externalId: 'fleetsuite-cd-press-1',
      customer: { id: '501' },
      subsidiary: { id: '2' },
      salesOrder: { id: '4521' },
      tranDate: '2026-10-30',
      payment: 2500.5,
      undepFunds: true,
      memo: 'Check 10442 · half down',
      checkNum: '10442',
    });
  });

  it("sends no check number for an ACH deposit, and reads the id from the answer when there's no Location", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7304 }));
    expect(await createCustomerDeposit({ ...DEPOSIT, checkNumber: null, memo: 'ACH 0187' })).toEqual({ success: true, depositId: '7304' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('checkNum');
    expect(body.memo).toBe('ACH 0187');
  });

  it('sends nothing of $0 or less, or that names no sales order', async () => {
    const aboveZero = { success: false, error: 'A deposit needs to be above $0' };
    expect(await createCustomerDeposit({ ...DEPOSIT, amount: 0 })).toEqual(aboveZero);
    expect(await createCustomerDeposit({ ...DEPOSIT, amount: 0.004 })).toEqual(aboveZero);
    expect(await createCustomerDeposit({ ...DEPOSIT, amount: -5 })).toEqual(aboveZero);
    expect(await createCustomerDeposit({ ...DEPOSIT, amount: Number.NaN })).toEqual(aboveZero);
    const noOrder = { success: false, error: 'A deposit needs the sales order it goes on' };
    expect(await createCustomerDeposit({ ...DEPOSIT, salesOrderId: '' })).toEqual(noOrder);
    expect(await createCustomerDeposit({ ...DEPOSIT, salesOrderId: 'SO1450' })).toEqual(noOrder);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ id: 7305 }));
    expect(await createCustomerDeposit({ ...DEPOSIT, amount: 0.01 })).toEqual({ success: true, depositId: '7305' });
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'The sales order is closed.' }] }, 400));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (400): The sales order is closed.' });
    expect(logged.mock.calls[0][0]).toBe('NetSuite create customer deposit error:');
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Not JSON', { status: 422 }));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (422): Not JSON' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Gateway', { status: 500 }));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (500): Gateway', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({
      success: false, error: "NetSuite said it made the deposit but didn't say its id.", unsure: true,
    });
    fetchMock.mockResolvedValueOnce(json({ id: null }));
    expect((await createCustomerDeposit(DEPOSIT)).unsure).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createCustomerDeposit(DEPOSIT)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
