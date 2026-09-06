import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  suiteqlQuery,
  suiteqlQueryAll,
  createSalesOrder,
  createDirectInvoice,
  createInvoiceFromSO,
  fulfillSalesOrder,
  createBillFromPo,
  createItemReceiptFromPo,
  createCustomerOrLead,
  getItemBasePrices,
} from './netsuite';

// Characterization tests for the NetSuite client. All network calls are
// mocked; what is locked in here is the request construction (URLs, headers,
// record payloads — i.e. what we actually bill) and the response handling.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('suiteqlQuery', () => {
  it('POSTs to the account-specific SuiteQL endpoint (underscores become dashes)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: '1' }] }));

    const result = await suiteqlQuery('SELECT id FROM transaction', 500, 25);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=500&offset=25'
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Prefer']).toBe('transient');
    expect(JSON.parse(init.body)).toEqual({ q: 'SELECT id FROM transaction' });
    expect(result.items).toEqual([{ id: '1' }]);
  });

  it('signs the request with OAuth 1.0a HMAC-SHA256 in the account realm', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));

    await suiteqlQuery('SELECT 1');

    const auth: string = fetchMock.mock.calls[0][1].headers['Authorization'];
    expect(auth).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(auth).toContain('oauth_consumer_key="ck"');
    expect(auth).toContain('oauth_token="tk"');
    expect(auth).toContain('oauth_signature_method="HMAC-SHA256"');
    expect(auth).toMatch(/oauth_signature="[^"]+"/);
  });

  it('throws with status and body text on a NetSuite error', async () => {
    fetchMock.mockResolvedValue(new Response('Invalid search query', { status: 400 }));

    await expect(suiteqlQuery('SELECT bogus')).rejects.toThrow(
      'NetSuite SuiteQL error (400): Invalid search query'
    );
  });

  it('carries the HTTP status on the thrown error', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));

    await expect(suiteqlQuery('SELECT 1')).rejects.toMatchObject({ status: 503 });
  });

  // NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. The
  // sales-order sync opts in; everything else keeps today's fail-fast.
  describe('retries', () => {
    const fail500 = () => new Response('{"o:errorDetails":[{"o:errorCode":"UNEXPECTED_ERROR"}]}', { status: 500 });

    it('does not retry by default', async () => {
      fetchMock.mockResolvedValue(fail500());

      await expect(suiteqlQuery('SELECT 1')).rejects.toThrow('SuiteQL error (500)');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-sends after a 5xx and returns the eventual success', async () => {
      fetchMock
        .mockResolvedValueOnce(fail500())
        .mockResolvedValueOnce(fail500())
        .mockResolvedValueOnce(jsonResponse({ items: [{ id: '1' }] }));

      const result = await suiteqlQuery('SELECT 1', 10, 0, { retries: 2, retryDelayMs: 0 });

      expect(result.items).toEqual([{ id: '1' }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Each attempt is signed afresh — the OAuth nonce must not repeat.
      const nonces = fetchMock.mock.calls.map(c => c[1].headers['Authorization'].match(/oauth_nonce="([^"]+)"/)![1]);
      expect(new Set(nonces).size).toBe(3);
    });

    it('re-sends after a network failure', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(jsonResponse({ items: [] }));

      await expect(suiteqlQuery('SELECT 1', 10, 0, { retries: 1, retryDelayMs: 0 })).resolves.toEqual({ items: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never retries a 4xx — a bad query does not get better', async () => {
      fetchMock.mockResolvedValue(new Response('Invalid search query', { status: 400 }));

      await expect(suiteqlQuery('SELECT bogus', 10, 0, { retries: 2, retryDelayMs: 0 })).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after the budget with the last status', async () => {
      // A fresh Response per attempt — a body can only be read once.
      fetchMock.mockImplementation(async () => fail500());

      await expect(suiteqlQuery('SELECT 1', 10, 0, { retries: 2, retryDelayMs: 0 })).rejects.toMatchObject({ status: 500 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('suiteqlQueryAll passes the retry budget to every page', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ items: [{ id: 1 }, { id: 2 }] }))
        .mockResolvedValueOnce(fail500())
        .mockResolvedValueOnce(jsonResponse({ items: [{ id: 3 }] }));

      const rows = await suiteqlQueryAll('SELECT id FROM item', 2, { retries: 1, retryDelayMs: 0 });

      expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

describe('suiteqlQueryAll', () => {
  it('pages through results until a short page', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 1 }, { id: 2 }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 3 }] }));

    const rows = await suiteqlQueryAll('SELECT id FROM item', 2);

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('limit=2&offset=0');
    expect(fetchMock.mock.calls[1][0]).toContain('limit=2&offset=2');
  });

  it('returns a single short page without a second request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 1 }] }));
    const rows = await suiteqlQueryAll('SELECT id FROM item', 1000);
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createSalesOrder', () => {
  const payload = {
    customerId: '4242',
    poNumber: 'PO-9001',
    locationId: '7',
    orderDate: '2026-06-01',
    memo: 'Upfit batch 3',
    shipTo: { name: 'BMG Fleet', address: '1 Depot Way', city: 'Fallon', state: 'NV', zip: '89406' },
    lineItems: [
      { itemId: '55', quantity: 2, rate: 125.5, description: 'Shelf unit' },
      { itemId: '56', quantity: 1, rate: 80 }, // no description → omitted entirely
    ],
  };

  it('builds the NetSuite record payload that gets billed', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/salesOrder/12345' },
      }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'SO-1001' }] }));

    const result = await createSalesOrder(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder');
    expect(JSON.parse(init.body)).toEqual({
      entity: { id: '4242' },
      otherRefNum: 'PO-9001',
      item: {
        items: [
          { item: { id: '55' }, quantity: 2, price: { id: '-1' }, rate: 125.5, description: 'Shelf unit' },
          { item: { id: '56' }, quantity: 1, price: { id: '-1' }, rate: 80 },
        ],
      },
      location: { id: '7' },
      tranDate: '2026-06-01',
      memo: 'Upfit batch 3',
      shippingAddress: {
        addressee: 'BMG Fleet',
        addr1: '1 Depot Way',
        city: 'Fallon',
        state: 'NV',
        zip: '89406',
        country: { id: 'US' },
      },
    });

    // 204 + Location header → ID extracted, then tranid looked up via SuiteQL
    expect(result).toEqual({ success: true, salesOrderId: '12345', salesOrderNumber: 'SO-1001' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).q).toBe(
      'SELECT tranid FROM transaction WHERE id = 12345'
    );
  });

  it('returns a failure (not a throw) when NetSuite rejects the order', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('Invalid entity', { status: 400 }));

    const result = await createSalesOrder(payload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('NetSuite error (400): Invalid entity');
    consoleSpy.mockRestore();
  });
});

