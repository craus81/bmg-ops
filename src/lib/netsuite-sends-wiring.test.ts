// The NetSuite client's sends as the NetSuite feed keeps them
// (src/lib/netsuite-sends.ts): each write from src/lib/netsuite.ts is kept
// with what NetSuite answered, its reads aren't, and what the client hands
// back is what it always did. Also holds that no file signing its own
// NetSuite requests calls fetch directly, so a new write can't skip the feed.
// Every call is mocked. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const h = vi.hoisted(() => ({ headers: new Map<string, string>() }));

vi.mock('next/headers', () => ({
  headers: () => ({ get: (name: string) => h.headers.get(name.toLowerCase()) ?? null }),
  cookies: () => ({ getAll: () => [] }),
}));

import {
  createDropShipPoViaRestlet, createInventoryAdjustment, createJournalEntry, createVendorCredit, getIncomeStatementFromRestlet,
  patchInvoice, updateItemDescription,
} from './netsuite';
import { pingRestlet } from './restlet-probe';
import { setSendWriter, type SendRow } from './netsuite-sends';

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const REST = 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest';
const ITEM_SCRIPT = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=101&deploy=1';
const MONEY_SCRIPT = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=102&deploy=1';
const JESSIE = 'b2c3d4e5-0000-4000-8000-00000000000a';
const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
let kept: Array<['start' | 'finish', SendRow]>;
/** The rows as NetSuite's answers left them. */
const finishes = () => kept.filter(([what]) => what === 'finish').map(([, row]) => row);

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv('NETSUITE_CURRENCY_ID', '');
  vi.stubEnv('NETSUITE_ITEM_RESTLET_URL', ITEM_SCRIPT);
  vi.stubEnv('NETSUITE_FINANCIALS_RESTLET_URL', MONEY_SCRIPT);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  kept = [];
  setSendWriter({
    start: async (row) => { kept.push(['start', { ...row }]); },
    finish: async (row) => { kept.push(['finish', { ...row }]); },
  });
  h.headers = new Map([['authorization', `Bearer ${jwt({ sub: JESSIE })}`]]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setSendWriter(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the NetSuite client's sends on the feed", () => {
  it('keeps an inventory adjustment NetSuite took, with what it made, and not the lookup after it', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${REST}/record/v1/inventoryAdjustment/7001` } }))
      .mockResolvedValueOnce(json({ items: [{ tranid: 'ADJ-12' }] }));
    expect(await createInventoryAdjustment({ itemId: '812', locationId: '1', accountId: '501', adjustQtyBy: -2, memo: 'Counted 3, not 5' }))
      .toEqual({ success: true, adjustmentId: '7001', adjustmentNumber: 'ADJ-12' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kept.map(([what]) => what)).toEqual(['start', 'finish']);
    expect(finishes()).toEqual([expect.objectContaining({
      method: 'POST', action: 'create', record_type: 'inventoryAdjustment', record_id: null, made_type: 'inventoryAdjustment',
      made_id: '7001', outcome: 'took', http_status: 204, error: null, user_id: JESSIE,
    })]);
    expect(JSON.stringify(kept)).not.toContain('Counted');
  });

  it("keeps a vendor credit NetSuite refused, with its reason, and the client's error is unchanged", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ currency: '1' }] }))
      .mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid account reference key 999.' }] }, 400));
    expect(await createVendorCredit({
      vendorId: '4001', tranId: 'VC-1', tranDate: '2026-10-30', subsidiaryId: '2', memo: 'Returned hitch',
      expenses: [{ accountId: '999', amount: 12.34 }], items: [], apply: [],
    })).toEqual({ success: false, error: 'NetSuite error (400): Invalid account reference key 999.' });
    expect(finishes()).toEqual([expect.objectContaining({
      action: 'create', record_type: 'vendorCredit', doc_ref: 'VC-1', outcome: 'refused', http_status: 400,
      error: 'Invalid account reference key 999.', made_id: null,
    })]);
  });

  it('keeps a change to an invoice that ended in a server error as unsure, as the client says', async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Internal Server Error' }, 500));
    expect(await patchInvoice('9001', { memo: 'Fixed' }, { replace: true }))
      .toEqual({ success: false, error: 'NetSuite error (500): Internal Server Error', unsure: true });
    expect(finishes()).toEqual([expect.objectContaining({
      method: 'PATCH', action: 'change', record_type: 'invoice', record_id: '9001', outcome: 'unsure', http_status: 500,
      error: 'Internal Server Error',
    })]);
  });

  it("keeps a journal entry NetSuite never answered as unsure, under FleetSuite's own name for it", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    expect(await createJournalEntry({
      subsidiaryId: '2', tranDate: '2026-10-30', memo: 'Card charges', externalId: 'fleetsuite-je-41',
      lines: [{ accountId: '601', debit: 10 }, { accountId: '201', credit: 10 }],
    })).toEqual({ success: false, error: "NetSuite didn't answer (fetch failed).", unsure: true });
    expect(finishes()).toEqual([expect.objectContaining({
      action: 'create', record_type: 'journalEntry', doc_ref: 'fleetsuite-je-41', outcome: 'unsure', http_status: null,
      error: 'FleetSuite lost touch with NetSuite before it answered: fetch failed (ECONNRESET)',
    })]);
  });

  it("keeps the item script's answers: a description it changed, and one it said it didn't", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ success: true, recordType: 'serviceSaleItem' }))
      .mockResolvedValueOnce(json({ success: false, error: 'Item 813 is inactive' }));
    expect(await updateItemDescription('812', 'Hitch, 2 in.')).toEqual({ success: true, recordType: 'serviceSaleItem' });
    expect(await updateItemDescription(813, 'Hitch, 2 in.')).toEqual({ success: false, error: 'Item 813 is inactive' });
    expect(finishes()).toEqual([
      expect.objectContaining({ action: 'change', record_type: 'item', record_id: '812', outcome: 'took', http_status: 200 }),
      expect.objectContaining({ action: 'change', record_type: 'item', record_id: '813', outcome: 'refused', error: 'Item 813 is inactive' }),
    ]);
  });

  it('keeps a drop ship PO the item script made from a sales order, with its number', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, purchaseOrderId: 6201, tranId: 'PO1490' }));
    expect(await createDropShipPoViaRestlet({ salesOrderId: '4521', vendorId: '4001' }))
      .toEqual({ success: true, purchaseOrderId: '6201', tranId: 'PO1490' });
    expect(finishes()).toEqual([expect.objectContaining({
      action: 'transform', record_type: 'salesOrder', record_id: '4521', made_type: 'purchaseOrder', made_id: '6201',
      doc_ref: 'PO1490', outcome: 'took',
    })]);
  });

  it("keeps none of the reads: the item script's ping and the money script", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ version: '2026-10-23.1' }))
      .mockResolvedValueOnce(json({ success: true, rows: [] }));
    expect(await pingRestlet('item', ITEM_SCRIPT)).toEqual({ reachable: true, version: '2026-10-23.1' });
    expect(await getIncomeStatementFromRestlet('2026-10-01', '2026-10-31')).toEqual({ success: true, rows: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kept).toEqual([]);
  });
});

describe('files that sign their own NetSuite requests', () => {
  const repoRoot = join(__dirname, '..', '..');
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
  const signers = sources(join(repoRoot, 'src'))
    .map((file) => ({ file: relative(repoRoot, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /from 'oauth-1\.0a'|suitetalk\.api\.netsuite\.com/.test(text));

  it('are found', () => {
    expect(signers.map((s) => s.file)).toEqual(expect.arrayContaining([
      'src/lib/netsuite.ts',
      'src/app/api/estimates/push/route.ts',
      'src/app/api/netsuite/fix-invoice-po/route.ts',
      'src/app/api/netsuite/customers/route.ts',
    ]));
  });

  it('send through the feed, never fetch', () => {
    const bare = signers.filter(({ text }) => /(?<![\w.$])fetch\s*\(/.test(text)).map((s) => s.file);
    expect(bare, 'call netsuiteFetch (src/lib/netsuite-sends.ts) so the send is kept on Books → NetSuite feed').toEqual([]);
    const unwired = signers.filter(({ text }) => !/\bnetsuiteFetch\(/.test(text)).map((s) => s.file);
    expect(unwired).toEqual([]);
  });
});
