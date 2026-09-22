import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sync reaches the importer's follow-up phases, and importer.ts pulls in
// notify.ts, which builds a Supabase client at module scope with no URL in a
// test environment. The daily sync never notifies anyone itself.
vi.mock('@/lib/notify', () => ({ notifyMany: async () => {} }));

import * as systemHealth from '@/lib/system-health';
import * as storage from '@/lib/ledger/storage';
import * as clientModule from './client';
import * as tokens from './tokens';
import { LEDGER_QBO_SYNC, SYNC_SOFT_BUDGET_MS, runLedgerQboSync } from './sync';
import { makeFakeService, writesTo, type FakeService } from './test-fake-service';

const ORIGINAL = { ...process.env };
let heartbeat: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.QBO_ENVIRONMENT = 'production';
  heartbeat = vi.fn().mockResolvedValue({ ok: true });
  vi.spyOn(systemHealth, 'recordHeartbeat').mockImplementation(heartbeat as any);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const opts = () => ({ startedAt: Date.now(), deadline: Date.now() + 150_000 });

const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 1, realm_id: '4620816365208163', environment: 'production',
  access_token: 'access-1', access_expires_at: iso(3_600_000),
  refresh_token: 'refresh-1', refresh_expires_at: iso(100 * 86_400_000),
  needs_reauth_at: null, refresh_lease_until: null, capabilities: {}, minor_version: '73',
  ...over,
});

const completedImport = (startedAt: string) => ({
  id: 'bulk-1', source: 'quickbooks', mode: 'import', status: 'complete',
  started_at: startedAt, config: { phases: ['connect', 'transactions', 'finalize'] },
});

/** A client whose every method is inert, so a test can assert the WINDOW. */
function stubClient(over: Partial<clientModule.QboClient> = {}) {
  const client = {
    fetch: vi.fn(),
    query: vi.fn(),
    page: vi.fn().mockResolvedValue({ items: [], orderBy: 'MetaData.LastUpdatedTime' }),
    count: vi.fn().mockResolvedValue(0),
    latestTxnDate: vi.fn().mockResolvedValue({ date: null, supported: false }),
    cdc: vi.fn().mockResolvedValue({ ok: true, changes: {} }),
    pdf: vi.fn(),
    attachables: vi.fn().mockResolvedValue([]),
    download: vi.fn(),
    report: vi.fn(),
    companyInfo: vi.fn(),
    stats: () => ({ calls: 0, throttled: 0, slowestMs: 0 }),
    ...over,
  } as unknown as clientModule.QboClient;
  vi.spyOn(clientModule, 'createQboClient').mockReturnValue(client);
  return client;
}

const lastHeartbeat = () => heartbeat.mock.calls.at(-1)!;

describe('the skip guards', () => {
  it('no connection at all is a GREEN skip', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [] });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(result).toMatchObject({ status: 'skipped' });
    expect(lastHeartbeat()[2]).toEqual({ skipped: 'QuickBooks not connected' });
  });

  it('needs_reauth_at is RED on purpose — nobody but a human can fix it', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ needs_reauth_at: iso(-1000) })] });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(result.status).toBe('error');
    expect(lastHeartbeat()[2]).toEqual({ error: 'QuickBooks needs reconnecting — Settings → Company' });
  });

  it('no completed bulk import is a green skip that still reports the refresh', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow()], ledger_import_runs: [] });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(result.payload).toMatchObject({ skipped: 'bulk import not complete — nothing to keep current yet' });
    expect(result.payload).toHaveProperty('refreshAhead');
  });

  it('an import that skipped the transactions phase does not count as complete', async () => {
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [{ id: 'r', source: 'quickbooks', mode: 'import', status: 'complete', started_at: iso(-86_400_000), config: { phases: ['pdfs'] } }],
    });
    expect((await runLedgerQboSync(svc as any, opts())).status).toBe('skipped');
  });

  it('EVERY skip passes touchLastSyncedAt:false', async () => {
    // recordHeartbeat writes last_synced_at = now unless told otherwise, and
    // a skip that stamped it would make the CDC watermark look fresh on
    // exactly the days nothing was synced.
    for (const svc of [
      makeFakeService({ quickbooks_tokens: [] }),
      makeFakeService({ quickbooks_tokens: [tokenRow({ needs_reauth_at: iso(-1) })] }),
      makeFakeService({ quickbooks_tokens: [tokenRow()], ledger_import_runs: [] }),
    ]) {
      heartbeat.mockClear();
      await runLedgerQboSync(svc as any, opts());
      expect(lastHeartbeat()[3]).toMatchObject({ touchLastSyncedAt: false });
      expect(lastHeartbeat()[3]).not.toHaveProperty('lastSyncedAt');
    }
  });
});