describe('createDirectInvoice', () => {
  it('invoices the given rates without any price lookups', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/invoice/777' },
      }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'INV-2001' }] }));

    const result = await createDirectInvoice({
      customerId: 9,
      locationId: '7',
      poNumber: 'PO-1',
      lineItems: [{ itemId: '55', quantity: 3, rate: 42.5 }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      entity: { id: 9 },
      item: { items: [{ item: { id: '55' }, quantity: 3, price: { id: '-1' }, rate: 42.5 }] },
      location: { id: '7' },
      otherRefNum: 'PO-1',
    });
    expect(result).toEqual({ success: true, invoiceId: '777', invoiceNumber: 'INV-2001' });
  });

  it('writes the VIN to custbody_vin_number_ like the SO path, and omits it when absent', async () => {
    fetchMock.mockResolvedValue(new Response(null, {
      status: 204,
      headers: { Location: 'https://x/services/rest/record/v1/invoice/779' },
    }));

    await createDirectInvoice({
      customerId: 9,
      locationId: '7',
      vin: '1FTBW3XK1PKB39418',
      lineItems: [{ itemId: '55', quantity: 1, rate: 10 }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).custbody_vin_number_).toBe('1FTBW3XK1PKB39418');

    await createDirectInvoice({
      customerId: 9,
      locationId: '7',
      vin: null,
      lineItems: [{ itemId: '55', quantity: 1, rate: 10 }],
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('custbody_vin_number_');
  });

  it('resolves a missing rate from the NetSuite base price before invoicing', async () => {
    fetchMock
      // getItemBasePrices source 1 (pricing table)
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '42.5' }] }))
      // record POST
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/invoice/778' },
      }))
      // tranid lookup
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'INV-2002' }] }));

    const result = await createDirectInvoice({
      customerId: 9,
      locationId: '7',
      lineItems: [{ itemId: '55', quantity: 1, rate: 0 }],
    });

    const priceQuery = JSON.parse(fetchMock.mock.calls[0][1].body).q;
    expect(priceQuery).toContain('p.pricelevel = 1 AND p.item IN (55)');

    const recordBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(recordBody.item.items[0].rate).toBe(42.5);
    expect(result.success).toBe(true);
  });

  it('refuses to invoice when no price exists anywhere, without posting', async () => {
    // All three base-price sources come back empty
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));

    const result = await createDirectInvoice({
      customerId: 9,
      locationId: '7',
      lineItems: [{ itemId: '55', quantity: 1, rate: 0 }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No price found in NetSuite for item(s): 55');
    // Only the three SuiteQL price lookups ran — no invoice was posted
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toContain('/query/v1/suiteql');
    }
  });

  it('adds the subsidiary hint to the cryptic "Invalid Field Value … item" error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response('Invalid Field Value 55 for the following field: item', { status: 400 })
    );

    const result = await createDirectInvoice({
      customerId: 9,
      locationId: '7',
      lineItems: [{ itemId: '55', quantity: 1, rate: 10 }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not assigned to the invoice\'s subsidiary');
    consoleSpy.mockRestore();
  });
});

