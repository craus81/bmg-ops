import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCountAdjustment, findCountAdjustment, getInventoryAdjustmentAccountId, type CountAdjustmentPayload } from './netsuite';

// What FleetSuite sends NetSuite to make a count's differences one Inventory
// Adjustment at its location (src/lib/stock-counts.ts), how it looks one up
// by FleetSuite's own name for it, and how it finds 52000 Inventory
// Adjustment. Every call is mocked; the requests and how the answers are read
// are what's held. Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';
const ID = 'fleetsuite-count-c0000000-0000-4000-8000-000000000001';

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

describe('getInventoryAdjustmentAccountId', () => {
  it("finds 52000 Inventory Adjustment, and throws when NetSuite has none or can't answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 501 }] }));
    expect(await getInventoryAdjustmentAccountId()).toBe('501');
    expect(queryOf(0)).toBe("SELECT id FROM account WHERE acctnumber = '52000' FETCH FIRST 1 ROWS ONLY");
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await expect(getInventoryAdjustmentAccountId()).rejects.toThrow('NetSuite has no account 52000 Inventory Adjustment');
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 'x' }] }));
    await expect(getInventoryAdjustmentAccountId()).rejects.toThrow('NetSuite has no account 52000 Inventory Adjustment');
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(getInventoryAdjustmentAccountId()).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('findCountAdjustment', () => {
  it('finds the adjustment NetSuite has under its External ID', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7001, tranid: 'ADJ-41' }] }));
    expect(await findCountAdjustment(` ${ID} `)).toEqual({ adjustmentId: '7001', number: 'ADJ-41' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(init.method).toBe('POST');
    expect(queryOf(0)).toBe(`SELECT id, tranid FROM transaction WHERE type = 'InvAdjst' AND externalid = '${ID}' ORDER BY id FETCH FIRST 1 ROWS ONLY`);
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await findCountAdjustment('fleetsuite-count-x')).toBeNull();
    // A row with no number still names the adjustment.
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7002 }] }));
    expect(await findCountAdjustment('fleetsuite-count-x')).toEqual({ adjustmentId: '7002', number: '' });
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer, so the caller sends nothing", async () => {
    await expect(findCountAdjustment("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findCountAdjustment('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findCountAdjustment('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findCountAdjustment('fleetsuite-count-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createCountAdjustment', () => {
  const COUNT: CountAdjustmentPayload = {
    externalId: ID,
    subsidiaryId: '2',
    accountId: '501',
    locationId: '1',
    tranDate: '2027-09-15',
    memo: "FleetSuite count CNT-0001 at O'Fallon · by Jessie Test, approved by Craig Test",
    lines: [{ itemId: '812', adjustQtyBy: -2 }, { itemId: '813', adjustQtyBy: 3.5 }],
  };

  it('makes one adjustment with its External ID, account, location, subsidiary, date, memo, and each change', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/inventoryAdjustment/7003` } }));
    expect(await createCountAdjustment(COUNT)).toEqual({ success: true, adjustmentId: '7003' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/inventoryAdjustment`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual({
      externalId: ID,
      account: { id: '501' },
      adjLocation: { id: '1' },
      subsidiary: { id: '2' },
      tranDate: '2027-09-15',
      memo: COUNT.memo,
      inventory: {
        items: [
          { item: { id: '812' }, location: { id: '1' }, adjustQtyBy: -2 },
          { item: { id: '813' }, location: { id: '1' }, adjustQtyBy: 3.5 },
        ],
      },
    });
  });

  it('leaves the subsidiary off for an account with one, cuts a long memo to 999, and reads the id from the answer', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7004 }));
    expect(await createCountAdjustment({ ...COUNT, subsidiaryId: null, memo: 'm'.repeat(1200) })).toEqual({ success: true, adjustmentId: '7004' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('subsidiary');
    expect(body.memo).toBe('m'.repeat(999));
  });

  it('sends nothing with no items, or with a change that changes nothing', async () => {
    expect(await createCountAdjustment({ ...COUNT, lines: [] })).toEqual({ success: false, error: 'A count adjustment needs an item that differs' });
    for (const adjustQtyBy of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await createCountAdjustment({ ...COUNT, lines: [COUNT.lines[0], { itemId: '813', adjustQtyBy }] }))
        .toEqual({ success: false, error: "Each item's change needs to be a number other than 0" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid item reference key 813.' }] }, 400));
    expect(await createCountAdjustment(COUNT)).toEqual({ success: false, error: 'NetSuite refused the adjustment (400): Invalid item reference key 813.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request' }, 400));
    expect(await createCountAdjustment(COUNT)).toEqual({ success: false, error: 'NetSuite refused the adjustment (400): Bad Request' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createCountAdjustment(COUNT)).toEqual({ success: false, error: 'NetSuite refused the adjustment (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
    expect(await createCountAdjustment(COUNT)).toEqual({ success: false, error: 'NetSuite refused the adjustment (500): Internal error', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createCountAdjustment(COUNT)).toEqual({
      success: false, error: "NetSuite said it made the adjustment but didn't say its id.", unsure: true,
    });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createCountAdjustment(COUNT)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