describe('refresh-ahead', () => {
  it('runs BEFORE the import guard, so the token is renewed from day one', async () => {
    // The 100-day idle expiry must never approach during a slow rollout.
    const refresh = vi.spyOn(tokens, 'getAccessToken').mockResolvedValue({ token: 't', conn: {} as any });
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(3_600_000) })], ledger_import_runs: [] });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(refresh).toHaveBeenCalled();
    expect(result.payload.refreshAhead).toBe('ok');
    expect(result.status).toBe('skipped');
  });

  it('a busy or failed refresh is reported as a problem but stays GREEN', async () => {
    vi.spyOn(tokens, 'getAccessToken').mockRejectedValue(new Error(tokens.QBO_REFRESH_BUSY));
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(1000) })], ledger_import_runs: [] });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(result.status).toBe('skipped');
    expect(result.payload.refreshAhead).toMatchObject({ problem: 'another refresh was in flight' });
  });

  it('an invalid_grant during refresh-ahead is the red reconnect heartbeat', async () => {
    vi.spyOn(tokens, 'getAccessToken').mockRejectedValue(new Error(tokens.QBO_NOT_CONNECTED));
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(1000) })], ledger_import_runs: [] });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(result.status).toBe('error');
    expect(result.payload).toEqual({ error: 'QuickBooks needs reconnecting — Settings → Company' });
  });
});

