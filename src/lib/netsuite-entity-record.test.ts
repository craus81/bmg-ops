import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEntityRecord, getItemRecord, patchEntityRecord, patchItemRecordFields } from './netsuite';

// What FleetSuite asks NetSuite for and sends it to change a customer's terms and credit limit, a vendor's details,
// or an item's accounts (src/lib/customer-terms.ts, src/lib/vendor-details.ts, src/lib/item-accounts.ts), and how it
// reads the answers: NetSuite's refusal in
// its own words, and a timeout or a fault on NetSuite's side as unsure, since the change may have gone in. Nothing
// sent is logged: a vendor's change may carry its tax ID. Every call is mocked. Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** Waits for an abort, as a request NetSuite never answers does. */
const never = (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getEntityRecord', () => {
  it("reads a customer live, and a vendor with its address book", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: '4410', companyName: 'Harbor Fleet Services', terms: { id: '1' } }));
    expect(await getEntityRecord('customer', '4410')).toEqual({
      success: true, record: { id: '4410', companyName: 'Harbor Fleet Services', terms: { id: '1' } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/customer/4410`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers).not.toHaveProperty('Prefer');

    fetchMock.mockResolvedValueOnce(json({ id: '2207', addressBook: { items: [] } }));
    expect(await getEntityRecord('vendor', '2207')).toEqual({ success: true, record: { id: '2207', addressBook: { items: [] } } });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/record/v1/vendor/2207?expandSubResources=true`);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    expect(await getEntityRecord('vendor', '2207')).toEqual({ success: true, record: {} });
  });

  it("says when NetSuite has no such record, and why it couldn't read one", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Not Found', 'o:errorDetails': [{ detail: 'The record instance does not exist.' }] }, 404));
    expect(await getEntityRecord('vendor', '2207')).toEqual({
      success: false, error: 'NetSuite error (404): The record instance does not exist.', notFound: true,
    });
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await getEntityRecord('customer', '4410')).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Invalid login attempt.', { status: 401 }));
    expect(await getEntityRecord('customer', '4410')).toEqual({ success: false, error: 'NetSuite error (401): Invalid login attempt.' });
    // A fault reading is just a failed read: nothing was changed.
    fetchMock.mockResolvedValueOnce(json({ title: 'Internal Server Error' }, 500));
    expect(await getEntityRecord('customer', '4410')).toEqual({ success: false, error: 'NetSuite error (500): Internal Server Error' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await getEntityRecord('customer', '4410')).toEqual({ success: false, error: "Couldn't reach NetSuite: fetch failed" });
    fetchMock.mockRejectedValueOnce(new Error());
    expect(await getEntityRecord('customer', '4410')).toEqual({ success: false, error: "Couldn't reach NetSuite: unknown error" });
  });

  it('gives up after 25 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(never);
    const pending = getEntityRecord('customer', '4410');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ success: false, error: 'NetSuite took too long to answer' });
  });

  it('asks nothing for an id that is not a number', async () => {
    expect(await getEntityRecord('customer', '4410/../1')).toEqual({ success: false, error: 'Bad customer id' });
    expect(await getEntityRecord('vendor', '')).toEqual({ success: false, error: 'Bad vendor id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('patchEntityRecord', () => {
  const BODY = { taxIdNum: '12-3456789', terms: { id: '3' } };

  it('changes only the fields sent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await patchEntityRecord('vendor', '2207', BODY)).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/vendor/2207`);
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual(BODY);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await patchEntityRecord('customer', '4410', { creditLimit: null });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/rest/record/v1/customer/4410`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ creditLimit: null });
  });

  it('says why NetSuite refused, that nothing changed, and logs nothing it was sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid value for taxIdNum.' }] }, 400));
    expect(await patchEntityRecord('vendor', '2207', BODY)).toEqual({ success: false, error: 'NetSuite error (400): Invalid value for taxIdNum.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Not Found' }, 404));
    expect(await patchEntityRecord('vendor', '2207', BODY)).toEqual({ success: false, error: 'NetSuite error (404): Not Found' });
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(700), { status: 400 }));
    expect(await patchEntityRecord('vendor', '2207', BODY)).toEqual({ success: false, error: `NetSuite error (400): ${'x'.repeat(600)}` });
    expect(JSON.stringify([error.mock.calls, log.mock.calls])).not.toContain('3456789');
  });

  it("can't tell whether it went in when NetSuite faults, times out or can't be reached", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Internal Server Error', 'o:errorDetails': [{ detail: 'An unexpected error occurred.' }] }, 500));
    expect(await patchEntityRecord('customer', '4410', { terms: { id: '2' } }))
      .toEqual({ success: false, error: 'NetSuite error (500): An unexpected error occurred.', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
    expect(await patchEntityRecord('customer', '4410', { terms: { id: '2' } }))
      .toEqual({ success: false, error: 'NetSuite error (503): Service Unavailable', unsure: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await patchEntityRecord('customer', '4410', { terms: { id: '2' } })).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await patchEntityRecord('customer', '4410', { terms: { id: '2' } })).toEqual({ success: false, error: "Couldn't reach NetSuite: fetch failed", unsure: true });
  });

  it('gives up after 25 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(never);
    const pending = patchEntityRecord('vendor', '2207', BODY);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
  });

  it('sends nothing for an id that is not a number', async () => {
    expect(await patchEntityRecord('vendor', '2207; DROP', BODY)).toEqual({ success: false, error: 'Bad vendor id' });
    expect(await patchEntityRecord('customer', '', BODY)).toEqual({ success: false, error: 'Bad customer id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getItemRecord', () => {
  const NON_INVENTORY = ['nonInventoryResaleItem', 'nonInventorySaleItem', 'nonInventoryPurchaseItem'] as const;
  const missing = () => json({ title: 'Not Found', 'o:errorDetails': [{ detail: 'The record instance does not exist.' }] }, 404);
  const urls = () => fetchMock.mock.calls.map((c) => c[0]);

  it('reads an item live, under the record type NetSuite files its kind under', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: '501', itemId: '51-2002', cogsAccount: { id: '106' } }));
    expect(await getItemRecord(['inventoryItem'], '501')).toEqual({
      success: true, recordType: 'inventoryItem', record: { id: '501', itemId: '51-2002', cogsAccount: { id: '106' } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/inventoryItem/501`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
  });

  it('tries the next record type where NetSuite has no such record, and stops at the one that has it', async () => {
    fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(json({ id: '502' }));
    expect(await getItemRecord(NON_INVENTORY, '502')).toEqual({ success: true, recordType: 'nonInventorySaleItem', record: { id: '502' } });
    expect(urls()).toEqual([`${BASE}/rest/record/v1/nonInventoryResaleItem/502`, `${BASE}/rest/record/v1/nonInventorySaleItem/502`]);
  });

  it('says NetSuite has no such item when none of the record types has it', async () => {
    fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(missing()).mockResolvedValueOnce(missing());
    expect(await getItemRecord(NON_INVENTORY, '502')).toEqual({ success: false, error: 'NetSuite has no item with id 502.', notFound: true });
    expect(urls()).toHaveLength(3);
    expect(await getItemRecord([], '502')).toEqual({ success: false, error: 'NetSuite has no item with id 502.', notFound: true });
    expect(urls()).toHaveLength(3);
  });

  it("keeps the first refusal, and still tries the rest in case one of them has it", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request' }, 400)).mockResolvedValueOnce(json({ title: 'Forbidden' }, 403))
      .mockResolvedValueOnce(missing());
    expect(await getItemRecord(NON_INVENTORY, '502')).toEqual({ success: false, error: 'NetSuite error (400): Bad Request' });
    expect(urls()).toHaveLength(3);
    fetchMock.mockResolvedValueOnce(missing()).mockResolvedValueOnce(json({ title: 'Internal Server Error' }, 500))
      .mockResolvedValueOnce(json({ id: '502' }));
    expect(await getItemRecord(NON_INVENTORY, '502')).toEqual({ success: true, recordType: 'nonInventoryPurchaseItem', record: { id: '502' } });
  });

  it("stops when NetSuite doesn't answer: the next wouldn't fare better", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await getItemRecord(NON_INVENTORY, '502')).toEqual({ success: false, error: "Couldn't reach NetSuite: fetch failed" });
    expect(urls()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(missing()).mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await getItemRecord(NON_INVENTORY, '502')).toEqual({ success: false, error: 'NetSuite took too long to answer' });
    expect(urls()).toHaveLength(3);
  });

  it('gives up after 25 seconds, without trying the next', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(never);
    const pending = getItemRecord(NON_INVENTORY, '502');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ success: false, error: 'NetSuite took too long to answer' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for an id that is not a number', async () => {
    expect(await getItemRecord(['inventoryItem', 'assemblyItem'], '501/../1')).toEqual({ success: false, error: 'Bad inventoryItem id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('patchItemRecordFields', () => {
  const BODY = { cogsAccount: { id: '105' }, assetAccount: { id: '106' } };

  it('changes only the accounts sent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await patchItemRecordFields('inventoryItem', '501', BODY)).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/inventoryItem/501`);
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it("says why NetSuite refused, and that it can't tell when NetSuite faults or doesn't answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid value for cogsAccount.' }] }, 400));
    expect(await patchItemRecordFields('inventoryItem', '501', BODY)).toEqual({ success: false, error: 'NetSuite error (400): Invalid value for cogsAccount.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Not Found' }, 404));
    expect(await patchItemRecordFields('serviceSaleItem', '601', { incomeAccount: { id: '101' } })).toEqual({ success: false, error: 'NetSuite error (404): Not Found' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Internal Server Error' }, 500));
    expect(await patchItemRecordFields('inventoryItem', '501', BODY)).toEqual({ success: false, error: 'NetSuite error (500): Internal Server Error', unsure: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await patchItemRecordFields('inventoryItem', '501', BODY)).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await patchItemRecordFields('inventoryItem', '501', BODY)).toEqual({ success: false, error: "Couldn't reach NetSuite: fetch failed", unsure: true });
  });

  it('sends nothing for an id that is not a number', async () => {
    expect(await patchItemRecordFields('serviceSaleItem', '601 OR 1', BODY)).toEqual({ success: false, error: 'Bad serviceSaleItem id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
