import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { determineCatalog, fetchSalesPrices, resolveSalesPrice } from './parts-sync';

// fetchSalesPrices talks to NetSuite through suiteqlQueryAll, so its tests
// stub fetch the same way src/lib/netsuite.test.ts does.
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

// The classification heuristic is now shared by the manual full rebuild and
// the hourly incremental cron — pin it so the two paths can't drift. (The
// "06" prefix quirk mis-files the Verizon RFID part under graphics; that's
// known, and the S1/product_line work replaces this heuristic — update these
// expectations deliberately when it does.)
describe('determineCatalog', () => {
  it('files anything with a graphics class under graphics', () => {
    expect(determineCatalog('C4-RA24-3', 'Graphics')).toBe('graphics');
    expect(determineCatalog('C4-RA24-3', 'Fleet Graphics : Decals')).toBe('graphics');
    expect(determineCatalog('C4-RA24-3', 'graphic design')).toBe('graphics');
  });

  it('files 06-prefixed item numbers under graphics (legacy convention)', () => {
    expect(determineCatalog('06N5TR', null)).toBe('graphics');
    expect(determineCatalog('06N179', '')).toBe('graphics');
  });

  it('defaults everything else to upfit', () => {
    expect(determineCatalog('C4-RA24-3', null)).toBe('upfit');
    expect(determineCatalog('C4-RA24-3', 'Upfit Parts')).toBe('upfit');
    expect(determineCatalog('', null)).toBe('upfit');
  });

  it('class beats item-number prefix', () => {
    // A graphics-classed part keeps graphics even without the 06 prefix,
    // and an 06 part with a non-graphics class still lands in graphics
    // (prefix rule fires when the class rule doesn't).
    expect(determineCatalog('ZZ-100', 'Graphics')).toBe('graphics');
    expect(determineCatalog('06N5TR', 'Upfit Parts')).toBe('graphics');
  });
});

// FleetSuite is the pricing authority: when the two systems disagree,
// FleetSuite's price is the current one and a sync run must not overwrite it.
// Shared by the manual full rebuild and the hourly incremental cron, so these
// pin the policy for both.
describe('resolveSalesPrice', () => {
  it('keeps the FleetSuite price when the two disagree', () => {
    expect(resolveSalesPrice(177.5, 160)).toBe(177.5);
    // The reverse of the old policy: a lower NetSuite price no longer wins.
    expect(resolveSalesPrice(160, 177.5)).toBe(160);
  });

  it('never lets a NetSuite item with no price zero out a FleetSuite price', () => {
    // The field bug this fixes: no price-level-1 row in NetSuite resolved to
    // 0, and `pricingMap[id] || 0` wrote that 0 over a good price every hour.
    expect(resolveSalesPrice(177.5, 0)).toBe(177.5);
    expect(resolveSalesPrice(177.5, undefined)).toBe(177.5);
    expect(resolveSalesPrice(177.5, null)).toBe(177.5);
  });

  it("fills from NetSuite when FleetSuite has no price of its own", () => {
    // A brand-new NetSuite item, or one nobody has priced here yet.
    expect(resolveSalesPrice(0, 160)).toBe(160);
    expect(resolveSalesPrice(null, 160)).toBe(160);
    expect(resolveSalesPrice(undefined, 160)).toBe(160);
  });

  it('resolves to 0 when neither system has a price', () => {
    expect(resolveSalesPrice(null, null)).toBe(0);
    expect(resolveSalesPrice(0, 0)).toBe(0);
  });

  it('treats junk and negatives as no price', () => {
    // Values arrive as Postgres numerics / SuiteQL strings — coerce, and
    // never let a nonsense local value shadow a real NetSuite price.
    expect(resolveSalesPrice('177.50', '160')).toBe(177.5);
    expect(resolveSalesPrice('', '160')).toBe(160);
    expect(resolveSalesPrice('abc', '160')).toBe(160);
    expect(resolveSalesPrice(-5, 160)).toBe(160);
  });
});

// The pricing lookup shared by the full rebuild and the hourly cron. The bug
// it exists to prevent: reading one pricing table, stopping because it
// returned *some* rows, and leaving every item that table didn't cover at 0 —
// which invoicing then refused to bill ("No NetSuite price set for: 06T936")
// even though NetSuite had a price on the item record all along.
describe('fetchSalesPrices', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps asking later sources for the items the first one missed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '10' }] })) // pricing
      .mockResolvedValueOnce(jsonResponse({ items: [] })) // itemPrice
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '56', sales_price: '7.5' }] })); // baseprice

    expect(await fetchSalesPrices(['55', '56'])).toEqual({ '55': 10, '56': 7.5 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops once every requested item has a price', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [
        { item_id: '55', sales_price: '10' },
        { item_id: '56', sales_price: '20' },
      ]})
    );

    expect(await fetchSalesPrices(['55', '56'])).toEqual({ '55': 10, '56': 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets the earlier source win when two disagree', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '10' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '99' }, { item_id: '56', sales_price: '20' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    expect(await fetchSalesPrices(['55', '56'])).toEqual({ '55': 10, '56': 20 });
  });

  it('carries on when a source throws — the table may not exist in this account', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Invalid search query: pricing'))
      .mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '12' }] }));

    expect(await fetchSalesPrices(['55'])).toEqual({ '55': 12 });
  });

  it('ignores zero, negative and unparsable prices', async () => {
    // A fresh Response per call: one instance can only be read once, and
    // every source below is expected to actually read its body.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ items: [
        { item_id: '55', sales_price: '0' },
        { item_id: '56', sales_price: null },
        { item_id: '57', sales_price: '-5' },
      ]})
    );

    expect(await fetchSalesPrices(['55', '56', '57'])).toEqual({});
  });

  it('scopes the query to the given ids, and chunks past 500', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
    fetchMock.mockImplementation(async () => jsonResponse({ items: [] }));

    await fetchSalesPrices(ids);

    const queries = fetchMock.mock.calls.map(c => JSON.parse(c[1].body).q);
    expect(queries[0]).toContain('p.item IN (1,2,');
    // Two chunks per source, three sources — none of them skipped.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('queries account-wide when given no ids, and stops early on coverage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ item_id: '55', sales_price: '10' }] }));

    expect(await fetchSalesPrices(null, ['55'])).toEqual({ '55': 10 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).q).not.toContain(' IN (');
  });

  it('makes no network call for an empty id list', async () => {
    expect(await fetchSalesPrices([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