describe('the CDC window', () => {
  function realRun(over: { state?: any; capabilities?: any; importStartedAt?: string } = {}): FakeService {
    return makeFakeService({
      quickbooks_tokens: [tokenRow({ capabilities: over.capabilities ?? {} })],
      ledger_import_runs: [completedImport(over.importStartedAt ?? new Date(Date.now() - 10 * 86_400_000).toISOString())],
      sync_state: over.state ? [over.state] : [],
    });
  }

  it('the FIRST real run derives since from the bulk import started_at − 1 day', async () => {
    // last_result.cdcThrough is absent, and last_synced_at is undecidable:
    // it lands at the column DEFAULT '2020-01-01' on the first INSERT.
    const importStartedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const client = stubClient();
    const svc = realRun({ importStartedAt });
    await runLedgerQboSync(svc as any, opts());
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'cdc')!;
    expect(run.config.since).toBe(new Date(Date.parse(importStartedAt) - 86_400_000).toISOString());
    // Inside the 30-day look-back, so this one takes the cheap CDC path.
    expect(client.cdc).toHaveBeenCalled();
  });

  it('the first-run branch STILL fires after weeks of skip heartbeats', async () => {
    // Skip runs write last_result but no cdcThrough, and (because of
    // touchLastSyncedAt:false) never move last_synced_at either — so the
    // branch must key on cdcThrough alone.
    const importStartedAt = new Date(Date.now() - 400 * 86_400_000).toISOString();
    stubClient();
    const svc = realRun({
      importStartedAt,
      state: {
        sync_type: 'ledger_qbo_sync',
        last_result: { skipped: 'bulk import not complete — nothing to keep current yet' },
        last_synced_at: '2020-01-01T00:00:00.000Z',
        updated_at: new Date().toISOString(),
      },
    });
    await runLedgerQboSync(svc as any, opts());
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'cdc')!;
    expect(run.config.since).toBe(new Date(Date.parse(importStartedAt) - 86_400_000).toISOString());
  });

  it('a LATER run derives since from cdcThrough − 1 day', async () => {
    stubClient();
    const svc = realRun({
      state: {
        sync_type: 'ledger_qbo_sync',
        last_result: { cdcThrough: '2026-09-10T09:57:00.000Z' },
        last_synced_at: '2026-09-10T09:57:00.000Z',
        updated_at: '2026-09-10T09:57:30.000Z',
      },
    });
    await runLedgerQboSync(svc as any, opts());
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'cdc')!;
    expect(run.config.since).toBe('2026-09-09T09:57:00.000Z');
  });

  it('a DRAINED run advances the watermark to the instant it opened the window', async () => {
    stubClient();
    const svc = realRun();
    const result = await runLedgerQboSync(svc as any, opts());
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'cdc')!;
    expect(result.payload.cdcThrough).toBe(run.config.windowStartedAt);
    expect(lastHeartbeat()[3]).toMatchObject({ lastSyncedAt: run.config.windowStartedAt });
  });

  it('a PARTIAL run carries the PREVIOUS cdcThrough forward unchanged', async () => {
    // last_result is replaced wholesale, so carrying it forward is what keeps
    // the watermark alive at all — and a half-swept window must not advance.
    stubClient({
      cdc: vi.fn().mockImplementation(async () => {
        // Burn the budget so the loop stops after the first group.
        vi.setSystemTime(new Date(Date.now() + 200_000));
        return { ok: true, changes: {} };
      }),
    } as any);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const svc = realRun({
      state: {
        sync_type: 'ledger_qbo_sync',
        last_result: { cdcThrough: '2026-09-10T09:57:00.000Z' },
        last_synced_at: '2026-09-10T09:57:00.000Z',
        updated_at: '2026-09-10T09:57:30.000Z',
      },
    });
    const result = await runLedgerQboSync(svc as any, { startedAt: Date.now(), deadline: Date.now() + 150_000 });
    vi.useRealTimers();
    expect(result.payload.partial).toBe(true);
    expect(result.payload.cdcThrough).toBe('2026-09-10T09:57:00.000Z');
    expect(lastHeartbeat()[3]).toMatchObject({ touchLastSyncedAt: false });
    expect(lastHeartbeat()[3]).not.toHaveProperty('lastSyncedAt');
  });

  it('a gap over 30 days takes the paged path with ORDERBY MetaData.LastUpdatedTime forced', async () => {
    const page = vi.fn().mockResolvedValue({ items: [], orderBy: 'MetaData.LastUpdatedTime' });
    const client = stubClient({ page } as any);
    const svc = realRun({ importStartedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() });
    await runLedgerQboSync(svc as any, opts());
    expect(client.cdc).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalled();
    expect(String(page.mock.calls[0][1])).toMatch(/^MetaData\.LastUpdatedTime > '/);
  });

  it('a company that rejected CDC before goes straight to the paged path', async () => {
    const page = vi.fn().mockResolvedValue({ items: [], orderBy: 'MetaData.LastUpdatedTime' });
    const client = stubClient({ page } as any);
    const svc = realRun({ capabilities: { cdc: false } });
    await runLedgerQboSync(svc as any, opts());
    expect(client.cdc).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalled();
  });

  it('the paged walk FORCES ORDERBY MetaData.LastUpdatedTime, not the Id probe', async () => {
    // The [H] clause, and also the column being filtered, so paging stays
    // stable while rows keep changing underneath. `page()`'s default would
    // emit ORDERBY Id and settle the `orderById` capability instead.
    const page = vi.fn().mockResolvedValue({ items: [], orderBy: 'MetaData.LastUpdatedTime' });
    stubClient({ page } as any);
    const svc = realRun({ capabilities: { cdc: false } });
    await runLedgerQboSync(svc as any, opts());
    expect(page.mock.calls[0][4]).toEqual({ order: 'MetaData.LastUpdatedTime' });
  });

  it('CDC REFUSED and the deadline already gone → partial, cdcThrough unchanged', async () => {
    // The run that records capabilities.cdc = false is exactly the run whose
    // paged fallback has 17 entities and a 30-day window to walk in 150 s.
    // Throwing away the fallback's stop marker would report the window swept
    // and jump the watermark to now.
    const page = vi.fn().mockResolvedValue({ items: [], orderBy: 'MetaData.LastUpdatedTime' });
    stubClient({
      cdc: vi.fn().mockImplementation(async () => {
        // Refused, and the budget is gone by the time the fallback starts.
        vi.setSystemTime(new Date(Date.now() + 200_000));
        return { ok: false, unsupported: true, reason: 'CDC not enabled' };
      }),
      page,
    } as any);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const svc = realRun({
      state: {
        sync_type: 'ledger_qbo_sync',
        last_result: { cdcThrough: '2026-09-10T09:57:00.000Z' },
        last_synced_at: '2026-09-10T09:57:00.000Z',
        updated_at: '2026-09-10T09:57:30.000Z',
      },
    });
    const result = await runLedgerQboSync(svc as any, { startedAt: Date.now(), deadline: Date.now() + 150_000 });
    vi.useRealTimers();

    expect(page).not.toHaveBeenCalled();
    expect(result.payload.partial).toBe(true);
    expect(result.payload.cdcThrough).toBe('2026-09-10T09:57:00.000Z');
    expect(result.payload.resume).toMatchObject({ entity: 'Invoice', startPosition: 1 });
    expect(lastHeartbeat()[3]).toMatchObject({ touchLastSyncedAt: false });
    expect(lastHeartbeat()[3]).not.toHaveProperty('lastSyncedAt');
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'cdc')!;
    expect(run.status).toBe('running');
  });
});

