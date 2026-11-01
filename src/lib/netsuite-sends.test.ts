// The NetSuite feed's recorder (src/lib/netsuite-sends.ts): what each request
// to NetSuite is, what NetSuite's answer says happened, what's kept of it
// (never the body, no long runs of digits), who sent it, and that keeping it
// never changes the send: the caller gets exactly fetch's answer or error, a
// body stays readable, and a feed that fails or hangs costs at most a few
// seconds. Made-up data.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  headers: new Map<string, string>() as Map<string, string> | null,
  cookies: [] as Array<{ name: string; value: string }>,
}));

vi.mock('next/headers', () => ({
  headers: () => {
    if (!h.headers) throw new Error('`headers` was called outside a request scope');
    const all = h.headers;
    return { get: (name: string) => all.get(name.toLowerCase()) ?? null };
  },
  cookies: () => ({ getAll: () => h.cookies }),
}));

import {
  answerOf, describeSend, netsuiteFetch, reasonOf, recordName, recordUrl, scrub, sendOf, setSendWriter, thrownAnswer,
  tokenUser, whoSent, type Send, type SendRow, type SendWriter,
} from './netsuite-sends';

const REST = 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest';
const SCRIPT = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=101&deploy=1';
const JESSIE = 'b2c3d4e5-0000-4000-8000-00000000000a';
const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

beforeEach(() => {
  h.headers = new Map();
  h.cookies = [];
});

