import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import OAuth from 'oauth-1.0a';
import CryptoJS from 'crypto-js';
import { getCheckNumbersUsed, getChecksNow, getPrintOnCheckAs, setCheckNumber } from './netsuite';

// What FleetSuite asks NetSuite to print a payment run's checks on BMG's
// stock (src/lib/check-printing.ts): each bill payment as NetSuite has it
// now, the check numbers NetSuite has on the bank account already, the name
// it prints on each vendor's checks, and each check's number set on its bill
// payment, taking it off To Be Printed. Every call is mocked; the requests
// and how the answers are read are what's held. Made-up data.

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

/** Whether an OAuth header was signed for this method and address, the way NetSuite checks it. */
function signedFor(auth: string, method: string, url: string): boolean {
  const field = (k: string) => decodeURIComponent(auth.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? '');
  const oauth = new OAuth({
    consumer: { key: ENV.NETSUITE_CONSUMER_KEY, secret: ENV.NETSUITE_CONSUMER_SECRET },
    signature_method: 'HMAC-SHA256',
    hash_function: (base: string, key: string) => CryptoJS.HmacSHA256(base, key).toString(CryptoJS.enc.Base64),
  });
  const data = {
    oauth_consumer_key: field('oauth_consumer_key'), oauth_nonce: field('oauth_nonce'), oauth_signature_method: field('oauth_signature_method'),
    oauth_timestamp: Number(field('oauth_timestamp')), oauth_version: field('oauth_version'), oauth_token: field('oauth_token'),
  };
  return oauth.getSignature({ url, method }, ENV.NETSUITE_TOKEN_SECRET, data) === field('oauth_signature');
}

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

describe('getChecksNow', () => {
  it("reads each bill payment's number, whether it's To Be Printed or voided, whose it is and its total", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { id: 8302, tranid: 'To Print', tobeprinted: 'T', voided: 'F', vendor_id: 31, total: '-1412.40' },
      { id: 8303, tranid: ' 1052 ', tobeprinted: 'F', voided: 'F', vendor_id: '52', total: '300' },
      { id: 8304, tranid: null, tobeprinted: true, voided: 'T', vendor_id: null, total: null },
      // A vendor that isn't NetSuite's id for one is no vendor, and a box that isn't ticked isn't.
      { id: 8305, tranid: '1053', tobeprinted: null, voided: 'true', vendor_id: 'Acme', total: 'n/a' },
      { id: 8306, tranid: '1054', tobeprinted: 'Yes', voided: false, vendor_id: '60', total: '50.00' },
    ] }));
    const now = await getChecksNow(['8302', '8303', ' 8304', '8304', '8302', 'CHK-1052', "8301) OR (1=1", '8304', '8305', '8306']);
    expect([...now]).toEqual([
      ['8302', { number: 'To Print', toBePrinted: true, voided: false, vendorId: '31', totalCents: 141240 }],
      ['8303', { number: '1052', toBePrinted: false, voided: false, vendorId: '52', totalCents: 30000 }],
      ['8304', { number: '', toBePrinted: true, voided: true, vendorId: null, totalCents: null }],
      ['8305', { number: '1053', toBePrinted: false, voided: true, vendorId: null, totalCents: null }],
      ['8306', { number: '1054', toBePrinted: false, voided: false, vendorId: '60', totalCents: 5000 }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(queryOf(0)).toBe(
      'SELECT t.id, t.tranid, t.tobeprinted, t.voided, t.entity AS vendor_id, t.foreigntotal AS total FROM transaction t '
      + "WHERE t.type = 'VendPymt' AND t.id IN (8302, 8303, 8304, 8305, 8306) ORDER BY t.id",
    );
  });

  it('asks nothing for no bill payments, and asks 200 at a time', async () => {
    expect([...(await getChecksNow([]))]).toEqual([]);
    expect([...(await getChecksNow(['CHK-1', '']))]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 30000, tranid: 'To Print', tobeprinted: 'T', voided: 'F', vendor_id: 31, total: '1' }] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 30200, tranid: 'To Print', tobeprinted: 'T', voided: 'F', vendor_id: 31, total: '2' }] }));
    const now = await getChecksNow(Array.from({ length: 201 }, (_, i) => String(30000 + i)));
    expect([...now.keys()]).toEqual(['30000', '30200']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queryOf(0).match(/IN \(([^)]*)\)/)?.[1].split(', ')).toHaveLength(200);
    expect(queryOf(1)).toContain('t.id IN (30200)');
  });

  it("throws when NetSuite can't answer", async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unknown identifier tobeprinted', { status: 400 }));
    await expect(getChecksNow(['8302'])).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('getCheckNumbersUsed', () => {
  it('asks for the numbers on checks, bill payments and refunds drawn on the bank account, and keeps the ones used', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ tranid: '1051' }, { tranid: ' 1050 ' }, { tranid: 'To Print' }, { tranid: null }, { tranid: '123456789' }] }));
    expect(await getCheckNumbersUsed(' 211 ', [1050, 1051, 1052, 1050, 0, 1.5, 100_000_000])).toEqual([1050, 1051]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryOf(0)).toBe(
      'SELECT DISTINCT t.tranid FROM transaction t JOIN transactionaccountingline tal ON tal.transaction = t.id '
      + "WHERE t.type IN ('Check', 'VendPymt', 'CustRfnd') AND tal.account = 211 AND t.tranid IN ('1050', '1051', '1052') ORDER BY t.tranid",
    );
  });

  it("asks nothing for no numbers or a bank account that isn't one, asks 200 at a time, and throws when NetSuite can't answer", async () => {
    expect(await getCheckNumbersUsed('211', [])).toEqual([]);
    expect(await getCheckNumbersUsed('211', [0, -3])).toEqual([]);
    await expect(getCheckNumbersUsed('10100 Operating', [1050])).rejects.toThrow("isn't NetSuite's id for a bank account");
    await expect(getCheckNumbersUsed("211 OR 1=1", [1050])).rejects.toThrow("isn't NetSuite's id for a bank account");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ items: [{ tranid: '1001' }] }));
    fetchMock.mockResolvedValueOnce(json({ items: [{ tranid: '1201' }] }));
    expect(await getCheckNumbersUsed('211', Array.from({ length: 201 }, (_, i) => 1001 + i))).toEqual([1001, 1201]);
    expect(queryOf(1)).toContain("t.tranid IN ('1201')");
    fetchMock.mockResolvedValueOnce(new Response('Unknown identifier tal.account', { status: 400 }));
    await expect(getCheckNumbersUsed('211', [1050])).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('getPrintOnCheckAs', () => {
  it("reads the name NetSuite prints on each vendor's checks, for the vendors that have one", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { id: 31, printoncheckas: ' Ozark Hose and Fitting LLC ' }, { id: 52, printoncheckas: '' }, { id: 60, printoncheckas: null },
    ] }));
    expect([...(await getPrintOnCheckAs(['31', '52', '60', '31', 'V-31']))]).toEqual([['31', 'Ozark Hose and Fitting LLC']]);
    expect(queryOf(0)).toBe('SELECT v.id, v.printoncheckas FROM vendor v WHERE v.id IN (31, 52, 60) ORDER BY v.id');
  });

  it("asks nothing for no vendors, and throws when NetSuite can't answer", async () => {
    expect([...(await getPrintOnCheckAs(['', 'Acme']))]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unknown identifier printoncheckas', { status: 400 }));
    await expect(getPrintOnCheckAs(['31'])).rejects.toThrow('NetSuite SuiteQL error (400)');
  });
});

