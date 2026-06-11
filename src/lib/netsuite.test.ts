import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  suiteqlQuery,
  suiteqlQueryAll,
  createSalesOrder,
  createDirectInvoice,
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
          { item: { id: '55' }, quantity: 2, rate: 125.5, description: 'Shelf unit' },
          { item: { id: '56' }, quantity: 1, rate: 80 },
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
      item: { items: [{ item: { id: '55' }, quantity: 3, rate: 42.5 }] },
      location: { id: '7' },
      otherRefNum: 'PO-1',
    });
    expect(result).toEqual({ success: true, invoiceId: '777', invoiceNumber: 'INV-2001' });
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