describe('fulfillSalesOrder', () => {
  const soStatus = (status: string) => jsonResponse({ items: [{ status }] });

  it('fulfils every remaining line via the documented transform, marked Shipped', async () => {
    fetchMock
      .mockResolvedValueOnce(soStatus('B')) // Pending Fulfillment
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/itemFulfillment/5001' },
      }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'IF-77' }] }));

    const result = await fulfillSalesOrder('766');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).q).toContain("type = 'SalesOrd'");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder/766/!transform/itemFulfillment'
    );
    expect(init.method).toBe('POST');
    // No line body and no ?replace=item: the transform carries every open
    // line itself. Shipped so the fulfillment posts and relieves inventory.
    expect(JSON.parse(init.body)).toEqual({ shipStatus: { id: 'C' } });
    expect(result).toEqual({ success: true, status: 'B', fulfillmentId: '5001', fulfillmentNumber: 'IF-77' });
  });

  it('skips an SO that is already Pending Billing / Billed instead of re-fulfilling', async () => {
    fetchMock.mockResolvedValueOnce(soStatus('F'));
    const result = await fulfillSalesOrder('767');
    expect(result).toEqual({ success: true, skipped: 'already_fulfilled', status: 'F' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // status read only, no transform
  });

  it('refuses a Pending Approval SO with a plain message and creates nothing', async () => {
    fetchMock.mockResolvedValueOnce(soStatus('A'));
    const result = await fulfillSalesOrder('768');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Pending Approval/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once without shipStatus when the account rejects that field', async () => {
    fetchMock
      .mockResolvedValueOnce(soStatus('D'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'o:errorDetails': [{ detail: "Invalid field shipStatus" }] }), { status: 400 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/itemFulfillment/5002' },
      }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'IF-78' }] }));

    const result = await fulfillSalesOrder('769');

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({});
    expect(result).toEqual({ success: true, status: 'D', fulfillmentId: '5002', fulfillmentNumber: 'IF-78' });
  });

  it('returns NetSuite\'s own message on any other failure', async () => {
    fetchMock
      .mockResolvedValueOnce(soStatus('B'))
      .mockResolvedValueOnce(new Response('You cannot fulfil this line', { status: 400 }));
    const result = await fulfillSalesOrder('770');
    expect(result.success).toBe(false);
    expect(result.error).toBe('NetSuite error (400): You cannot fulfil this line');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createInvoiceFromSO', () => {
  it('carries SO line descriptions into partial-invoice line overrides', async () => {
    fetchMock
      // SO line lookup
      .mockResolvedValueOnce(jsonResponse({ items: [
        { linesequencenumber: '1', item: '55', quantity: '4', rate: '125.5', memo: 'Shelf unit — mount behind driver bulkhead' },
        { linesequencenumber: '2', item: '56', quantity: '2', rate: '80' }, // no memo on the SO line
      ] }))
      // invoice transform POST
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/invoice/900' },
      }))
      // tranid lookup
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'INV-3001' }] }));

    const result = await createInvoiceFromSO({
      salesOrderId: '12345',
      installedQuantities: { 1: 2, 2: 1 },
      locationId: '7',
      memo: 'Invoice from BMG FleetSuite — PO #1',
    });

    // The SO line query must fetch the line description (tl.memo)…
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).q).toContain('tl.memo');

    // …because ?replace=item rebuilds every line: one sent without a
    // description reverts to the item record's default text, silently
    // dropping estimate/SO placement notes. The URL is the documented
    // !transform path — the old `invoice?init=salesOrder&id=` form is
    // rejected by the account's current NetSuite release ("Invalid query
    // parameter name 'id'").
    const [transformUrl, init] = fetchMock.mock.calls[1];
    expect(transformUrl).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder/12345/!transform/invoice?replace=item'
    );
    const body = JSON.parse(init.body);
    expect(body.item.items).toEqual([
      { item: { id: '55' }, quantity: 2, price: { id: '-1' }, rate: 125.5, description: 'Shelf unit — mount behind driver bulkhead' },
      { item: { id: '56' }, quantity: 1, price: { id: '-1' }, rate: 80 },
    ]);
    expect(body.location).toEqual({ id: '7' });
    expect(result).toEqual({ success: true, invoiceId: '900', invoiceNumber: 'INV-3001' });
  });

  it('bills the full SO with no replace=item and no line body (vehicle completion path)', async () => {
    fetchMock
      // invoice transform POST — no SO line lookup runs on the full path
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/invoice/901' },
      }))
      // tranid lookup
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'INV-3002' }] }));

    const result = await createInvoiceFromSO({ salesOrderId: '766' });

    // No ?replace=item here: replace makes the sublist exactly what the body
    // carries, and this body carries no lines — the transform must keep the
    // SO's own lines.
    const [transformUrl, init] = fetchMock.mock.calls[0];
    expect(transformUrl).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder/766/!transform/invoice'
    );
    expect(JSON.parse(init.body)).toEqual({});
    expect(result).toEqual({ success: true, invoiceId: '901', invoiceNumber: 'INV-3002' });
  });
});