describe('sendOf', () => {
  it("passes reads by: a GET, SuiteQL and the item script's ping", () => {
    expect(sendOf(`${REST}/record/v1/invoice/77`, 'GET', undefined)).toBeNull();
    expect(sendOf(`${REST}/record/v1/invoice/77`, undefined, undefined)).toBeNull();
    expect(sendOf(`${REST}/query/v1/suiteql?limit=1000&offset=0`, 'POST', JSON.stringify({ q: 'SELECT 1' }))).toBeNull();
    expect(sendOf(SCRIPT, 'POST', JSON.stringify({ action: 'ping' }))).toBeNull();
    expect(sendOf(SCRIPT, 'GET', undefined)).toBeNull();
    expect(sendOf('not a url', 'POST', '{}')).toBeNull();
  });

  it('tells a new record, a change, a delete and one made from another apart', () => {
    const base = { recordId: null, madeType: null, docRef: null, script: false };
    expect(sendOf(`${REST}/record/v1/vendorBill`, 'post', JSON.stringify({ tranId: 'A-1001', entity: { id: '4001' } }))).toEqual({
      ...base, method: 'POST', action: 'create', recordType: 'vendorBill', madeType: 'vendorBill', docRef: 'A-1001',
    });
    expect(sendOf(`${REST}/record/v1/salesOrder/4521?replace=item`, 'PATCH', JSON.stringify({ item: { items: [] } }))).toEqual({
      ...base, method: 'PATCH', action: 'change', recordType: 'salesOrder', recordId: '4521',
    });
    expect(sendOf(`${REST}/record/v1/contact/88`, 'DELETE', undefined)).toEqual({
      ...base, method: 'DELETE', action: 'delete', recordType: 'contact', recordId: '88',
    });
    expect(sendOf(`${REST}/record/v1/salesOrder/4521/!transform/invoice?replace=item`, 'POST', '{}')).toEqual({
      ...base, method: 'POST', action: 'transform', recordType: 'salesOrder', recordId: '4521', madeType: 'invoice',
    });
    // A record addressed by its External ID, as NetSuite spells it.
    expect(sendOf(`${REST}/record/v1/customer/eid%3Aacme-1`, 'PATCH', '{}')?.recordId).toBe('eid:acme-1');
    expect(sendOf(`${REST}/record/v1/customer/%E0%A4%A`, 'PATCH', '{}')?.recordId).toBe('%E0%A4%A');
    // A put or a delete without a record still says what it is.
    expect(sendOf(`${REST}/record/v1/customer`, 'PUT', '{}')?.action).toBe('change');
    expect(sendOf(`${REST}/record/v1/customer`, 'DELETE', undefined)?.action).toBe('delete');
    // Anywhere else in NetSuite: other.
    expect(sendOf(`${REST}/auth/v1/thing`, 'POST', '{}')).toEqual({ ...base, method: 'POST', action: 'create', recordType: 'other' });
    expect(sendOf(`${REST}/auth/v1/thing`, 'PATCH', '{}')?.action).toBe('change');
    expect(sendOf(`${REST}/auth/v1/thing`, 'DELETE', undefined)?.action).toBe('delete');
  });

  it('keeps one number or name to find it by, the first of the ones that name a record, and nothing else of the body', () => {
    const ref = (body: unknown) => sendOf(`${REST}/record/v1/journalEntry`, 'POST', typeof body === 'string' ? body : JSON.stringify(body))?.docRef;
    expect(ref({ memo: 'Rent', tranId: 'JE-9', externalId: 'fleetsuite-card-1' })).toBe('fleetsuite-card-1');
    expect(ref({ entityId: 'Acme Fleet', companyName: 'Acme Fleet LLC' })).toBe('Acme Fleet');
    expect(ref({ itemId: '06-1234' })).toBe('06-1234');
    expect(ref({ companyName: '  Acme Racks  ' })).toBe('Acme Racks');
    expect(ref({ tranId: 5001 })).toBe('5001');
    expect(ref({ tranId: 'x'.repeat(200) })).toBe('x'.repeat(120));
    expect(ref({ tranId: '   ', externalId: { id: 1 } })).toBeNull();
    expect(ref({ memo: 'Rent', taxIdNum: '12-3456789' })).toBeNull();
    expect(ref([{ tranId: 'A' }])).toBeNull();
    expect(ref('not json')).toBeNull();
    // A body over a million characters isn't read for one.
    const sized = (length: number) => {
      const shell = JSON.stringify({ externalId: 'fleetsuite-inv-2', memo: '' }).length;
      return JSON.stringify({ externalId: 'fleetsuite-inv-2', memo: 'x'.repeat(length - shell) });
    };
    expect(ref(sized(1_000_000))).toBe('fleetsuite-inv-2');
    expect(ref(sized(1_000_001))).toBeNull();
    expect(sendOf(`${REST}/record/v1/journalEntry`, 'POST', new URLSearchParams({ tranId: 'A' }) as any)?.docRef).toBeNull();
  });

  it('reads what the item script was asked', () => {
    expect(sendOf(SCRIPT, 'POST', JSON.stringify({ action: 'createDropShipPo', salesOrderId: '1177', vendorId: '4001' }))).toEqual({
      method: 'POST', action: 'transform', recordType: 'salesOrder', recordId: '1177', madeType: 'purchaseOrder', docRef: null, script: true,
    });
    expect(sendOf(SCRIPT, 'POST', JSON.stringify({ itemId: '812', itemNumber: '06-1234', salesPrice: 10 }))).toEqual({
      method: 'POST', action: 'change', recordType: 'item', recordId: '812', madeType: null, docRef: '06-1234', script: true,
    });
    expect(sendOf(SCRIPT, 'POST', JSON.stringify({ itemId: 812 }))?.recordId).toBe('812');
    expect(sendOf(SCRIPT, 'POST', JSON.stringify({ itemId: 'x'.repeat(61) }))?.recordId).toBeNull();
    expect(sendOf(SCRIPT, 'POST', JSON.stringify({ action: 'somethingNew' }))).toEqual({
      method: 'POST', action: 'script', recordType: 'script', recordId: null, madeType: null, docRef: null, script: true,
    });
    expect(sendOf(SCRIPT, 'POST', undefined)?.action).toBe('script');
  });
});

