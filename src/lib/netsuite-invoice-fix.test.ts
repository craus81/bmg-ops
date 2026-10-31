import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { patchInvoice } from './netsuite';

// What FleetSuite sends NetSuite to fix an invoice (src/lib/invoice-fix.ts),
// and how it reads the answer: NetSuite's refusal in its own words, and a
// timeout or a fault on NetSuite's side as unsure, since the change may have
// gone in. Every call is mocked. Made-up data.

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

describe('patchInvoice', () => {
  const BODY = { otherRefNum: 'PO-778', item: { items: [{ line: 2, quantity: 3 }] } };

  it('changes the lines sent by their keys, and only those', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await patchInvoice('7001', BODY, { replace: false })).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/invoice/7001`);
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it('makes the lines exactly those sent when a line is taken off', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await patchInvoice('7001', BODY, { replace: true })).toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/record/v1/invoice/7001?replace=item`);
  });

  it("says why NetSuite refused, and that nothing changed", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'The period is closed.' }] }, 400));
    expect(await patchInvoice('7001', BODY, { replace: false })).toEqual({ success: false, error: 'NetSuite error (400): The period is closed.' });
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await patchInvoice('7001', BODY, { replace: false })).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Invalid login attempt.', { status: 401 }));
    expect(await patchInvoice('7001', BODY, { replace: false })).toEqual({ success: false, error: 'NetSuite error (401): Invalid login attempt.' });
  });

  it("can't tell whether it went in when NetSuite faults, times out or can't be reached", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Internal Server Error', 'o:errorDetails': [{ detail: 'An unexpected error occurred.' }] }, 500));
    expect(await patchInvoice('7001', BODY, { replace: false }))
      .toEqual({ success: false, error: 'NetSuite error (500): An unexpected error occurred.', unsure: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await patchInvoice('7001', BODY, { replace: false })).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await patchInvoice('7001', BODY, { replace: false })).toEqual({ success: false, error: "Couldn't reach NetSuite: fetch failed", unsure: true });
  });

  it('gives up after 25 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = patchInvoice('7001', BODY, { replace: false });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ success: false, error: 'NetSuite took too long to answer', unsure: true });
  });

  it('sends nothing for an id that is not a number', async () => {
    expect(await patchInvoice('7001; DROP', BODY, { replace: false })).toEqual({ success: false, error: 'Bad invoice id' });
    expect(await patchInvoice('', BODY, { replace: true })).toEqual({ success: false, error: 'Bad invoice id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