describe('createBillFromPo', () => {
  it('transforms the PO via the documented !transform path with tranId/memo in the body', async () => {
    fetchMock
      // vendorBill transform POST
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/vendorBill/700' },
      }))
      // tranid lookup
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'VB-88' }] }));

    const result = await createBillFromPo({
      purchaseOrderId: '321',
      referenceNo: 'INV-9',
      memo: 'Parts invoice INV-9 (via FleetSuite parts mail)',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/purchaseOrder/321/!transform/vendorBill'
    );
    expect(JSON.parse(init.body)).toEqual({
      tranId: 'INV-9',
      memo: 'Parts invoice INV-9 (via FleetSuite parts mail)',
    });
    expect(result).toEqual({ success: true, billId: '700', billNumber: 'VB-88' });
  });
});

describe('createItemReceiptFromPo', () => {
  it('lists EVERY line explicitly — received with quantities, the rest itemReceive:false — so the transform cannot default a line to fully received', async () => {
    fetchMock
      // itemReceipt transform POST
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/services/rest/record/v1/itemReceipt/500' },
      }))
      // tranid lookup
      .mockResolvedValueOnce(jsonResponse({ items: [{ tranid: 'IR-42' }] }));

    const result = await createItemReceiptFromPo({
      purchaseOrderId: '321',
      receiveLines: [{ orderLine: 2, quantity: 3 }],
      excludeOrderLines: [1, 3],
      memo: 'Received via FleetSuite',
      tranDate: '2026-08-30',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/purchaseOrder/321/!transform/itemReceipt'
    );
    expect(JSON.parse(init.body)).toEqual({
      item: {
        items: [
          { orderLine: 2, quantity: 3, itemReceive: true },
          { orderLine: 1, itemReceive: false },
          { orderLine: 3, itemReceive: false },
        ],
      },
      memo: 'Received via FleetSuite',
      tranDate: '2026-08-30',
    });
    expect(result).toEqual({ success: true, receiptId: '500', receiptNumber: 'IR-42' });
  });
});