describe('applying changes', () => {
  it('a Deleted stub becomes a TOMBSTONE, never a physical delete', async () => {
    stubClient({
      cdc: vi.fn().mockResolvedValue({ ok: true, changes: { Invoice: { items: [], deleted: ['101'] } } }),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
      ledger_invoices: [{ id: 'inv-1', source: 'quickbooks', external_id: 'Invoice/101', deleted_at: null }],
    });
    await runLedgerQboSync(svc as any, opts());
    expect(svc.tables.ledger_invoices).toHaveLength(1);
    expect(svc.tables.ledger_invoices[0].deleted_at).toBeTruthy();
  });

  it('a changed document sends its stored PDF back to pending', async () => {
    // A stored PDF of an edited invoice is the OLD version.
    stubClient({
      cdc: vi.fn().mockResolvedValue({
        ok: true,
        changes: { Invoice: { items: [{ Id: '101', TxnDate: '2020-01-01', TotalAmt: 10, SyncToken: '5' }], deleted: [] } },
      }),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
      ledger_documents: [{
        id: 'doc-1', source: 'quickbooks', kind: 'pdf', entity_external_id: 'Invoice/101',
        status: 'stored', storage_path: 'quickbooks/Invoice/101/Invoice_1042.pdf',
        sha256: 'digest-of-the-old-render', size_bytes: 1234,
        fetched_at: '2020-01-01T00:00:00.000Z',
      }],
    });
    await runLedgerQboSync(svc as any, opts());
    const doc = svc.tables.ledger_documents[0];
    expect(doc.status).toBe('pending');
    expect(doc.storage_path).toBeNull();
    // The digest and size described the OLD render — a row that points at
    // nothing must not still claim to know what is in it.
    expect(doc.sha256).toBeNull();
    expect(doc.size_bytes).toBeNull();
    // `fetched_at` is KEPT on purpose: it is how the pdfs phase knows this is
    // a re-fetch and must REPLACE the R2 object rather than let
    // putLedgerObject's existence short-circuit leave the pre-edit bytes
    // under the same key (importer.test.ts pins the other half).
    expect(doc.fetched_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('a customer RENAMED in QuickBooks goes back to the review queue', async () => {
    // §2.5 step 4: the grade was made on the name. A `manual` decision is a
    // human's answer and is never reset.
    stubClient({
      cdc: vi.fn().mockResolvedValue({
        ok: true,
        changes: {
          Customer: {
            items: [
              { Id: '7', DisplayName: 'Broadway Ford of Chicago', SyncToken: '4' },
              { Id: '8', DisplayName: 'Renamed By Hand', SyncToken: '2' },
            ],
            deleted: [],
          },
        },
      }),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
      ledger_customers: [
        {
          id: 'lc-1', source: 'quickbooks', external_id: 'Customer/7', display_name: 'Broadway Ford',
          match_status: 'cleaned', customer_id: 'cust-1', customer_netsuite_id: '900', matched_at: iso(-1000),
        },
        {
          id: 'lc-2', source: 'quickbooks', external_id: 'Customer/8', display_name: 'Something Else',
          match_status: 'manual', customer_id: 'cust-2', customer_netsuite_id: '901', matched_at: iso(-1000),
        },
      ],
    });
    await runLedgerQboSync(svc as any, opts());

    const renamed = svc.tables.ledger_customers.find(c => c.id === 'lc-1')!;
    expect(renamed.match_status).toBe('pending');
    expect(renamed.customer_id).toBeNull();
    expect(renamed.match_reason).toBe('display name changed at source');
    const byHand = svc.tables.ledger_customers.find(c => c.id === 'lc-2')!;
    expect(byHand.match_status).toBe('manual');
    expect(byHand.customer_id).toBe('cust-2');
  });
});

describe('an EDITED document, not just its header', () => {
  const editedInvoice = {
    Id: '101', DocNumber: '1042', TxnDate: '2020-01-01', TotalAmt: 400, Balance: 400,
    SyncToken: '5', MetaData: { LastUpdatedTime: '2020-02-01T00:00:00Z' },
    CustomerRef: { value: '7', name: 'Broadway Ford' },
    Line: [
      { Id: '1', Amount: 250, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '5' } } },
      { Id: '2', Amount: 150, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '6' } } },
    ],
  };

  function editedRun() {
    stubClient({
      cdc: vi.fn().mockResolvedValue({ ok: true, changes: { Invoice: { items: [editedInvoice], deleted: [] } } }),
    } as any);
    return makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
      ledger_invoices: [{
        id: 'inv-1', source: 'quickbooks', external_id: 'Invoice/101', external_ref: '101',
        total: 500, lines_synced_at: '2020-01-02T00:00:00.000Z',
      }],
      // The three stale lines that summed to the OLD total.
      ledger_invoice_lines: [
        { id: 'l-1', document_id: 'inv-1', line_external_id: '1', amount: 200 },
        { id: 'l-2', document_id: 'inv-1', line_external_id: '2', amount: 200 },
        { id: 'l-3', document_id: 'inv-1', line_external_id: '3', amount: 100 },
      ],
    });
  }

  it('replaces the stored LINES so they cannot contradict the header total', async () => {
    const svc = editedRun();
    await runLedgerQboSync(svc as any, opts());

    expect(svc.tables.ledger_invoices[0].total).toBe(400);
    const lines = svc.tables.ledger_invoice_lines;
    expect(lines).toHaveLength(2);
    expect(lines.reduce((sum, l) => sum + Number(l.amount), 0)).toBe(400);
    expect(lines.map(l => l.line_external_id).sort()).toEqual(['1', '2']);
  });

  it('re-stamps lines_synced_at, so `repair` is a safety net and not the only hope', async () => {
    const svc = editedRun();
    const before = svc.tables.ledger_invoices[0].lines_synced_at;
    await runLedgerQboSync(svc as any, opts());
    expect(svc.tables.ledger_invoices[0].lines_synced_at).not.toBe(before);
  });

  it('writes a Payment\u2019s APPLICATIONS, not just the payment header', async () => {
    stubClient({
      cdc: vi.fn().mockResolvedValue({
        ok: true,
        changes: {
          Payment: {
            items: [{
              Id: '9', TxnDate: '2020-03-03', TotalAmt: 400, SyncToken: '2',
              CustomerRef: { value: '7' },
              Line: [{ Amount: 400, LinkedTxn: [{ TxnId: '101', TxnType: 'Invoice' }] }],
            }],
            deleted: [],
          },
        },
      }),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
    });
    await runLedgerQboSync(svc as any, opts());
    expect(svc.tables.ledger_payments).toHaveLength(1);
    expect(svc.tables.ledger_payment_applications).toHaveLength(1);
    expect(svc.tables.ledger_payment_applications[0].applied_external_id).toBe('Invoice/101');
    expect(svc.tables.ledger_payments[0].applications_synced_at).toBeTruthy();
  });

  it('a CDC page raises the same dropped_field event an import page does', async () => {
    // The sweep gets the exception feed too — it is the same machinery.
    // Entity-aware: `cdc` is called once per group of 5, so a blanket mock
    // would apply the same page four times and count four events.
    stubClient({
      cdc: vi.fn(async (entities: string[]) => ({
        ok: true,
        changes: entities.includes('Customer')
          ? {
            Customer: {
              items: [{ Id: '7', DisplayName: 'Broadway Ford', SyncToken: '2', PrimaryTaxIdentifier: '99-1234567' }],
              deleted: [],
            },
          }
          : {},
      })),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
    });
    await runLedgerQboSync(svc as any, opts());
    const dropped = svc.tables.ledger_import_events.filter(e => e.outcome === 'dropped_field');
    expect(dropped).toHaveLength(1);
    expect(JSON.stringify(svc.tables.ledger_customers)).not.toMatch(/PrimaryTaxIdentifier/);
  });
});

