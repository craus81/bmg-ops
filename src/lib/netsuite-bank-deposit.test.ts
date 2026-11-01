import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBankDeposit, findBankDeposit, getUndepositedFunds, type BankDepositPayload } from './netsuite';

// What FleetSuite asks NetSuite to deposit the payments waiting in Undeposited
// Funds to the bank (src/lib/bank-deposit.ts): what's waiting for a company,
// the bank deposit by FleetSuite's own name for it, and the bank deposit
// itself. Every call is mocked; the requests and how the answers are read are
// what's held. Made-up data.

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

describe('getUndepositedFunds', () => {
  const PAYMENT = {
    id: 9001, type: 'CustPymt', tranid: 'PYMT-9001', trandate: '10/28/2026', customer_name: 'Rivera Plumbing', customer_entity_id: 'C-501',
    reference: '10442', status_name: 'Payment : Not Deposited', total: '1250.00',
  };
  const DEPOSIT = {
    ...PAYMENT, id: 9003, type: 'CustDep', tranid: 'DEP-77', trandate: '10/30/2026', customer_name: 'Ozark Fleet Co', reference: null,
    status_name: 'Customer Deposit : Not Deposited', total: '2500',
  };
  const seesPayments = () => fetchMock.mockResolvedValueOnce(json({ items: [{ id: 1 }] }));

  it("reads the company's payments and deposits NetSuite has as Not Deposited, oldest first", async () => {
    seesPayments();
    fetchMock.mockResolvedValueOnce(json({ items: [PAYMENT, DEPOSIT] }));
    expect(await getUndepositedFunds(' 2 ', { since: '2025-10-30' })).toEqual([
      { netsuiteId: '9001', kind: 'payment', number: 'PYMT-9001', date: '2026-10-28', customerName: 'Rivera Plumbing', reference: '10442', cents: 125000 },
      { netsuiteId: '9003', kind: 'deposit', number: 'DEP-77', date: '2026-10-30', customerName: 'Ozark Fleet Co', reference: null, cents: 250000 },
    ]);
    expect(queryOf(0)).toBe("SELECT id FROM transaction WHERE type = 'CustPymt' FETCH FIRST 1 ROWS ONLY");
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(1)).toContain('t.otherrefnum AS reference, BUILTIN.DF(t.status) AS status_name, t.foreigntotal AS total');
    expect(queryOf(1)).toContain("FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' LEFT JOIN customer c ON c.id = t.entity");
    expect(queryOf(1)).toContain("WHERE t.type IN ('CustPymt', 'CustDep') AND tl.subsidiary = 2");
    expect(queryOf(1)).toContain("AND t.trandate >= TO_DATE('10/30/2025', 'MM/DD/YYYY') AND BUILTIN.DF(t.status) LIKE '%Not Deposited'");
    expect(queryOf(1)).toContain('ORDER BY t.trandate, t.id');
  });

  it("keeps only what NetSuite names Not Deposited, with an amount, a day and an id", async () => {
    seesPayments();
    fetchMock.mockResolvedValueOnce(json({ items: [
      { ...PAYMENT, id: 9101, status_name: 'Payment : Deposited' },
      { ...PAYMENT, id: 9102, status_name: 'Customer Deposit : Fully Applied' },
      { ...PAYMENT, id: 9103, status_name: 'Payment : Not Deposited yet' },
      { ...PAYMENT, id: 9104, total: '0.00' },
      { ...PAYMENT, id: 9105, total: null },
      { ...PAYMENT, id: 9106, trandate: null },
      { ...PAYMENT, id: null },
      { ...PAYMENT, id: 9108, type: 'CashSale' },
      { ...PAYMENT, id: 9109, total: '-48.5', status_name: 'payment : not deposited' },
      { ...PAYMENT, id: 9110, status_name: 'Not Deposited' },
      { ...PAYMENT, id: 9111, status_name: 'Payment Not Deposited' },
    ] }));
    expect((await getUndepositedFunds('2', { since: '2025-10-30' })).map((w) => [w.netsuiteId, w.cents])).toEqual([['9109', 4850], ['9110', 125000]]);
  });

  it('names what NetSuite leaves out', async () => {
    seesPayments();
    fetchMock.mockResolvedValueOnce(json({ items: [
      { ...PAYMENT, tranid: null, customer_name: null, reference: '  ' },
      { ...DEPOSIT, tranid: '', customer_name: '', customer_entity_id: null },
    ] }));
    expect(await getUndepositedFunds('2', { since: '2025-10-30' })).toMatchObject([
      { number: 'Payment 9001', customerName: 'C-501', reference: null },
      { number: 'Deposit 9003', customerName: 'No customer' },
    ]);
  });

  it('reads every page', async () => {
    seesPayments();
    fetchMock.mockResolvedValueOnce(json({ items: Array.from({ length: 1000 }, (_, i) => ({ ...PAYMENT, id: 20000 + i })) }));
    fetchMock.mockResolvedValueOnce(json({ items: [DEPOSIT] }));
    expect(await getUndepositedFunds('2', { since: '2025-10-30' })).toHaveLength(1001);
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=1000`);
  });

  it("throws when FleetSuite can't see customer payments, since none waiting can't be told from none seen", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await expect(getUndepositedFunds('2', { since: '2025-10-30' })).rejects.toThrow("FleetSuite can't see NetSuite's customer payments");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a subsidiary or day that isn't one, and throws when NetSuite can't answer", async () => {
    await expect(getUndepositedFunds('2 OR 1=1', { since: '2025-10-30' })).rejects.toThrow("isn't a NetSuite subsidiary id");
    await expect(getUndepositedFunds('', { since: '2025-10-30' })).rejects.toThrow("isn't a NetSuite subsidiary id");
    await expect(getUndepositedFunds('2', { since: "2025-10-30' OR '1'='1" })).rejects.toThrow("isn't a day");
    await expect(getUndepositedFunds('2', { since: '10/30/2025' })).rejects.toThrow("isn't a day");
    expect(fetchMock).not.toHaveBeenCalled();
    seesPayments();
    fetchMock.mockResolvedValueOnce(new Response('Bad query', { status: 400 }));
    await expect(getUndepositedFunds('2', { since: '2025-10-30' })).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('findBankDeposit', () => {
  it('finds the bank deposit NetSuite has under its External ID, with its total', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 8301, tranid: 'BD-12', total: '3750.00' }] }));
    expect(await findBankDeposit(' fleetsuite-bd-6b0c1d2e-0000-4000-8000-000000000001 ')).toEqual({ depositId: '8301', number: 'BD-12', totalCents: 375000 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(0)).toBe(
      "SELECT id, tranid, foreigntotal AS total FROM transaction WHERE type = 'Deposit' AND externalid = 'fleetsuite-bd-6b0c1d2e-0000-4000-8000-000000000001' "
      + 'ORDER BY id FETCH FIRST 1 ROWS ONLY',
    );
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 8302, tranid: null, total: null }] }));
    expect(await findBankDeposit('fleetsuite-bd-x')).toEqual({ depositId: '8302', number: '', totalCents: null });
  });

  it('says there is none only when NetSuite shows FleetSuite other bank deposits', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 6001 }] }));
    expect(await findBankDeposit('fleetsuite-bd-x')).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1&offset=0`);
    expect(queryOf(1)).toBe("SELECT id FROM transaction WHERE type = 'Deposit' FETCH FIRST 1 ROWS ONLY");
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await expect(findBankDeposit('fleetsuite-bd-x')).rejects.toThrow("FleetSuite can't see NetSuite's bank deposits");
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer", async () => {
    await expect(findBankDeposit("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findBankDeposit('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findBankDeposit('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findBankDeposit('fleetsuite-bd-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createBankDeposit', () => {
  const DEPOSIT: BankDepositPayload = {
    externalId: 'fleetsuite-bd-press-1',
    subsidiaryId: '2',
    accountId: '211',
    tranDate: '2026-10-30',
    memo: 'slip 14',
    paymentIds: ['9001', '9003'],
  };

  it('makes it into the bank account named, with exactly the payments named ticked', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/deposit/8303` } }));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: true, depositId: '8303' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/deposit`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(JSON.parse(init.body)).toEqual({
      externalId: 'fleetsuite-bd-press-1',
      subsidiary: { id: '2' },
      account: { id: '211' },
      tranDate: '2026-10-30',
      memo: 'slip 14',
      payment: { items: [{ id: '9001', deposit: true }, { id: '9003', deposit: true }] },
    });
  });

  it("sends no memo when there's none, and reads the id from the answer when there's no Location", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 8304 }));
    expect(await createBankDeposit({ ...DEPOSIT, memo: null })).toEqual({ success: true, depositId: '8304' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('memo');
  });

  it('sends nothing with no payments in it, a payment or account that isn\'t a NetSuite id', async () => {
    expect(await createBankDeposit({ ...DEPOSIT, paymentIds: [] })).toEqual({ success: false, error: 'A bank deposit needs a payment or deposit in it' });
    const byId = { success: false, error: "A bank deposit takes payments by NetSuite's id for them" };
    expect(await createBankDeposit({ ...DEPOSIT, paymentIds: ['9001', 'PYMT-9002'] })).toEqual(byId);
    expect(await createBankDeposit({ ...DEPOSIT, paymentIds: [''] })).toEqual(byId);
    const noAccount = { success: false, error: 'A bank deposit needs the bank account it goes into' };
    expect(await createBankDeposit({ ...DEPOSIT, accountId: '' })).toEqual(noAccount);
    expect(await createBankDeposit({ ...DEPOSIT, accountId: '10100 Operating' })).toEqual(noAccount);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid payment reference key 9003.' }] }, 400));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (400): Invalid payment reference key 9003.' });
    expect(logged.mock.calls[0][0]).toBe('NetSuite create bank deposit error:');
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Not JSON', { status: 422 }));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (422): Not JSON' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Gateway', { status: 500 }));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: false, error: 'NetSuite error (500): Gateway', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createBankDeposit(DEPOSIT)).toEqual({
      success: false, error: "NetSuite said it made the bank deposit but didn't say its id.", unsure: true,
    });
    fetchMock.mockResolvedValueOnce(json({ id: null }));
    expect((await createBankDeposit(DEPOSIT)).unsure).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createBankDeposit(DEPOSIT)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