describe('setCheckNumber', () => {
  it("sets the check's number on its bill payment and takes it off To Be Printed", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/vendorPayment/8302`);
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(signedFor(init.headers.Authorization, 'PATCH', url)).toBe(true);
    expect(init.headers.Prefer).toBe('respondAsync=false');
    expect(JSON.parse(init.body)).toEqual({ tranId: '1052', toBePrinted: false });
  });

  it("sends nothing for a bill payment that isn't NetSuite's id, or a number that isn't a check's", async () => {
    const byId = { success: false, error: "A check's number is set on its bill payment, by NetSuite's id for it" };
    expect(await setCheckNumber('CHK-1052', 1052)).toEqual(byId);
    expect(await setCheckNumber('', 1052)).toEqual(byId);
    const notNumber = { success: false, error: 'A check number is a whole number from 1 to 99,999,999' };
    for (const n of [0, -1, 1052.5, 100_000_000, Number.NaN]) expect(await setCheckNumber('8302', n)).toEqual(notNumber);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await setCheckNumber('8302', 99_999_999)).toEqual({ success: true });
    expect(await setCheckNumber('8302', 1)).toEqual({ success: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ tranId: '1', toBePrinted: false });
  });

  it("says NetSuite refused it after a 4xx, and that it may have taken it after a server error or no answer in time", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'This transaction is voided.' }] }, 400));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: false, error: 'NetSuite error (400): This transaction is voided.' });
    expect(logged.mock.calls[0][0]).toBe('NetSuite set check number error:');
    fetchMock.mockResolvedValueOnce(json({ title: 'Forbidden' }, 403));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: false, error: 'NetSuite error (403): Forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('Not JSON', { status: 422 }));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: false, error: 'NetSuite error (422): Not JSON' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response('Gateway', { status: 500 }));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: false, error: 'NetSuite error (500): Gateway', unsure: true });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await setCheckNumber('8302', 1052)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });

    // Given up on when it takes too long.
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    expect(await setCheckNumber('8302', 1052, { timeoutMs: 5 })).toEqual({ success: false, error: "NetSuite didn't answer (it took too long).", unsure: true });
  });
});