describe('answerOf', () => {
  const create: Send = { method: 'POST', action: 'create', recordType: 'invoice', recordId: null, madeType: 'invoice', docRef: null, script: false };
  const change: Send = { ...create, method: 'PATCH', action: 'change', recordId: '77', madeType: null };
  const transform: Send = { ...create, action: 'transform', recordType: 'salesOrder', recordId: '4521' };
  const script: Send = { ...transform, madeType: 'purchaseOrder', script: true };

  it("takes NetSuite's ID for a new record from where it says it is", () => {
    expect(answerOf(create, 204, `${REST}/record/v1/invoice/9001`, null)).toEqual({ outcome: 'took', httpStatus: 204, madeId: '9001', docRef: null, error: null });
    expect(answerOf(transform, 204, `${REST}/record/v1/invoice/9002/`, null).madeId).toBe('9002');
    expect(answerOf(create, 200, null, null)).toEqual({ outcome: 'took', httpStatus: 200, madeId: null, docRef: null, error: null });
    expect(answerOf(create, 204, `${REST}/record/v1/invoice/eid:x`, null).madeId).toBeNull();
    // A change says where the record is too, but makes nothing.
    expect(answerOf(change, 204, `${REST}/record/v1/invoice/77`, null)).toEqual({ outcome: 'took', httpStatus: 204, madeId: null, docRef: null, error: null });
  });

  it("calls a 4xx refused with NetSuite's reason, and a 5xx or anything else not sure", () => {
    const detail = JSON.stringify({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid value for field entity: 4001.' }] });
    expect(answerOf(create, 400, null, detail)).toEqual({ outcome: 'refused', httpStatus: 400, madeId: null, docRef: null, error: 'Invalid value for field entity: 4001.' });
    expect(answerOf(create, 499, null, '')).toMatchObject({ outcome: 'refused', error: 'NetSuite refused it (499).' });
    expect(answerOf(create, 429, null, JSON.stringify({ title: 'Too many requests' }))).toMatchObject({ outcome: 'refused', error: 'Too many requests' });
    expect(answerOf(create, 500, null, JSON.stringify({ title: 'Internal Server Error', 'o:errorDetails': [{ detail: 'UNEXPECTED_ERROR' }] })))
      .toEqual({ outcome: 'unsure', httpStatus: 500, madeId: null, docRef: null, error: 'UNEXPECTED_ERROR' });
    expect(answerOf(create, 502, null, '<html><body><h1>502 Bad Gateway</h1></body></html>')).toMatchObject({ outcome: 'unsure', error: '502 Bad Gateway' });
    expect(answerOf(create, 503, null, null)).toMatchObject({ outcome: 'unsure', error: "NetSuite answered 503, which doesn't say whether it was done." });
    expect(answerOf(create, 302, `${REST}/record/v1/invoice/9001`, null)).toMatchObject({ outcome: 'unsure', madeId: null });
    expect(answerOf(create, 199, null, null)).toMatchObject({ outcome: 'unsure', httpStatus: 199 });
    expect(answerOf(create, 600, null, null)).toMatchObject({ outcome: 'unsure', httpStatus: null });
    expect(answerOf(create, 99, null, null)).toMatchObject({ outcome: 'unsure', httpStatus: null });
    expect(answerOf(create, 300, null, null).outcome).toBe('unsure');
    expect(answerOf(create, 399, null, null).outcome).toBe('unsure');
    expect(answerOf(create, 400, null, null).outcome).toBe('refused');
  });

  it("reads the item script's own answer, which comes back 200 either way", () => {
    expect(answerOf(script, 200, null, JSON.stringify({ success: true, purchaseOrderId: 8123, tranId: 'PO1301' })))
      .toEqual({ outcome: 'took', httpStatus: 200, madeId: '8123', docRef: 'PO1301', error: null });
    expect(answerOf(script, 200, null, JSON.stringify({ success: true, recordType: 'inventoryitem' })))
      .toEqual({ outcome: 'took', httpStatus: 200, madeId: null, docRef: null, error: null });
    expect(answerOf(script, 200, null, JSON.stringify({ success: true, purchaseOrderId: 'PO-x' })).madeId).toBeNull();
    expect(answerOf(script, 200, null, JSON.stringify({ success: false, error: 'Missing parameter: itemId' })))
      .toEqual({ outcome: 'refused', httpStatus: 200, madeId: null, docRef: null, error: 'Missing parameter: itemId' });
    expect(answerOf(script, 200, null, JSON.stringify({ success: false, error: { message: 'No vendor' } })).error).toBe('No vendor');
    expect(answerOf(script, 200, null, JSON.stringify({ success: false })).error).toBe("The item script said it didn't do it.");
    expect(answerOf(script, 200, null, 'Not JSON')).toEqual({
      outcome: 'unsure', httpStatus: 200, madeId: null, docRef: null,
      error: "NetSuite answered, but not in a way FleetSuite could read, so it can't tell whether it was done.",
    });
    expect(answerOf(script, 200, null, '[1]').outcome).toBe('unsure');
    expect(answerOf(script, 200, null, null).outcome).toBe('unsure');
    // Its answers always say success true or false, so one that doesn't isn't its own.
    expect(answerOf(script, 200, null, JSON.stringify({ recordType: 'inventoryitem' }))).toEqual({
      outcome: 'unsure', httpStatus: 200, madeId: null, docRef: null,
      error: "NetSuite answered, but not in a way FleetSuite could read, so it can't tell whether it was done.",
    });
    expect(answerOf(script, 200, null, JSON.stringify({ success: 'yes' })).outcome).toBe('unsure');
    // An error from the script is NetSuite's as any other's.
    expect(answerOf(script, 400, null, JSON.stringify({ error: { code: 'SSS_MISSING_REQD_ARGUMENT', message: 'salesOrderId' } })))
      .toMatchObject({ outcome: 'refused', error: 'salesOrderId' });
  });
});

describe('scrub and reasonOf', () => {
  it('hides any run of nine or more digits, keeps dates and shorter numbers, and keeps it to one line of 600', () => {
    expect(scrub('Tax ID 12-3456789 and account 000123456789 are invalid')).toBe('Tax ID ••• and account ••• are invalid');
    expect(scrub('Card 4111 1111 1111 1111, SSN 123-45-6789')).toBe('Card •••, SSN •••');
    expect(scrub('Record 12345678 dated 2026-10-31 on line 4521')).toBe('Record 12345678 dated 2026-10-31 on line 4521');
    expect(scrub('  two\n\nlines\t here ')).toBe('two lines here');
    expect(scrub('x'.repeat(700))).toHaveLength(600);
  });

  it("finds NetSuite's reason, wherever it put it", () => {
    expect(reasonOf(null)).toBe('');
    expect(reasonOf('')).toBe('');
    expect(reasonOf(JSON.stringify({ title: 'T', 'o:errorDetails': [{ detail: 'D' }] }))).toBe('D');
    expect(reasonOf(JSON.stringify({ title: 'T', 'o:errorDetails': [{ detail: '  ' }] }))).toBe('T');
    expect(reasonOf(JSON.stringify({ error: { message: 'M' }, title: 'T' }))).toBe('M');
    expect(reasonOf(JSON.stringify({ error: 'E', title: 'T' }))).toBe('E');
    expect(reasonOf(JSON.stringify({ error: { code: 'X' }, title: 'T' }))).toBe('T');
    expect(reasonOf(JSON.stringify({ message: 'Msg' }))).toBe('Msg');
    expect(reasonOf(JSON.stringify({ other: 1 }))).toBe('{"other":1}');
    expect(reasonOf('Plain <b>words</b>')).toBe('Plain words');
    expect(reasonOf(JSON.stringify({ title: 'Account 000123456789 is closed' }))).toBe('Account ••• is closed');
  });

  it("says what a thrown send leaves FleetSuite not knowing", () => {
    expect(thrownAnswer(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })))
      .toEqual({ outcome: 'unsure', httpStatus: null, madeId: null, docRef: null, error: "NetSuite didn't answer in time." });
    expect(thrownAnswer(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })).error)
      .toBe('FleetSuite stopped waiting before NetSuite answered.');
    expect(thrownAnswer(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).error)
      .toBe('FleetSuite lost touch with NetSuite before it answered: fetch failed (ECONNRESET)');
    expect(thrownAnswer(new Error('socket hang up')).error).toBe('FleetSuite lost touch with NetSuite before it answered: socket hang up');
    expect(thrownAnswer(new Error('Account 000123456789\nis locked')).error)
      .toBe('FleetSuite lost touch with NetSuite before it answered: Account ••• is locked');
    expect(thrownAnswer('dropped').error).toBe('FleetSuite lost touch with NetSuite before it answered: dropped');
    expect(thrownAnswer(null).error).toBe('FleetSuite lost touch with NetSuite before it answered: null');
    expect(thrownAnswer(Object.assign(new Error(''), { cause: { code: 7 } })).error).toBe('FleetSuite lost touch with NetSuite before it answered: Error');
  });
});

