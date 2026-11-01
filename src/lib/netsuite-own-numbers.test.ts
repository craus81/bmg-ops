import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCreditMemoFromInvoice, createDirectInvoice, createInvoiceFromSO, createPurchaseOrder, createSalesOrder } from './netsuite';
import { setSendWriter, type SendRow } from './netsuite-sends';
import { setNumberKeeper, type NumberEnd, type OwnNumberType } from './books/own-numbers';

// FleetSuite's own numbers (src/lib/books/own-numbers.ts) on each sales order,
// PO, invoice and credit memo FleetSuite makes in NetSuite: the number is
// taken just before the send and goes as the document's number, and what
// became of it is kept. Every call is mocked and the numbers come from a
// stand-in keeper. Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const madeAt = (type: string, id: string) => new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/${type}/${id}` } });
const LETTERS: Record<OwnNumberType, string> = { sales_order: 'SO', purchase_order: 'PO', invoice: 'INV', credit_memo: 'CM' };

/** A stand-in keeper: hands out each kind's next number from 10001, or none while `off`, and keeps what became of each. */
function keeper(opts: { off?: boolean; fails?: boolean; settleFails?: boolean } = {}) {
  const kept = { taken: [] as OwnNumberType[], ends: [] as Array<[string, NumberEnd]> };
  let n = 10000;
  setNumberKeeper({
    async reserve(type) {
      if (opts.fails) throw new Error('could not reach the database');
      kept.taken.push(type);
      if (opts.off) return null;
      n += 1;
      return { id: `num-${n}`, number: `${LETTERS[type]}${n}` };
    },
    async settle(id, end) {
      if (opts.settleFails) throw new Error('could not reach the database');
      kept.ends.push([id, end]);
    },
  });
  return kept;
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setNumberKeeper(undefined);
  setSendWriter(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Create {
  type: OwnNumberType;
  record: string;
  url: string;
  send: () => Promise<{ success: boolean; error?: string } & Record<string, unknown>>;
  id: string;
  number: string;
}

const CREATES: Create[] = [
  {
    type: 'sales_order', record: 'salesOrder', url: `${BASE}/rest/record/v1/salesOrder`, id: 'salesOrderId', number: 'salesOrderNumber',
    send: () => createSalesOrder({ customerId: '4242', locationId: '7', lineItems: [{ itemId: '55', quantity: 2, rate: 125.5 }] }),
  },
  {
    type: 'purchase_order', record: 'purchaseOrder', url: `${BASE}/rest/record/v1/purchaseOrder`, id: 'purchaseOrderId', number: 'purchaseOrderNumber',
    send: () => createPurchaseOrder({ vendorId: '3001', locationId: '7', lineItems: [{ itemId: '55', quantity: 4, rate: 61.25 }] }),
  },
  {
    type: 'invoice', record: 'invoice', url: `${BASE}/rest/record/v1/invoice`, id: 'invoiceId', number: 'invoiceNumber',
    send: () => createDirectInvoice({ customerId: '4242', locationId: '7', lineItems: [{ itemId: '55', quantity: 1, rate: 125.5 }] }),
  },
  {
    type: 'invoice', record: 'invoice', url: `${BASE}/rest/record/v1/salesOrder/6001/!transform/invoice`, id: 'invoiceId', number: 'invoiceNumber',
    send: () => createInvoiceFromSO({ salesOrderId: '6001' }),
  },
  {
    type: 'credit_memo', record: 'creditMemo', url: `${BASE}/rest/record/v1/invoice/7001/!transform/creditMemo?replace=item`, id: 'creditMemoId', number: 'creditMemoNumber',
    send: () => createCreditMemoFromInvoice({ invoiceId: '7001', lines: [{ item: { id: '55' }, quantity: 1, rate: 125.5 }], memo: 'Returned' }),
  },
];

describe.each(CREATES)('$record from $url', (c) => {
  const ours = `${LETTERS[c.type]}10001`;
  const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  it("sends FleetSuite's number as the document's number and keeps the number NetSuite kept", async () => {
    const kept = keeper();
    fetchMock.mockResolvedValueOnce(madeAt(c.record, '9001')).mockResolvedValueOnce(json({ items: [{ tranid: ours }] }));
    const result = await c.send();
    expect(fetchMock.mock.calls[0][0]).toBe(c.url);
    expect(sent().tranId).toBe(ours);
    expect(result).toMatchObject({ success: true, [c.id]: '9001', [c.number]: ours });
    expect(kept.taken).toEqual([c.type]);
    expect(kept.ends).toEqual([['num-10001', { status: 'made', netsuiteId: '9001', netsuiteNumber: ours }]]);
  });

  it('keeps the number NetSuite gave it instead, or none when it never said', async () => {
    const kept = keeper();
    fetchMock.mockResolvedValueOnce(madeAt(c.record, '9001')).mockResolvedValueOnce(json({ items: [{ tranid: `${LETTERS[c.type]}2702` }] }));
    expect(await c.send()).toMatchObject({ success: true, [c.number]: `${LETTERS[c.type]}2702` });
    fetchMock.mockResolvedValueOnce(madeAt(c.record, '9002')).mockRejectedValueOnce(new Error('SuiteQL is down'));
    expect(await c.send()).toMatchObject({ success: true, [c.id]: '9002', [c.number]: '' });
    expect(kept.ends).toEqual([
      ['num-10001', { status: 'made', netsuiteId: '9001', netsuiteNumber: `${LETTERS[c.type]}2702` }],
      ['num-10002', { status: 'made', netsuiteId: '9002', netsuiteNumber: null }],
    ]);
  });

  it("lets NetSuite number it while FleetSuite's own numbers is off", async () => {
    const kept = keeper({ off: true });
    fetchMock.mockResolvedValueOnce(madeAt(c.record, '9001')).mockResolvedValueOnce(json({ items: [{ tranid: `${LETTERS[c.type]}2702` }] }));
    expect(await c.send()).toMatchObject({ success: true, [c.number]: `${LETTERS[c.type]}2702` });
    expect(sent()).not.toHaveProperty('tranId');
    expect(kept.taken).toEqual([c.type]);
    expect(kept.ends).toEqual([]);
  });

  it("sends nothing when FleetSuite can't give it its number", async () => {
    keeper({ fails: true });
    const result = await c.send();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^FleetSuite couldn't give this (sales order|PO|invoice|credit memo) its number, so nothing was sent to NetSuite\. Try again in a moment\.$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says NetSuite refused it, so nothing has the number', async () => {
    const kept = keeper();
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid value for the field entity.' }] }, 400));
    expect((await c.send()).success).toBe(false);
    expect(kept.ends).toEqual([['num-10001', { status: 'refused', note: 'Invalid value for the field entity.' }]]);
  });

  it("says when FleetSuite can't tell whether NetSuite made it", async () => {
    const kept = keeper();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect((await c.send()).success).toBe(false);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
    expect((await c.send()).success).toBe(false);
    expect(kept.ends).toEqual([
      ['num-10001', { status: 'unsure', note: "NetSuite answered 503, which doesn't say whether it made it." }],
      ['num-10002', { status: 'unsure', note: "NetSuite didn't answer in time." }],
    ]);
  });

  it("still makes it when what became of the number can't be kept", async () => {
    keeper({ settleFails: true });
    fetchMock.mockResolvedValueOnce(madeAt(c.record, '9001')).mockResolvedValueOnce(json({ items: [{ tranid: ours }] }));
    expect(await c.send()).toMatchObject({ success: true, [c.id]: '9001', [c.number]: ours });
  });
});

describe("FleetSuite's own numbers in the NetSuite feed", () => {
  it("names the send by FleetSuite's number", async () => {
    const rows: SendRow[] = [];
    setSendWriter({ start: async (row) => { rows.push(row); }, finish: async (row) => { rows.push(row); } });
    keeper();
    fetchMock.mockResolvedValueOnce(madeAt('invoice', '9001')).mockResolvedValueOnce(json({ items: [{ tranid: 'INV10001' }] }));
    await createDirectInvoice({ customerId: '4242', locationId: '7', lineItems: [{ itemId: '55', quantity: 1, rate: 125.5 }] });
    expect(rows.map((r) => [r.action, r.record_type, r.doc_ref])).toEqual([['create', 'invoice', 'INV10001'], ['create', 'invoice', 'INV10001']]);
  });

  it('takes no number for a document refused before it goes', async () => {
    const kept = keeper();
    expect(await createCreditMemoFromInvoice({ invoiceId: '7001', lines: [], memo: 'Nothing' })).toEqual({ success: false, error: 'Nothing to credit' });
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    const result = await createDirectInvoice({ customerId: '4242', locationId: '7', lineItems: [{ itemId: '56', quantity: 1, rate: 0 }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No price found in NetSuite');
    expect(kept.taken).toEqual([]);
  });
});