describe('the follow-up phases', () => {
  it('fetches the PDF the sweep just re-queued, once the window has drained', async () => {
    // Without this the re-queued PDF would sit `pending` until somebody
    // remembered to run --phases pdfs by hand.
    process.env.LEDGER_PDFS_ENABLED = 'true';
    vi.spyOn(storage, 'putLedgerObject').mockResolvedValue({ ok: true, key: 'ledger/x', sha256: 'abc', size: 4, existed: false });
    const client = stubClient({
      cdc: vi.fn().mockResolvedValue({
        ok: true,
        changes: { Invoice: { items: [{ Id: '101', TxnDate: '2020-01-01', TotalAmt: 10, SyncToken: '5' }], deleted: [] } },
      }),
      pdf: vi.fn().mockResolvedValue({ ok: true, bytes: Buffer.from('%PDF') }),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
      ledger_documents: [{
        id: 'doc-1', source: 'quickbooks', kind: 'pdf', entity_type: 'Invoice', entity_external_id: 'Invoice/101',
        external_ref: '101', file_name: 'Invoice_1042.pdf', status: 'stored', attempts: 0,
        storage_path: 'quickbooks/Invoice/101/Invoice_1042.pdf', first_seen_at: iso(-10_000),
      }],
    });
    const result = await runLedgerQboSync(svc as any, opts());

    expect(client.pdf).toHaveBeenCalledWith('invoice', '101');
    expect(svc.tables.ledger_documents[0].status).toBe('stored');
    expect(svc.tables.ledger_documents[0].sha256).toBe('abc');
    expect(result.payload.followUp).toMatchObject({ partial: false });
  });

  it('a PARTIAL sweep leaves the follow-up for tomorrow — the window comes first', async () => {
    stubClient({
      cdc: vi.fn().mockResolvedValue({ ok: true, changes: {} }),
      pdf: vi.fn(),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
    });
    // A deadline already gone: the sweep answers partial and nothing else runs.
    const result = await runLedgerQboSync(svc as any, { startedAt: Date.now(), deadline: Date.now() - 1 });
    expect(result.payload.partial).toBe(true);
    expect(result.payload).not.toHaveProperty('followUp');
  });
});