describe('who sent it', () => {
  it('reads the person from a sign-in token, and nobody from anything else', () => {
    expect(tokenUser(jwt({ sub: JESSIE.toUpperCase(), role: 'authenticated' }))).toBe(JESSIE);
    expect(tokenUser(jwt({ sub: 'service_role' }))).toBeNull();
    expect(tokenUser(jwt({ role: 'anon' }))).toBeNull();
    expect(tokenUser(jwt('just a string'))).toBeNull();
    expect(tokenUser('a-cron-secret-with-no-dots')).toBeNull();
    expect(tokenUser('h.!!!.sig')).toBeNull();
    expect(tokenUser('h..sig')).toBeNull();
  });

  it("is whoever the request's sign-in names, by its header or its cookie, and nobody outside a request", async () => {
    h.headers = new Map([['authorization', `Bearer ${jwt({ sub: JESSIE })}`]]);
    expect(await whoSent()).toBe(JESSIE);
    h.headers = new Map();
    h.cookies = [{ name: 'sb-abc-auth-token', value: encodeURIComponent(JSON.stringify({ access_token: jwt({ sub: JESSIE }) })) }];
    expect(await whoSent()).toBe(JESSIE);
    h.cookies = [];
    expect(await whoSent()).toBeNull();
    h.headers = new Map([['authorization', 'Bearer a-cron-secret']]);
    expect(await whoSent()).toBeNull();
    h.headers = null;
    expect(await whoSent()).toBeNull();
  });
});

