import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCustomerPayment, findCustomerPayment, getInvoicesOpen, getPaymentInvoices, type CustomerPaymentPayload,
} from './netsuite';

// What FleetSuite asks NetSuite to receive a customer's check or ACH payment
// (src/lib/receive-payment.ts): the customer's open invoices, the payment by
// FleetSuite's own name for it, and the payment itself. Every call is mocked;
// the requests and how the answers are read are what's held. Made-up data.

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

describe('getPaymentInvoices', () => {
  const HEAD = { id: 9001, tranid: 'INV2001', customer_id: 501, customer_name: 'Acme Plumbing', customer_entity_id: 'C-501', unpaid: '-250.00', subsidiary_id: 2 };

  it("reads the invoice, its customer and the customer's open invoices in its company, oldest first", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [HEAD] }));
    fetchMock.mockResolvedValueOnce(json({
      items: [
        { id: 8990, tranid: 'INV1990', trandate: '9/3/2026', duedate: '10/3/2026', po: 'PO-77', total: '1200.00', unpaid: '400.10', subsidiary_id: 2 },
        { id: 8995, tranid: 'INV1995', trandate: '2026-09-20', duedate: null, po: null, total: '75', unpaid: '75', subsidiary_id: '2' },
        { id: 8995, tranid: 'INV1995', trandate: '2026-09-20', duedate: null, po: null, total: '75', unpaid: '75', subsidiary_id: '2' },
        { id: 8996, tranid: 'INV1996', trandate: '2026-09-21', total: '50', unpaid: '0', subsidiary_id: 2 },
        { id: 8997, tranid: 'INV1997', trandate: '2026-09-22', total: '90', unpaid: '90', subsidiary_id: 3 },
        { id: 9001, tranid: 'INV2001', trandate: '10/1/2026', duedate: '10/31/2026', total: '-250', unpaid: '-250.00', subsidiary_id: 2 },
        { id: 'x', tranid: 'bad', trandate: '2026-10-02', total: '1', unpaid: '1', subsidiary_id: 2 },
      ],
    }));
    expect(await getPaymentInvoices(' 9001 ')).toEqual({
      invoice: { id: '9001', number: 'INV2001', customerId: '501', customerName: 'Acme Plumbing', subsidiaryId: '2', openCents: 25000 },
      open: [
        { id: '8990', number: 'INV1990', date: '2026-09-03', dueDate: '2026-10-03', po: 'PO-77', totalCents: 120000, openCents: 40010 },
        { id: '8995', number: 'INV1995', date: '2026-09-20', dueDate: null, po: null, totalCents: 7500, openCents: 7500 },
        { id: '9001', number: 'INV2001', date: '2026-10-01', dueDate: '2026-10-31', po: null, totalCents: 25000, openCents: 25000 },
      ],
      elsewhere: 1,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=5&offset=0`);
    expect(queryOf(0)).toContain("FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' LEFT JOIN customer c ON c.id = t.entity");
    expect(queryOf(0)).toContain("WHERE t.type = 'CustInvc' AND t.id = 9001");
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(1)).toContain("WHERE t.type = 'CustInvc' AND t.status = 'A' AND t.entity = 501 ORDER BY t.trandate, t.id");
    expect(queryOf(1)).toContain('t.foreignamountunpaid AS unpaid, tl.subsidiary AS subsidiary_id');
  });

  it("names the customer by its number, then its id, and says when NetSuite has no such invoice", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...HEAD, customer_name: null }] }));
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect((await getPaymentInvoices('9001')).invoice?.customerName).toBe('C-501');
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...HEAD, customer_name: '', customer_entity_id: null, subsidiary_id: null }] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 8990, tranid: 'INV1990', trandate: '2026-09-03', total: '5', unpaid: '5', subsidiary_id: null }] }));
    const noSubsidiary = await getPaymentInvoices('9001');
    expect(noSubsidiary.invoice).toMatchObject({ customerName: 'Customer 501', subsidiaryId: null });
    expect(noSubsidiary.open.map((i) => i.id)).toEqual(['8990']);
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await getPaymentInvoices('9002')).toEqual({ invoice: null, open: [], elsewhere: 0 });
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...HEAD, customer_id: null }] }));
    expect(await getPaymentInvoices('9003')).toEqual({ invoice: null, open: [], elsewhere: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("asks nothing for an id that isn't one, and throws when NetSuite can't answer", async () => {
    await expect(getPaymentInvoices('9001 OR 1=1')).rejects.toThrow("isn't a NetSuite invoice id");
    await expect(getPaymentInvoices('')).rejects.toThrow("isn't a NetSuite invoice id");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Bad query', { status: 400 }));
    await expect(getPaymentInvoices('9001')).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('getInvoicesOpen', () => {
  it("reads what each invoice has open now, and asks nothing when there's none to read", async () => {
    expect(await getInvoicesOpen([])).toEqual(new Map());
    expect(await getInvoicesOpen(['x', '1 OR 1=1'])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 8990, unpaid: '-0.10' }, { id: 9001, unpaid: null }] }));
    expect(await getInvoicesOpen(['8990', '9001', '8990', 'bad'])).toEqual(new Map([['8990', 10], ['9001', 0]]));
    expect(queryOf(0)).toBe("SELECT t.id, t.foreignamountunpaid AS unpaid FROM transaction t WHERE t.type = 'CustInvc' AND t.id IN (8990, 9001)");
  });
});

describe('findCustomerPayment', () => {
  it('finds the payment NetSuite has under its External ID', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7101, tranid: 'PYMT-301' }] }));
    expect(await findCustomerPayment(' fleetsuite-cp-6b0c1d2e-0000-4000-8000-000000000001 ')).toEqual({ paymentId: '7101', number: 'PYMT-301' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(0)).toBe(
      "SELECT id, tranid FROM transaction WHERE type = 'CustPymt' AND externalid = 'fleetsuite-cp-6b0c1d2e-0000-4000-8000-000000000001' "
      + 'ORDER BY id FETCH FIRST 1 ROWS ONLY',
    );
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7102, tranid: null }] }));
    expect(await findCustomerPayment('fleetsuite-cp-x')).toEqual({ paymentId: '7102', number: '' });
  });

  it('says there is none only when NetSuite shows FleetSuite other customer payments', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 6001 }] }));
    expect(await findCustomerPayment('fleetsuite-cp-x')).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1&offset=0`);
    expect(queryOf(1)).toBe("SELECT id FROM transaction WHERE type = 'CustPymt' FETCH FIRST 1 ROWS ONLY");
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await expect(findCustomerPayment('fleetsuite-cp-x')).rejects.toThrow("FleetSuite can't see NetSuite's customer payments");
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer", async () => {
    await expect(findCustomerPayment("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findCustomerPayment('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findCustomerPayment('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findCustomerPayment('fleetsuite-cp-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createCustomerPayment', () => {
  const PAYMENT: CustomerPaymentPayload = {
    externalId: 'fleetsuite-cp-press-1',
    customerId: '501',
    subsidiaryId: '2',
    tranDate: '2026-10-30',
    amount: 650.1,
    checkNumber: '10442',
    memo: 'Check 10442 · September and October',
    apply: [{ invoiceId: '8990', amount: 400.1 }, { invoiceId: '9001', amount: 250 }],
  };

  it("makes it in Undeposited Funds, applied to exactly the invoices named, with NetSuite's own spreading off", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/customerPayment/7103` } }));
    expect(await createCustomerPayment(PAYMENT)).toEqual({ success: true, paymentId: '7103' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/customerPayment`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(JSON.parse(init.body)).toEqual({
      externalId: 'fleetsuite-cp-press-1',
      customer: { id: '501' },
      subsidiary: { id: '2' },
      tranDate: '2026-10-30',
      payment: 650.1,
      undepFunds: true,
      autoApply: false,
      memo: 'Check 10442 · September and October',
      checkNum: '10442',
      apply: { items: [{ doc: { id: '8990' }, apply: true, amount: 400.1 }, { doc: { id: '9001' }, apply: true, amount: 250 }] },
    });
  });

  it("sends no check number for an ACH payment, and reads the id from the answer when there's no Location", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7104 }));
    expect(await createCustomerPayment({ ...PAYMENT, checkNumber: null, memo: 'ACH 0187' })).toEqual({ success: true, paymentId: '7104' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('checkNum');
    expect(body.memo).toBe('ACH 0187');
  });

  it("sends nothing that pays no invoice, has an amount of $0 or less, or doesn't add up to the cent", async () => {
    expect(await createCustomerPayment({ ...PAYMENT, apply: [] })).toEqual({ success: false, error: 'A payment needs an invoice to pay' });
    const aboveZero = 'A payment, and what it pays on each invoice, need to be above $0';
    expect(await createCustomerPayment({ ...PAYMENT, amount: 0 })).toEqual({ success: false, error: aboveZero });
    expect(await createCustomerPayment({ ...PAYMENT, amount: Number.NaN })).toEqual({ success: false, error: aboveZero });
    expect(await createCustomerPayment({ ...PAYMENT, apply: [{ invoiceId: '8990', amount: 650.1 }, { invoiceId: '9001', amount: 0.001 }] }))
      .toEqual({ success: false, error: aboveZero });
    expect(await createCustomerPayment({ ...PAYMENT, apply: [{ invoiceId: '8990', amount: 700.1 }, { invoiceId: '9001', amount: -50 }] }))
      .toEqual({ success: false, error: aboveZero });
    expect(await createCustomerPayment({ ...PAYMENT, amount: 650.11 }))
      .toEqual({ success: false, error: "What the payment pays on its invoices doesn't add up to its amount" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds up to the cent, not to the floating-point sum', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7105 }));
    const r = await createCustomerPayment({ ...PAYMENT, amount: 0.3, apply: [{ invoiceId: '8990', amount: 0.1 }, { invoiceId: '9001', amount: 0.2 }] });
    expect(r).toEqual({ success: true, paymentId: '7105' });
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'The invoice is paid in full.' }] }, 400));
    expect(await createCustomerPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (400): The invoice is paid in full.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await createCustomerPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createCustomerPayment(PAYMENT)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createCustomerPayment(PAYMENT)).toEqual({
      success: false, error: "NetSuite said it made the payment but didn't say its id.", unsure: true,
    });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createCustomerPayment(PAYMENT)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