describe('failure', () => {
  it('a page-level QboApiError fails the run and the heartbeat', async () => {
    stubClient({
      cdc: vi.fn().mockRejectedValue(new clientModule.QboApiError('Invalid query', { status: 400, code: '4000' })),
    } as any);
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
    });
    const result = await runLedgerQboSync(svc as any, opts());
    expect(result.status).toBe('error');
    expect(String(result.payload.error)).toContain('Invalid query (4000)');
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'cdc')!;
    expect(run.status).toBe('failed');
    expect(lastHeartbeat()[3]).toMatchObject({ touchLastSyncedAt: false });
  });
});

describe('per-page cursors', () => {
  it('writes the pointer through sync_state, never a heartbeat per page', async () => {
    stubClient();
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow()],
      ledger_import_runs: [completedImport(new Date(Date.now() - 86_400_000).toISOString())],
    });
    await runLedgerQboSync(svc as any, opts());
    // Every sync_state write here is the plain cursor upsert; the ONE
    // heartbeat is mocked out and counted separately.
    expect(writesTo(svc, 'sync_state').length).toBeGreaterThan(0);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(writesTo(svc, 'cron_runs')).toEqual([]);
  });
});

describe('the job is registered where System Health looks', () => {
  it('LEDGER_QBO_SYNC matches its HEALTH_MONITORS entry, daily', () => {
    // Two spellings would mean the board watches a sync_type nothing writes,
    // and the job reports "never" forever.
    const monitor = systemHealth.HEALTH_MONITORS.find(m => m.syncType === LEDGER_QBO_SYNC);
    expect(monitor).toBeDefined();
    expect(monitor!.intervalMinutes).toBe(1440);
    expect(monitor!.label).toBe('QuickBooks ledger daily change sync');
  });

  it('the soft budget leaves the 09:57 run clear of 10:00', () => {
    // 150 s from 09:57 ends by 09:59:30 — before the hour and before
    // calendar-pull at 10:02.
    expect(SYNC_SOFT_BUDGET_MS).toBe(150_000);
    expect(57 * 60 + SYNC_SOFT_BUDGET_MS / 1000).toBeLessThan(60 * 60);
  });
});