describe('how a send reads', () => {
  it('names records in plain words', () => {
    expect(recordName('salesOrder')).toBe('sales order');
    expect(recordName('vendorBill')).toBe('bill');
    expect(recordName('serviceSaleItem')).toBe('item');
    expect(recordName('customerPayment')).toBe('customer payment');
    expect(recordName('customerDeposit')).toBe('customer deposit');
    expect(recordName('deposit')).toBe('bank deposit');
    expect(recordName('vendorPayment')).toBe('bill payment');
    expect(recordName('check')).toBe('check');
  });

  it('says what each asked NetSuite for', () => {
    const d = (action: any, record_type: string, made_type: string | null = null) => describeSend({ action, record_type, made_type });
    expect(d('create', 'invoice', 'invoice')).toBe('New invoice');
    expect(d('create', 'inventoryItem')).toBe('New item');
    expect(d('change', 'salesOrder')).toBe('Change to a sales order');
    expect(d('change', 'invoice')).toBe('Change to an invoice');
    expect(d('delete', 'contact')).toBe('Deletion of a contact');
    expect(d('transform', 'salesOrder', 'invoice')).toBe('Invoice from a sales order');
    expect(d('transform', 'purchaseOrder', 'itemReceipt')).toBe('Item receipt from a purchase order');
    expect(d('transform', 'invoice')).toBe('Invoice from an invoice');
    expect(d('script', 'script')).toBe('Request to the item script');
    expect(d('create', 'other')).toBe('New record in NetSuite');
    expect(d('change', 'other')).toBe('Change in NetSuite');
    expect(d('delete', 'other')).toBe('Deletion in NetSuite');
  });

  it("links to NetSuite's page for the record, when it knows the record and the account", () => {
    vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567-sb1');
    try {
      const ui = 'https://1234567_SB1.app.netsuite.com/app';
      expect(recordUrl('invoice', '9001')).toBe(`${ui}/accounting/transactions/custinvc.nl?id=9001`);
      expect(recordUrl('salesOrder', '4521')).toBe(`${ui}/accounting/transactions/salesord.nl?id=4521`);
      expect(recordUrl('inventoryAdjustment', '12')).toBe(`${ui}/accounting/transactions/invadjst.nl?id=12`);
      expect(recordUrl('customerDeposit', '7301')).toBe(`${ui}/accounting/transactions/custdep.nl?id=7301`);
      expect(recordUrl('deposit', '8301')).toBe(`${ui}/accounting/transactions/deposit.nl?id=8301`);
      expect(recordUrl('vendorPayment', '8302')).toBe(`${ui}/accounting/transactions/vendpymt.nl?id=8302`);
      expect(recordUrl('customer', '5')).toBe(`${ui}/common/entity/custjob.nl?id=5`);
      expect(recordUrl('vendor', '4001')).toBe(`${ui}/common/entity/vendor.nl?id=4001`);
      expect(recordUrl('serviceSaleItem', '812')).toBe(`${ui}/common/item/item.nl?id=812`);
      expect(recordUrl('item', '812')).toBe(`${ui}/common/item/item.nl?id=812`);
      expect(recordUrl('note', '3')).toBeNull();
      expect(recordUrl('customer', 'eid:acme')).toBeNull();
      expect(recordUrl(null, '3')).toBeNull();
      expect(recordUrl('invoice', null)).toBeNull();
      vi.stubEnv('NETSUITE_ACCOUNT_ID', '');
      expect(recordUrl('invoice', '9001')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('netsuiteFetch', () => {
  // What finding who sent it loads is loaded up front, so the timings below are the send's own.
  beforeAll(async () => { await whoSent(); });

  let fetchMock: ReturnType<typeof vi.fn>;
  let kept: Array<['start' | 'finish', SendRow]>;
  let writer: SendWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    kept = [];
    writer = {
      start: vi.fn(async (row: SendRow) => { kept.push(['start', { ...row }]); }),
      finish: vi.fn(async (row: SendRow) => { kept.push(['finish', { ...row }]); }),
    };
    setSendWriter(writer);
    h.headers = new Map([['authorization', `Bearer ${jwt({ sub: JESSIE })}`]]);
  });

  afterEach(() => {
    setSendWriter(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps nothing under the test runner unless a test asks, so mocked fetches see only their requests', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSendWriter(undefined);
    const answer = new Response(null, { status: 204 });
    fetchMock.mockResolvedValueOnce(answer);
    const init = { method: 'POST', body: '{}' };
    expect(await netsuiteFetch(`${REST}/record/v1/invoice`, init)).toBe(answer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${REST}/record/v1/invoice`, init);
    setSendWriter(null);
    fetchMock.mockResolvedValueOnce(answer);
    expect(await netsuiteFetch(`${REST}/record/v1/invoice`, init)).toBe(answer);
    expect(writer.start).not.toHaveBeenCalled();
    // Not even tried, so nothing in the log either.
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes reads straight through, kept nowhere', async () => {
    const answer = json({ items: [] });
    fetchMock.mockResolvedValue(answer);
    expect(await netsuiteFetch(`${REST}/query/v1/suiteql?limit=1000&offset=0`, { method: 'POST', body: JSON.stringify({ q: 'SELECT id FROM item' }) })).toBe(answer);
    expect(await netsuiteFetch(`${REST}/record/v1/invoice/77`)).toBe(answer);
    expect(await netsuiteFetch(new URL(SCRIPT), { method: 'POST', body: JSON.stringify({ action: 'ping' }) })).toBe(answer);
    expect(kept).toEqual([]);
  });

  it('keeps a write as it starts and again with the answer, and hands back the very answer fetch gave', async () => {
    const answer = new Response(null, { status: 204, headers: { Location: `${REST}/record/v1/invoice/9001` } });
    fetchMock.mockImplementationOnce(async () => {
      // Kept before NetSuite answers.
      expect(kept.map(([what]) => what)).toEqual(['start']);
      return answer;
    });
    const init = { method: 'POST', headers: { Authorization: 'OAuth secret' }, body: JSON.stringify({ externalId: 'fleetsuite-inv-1', memo: 'Private' }) };
    expect(await netsuiteFetch(`${REST}/record/v1/invoice`, init)).toBe(answer);
    expect(fetchMock).toHaveBeenCalledWith(`${REST}/record/v1/invoice`, init);
    const [[, start], [, finish]] = kept;
    expect(start).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      started_at: expect.any(String),
      method: 'POST',
      action: 'create',
      record_type: 'invoice',
      record_id: null,
      made_type: 'invoice',
      doc_ref: 'fleetsuite-inv-1',
      user_id: JESSIE,
    });
    expect(finish).toEqual({
      ...start, finished_at: expect.any(String), outcome: 'took', http_status: 204, made_id: '9001', error: null,
    });
    expect(Date.parse(finish.finished_at!)).toBeGreaterThanOrEqual(Date.parse(start.started_at));
    // Never the body, nor how it was signed.
    expect(JSON.stringify(kept)).not.toMatch(/Private|secret/);
  });

  it("keeps NetSuite's reason for a refusal and leaves the body for the caller to read", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid account 000123456789.' }] }, 400));
    const res = await netsuiteFetch(`${REST}/record/v1/vendorCredit`, { method: 'POST', body: JSON.stringify({ tranId: 'VC-7' }) });
    expect(res.status).toBe(400);
    expect((await res.json())['o:errorDetails'][0].detail).toBe('Invalid account 000123456789.');
    expect(kept[1][1]).toMatchObject({ outcome: 'refused', http_status: 400, error: 'Invalid account •••.', doc_ref: 'VC-7', made_id: null });
  });

  it("reads the item script's answer for whether it did it, and the caller still can", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, purchaseOrderId: '8123', tranId: 'PO1301' }));
    const res = await netsuiteFetch(SCRIPT, { method: 'POST', body: JSON.stringify({ action: 'createDropShipPo', salesOrderId: '1177', vendorId: '4001' }) });
    expect(await res.json()).toEqual({ success: true, purchaseOrderId: '8123', tranId: 'PO1301' });
    expect(kept[1][1]).toMatchObject({
      action: 'transform', record_type: 'salesOrder', record_id: '1177', made_type: 'purchaseOrder', outcome: 'took', made_id: '8123', doc_ref: 'PO1301',
    });
  });

  it("doesn't read the body of an answer NetSuite took", async () => {
    const answer = json({ id: 1 });
    const clone = vi.spyOn(answer, 'clone');
    fetchMock.mockResolvedValueOnce(answer);
    await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' });
    expect(clone).not.toHaveBeenCalled();
    expect(kept[1][1]).toMatchObject({ action: 'change', record_id: '77', outcome: 'took', http_status: 200 });
  });

  it('keeps a send that threw as not sure, and throws the very same error', async () => {
    const lost = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    fetchMock.mockRejectedValueOnce(lost);
    await expect(netsuiteFetch(`${REST}/record/v1/journalEntry`, { method: 'POST', body: JSON.stringify({ externalId: 'fleetsuite-je-1' }) })).rejects.toBe(lost);
    expect(kept[1][1]).toMatchObject({
      outcome: 'unsure', http_status: null, made_id: null, error: 'FleetSuite lost touch with NetSuite before it answered: fetch failed (ECONNRESET)',
    });
  });

  it("sends even when the feed can't keep it, and says so only in the log", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSendWriter({
      start: () => { throw new Error('feed down'); },
      finish: async () => { throw new Error('feed still down'); },
    });
    const answer = new Response(null, { status: 204 });
    fetchMock.mockResolvedValueOnce(answer);
    expect(await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' })).toBe(answer);
    expect(warn).toHaveBeenCalledWith("[netsuite-sends] couldn't keep a send:", 'feed down');
    expect(warn).toHaveBeenCalledWith("[netsuite-sends] couldn't keep a send:", 'feed still down');
    // Not an Error: still only a warning.
    setSendWriter({ start: async () => { throw 'odd'; }, finish: async () => undefined });
    fetchMock.mockResolvedValueOnce(answer);
    expect(await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' })).toBe(answer);
    expect(warn).toHaveBeenCalledWith("[netsuite-sends] couldn't keep a send:", 'odd');
  });

  it('waits for the feed at most three seconds once NetSuite has answered', async () => {
    vi.useFakeTimers();
    setSendWriter({ start: async () => undefined, finish: () => new Promise(() => {}) });
    const answer = new Response(null, { status: 204 });
    fetchMock.mockResolvedValueOnce(answer);
    let done: Response | null = null;
    const sending = netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' }).then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(done).toBe(answer);
  });

  it('leaves nothing waiting once a send is kept', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })).mockRejectedValueOnce(new TypeError('fetch failed'));
    await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' });
    await expect(netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' })).rejects.toThrow('fetch failed');
    expect(kept.map(([what]) => what)).toEqual(['start', 'finish', 'start', 'finish']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("doesn't wait for a start the feed is slow to keep", async () => {
    let started = false;
    setSendWriter({
      start: () => new Promise((resolve) => setTimeout(() => { started = true; resolve(undefined); }, 50)),
      finish: async (row) => { kept.push(['finish', row]); },
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' });
    expect(started).toBe(false);
    expect(kept.map(([what]) => what)).toEqual(['finish']);
  });

  it('copes with an answer that is not a full Response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
    const res = await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(500);
    expect(kept[1][1]).toMatchObject({ outcome: 'unsure', http_status: 500, error: "NetSuite answered 500, which doesn't say whether it was done." });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, headers: { get: () => { throw new Error('no'); } } } as unknown as Response);
    await netsuiteFetch(`${REST}/record/v1/invoice`, { method: 'POST', body: '{}' });
    expect(kept[3][1]).toMatchObject({ outcome: 'took', made_id: null });
    const broken = new Response('x', { status: 500 });
    vi.spyOn(broken, 'clone').mockImplementation(() => { throw new Error('used'); });
    fetchMock.mockResolvedValueOnce(broken);
    await netsuiteFetch(`${REST}/record/v1/invoice/77`, { method: 'PATCH', body: '{}' });
    expect(kept[5][1]).toMatchObject({ outcome: 'unsure', error: "NetSuite answered 500, which doesn't say whether it was done." });
  });

  it('notes nobody for a scheduled job', async () => {
    h.headers = new Map([['authorization', 'Bearer cron-secret']]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await netsuiteFetch(`${REST}/record/v1/estimate/5`, { method: 'PATCH', body: JSON.stringify({ status: 'C' }) });
    expect(kept[0][1].user_id).toBeNull();
  });
});