describe('createCustomerOrLead', () => {
  it('sends the required subsidiary (BMG Fleet Installations = id 2) on the customer record', async () => {
    fetchMock
      // record POST — new customer, id returned in the Location header
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { Location: 'https://x/customer/4242' },
      }))
      // entityid lookup
      .mockResolvedValueOnce(jsonResponse({ items: [{ entityid: 'ACME' }] }));

    const result = await createCustomerOrLead({ companyName: 'Acme Co', type: 'customer' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/services/rest/record/v1/customer');
    const body = JSON.parse(init.body);
    // The fix: without this the account rejects the create with
    // "Please enter value(s) for: Subsid."
    expect(body.subsidiary).toEqual({ id: '2' });
    expect(body).toMatchObject({ companyName: 'Acme Co', stage: 'CUSTOMER', isPerson: false });
    expect(result).toEqual({
      success: true,
      customerId: '4242',
      entityId: 'ACME',
      netsuiteUrl: expect.stringContaining('id=4242'),
    });
  });

  it('honors the NETSUITE_SUBSIDIARY_ID override', async () => {
    vi.stubEnv('NETSUITE_SUBSIDIARY_ID', '5');
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: 'https://x/customer/1' } }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    await createCustomerOrLead({ companyName: 'Beta', type: 'lead' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subsidiary).toEqual({ id: '5' });
    expect(body.stage).toBe('LEAD');
  });
});

describe('getItemBasePrices', () => {
  it('dedupes item IDs and stops at the first source that prices everything', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [
        { item_id: '55', sales_price: '10' },
        { item_id: '56', sales_price: '20' },
      ]})
    );

    const prices = await getItemBasePrices(['55', 56, '55']);

    expect(prices).toEqual({ '55': 10, '56': 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).q).toContain('IN (55,56)');
  });

  it('falls through to later sources for unpriced items', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [] })) // pricing
      .mockResolvedValueOnce(jsonResponse({ items: [] })) // itemPrice
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '7.5' }] })); // item.baseprice

    const prices = await getItemBasePrices(['55']);
    expect(prices).toEqual({ '55': 7.5 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ignores zero and unparsable prices', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [{ item_id: '55', sales_price: '0' }, { item_id: '56', sales_price: null }] })
    );
    const prices = await getItemBasePrices(['55', '56']);
    expect(prices).toEqual({});
  });

  it('returns an empty map for no IDs without any network call', async () => {
    expect(await getItemBasePrices([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
