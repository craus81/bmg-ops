import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInventoryTransfer, findInventoryTransfer, getLocationOnHand, type InventoryTransferPayload } from './netsuite';

// What FleetSuite sends NetSuite to move stock from one location to another
// (src/lib/inventory-transfers.ts), how it looks a transfer up by
// FleetSuite's own name for it, and how it reads what NetSuite has at the
// location it moves from. Every call is mocked; the requests and how the
// answers are read are what's held. Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';
const ID = 'fleetsuite-it-f0000000-0000-4000-8000-000000000001';

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

describe('findInventoryTransfer', () => {
  it('finds the transfer NetSuite has under its External ID', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 9001, tranid: 'IT-12' }] }));
    expect(await findInventoryTransfer(` ${ID} `)).toEqual({ transferId: '9001', number: 'IT-12' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(init.method).toBe('POST');
    expect(queryOf(0)).toBe(`SELECT id, tranid FROM transaction WHERE type = 'InvTrnfr' AND externalid = '${ID}' ORDER BY id FETCH FIRST 1 ROWS ONLY`);
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await findInventoryTransfer('fleetsuite-it-x')).toBeNull();
    // A row with no number still names the transfer.
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 9002 }] }));
    expect(await findInventoryTransfer('fleetsuite-it-x')).toEqual({ transferId: '9002', number: '' });
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer, so the caller sends nothing", async () => {
    await expect(findInventoryTransfer("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findInventoryTransfer('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findInventoryTransfer('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findInventoryTransfer('fleetsuite-it-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('getLocationOnHand', () => {
  it("reads NetSuite's count of each item at the location, 0 for one it has none of there", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ item: 501, quantityonhand: '10' }, { item: '502', quantityonhand: 250.5 }, { item: 599, quantityonhand: 7 }] }));
    const onHand = await getLocationOnHand('1', ['501', '502', '503', '501']);
    expect([...onHand]).toEqual([['501', 10], ['502', 250.5], ['503', 0]]);
    expect(queryOf(0)).toBe('SELECT item, quantityonhand FROM inventoryitemlocations WHERE location = 1 AND item IN (501, 502, 503)');
    // A count NetSuite leaves blank is none.
    fetchMock.mockResolvedValueOnce(json({ items: [{ item: 501, quantityonhand: null }, { item: 502 }] }));
    expect([...(await getLocationOnHand('1', ['501', '502']))]).toEqual([['501', 0], ['502', 0]]);
  });

  it("asks nothing for no items or an id that isn't NetSuite's, and throws when NetSuite can't answer", async () => {
    expect([...(await getLocationOnHand('1', []))]).toEqual([]);
    await expect(getLocationOnHand('1 OR 1=1', ['501'])).rejects.toThrow("isn't a NetSuite location id");
    await expect(getLocationOnHand('1', ['501', '502) OR (1=1'])).rejects.toThrow("An item id isn't a NetSuite id");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(getLocationOnHand('1', ['501'])).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createInventoryTransfer', () => {
  const TRANSFER: InventoryTransferPayload = {
    subsidiaryId: '2',
    tranDate: '2027-01-15',
    memo: 'Stock for the van',
    externalId: ID,
    fromLocationId: '1',
    toLocationId: '7',
    lines: [{ itemId: '501', quantity: 4 }, { itemId: '502', quantity: 12.5 }],
  };

  it('makes it with its External ID, subsidiary, date, memo, both locations, and how many of each item', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/inventoryTransfer/9003` } }));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: true, transferId: '9003' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/inventoryTransfer`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual({
      externalId: ID,
      subsidiary: { id: '2' },
      tranDate: '2027-01-15',
      memo: 'Stock for the van',
      location: { id: '1' },
      transferLocation: { id: '7' },
      inventory: { items: [{ item: { id: '501' }, adjustQtyBy: 4 }, { item: { id: '502' }, adjustQtyBy: 12.5 }] },
    });
  });

  it('reads the id from the answer when there is no Location', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 9004 }));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: true, transferId: '9004' });
  });

  it('sends nothing with no items, to where it already is, or with a quantity that moves nothing', async () => {
    expect(await createInventoryTransfer({ ...TRANSFER, lines: [] })).toEqual({ success: false, error: 'A transfer needs an item to move' });
    expect(await createInventoryTransfer({ ...TRANSFER, toLocationId: '1' }))
      .toEqual({ success: false, error: 'A transfer moves stock from one location to another' });
    for (const quantity of [0, -1, Number.NaN]) {
      expect(await createInventoryTransfer({ ...TRANSFER, lines: [TRANSFER.lines[0], { itemId: '502', quantity }] }))
        .toEqual({ success: false, error: 'Each item moved needs a quantity above 0' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'You cannot transfer more than is on hand.' }] }, 400));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: false, error: 'NetSuite error (400): You cannot transfer more than is on hand.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request' }, 400));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: false, error: 'NetSuite error (400): Bad Request' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: false, error: 'NetSuite error (500): Internal error', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({
      success: false, error: "NetSuite said it made the transfer but didn't say its id.", unsure: true,
    });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createInventoryTransfer(TRANSFER)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
