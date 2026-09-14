import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// notify.ts builds a Supabase client at module scope, which has no URL in a
// test environment — and these tests care about WHO was notified, not how.
const notifyManyMock = vi.fn(async (_ids: string[], _payload: any) => {});
vi.mock('@/lib/notify', () => ({
  notifyMany: (ids: string[], payload: any) => notifyManyMock(ids, payload),
}));

// A tiny in-memory R2 so the REAL putLedgerObject runs end to end: the
// re-fetch test below is about which bytes end up under a key, which a
// stubbed putLedgerObject cannot answer.
const r2Objects = new Map<string, Buffer>();
vi.mock('@/lib/r2', () => ({
  r2Head: async (prefix: string, path: string) => r2Objects.has(`${prefix}/${path}`),
  r2Upload: async (prefix: string, path: string, body: Buffer) => {
    r2Objects.set(`${prefix}/${path}`, Buffer.from(body));
    return { success: true, key: `${prefix}/${path}`, publicUrl: `https://public/${prefix}/${path}` };
  },
  r2GetBytes: async (prefix: string, path: string) => {
    const bytes = r2Objects.get(`${prefix}/${path}`);
    return bytes ? { bytes, contentType: 'application/pdf' } : null;
  },
}));

import * as clientModule from './client';
import * as systemHealth from '@/lib/system-health';
import * as storage from '@/lib/ledger/storage';
import {
  GATE_FREE_PHASES,
  TRANSACTION_ENTITIES,
  claimLease,
  confirmCutover,
  markReportViewed,
  runImportChunk,
  startDryRun,
  startImport,
} from './importer';
import { makeFakeService, writesTo, type FakeService } from './test-fake-service';

const ORIGINAL = { ...process.env };
const REALM = '4620816365208163';
const MASKED = '…8163';

beforeEach(() => {
  process.env.QBO_ENVIRONMENT = 'production';
  delete process.env.LEDGER_PDFS_ENABLED;
  notifyManyMock.mockClear();
  r2Objects.clear();
  vi.spyOn(systemHealth, 'recordHeartbeat').mockResolvedValue({ ok: true });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const tokenRow = () => ({
  id: 1, realm_id: REALM, environment: 'production', company_name: 'BMG Fleet',
  access_token: 'access-1', access_expires_at: iso(3_600_000),
  refresh_token: 'refresh-1', refresh_expires_at: iso(100 * 86_400_000),
  needs_reauth_at: null, refresh_lease_until: null, capabilities: {}, minor_version: '73',
});

function stubClient(over: Record<string, any> = {}): any {
  const client = {
    fetch: vi.fn(),
    query: vi.fn(),
    page: vi.fn().mockResolvedValue({ items: [], orderBy: 'Id' }),
    count: vi.fn().mockResolvedValue(0),
    latestTxnDate: vi.fn().mockResolvedValue({ date: null, supported: false }),
    cdc: vi.fn(),
    pdf: vi.fn(),
    attachables: vi.fn().mockResolvedValue([]),
    download: vi.fn(),
    report: vi.fn(),
    companyInfo: vi.fn().mockResolvedValue({ companyName: 'BMG Fleet', probe: 'ok' }),
    stats: () => ({ calls: 3, throttled: 0, slowestMs: 100 }),
    ...over,
  };
  vi.spyOn(clientModule, 'createQboClient').mockReturnValue(client as any);
  return client;
}

function base(extra: Record<string, any[]> = {}): FakeService {
  return makeFakeService({ quickbooks_tokens: [tokenRow()], ...extra });
}

const importRun = (over: Record<string, unknown> = {}) => ({
  id: 'run-1', source: 'quickbooks', mode: 'import', status: 'running',
  realm_id: MASKED, started_by: 'user-1', started_at: iso(-1000),
  phase: 'transactions', cursor: { phase: 'transactions' },
  config: { environment: 'production', phases: ['transactions'], cutoverDate: null },
  counts: {}, api_calls: 0, invocations: 0, lease_until: null,
  ...over,
});

const invoice = (id: string, over: Record<string, unknown> = {}) => ({
  Id: id, DocNumber: `10${id}`, TxnDate: '2019-06-01', TotalAmt: 100, Balance: 0,
  CustomerRef: { value: '7', name: 'Broadway Ford' }, SyncToken: '1',
  MetaData: { LastUpdatedTime: '2019-06-02T00:00:00Z' },
  Line: [{ Id: '1', Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '5' } } }],
  ...over,
});

describe('the dry-run gate (owner requirement 7)', () => {
  it('refuses an import with no dryRunId', async () => {
    const svc = base();
    const result = await startImport(svc as any, { startedBy: 'u' });
    expect(result).toMatchObject({ ok: false, status: 412, needsDryRun: true });
  });

  it('refuses a dry run that never FINISHED, even with the report marked read', async () => {
    // `finished_at` null is the tell that the dry run stopped at its deadline
    // partway through the Customer walk: its report covers a fraction of the
    // customers, and the `confirmedAt > finished_at` comparison below cannot
    // be satisfied by a null. The page hides this (its button wants
    // `complete`); the script and the route come straight through here.
    const svc = base({
      ledger_import_runs: [{
        id: 'dry-1', mode: 'dry_run', status: 'running', realm_id: MASKED,
        config: { environment: 'production' }, report_viewed_at: iso(-1000), finished_at: null,
      }],
      app_settings: [{ key: 'ledger', value: { cutover: { date: '2021-04-01', confirmedAt: iso(-100), confirmedBy: null, dryRunId: 'dry-1' } } }],
    });
    const result = await startImport(svc as any, { startedBy: 'u', dryRunId: 'dry-1' });
    expect(result).toMatchObject({ ok: false, status: 412, needsDryRun: true });
    expect((result as any).error).toMatch(/has not finished/);
    expect(svc.tables.ledger_import_runs.some(r => r.mode === 'import')).toBe(false);
  });

  it('markReportViewed refuses a run that is not a COMPLETED dry run', async () => {
    const svc = base({
      ledger_import_runs: [
        { id: 'dry-1', mode: 'dry_run', status: 'running', realm_id: MASKED, config: {} },
        { id: 'imp-1', mode: 'import', status: 'complete', realm_id: MASKED, config: {} },
      ],
    });
    expect(await markReportViewed(svc as any, 'dry-1', 'u')).toMatchObject({ ok: false });
    expect(await markReportViewed(svc as any, 'imp-1', 'u')).toMatchObject({ ok: false });
    expect(await markReportViewed(svc as any, '00000000-0000-4000-8000-000000000000', 'u'))
      .toMatchObject({ ok: false, error: expect.stringContaining('unknown_dry_run') });
    // Nothing was stamped on any of them.
    expect(svc.tables.ledger_import_runs.every(r => !r.report_viewed_at)).toBe(true);
  });

  it('refuses a dry run whose report has not been marked read', async () => {
    const svc = base({
      ledger_import_runs: [{ id: 'dry-1', mode: 'dry_run', status: 'complete', realm_id: MASKED, config: { environment: 'production' }, report_viewed_at: null, finished_at: iso(-5000) }],
    });
    const result = await startImport(svc as any, { startedBy: 'u', dryRunId: 'dry-1' });
    expect(result).toMatchObject({ ok: false, status: 412 });
    expect((result as any).error).toMatch(/not been marked as read/);
  });

  it('refuses a dry run taken against a DIFFERENT masked realm', async () => {
    const svc = base({
      ledger_import_runs: [{ id: 'dry-1', mode: 'dry_run', status: 'complete', realm_id: '…9999', config: { environment: 'production' }, report_viewed_at: iso(-4000), finished_at: iso(-5000) }],
      app_settings: [{ key: 'ledger', value: { cutover: { date: '2021-04-01', confirmedAt: iso(-1000), confirmedBy: null, dryRunId: 'dry-1' } } }],
    });
    const result = await startImport(svc as any, { startedBy: 'u', dryRunId: 'dry-1' });
    expect((result as any).error).toMatch(/different QuickBooks company/);
  });

  it('refuses when the cutover was confirmed BEFORE the dry run finished', async () => {
    const svc = base({
      ledger_import_runs: [{ id: 'dry-1', mode: 'dry_run', status: 'complete', realm_id: MASKED, config: { environment: 'production' }, report_viewed_at: iso(-1000), finished_at: iso(-1000) }],
      app_settings: [{ key: 'ledger', value: { cutover: { date: '2021-04-01', confirmedAt: iso(-50_000), confirmedBy: null, dryRunId: 'dry-1' } } }],
    });
    const result = await startImport(svc as any, { startedBy: 'u', dryRunId: 'dry-1' });
    expect((result as any).error).toMatch(/confirmed before this dry run finished/);
  });

  it('accepts a read dry run with a later cutover confirmation', async () => {
    const svc = base({
      ledger_import_runs: [{ id: 'dry-1', mode: 'dry_run', status: 'complete', realm_id: MASKED, config: { environment: 'production' }, report_viewed_at: iso(-4000), finished_at: iso(-5000) }],
      app_settings: [{ key: 'ledger', value: { cutover: { date: '2021-04-01', confirmedAt: iso(-1000), confirmedBy: null, dryRunId: 'dry-1' } } }],
    });
    const result = await startImport(svc as any, { startedBy: 'u', dryRunId: 'dry-1' });
    expect(result.ok).toBe(true);
    const run = svc.tables.ledger_import_runs.find(r => r.mode === 'import')!;
    expect(run.config.cutoverDate).toBe('2021-04-01');
    expect(writesTo(svc, 'audit_log')[0].rows[0].action).toBe('ledger_import_started');
  });

  it('phases:[reports] with no dryRunId is REFUSED — it writes financial rows', async () => {
    const svc = base();
    const result = await startImport(svc as any, { startedBy: 'u', phases: ['reports'] });
    expect(result).toMatchObject({ ok: false, status: 412 });
  });

  it('the gate-free set passes with no dry run at all', async () => {
    expect(GATE_FREE_PHASES).toEqual(['pdfs', 'attachments_fetch', 'repair']);
    const svc = base();
    const result = await startImport(svc as any, { startedBy: 'u', phases: ['pdfs', 'attachments_fetch', 'repair'] });
    expect(result.ok).toBe(true);
  });
});

describe('the lease', () => {
  it('a second driver gets no rows and is told to wait', async () => {
    const svc = base({ ledger_import_runs: [importRun()] });
    const first = await claimLease(svc as any, 'run-1', 45_000);
    expect(first.ok).toBe(true);
    const second = await claimLease(svc as any, 'run-1', 45_000);
    expect(second).toMatchObject({ ok: false, retryAfterMs: 5_000 });
  });

  it('a lapsed lease is freely reclaimed — a killed chunk needs no manual unlock', async () => {
    const svc = base({ ledger_import_runs: [importRun({ lease_until: iso(-1_000) })] });
    expect((await claimLease(svc as any, 'run-1', 45_000)).ok).toBe(true);
  });

  it('counts invocations', async () => {
    const svc = base({ ledger_import_runs: [importRun({ invocations: 4 })] });
    await claimLease(svc as any, 'run-1', 45_000);
    expect(svc.tables.ledger_import_runs[0].invocations).toBe(5);
  });
});

describe('the cursor is written BEFORE each fetch', () => {
  it('checkpoints the run row and the sync_state mirror, with updated_at', async () => {
    const order: string[] = [];
    stubClient({
      count: vi.fn().mockImplementation(async () => { order.push('COUNT'); return 1; }),
      page: vi.fn().mockImplementation(async () => { order.push('PAGE'); return { items: [], orderBy: 'Id' }; }),
    });
    const svc = base({ ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })] });
    const realFrom = svc.from;
    (svc as any).from = (table: string) => {
      const q = realFrom(table);
      const update = q.update;
      const upsert = q.upsert;
      q.update = (row: any) => { if (table === 'ledger_import_runs' && row.cursor) order.push('CURSOR'); return update(row); };
      q.upsert = (rows: any) => { if (table === 'sync_state') order.push('POINTER'); return upsert(rows); };
      return q;
    };
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(order.indexOf('CURSOR')).toBeLessThan(order.indexOf('PAGE'));
    expect(order.indexOf('POINTER')).toBeLessThan(order.indexOf('PAGE'));
    const [pointer] = writesTo(svc, 'sync_state');
    expect(pointer.rows[0].sync_type).toBe('ledger_qbo_import');
    expect(pointer.rows[0].updated_at).toBeTruthy();
  });

  it('a DRY RUN writes no sync_state pointer at all', async () => {
    stubClient({ count: vi.fn().mockResolvedValue(0) });
    const svc = base({
      ledger_import_runs: [importRun({ mode: 'dry_run', phase: 'connect', cursor: { phase: 'connect' }, config: { environment: 'production' } })],
      customers: [],
      netsuite_sales_orders: [],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(writesTo(svc, 'sync_state')).toEqual([]);
  });
});

describe('§2.6 — exactly what a dry run writes', () => {
  it('touches ONLY its run row, one audit row and the capabilities merge', async () => {
    stubClient({ count: vi.fn().mockResolvedValue(0), page: vi.fn().mockResolvedValue({ items: [], orderBy: 'Id' }) });
    const svc = base({ customers: [], netsuite_sales_orders: [] });
    const runId = await startDryRun(svc as any, { startedBy: 'user-1' });
    await runImportChunk(svc as any, runId, { deadline: Date.now() + 5_000 });

    const touched = new Set(svc.writes.map(w => w.table));
    expect(touched).toContain('ledger_import_runs');
    expect(touched).toContain('audit_log');
    // NOTHING else in the ledger, and no pointer.
    for (const forbidden of [
      'ledger_invoices', 'ledger_customers', 'ledger_payments', 'ledger_bills',
      'ledger_journal_entries', 'ledger_documents', 'ledger_accounts', 'ledger_entities',
      'ledger_report_snapshots', 'ledger_import_events', 'sync_state',
    ]) {
      expect([...touched], forbidden).not.toContain(forbidden);
    }
    // EXACTLY ONE audit row. `finalize` writes a second (`ledger_import_finished`)
    // for a real import; a dry run is defined as writing nothing but this one.
    expect(writesTo(svc, 'audit_log')).toHaveLength(1);
    expect(writesTo(svc, 'audit_log')[0].rows[0].action).toBe('ledger_dry_run');
    expect(writesTo(svc, 'audit_log')[0].rows[0].detail.realmMasked).toBe(MASKED);
  });

  it('notifies NOBODY, even with a real System Health audience', async () => {
    // The audience fixture is the point: the old test passed only because
    // `profiles` was empty, so systemHealthAudience() returned [] and the
    // push a dry run should never send was invisible.
    stubClient({ count: vi.fn().mockResolvedValue(0), page: vi.fn().mockResolvedValue({ items: [], orderBy: 'Id' }) });
    const svc = base({
      customers: [],
      netsuite_sales_orders: [],
      profiles: [{ id: 'sa-1', approved: true, role: 'admin', roles: ['admin', 'super_admin'] }],
    });
    const runId = await startDryRun(svc as any, { startedBy: 'user-1' });
    await runImportChunk(svc as any, runId, { deadline: Date.now() + 5_000 });
    expect(notifyManyMock).not.toHaveBeenCalled();
  });
});

describe('the 5,000-event cap is PER RUN, not per invocation', () => {
  it('a second chunk on a run that already hit the cap appends nothing', async () => {
    // The bulk import is hundreds of chunks. A `seen: 0` reset each call
    // would let a systematically broken import write 5,000 rows per chunk
    // into a table every finance/executive reader can SELECT.
    const existing = Array.from({ length: 5_000 }, (_, i) => ({
      id: `ev-${i}`, run_id: 'run-1', outcome: 'error', entity_type: 'Invoice',
    }));
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn(async (entity: string) =>
        entity === 'Invoice'
          // A payload with a dropped key raises exactly one `dropped_field`
          // event per page — a real event, on the normal path.
          ? { items: [invoice('101', { PrimaryTaxIdentifier: '99-1234567' })], orderBy: 'Id' }
          : { items: [], orderBy: 'Id' },
      ),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })],
      ledger_import_events: existing,
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(svc.tables.ledger_import_events).toHaveLength(5_000);
  });

  it('…and the SAME chunk on an empty run does append it', async () => {
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn(async (entity: string) =>
        entity === 'Invoice'
          ? { items: [invoice('101', { PrimaryTaxIdentifier: '99-1234567' })], orderBy: 'Id' }
          : { items: [], orderBy: 'Id' },
      ),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })],
      ledger_import_events: [],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    const dropped = svc.tables.ledger_import_events.filter(e => e.outcome === 'dropped_field');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].raw.dropped).toContain('PrimaryTaxIdentifier');
  });
});

describe('a chunk started while QuickBooks is disconnected', () => {
  it('marks the run failed and drops the lease before it rethrows', async () => {
    // The route answers 401 needsAuth. If the run row stayed `running` with
    // the lease claimLease just took, /admin/ledger would show a run going
    // nowhere with a null error for as long as anyone looked at it.
    stubClient();
    const svc = base({
      quickbooks_tokens: [],
      ledger_import_runs: [importRun({ lease_until: iso(60_000) })],
    });
    await expect(runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 })).rejects.toThrow();
    const run = svc.tables.ledger_import_runs[0];
    expect(run.status).toBe('failed');
    expect(run.error).toBe('reconnect QuickBooks — Settings → Company');
    expect(run.lease_until).toBeNull();
  });

  it('a connection that dies MID-chunk answers the same way — failed row, then rethrow', async () => {
    // §2.5's Errors paragraph asks for one shape: 401 { needsAuth: true }.
    // Folding a mid-chunk NO_QBO_TOKEN into `failure` and answering 200
    // status:'failed' gave the same cause two different shapes depending on
    // when the super admin hit Disconnect.
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn().mockRejectedValue(new Error('QBO_NOT_CONNECTED')),
    });
    const svc = base({ ledger_import_runs: [importRun({ lease_until: iso(60_000) })] });
    await expect(runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 }))
      .rejects.toThrow('QBO_NOT_CONNECTED');
    const run = svc.tables.ledger_import_runs[0];
    // Still marked failed, still resumable, cursor intact — only the shape
    // of the answer changed.
    expect(run.status).toBe('failed');
    expect(run.error).toBe('reconnect QuickBooks — Settings → Company');
    expect(run.lease_until).toBeNull();
    expect(run.cursor.phase).toBe('transactions');
  });
});

describe('the chunk response reports capabilities as of the END of the chunk', () => {
  it('re-reads the connection so probes that settled DURING the chunk are in it', async () => {
    // The driver and the page read `capabilities` out of this response. The
    // pre-chunk snapshot is stale by definition: orderById, queryTotalCount
    // and pdf[<Entity>] settle inside the very loop it was taken before.
    const svc = base({ ledger_import_runs: [importRun()] });
    stubClient({
      count: vi.fn(async () => {
        svc.tables.quickbooks_tokens[0].capabilities = { orderById: true, queryTotalCount: true };
        return 0;
      }),
      page: vi.fn().mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(result.capabilities).toMatchObject({ orderById: true, queryTotalCount: true });
  });
});

describe('the dry run\u2019s COUNT(*) walk', () => {
  it('resumes at the deadline instead of presenting a short count map as complete', async () => {
    // The counts are the gate the owner approves (owner item 7): a missing
    // key simply does not render, and plan.estimatedApiCalls is derived from
    // this map. Breaking out and returning true would mark the phase done.
    let calls = 0;
    let deadlinePassed = false;
    stubClient({
      // Two counts land, then the clock runs out.
      count: vi.fn(async () => { calls += 1; if (calls >= 2) deadlinePassed = true; return 7; }),
      page: vi.fn().mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({ customers: [], netsuite_sales_orders: [] });
    const runId = await startDryRun(svc as any, { startedBy: 'user-1' });

    const realNow = Date.now;
    const start = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => (deadlinePassed ? start + 999_999 : realNow()));
    const first = await runImportChunk(svc as any, runId, { deadline: start + 5_000 });
    vi.mocked(Date.now).mockRestore();

    expect(first.complete).toBe(false);
    expect(first.partial).toBe(true);
    expect(first.phase).toBe('connect');
    const run = svc.tables.ledger_import_runs.find(r => r.id === runId);
    // The counts already taken are STORED, and the cursor names where to
    // resume — the phase is not silently finished.
    expect(run.cursor.countIndex).toBe(2);
    expect(Object.keys(run.report.counts)).toEqual(['Customer', 'Invoice']);

    // Second chunk: the remaining counts are taken, none is re-taken.
    calls = 0;
    deadlinePassed = false;
    stubClient({
      count: vi.fn(async () => { calls += 1; return 7; }),
      page: vi.fn().mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    await runImportChunk(svc as any, runId, { deadline: Date.now() + 30_000 });
    const after = svc.tables.ledger_import_runs.find(r => r.id === runId);
    expect(Object.keys(after.report.counts)).toHaveLength(1 + TRANSACTION_ENTITIES.length);
    expect(after.report.counts.Transfer).toBe(7);
  });

  it('warns when the graded total does not equal count(Customer)', async () => {
    // A short page mid-walk otherwise yields a report that is internally
    // consistent (buckets sum to total) while hundreds went ungraded.
    stubClient({
      count: vi.fn(async (entity: string) => (entity === 'Customer' ? 9 : 0)),
      page: vi.fn()
        .mockResolvedValueOnce({ items: [{ Id: '1', DisplayName: 'Only One' }], orderBy: 'Id' })
        .mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({ customers: [], netsuite_sales_orders: [] });
    const runId = await startDryRun(svc as any, { startedBy: 'user-1' });
    await runImportChunk(svc as any, runId, { deadline: Date.now() + 30_000 });

    const run = svc.tables.ledger_import_runs.find(r => r.id === runId);
    expect(run.report.customers.total).toBe(1);
    expect(run.report.counts.Customer).toBe(9);
    expect(run.report.warnings.join(' ')).toMatch(/Graded 1 customers but QuickBooks counts 9/);
  });

  it('files a row a HUMAN already decided under alreadyManual and never re-grades it', async () => {
    // The bucket the dry-run report prints as "N already decided". Its only
    // producer is phaseDryRunCustomers — buildMatchReport just folds the flag
    // — so a second dry run taken after the review queue has been worked
    // would otherwise re-grade `manual`/`ignored` rows from scratch and file
    // them under ambiguous/unmatched, telling the owner their own decisions
    // had come undone.
    stubClient({
      count: vi.fn(async (entity: string) => (entity === 'Customer' ? 3 : 0)),
      page: vi.fn()
        .mockResolvedValueOnce({
          items: [
            { Id: '1', DisplayName: 'Broadway Ford' },   // attached by hand
            { Id: '2', DisplayName: 'Nowhere Fleet' },   // ignored by hand
            { Id: '3', DisplayName: 'Broadway Ford' },   // never decided
          ],
          orderBy: 'Id',
        })
        .mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      customers: [{ id: 'cust-1', netsuite_id: '900', company_name: 'Broadway Ford', entity_id: 'BF', active: true }],
      netsuite_sales_orders: [],
      ledger_customers: [
        { id: 'lc-1', source: 'quickbooks', external_id: 'Customer/1', match_status: 'manual' },
        { id: 'lc-2', source: 'quickbooks', external_id: 'Customer/2', match_status: 'ignored' },
        { id: 'lc-3', source: 'quickbooks', external_id: 'Customer/3', match_status: 'pending' },
      ],
    });
    const runId = await startDryRun(svc as any, { startedBy: 'user-1' });
    await runImportChunk(svc as any, runId, { deadline: Date.now() + 30_000 });

    const report = svc.tables.ledger_import_runs.find(r => r.id === runId).report;
    expect(report.customers.buckets.alreadyManual).toBe(2);
    expect(report.customers.buckets.exact).toBe(1);
    expect(report.customers.total).toBe(3);
    // The decided rows carry no re-grade at all — no match, no candidates.
    const decided = report.customers.rows.filter((r: any) => r.bucket === 'alreadyManual');
    expect(decided.map((r: any) => r.externalId).sort()).toEqual(['Customer/1', 'Customer/2']);
    expect(decided.every((r: any) => r.matched === null && r.candidates.length === 0)).toBe(true);
    // …and the dry run still wrote nothing to ledger_customers.
    expect(writesTo(svc, 'ledger_customers')).toHaveLength(0);
  });

  it('is silent when the walk covered every customer QuickBooks counted', async () => {
    stubClient({
      count: vi.fn(async (entity: string) => (entity === 'Customer' ? 1 : 0)),
      page: vi.fn()
        .mockResolvedValueOnce({ items: [{ Id: '1', DisplayName: 'Only One' }], orderBy: 'Id' })
        .mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({ customers: [], netsuite_sales_orders: [] });
    const runId = await startDryRun(svc as any, { startedBy: 'user-1' });
    await runImportChunk(svc as any, runId, { deadline: Date.now() + 30_000 });
    const run = svc.tables.ledger_import_runs.find(r => r.id === runId);
    expect((run.report.warnings as string[]).join(' ')).not.toMatch(/were not walked/);
  });
});

describe('the page walk', () => {
  function runWith(items: any[], over: Record<string, unknown> = {}) {
    const client = stubClient({
      count: vi.fn().mockResolvedValue(items.length),
      page: vi.fn()
        .mockResolvedValueOnce({ items, orderBy: 'Id' })
        .mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'], cutoverDate: '2021-04-01' }, ...over })],
      ledger_customers: [{ id: 'lc-1', source: 'quickbooks', external_id: 'Customer/7', customer_id: 'cust-9', customer_netsuite_id: '4821' }],
    });
    return { client, svc };
  }

  it('upserts headers, replaces lines, then stamps lines_synced_at', async () => {
    const { svc } = runWith([invoice('101')]);
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    const stored = svc.tables.ledger_invoices[0];
    expect(stored.external_id).toBe('Invoice/101');
    expect(stored.last_synced_at).toBeTruthy();
    expect(svc.tables.ledger_invoice_lines).toHaveLength(1);
    expect(stored.lines_synced_at).toBeTruthy();
  });

  it('flags post_cutover and COUNTS it — no per-row event', async () => {
    // Rows are kept and flagged; the 5,000-event cap stays free for real
    // exceptions.
    const { svc } = runWith([invoice('101', { TxnDate: '2021-06-01' })]);
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(svc.tables.ledger_invoices[0].post_cutover).toBe(true);
    expect(result.counts.Invoice.postCutover).toBe(1);
    const events = writesTo(svc, 'ledger_import_events').flatMap(w => w.rows);
    expect(events.filter(e => e.outcome === 'voided' || e.entity_type === 'Invoice' && e.outcome === 'skipped')).toEqual([]);
  });

  it('counts voided headers rather than eventing them', async () => {
    const { svc } = runWith([invoice('101', { TotalAmt: 0, PrivateNote: 'Voided' })]);
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(result.counts.Invoice.voided).toBe(1);
  });

  it('resolves the FleetSuite customer onto the transaction rows', async () => {
    const { svc } = runWith([invoice('101')]);
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    const stored = svc.tables.ledger_invoices[0];
    expect(stored.ledger_customer_id).toBe('lc-1');
    expect(stored.customer_id).toBe('cust-9');
    expect(stored.customer_netsuite_id).toBe('4821');
  });

  it('a re-run inserts NOTHING new — every write is an upsert on the full key', async () => {
    const { svc } = runWith([invoice('101')]);
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(svc.tables.ledger_invoices).toHaveLength(1);

    // Reset the run and walk the same page again.
    svc.tables.ledger_import_runs[0].status = 'running';
    svc.tables.ledger_import_runs[0].cursor = { phase: 'transactions' };
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn().mockResolvedValueOnce({ items: [invoice('101')], orderBy: 'Id' }).mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(svc.tables.ledger_invoices).toHaveLength(1);
    expect(svc.tables.ledger_invoice_lines).toHaveLength(1);
  });

  it('a Payment carrying card and bank fields leaves NO digits anywhere it wrote', async () => {
    const payment = {
      Id: '9', TxnDate: '2019-07-02', TotalAmt: 500,
      CustomerRef: { value: '7', name: 'Broadway Ford' },
      CreditCardPayment: { CreditChargeInfo: { Number: '4111111111111111', CcExpiryMonth: 11 } },
      CheckPayment: { BankName: 'First National', AcctNum: '000123456789', NameOnAcct: 'BMG' },
      // The LINE and its LinkedTxn carry instrument fields too — the child
      // `raw` path, which is stored in reader-visible tables of its own.
      Line: [{
        Amount: 500,
        CreditCardPayment: { CreditChargeInfo: { Number: '4111111111111111' } },
        LinkedTxn: [{ TxnId: '101', TxnType: 'Invoice', CardNumber: '4242424242424242' }],
      }],
    };
    // ENTITY-AWARE, or this fixture is served to the FIRST page() call —
    // which is Invoice — and `mapPayment`, `applicationsOf` and
    // ledger_payment_applications are never exercised at all.
    stubClient({
      count: vi.fn(async (entity: string) => (entity === 'Payment' ? 1 : 0)),
      page: vi.fn(async (entity: string) =>
        entity === 'Payment' ? { items: [payment], orderBy: 'Id' } : { items: [], orderBy: 'Id' },
      ),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });

    // The row really landed — otherwise "no digits" proves nothing.
    expect(svc.tables.ledger_payments).toHaveLength(1);
    expect(svc.tables.ledger_payments[0].external_id).toBe('Payment/9');
    expect(svc.tables.ledger_payment_applications).toHaveLength(1);
    expect(svc.tables.ledger_payment_applications[0].applied_external_id).toBe('Invoice/101');

    const everything = JSON.stringify(svc.writes);
    expect(everything).not.toMatch(/\d{13,19}/);
    // The header, the line's application raw: no instrument SUBTREE anywhere
    // in the stored rows. (The dropped_field event names the keys on purpose,
    // so that assertion is scoped to the tables, not to every write.)
    const stored = JSON.stringify([svc.tables.ledger_payments, svc.tables.ledger_payment_applications]);
    expect(stored).not.toMatch(/CreditCardPayment|CheckPayment|CardNumber/);
    const events = writesTo(svc, 'ledger_import_events').flatMap(w => w.rows);
    // A dropped_field event carries the NAMES, never the values.
    const dropped = events.find(e => e.outcome === 'dropped_field');
    expect(dropped?.raw?.dropped).toContain('CreditCardPayment');
    expect(JSON.stringify(dropped?.raw)).not.toMatch(/\d{13,19}/);
  });

  it('an INVOICE and a BILL leave no digits in their copied-whole header JSONB either', async () => {
    // The Payment fixture above populates none of bill_address /
    // ship_address / linked_txns, so its "no digits anywhere" assertion never
    // touched those columns. These two do.
    const invoice = {
      Id: '30', DocNumber: '3030', TxnDate: '2019-08-01', TotalAmt: 100, Balance: 0,
      CustomerRef: { value: '7', name: 'Broadway Ford' }, SyncToken: '1',
      MetaData: { LastUpdatedTime: '2019-08-02T00:00:00Z' },
      BillAddr: { Line1: '1 Main St', CardNumber: '4111111111111111' },
      ShipAddr: { Line1: '2 Side St', TaxIdentifier: '12-3456789' },
      LinkedTxn: [{ TxnId: '9', TxnType: 'Payment', CardNumber: '4242424242424242' }],
      Line: [{ Id: '1', Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '5' } } }],
    };
    const bill = {
      Id: '31', TxnDate: '2019-08-03', TotalAmt: 40, SyncToken: '1',
      VendorRef: { value: '4', name: 'Acme' },
      MetaData: { LastUpdatedTime: '2019-08-04T00:00:00Z' },
      LinkedTxn: [{ TxnId: '77', TxnType: 'BillPayment', CardNumber: '4111111111111111' }],
      Line: [{ Id: '1', Amount: 40, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: {} }],
    };
    stubClient({
      count: vi.fn(async (entity: string) => (entity === 'Invoice' || entity === 'Bill' ? 1 : 0)),
      page: vi.fn(async (entity: string) => {
        if (entity === 'Invoice') return { items: [invoice], orderBy: 'Id' };
        if (entity === 'Bill') return { items: [bill], orderBy: 'Id' };
        return { items: [], orderBy: 'Id' };
      }),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });

    expect(svc.tables.ledger_invoices).toHaveLength(1);
    expect(svc.tables.ledger_bills).toHaveLength(1);
    // The header JSONB columns are inside this — that is the point.
    expect(JSON.stringify(svc.writes)).not.toMatch(/\d{13,19}/);
    const stored = JSON.stringify([svc.tables.ledger_invoices, svc.tables.ledger_bills]);
    expect(stored).not.toMatch(/CardNumber|TaxIdentifier/);
    // …and the columns still carry what the ledger needs from them.
    expect(svc.tables.ledger_invoices[0].bill_address).toEqual({ Line1: '1 Main St' });
    expect(svc.tables.ledger_invoices[0].linked_txns).toEqual([{ TxnId: '9', TxnType: 'Payment' }]);
    expect(svc.tables.ledger_bills[0].linked_txns).toEqual([{ TxnId: '77', TxnType: 'BillPayment' }]);
  });
});

describe('a customer renamed at source', () => {
  it('goes back to pending, while manual and ignored decisions are untouched', async () => {
    stubClient({
      count: vi.fn().mockResolvedValue(3),
      page: vi.fn().mockResolvedValueOnce({
        items: [
          { Id: '1', DisplayName: 'Renamed Ltd', SyncToken: '2' },
          { Id: '2', DisplayName: 'Manual Ltd NEW', SyncToken: '2' },
          { Id: '3', DisplayName: 'Ignored Ltd NEW', SyncToken: '2' },
        ],
        orderBy: 'Id',
      }).mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['customers'] }, phase: 'customers', cursor: { phase: 'customers' } })],
      ledger_customers: [
        { id: 'lc-1', source: 'quickbooks', external_id: 'Customer/1', display_name: 'Old Ltd', match_status: 'exact', customer_id: 'cust-1', customer_netsuite_id: '1' },
        { id: 'lc-2', source: 'quickbooks', external_id: 'Customer/2', display_name: 'Manual Ltd', match_status: 'manual', customer_id: 'cust-2', customer_netsuite_id: '2' },
        { id: 'lc-3', source: 'quickbooks', external_id: 'Customer/3', display_name: 'Ignored Ltd', match_status: 'ignored', customer_id: null, customer_netsuite_id: null },
      ],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    const byId = Object.fromEntries(svc.tables.ledger_customers.map(r => [r.id, r]));
    expect(byId['lc-1'].match_status).toBe('pending');
    expect(byId['lc-1'].customer_id).toBeNull();
    expect(byId['lc-1'].match_reason).toBe('display name changed at source');
    // A human's decision is never reset by an import.
    expect(byId['lc-2'].match_status).toBe('manual');
    expect(byId['lc-2'].customer_id).toBe('cust-2');
    expect(byId['lc-3'].match_status).toBe('ignored');
  });
});

describe('the deadline', () => {
  it('stops mid-walk with partial:true and a cursor at the SAME page', async () => {
    let call = 0;
    stubClient({
      count: vi.fn().mockResolvedValue(400),
      page: vi.fn().mockImplementation(async () => {
        call++;
        // The second page arrives after the budget is gone.
        if (call === 2) vi.setSystemTime(new Date(Date.now() + 60_000));
        return { items: Array.from({ length: 200 }, (_, i) => invoice(String(call * 1000 + i))), orderBy: 'Id' };
      }),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const svc = base({ ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })] });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    vi.useRealTimers();

    expect(result.partial).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.status).toBe('running');
    const cursor = svc.tables.ledger_import_runs[0].cursor;
    expect(cursor.phase).toBe('transactions');
    expect(cursor.startPosition).toBe(401);
    expect(cursor.orderBy).toBe('Id');
  });
});

describe('a page-level QboApiError', () => {
  it('FAILS the run with the Fault text, an intact cursor and a 200-shaped body', async () => {
    stubClient({
      count: vi.fn().mockResolvedValue(10),
      page: vi.fn().mockRejectedValue(new clientModule.QboApiError('Invalid query', { status: 400, code: '4000' })),
    });
    const svc = base({ ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })] });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Invalid query (4000)');
    expect(result.complete).toBe(false);
    expect(result.nextHint).toBe('fix the cause, then --mode resume --run <id>');
    // The page is re-fetched on resume.
    expect(svc.tables.ledger_import_runs[0].cursor.startPosition).toBe(1);
    expect(svc.tables.ledger_import_runs[0].status).toBe('failed');
  });

  it('a THROTTLE is partial with a retryAfterMs, not a failure', async () => {
    stubClient({
      count: vi.fn().mockResolvedValue(10),
      page: vi.fn().mockRejectedValue(new clientModule.QboApiError('throttled', { status: 429, throttled: true })),
    });
    const svc = base({ ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['transactions'] } })] });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(result).toMatchObject({ partial: true, retryAfterMs: 30_000, status: 'running' });
    expect(result.error).toBeUndefined();
  });
});

describe('the pdfs phase', () => {
  const pdfRun = () => importRun({
    config: { environment: 'production', phases: ['pdfs'] }, phase: 'pdfs', cursor: { phase: 'pdfs' },
  });
  const pendingDoc = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1', source: 'quickbooks', kind: 'pdf', status: 'pending', entity_type: 'Invoice',
    external_ref: '101', file_name: 'Invoice_1042.pdf', attempts: 0, first_seen_at: iso(-1000), raw: {},
    ...over,
  });

  it('with the gate SHUT it records one skipped event and names the runbook', async () => {
    stubClient();
    const svc = base({ ledger_import_runs: [pdfRun()], ledger_documents: [pendingDoc()] });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(result.counts.pdfs).toEqual({ skipped: 'LEDGER_PDFS_ENABLED not set — verify docs/r2-private-flip.md first' });
    expect(svc.tables.ledger_documents[0].status).toBe('pending');
    const events = writesTo(svc, 'ledger_import_events').flatMap(w => w.rows);
    expect(events.filter(e => e.outcome === 'skipped')).toHaveLength(1);
  });

  it('with the gate OPEN it stores the bytes and stamps the row', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    vi.spyOn(storage, 'putLedgerObject').mockResolvedValue({ ok: true, key: 'ledger/x', sha256: 'abc', size: 12, existed: false });
    stubClient({ pdf: vi.fn().mockResolvedValue({ ok: true, bytes: Buffer.from('%PDF') }) });
    const svc = base({ ledger_import_runs: [pdfRun()], ledger_documents: [pendingDoc()] });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 60_000 });
    const doc = svc.tables.ledger_documents[0];
    expect(doc.status).toBe('stored');
    expect(doc.sha256).toBe('abc');
    expect(doc.storage_path).toBe('quickbooks/Invoice/101/Invoice_1042.pdf');
  });

  it('an unsupported type is swept in ONE bulk update for the whole type', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    stubClient({ pdf: vi.fn().mockResolvedValue({ ok: false, unsupported: true, reason: 'Bill PDF rejected with HTTP 400' }) });
    const svc = base({
      ledger_import_runs: [pdfRun()],
      ledger_documents: [
        pendingDoc({ id: 'd1', entity_type: 'Bill', external_ref: '1' }),
        pendingDoc({ id: 'd2', entity_type: 'Bill', external_ref: '2' }),
      ],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 60_000 });
    expect(svc.tables.ledger_documents.every(d => d.status === 'unsupported')).toBe(true);
  });

  it('a document RE-FETCHED after a CDC edit ends with the NEW bytes in R2 and a matching sha256', async () => {
    // The whole point of §2.8's "changed SyncToken → the pdf back to
    // pending": the key is `<Entity>/<Id>/<Entity>_<DocNumber|Id>.pdf` and
    // does NOT move when an edit changes only the amounts, so a re-fetch that
    // let putLedgerObject's existence short-circuit fire would leave the
    // PRE-edit bytes in the bucket while the row swore they were the new
    // ones. Real putLedgerObject, real (in-memory) R2 — a stub could not
    // catch this.
    process.env.LEDGER_PDFS_ENABLED = 'true';
    const KEY = 'ledger/quickbooks/Invoice/101/Invoice_1042.pdf';
    const oldBytes = Buffer.from('%PDF-v1-before-the-edit');
    const newBytes = Buffer.from('%PDF-v2-after-the-edit-with-more-bytes');
    r2Objects.set(KEY, oldBytes);

    stubClient({ pdf: vi.fn().mockResolvedValue({ ok: true, bytes: newBytes }) });
    const svc = base({
      ledger_import_runs: [pdfRun()],
      // Exactly what sync.applyChanges leaves behind: pending again,
      // storage_path/sha256/size cleared, `fetched_at` kept as the tell that
      // this row has been fetched before.
      ledger_documents: [pendingDoc({
        storage_path: null, sha256: null, size_bytes: null,
        fetched_at: iso(-86_400_000),
      })],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 60_000 });

    const doc = svc.tables.ledger_documents[0];
    expect(doc.status).toBe('stored');
    expect(doc.storage_path).toBe('quickbooks/Invoice/101/Invoice_1042.pdf');
    // The bytes actually in the bucket are the new ones …
    expect(r2Objects.get(KEY)!.toString()).toBe(newBytes.toString());
    // … and the row's digest and size describe exactly those bytes.
    expect(doc.sha256).toBe(storage.sha256Hex(newBytes));
    expect(doc.size_bytes).toBe(newBytes.byteLength);
  });

  it('a FIRST fetch onto a key that already holds bytes reports the STORED digest', async () => {
    // Not a re-fetch (no fetched_at, no attempts): the object is there
    // because a previous chunk was killed between the upload and the row
    // write. We did not write these bytes now, so the digest stamped is the
    // one the bucket can actually produce.
    process.env.LEDGER_PDFS_ENABLED = 'true';
    const KEY = 'ledger/quickbooks/Invoice/101/Invoice_1042.pdf';
    const there = Buffer.from('%PDF-already-uploaded');
    r2Objects.set(KEY, there);
    stubClient({ pdf: vi.fn().mockResolvedValue({ ok: true, bytes: Buffer.from('%PDF-fetched') }) });
    const svc = base({ ledger_import_runs: [pdfRun()], ledger_documents: [pendingDoc()] });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 60_000 });

    expect(r2Objects.get(KEY)!.toString()).toBe(there.toString());
    expect(svc.tables.ledger_documents[0].sha256).toBe(storage.sha256Hex(there));
  });

  it('a transient failure retries and only FAILS after three attempts', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    stubClient({ pdf: vi.fn().mockResolvedValue({ ok: false, error: 'gateway timeout', status: 504 }) });
    const svc = base({ ledger_import_runs: [pdfRun()], ledger_documents: [pendingDoc({ attempts: 1 })] });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 60_000 });
    expect(svc.tables.ledger_documents[0].status).toBe('pending');
    expect(svc.tables.ledger_documents[0].attempts).toBe(2);

    svc.tables.ledger_import_runs[0].status = 'running';
    svc.tables.ledger_import_runs[0].cursor = { phase: 'pdfs' };
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 60_000 });
    expect(svc.tables.ledger_documents[0].status).toBe('failed');
    expect(svc.tables.ledger_documents[0].attempts).toBe(3);
  });
});

describe('the match phase backfill', () => {
  it('updates invoices and payments in ONE `.in()` batch per target, not a pair per customer', async () => {
    // Two QuickBooks customers that grade to the SAME FleetSuite customer are
    // one UPDATE per table, not four round trips. §2.5 step 5 words it as
    // `WHERE ledger_customer_id IN (…)`.
    stubClient();
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['match'] },
        phase: 'match', cursor: { phase: 'match' },
      })],
      customers: [{ id: 'cust-1', netsuite_id: '900', company_name: 'Broadway Ford', entity_id: 'BF', active: true }],
      ledger_customers: [
        { id: 'lc-1', source: 'quickbooks', external_id: 'Customer/1', display_name: 'Broadway Ford', cleaned_name: 'Broadway Ford', match_status: 'pending' },
        { id: 'lc-2', source: 'quickbooks', external_id: 'Customer/2', display_name: 'Broadway Ford', cleaned_name: 'Broadway Ford', match_status: 'pending' },
      ],
      ledger_invoices: [
        { id: 'inv-1', source: 'quickbooks', external_id: 'Invoice/1', ledger_customer_id: 'lc-1' },
        { id: 'inv-2', source: 'quickbooks', external_id: 'Invoice/2', ledger_customer_id: 'lc-2' },
      ],
      ledger_payments: [{ id: 'pay-1', source: 'quickbooks', external_id: 'Payment/1', ledger_customer_id: 'lc-1' }],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    // Both graded onto the same FleetSuite customer …
    expect(svc.tables.ledger_customers.every(c => c.customer_id === 'cust-1')).toBe(true);
    // … and the backfill landed on both invoices and the payment.
    expect(svc.tables.ledger_invoices.every(i => i.customer_id === 'cust-1')).toBe(true);
    expect(svc.tables.ledger_payments[0].customer_netsuite_id).toBe('900');
    // One UPDATE per table for the shared target, addressed with `.in()`.
    for (const table of ['ledger_invoices', 'ledger_payments']) {
      const updates = writesTo(svc, table).filter(w => w.op === 'update');
      expect(updates, table).toHaveLength(1);
      expect(updates[0].filters.some(
        ([col, value]: [string, any]) => col === 'ledger_customer_id' && Array.isArray(value),
      ), table).toBe(true);
    }
  });
});

describe('the repair phase paginates', () => {
  it('enumerates ALL 1,200 NULL-target applications, not the first 1,000', async () => {
    // One row per application over the whole history: a plain select would
    // stop silently at 1000 and leave the surplus looking unapplied forever.
    stubClient();
    const apps = Array.from({ length: 1_200 }, (_, i) => ({
      id: `app-${String(i).padStart(4, '0')}`,
      payment_id: 'pay-1',
      applied_kind: 'invoice',
      applied_external_id: `Invoice/${String(i).padStart(4, '0')}`,
      applied_invoice_id: null,
      applied_bill_id: null,
    }));
    const invoices = apps.map((a, i) => ({
      id: `inv-${i}`, source: 'quickbooks', external_id: a.applied_external_id, lines_synced_at: iso(0),
    }));
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['repair'] }, phase: 'repair', cursor: { phase: 'repair' } })],
      ledger_payment_applications: apps,
      ledger_invoices: invoices,
    });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 120_000 });
    expect(result.counts.repair.resolved).toBe(1_200);
    expect(svc.tables.ledger_payment_applications.every(a => a.applied_invoice_id)).toBe(true);
  });

  it('re-fetches each entity under its OWN name — one table holds five of them', async () => {
    // ledger_invoices carries Invoice, CreditMemo, SalesReceipt, RefundReceipt
    // and Estimate, and `Id IN (…)` is scoped to the FROM clause. Asking
    // Invoice for a CreditMemo's id returns nothing (or the wrong record —
    // QuickBooks ids are per-entity), so the row would never be repaired.
    const client = stubClient();
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['repair'] }, phase: 'repair', cursor: { phase: 'repair' } })],
      ledger_invoices: [
        { id: 'a', source: 'quickbooks', external_id: 'Invoice/11', external_ref: '11', lines_synced_at: null },
        { id: 'b', source: 'quickbooks', external_id: 'CreditMemo/12', external_ref: '12', lines_synced_at: null },
      ],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    const asked = client.page.mock.calls.map((c: any[]) => [c[0], c[1]]);
    expect(asked).toContainEqual(['Invoice', "Id IN ('11')"]);
    expect(asked).toContainEqual(['CreditMemo', "Id IN ('12')"]);
    // …and never one entity carrying the other's id.
    expect(asked).not.toContainEqual(['Invoice', "Id IN ('11','12')"]);
  });

  it('stamps lines_synced_at on BOTH the Invoice and the CreditMemo it re-fetched', async () => {
    // The mis-query left the odd one out unrepaired forever, because every
    // later run repeated it. This is the end-to-end proof.
    const line = (id: string) => ({
      Id: id, DocNumber: `D${id}`, TxnDate: '2019-06-01', TotalAmt: 100, Balance: 0,
      SyncToken: '1', MetaData: { LastUpdatedTime: '2019-06-02T00:00:00Z' },
      Line: [{ Id: '1', Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '5' } } }],
    });
    stubClient({
      page: vi.fn(async (entity: string, where: string) => ({
        items: entity === 'Invoice' && where === "Id IN ('11')" ? [line('11')]
          : entity === 'CreditMemo' && where === "Id IN ('12')" ? [line('12')]
            : [],
        orderBy: 'Id',
      })),
    });
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['repair'] }, phase: 'repair', cursor: { phase: 'repair' } })],
      ledger_invoices: [
        { id: 'a', source: 'quickbooks', external_id: 'Invoice/11', external_ref: '11', lines_synced_at: null },
        { id: 'b', source: 'quickbooks', external_id: 'CreditMemo/12', external_ref: '12', lines_synced_at: null },
      ],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    const byExternal = Object.fromEntries(svc.tables.ledger_invoices.map(r => [r.external_id, r]));
    expect(byExternal['Invoice/11'].lines_synced_at).toBeTruthy();
    expect(byExternal['CreditMemo/12'].lines_synced_at).toBeTruthy();
    expect(svc.tables.ledger_invoice_lines).toHaveLength(2);
  });

  it('leaves a target that is NOT mirrored yet as NULL for the next pass', async () => {
    // NULL means "not mirrored yet", never "unapplied".
    stubClient();
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['repair'] }, phase: 'repair', cursor: { phase: 'repair' } })],
      ledger_payment_applications: [{
        id: 'app-1', payment_id: 'pay-1', applied_kind: 'credit_memo',
        applied_external_id: 'CreditMemo/500', applied_invoice_id: null, applied_bill_id: null,
      }],
      ledger_invoices: [],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    expect(svc.tables.ledger_payment_applications[0].applied_invoice_id).toBeNull();
  });
});

describe('confirm_cutover', () => {
  /** The dry run the cutover points at has to EXIST — see the 400 test below. */
  const dryRunRow = () => ({ id: 'dry-1', source: 'quickbooks', mode: 'dry_run', status: 'complete' });

  it('re-stamps in batches and reports partial at the deadline', async () => {
    const invoices = Array.from({ length: 500 }, (_, i) => ({
      id: `inv-${String(i).padStart(4, '0')}`, source: 'quickbooks', doc_date: '2022-01-01', post_cutover: false,
    }));
    const svc = base({ ledger_import_runs: [dryRunRow()], app_settings: [], ledger_invoices: invoices, ledger_bills: [], ledger_journal_entries: [], ledger_payments: [] });
    const result = await confirmCutover(svc as any, {
      dryRunId: 'dry-1', date: '2021-04-01', userId: null, deadline: Date.now() + 30_000,
    });
    expect(result.ok).toBe(true);
    expect(result.restamped).toBe(500);
    expect(svc.tables.ledger_invoices.every(r => r.post_cutover === true)).toBe(true);
    // confirmedBy is NULL on the cron-secret path — the type allows it.
    const settings = svc.tables.app_settings[0].value;
    expect(settings.cutover).toMatchObject({ date: '2021-04-01', confirmedBy: null, dryRunId: 'dry-1' });
    expect(writesTo(svc, 'audit_log')[0].rows[0].action).toBe('ledger_cutover_confirmed');
  });

  it('stops at the deadline with partial:true and a re-run hint', async () => {
    const invoices = Array.from({ length: 1_000 }, (_, i) => ({
      id: `inv-${String(i).padStart(4, '0')}`, source: 'quickbooks', doc_date: '2022-01-01', post_cutover: false,
    }));
    const svc = base({ ledger_import_runs: [dryRunRow()], app_settings: [], ledger_invoices: invoices, ledger_bills: [], ledger_journal_entries: [], ledger_payments: [] });
    const result = await confirmCutover(svc as any, {
      dryRunId: 'dry-1', date: '2021-04-01', userId: 'u', deadline: Date.now() - 1,
    });
    expect(result.partial).toBe(true);
    expect(result.nextHint).toBe('re-run --mode confirm-cutover with the same date');
  });

  it('a re-run is a NO-OP because already-stamped rows are excluded', async () => {
    const svc = base({
      ledger_import_runs: [dryRunRow()],
      app_settings: [],
      ledger_invoices: [{ id: 'i1', source: 'quickbooks', doc_date: '2022-01-01', post_cutover: true }],
      ledger_bills: [], ledger_journal_entries: [], ledger_payments: [],
    });
    const result = await confirmCutover(svc as any, {
      dryRunId: 'dry-1', date: '2021-04-01', userId: 'u', deadline: Date.now() + 30_000,
    });
    expect(result.restamped).toBe(0);
  });

  it('uses payment_date on ledger_payments — there is no doc_date there', async () => {
    const svc = base({
      ledger_import_runs: [dryRunRow()],
      app_settings: [],
      ledger_invoices: [], ledger_bills: [], ledger_journal_entries: [],
      ledger_payments: [{ id: 'p1', source: 'quickbooks', payment_date: '2022-05-01', post_cutover: false }],
    });
    const result = await confirmCutover(svc as any, {
      dryRunId: 'dry-1', date: '2021-04-01', userId: 'u', deadline: Date.now() + 30_000,
    });
    expect(result.restamped).toBe(1);
    expect(svc.tables.ledger_payments[0].post_cutover).toBe(true);
  });

  it('refuses a dryRunId that names nothing — no settings row, no audit row', async () => {
    // startImport's 412 gate re-reads the dry run, so a bogus id could never
    // open it; the point is that app_settings and `ledger_cutover_confirmed`
    // must not end up pointing at a run that never existed.
    const svc = base({ ledger_import_runs: [], app_settings: [] });
    const result = await confirmCutover(svc as any, {
      dryRunId: 'not-a-run', date: '2021-04-01', userId: 'u', deadline: Date.now() + 30_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^unknown_dry_run/);
    expect(writesTo(svc, 'app_settings')).toEqual([]);
    expect(writesTo(svc, 'audit_log')).toEqual([]);
  });

  it('refuses a runId that is an IMPORT, not a dry run', async () => {
    const svc = base({
      ledger_import_runs: [{ id: 'run-9', source: 'quickbooks', mode: 'import', status: 'complete' }],
      app_settings: [],
    });
    const result = await confirmCutover(svc as any, {
      dryRunId: 'run-9', date: '2021-04-01', userId: 'u', deadline: Date.now() + 30_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^unknown_dry_run/);
  });
});

describe('finalize', () => {
  it('completes the run, audits it and notifies the System Health audience', async () => {
    // Never [startedBy] alone: a cron-secret run has no session user at all.
    stubClient();
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['finalize'] }, phase: 'finalize', cursor: { phase: 'finalize' } })],
      profiles: [{ id: 'owner', role: 'admin', roles: ['admin', 'super_admin'], status: 'approved' }],
      user_feature_overrides: [],
    });
    const result = await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(result.complete).toBe(true);
    expect(svc.tables.ledger_import_runs[0].status).toBe('complete');
    expect(svc.tables.ledger_import_runs[0].finished_at).toBeTruthy();
    expect(writesTo(svc, 'audit_log').map(w => w.rows[0].action)).toContain('ledger_import_finished');
    expect(notifyManyMock).toHaveBeenCalledWith(['owner'], expect.objectContaining({ type: 'ledger_import' }));
    expect(notifyManyMock.mock.calls[0][1].url).toBe('/admin/ledger?run=run-1');
  });

  it('never writes a heartbeat — the bulk import is not in HEALTH_MONITORS', async () => {
    stubClient();
    const svc = base({
      ledger_import_runs: [importRun({ config: { environment: 'production', phases: ['finalize'] }, phase: 'finalize', cursor: { phase: 'finalize' } })],
      profiles: [], user_feature_overrides: [],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 5_000 });
    expect(systemHealth.recordHeartbeat).not.toHaveBeenCalled();
    expect(writesTo(svc, 'cron_runs')).toEqual([]);
  });
});

describe('the attachments index', () => {
  it('links an attachment to the ledger row it hangs on, and leaves an unmirrored parent NULL', async () => {
    // The file is real even when its owner is not mirrored — the attachment
    // is kept with a NULL parent rather than dropped.
    stubClient({
      count: vi.fn().mockResolvedValue(2),
      page: vi.fn().mockResolvedValueOnce({
        items: [
          { Id: '80', FileName: 'signed.pdf', ContentType: 'application/pdf', Size: 10, AttachableRef: [{ EntityRef: { type: 'Invoice', value: '101' } }] },
          { Id: '81', FileName: 'orphan.pdf', ContentType: 'application/pdf', Size: 10, AttachableRef: [{ EntityRef: { type: 'Invoice', value: '999' } }] },
        ],
        orderBy: 'Id',
      }).mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['attachments_index'] },
        phase: 'attachments_index', cursor: { phase: 'attachments_index' },
      })],
      ledger_invoices: [{ id: 'inv-1', source: 'quickbooks', external_id: 'Invoice/101' }],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    const byExternal = Object.fromEntries(svc.tables.ledger_documents.map(d => [d.external_id, d]));
    expect(byExternal['Attachable/80'].entity_table).toBe('ledger_invoices');
    expect(byExternal['Attachable/80'].entity_row_id).toBe('inv-1');
    expect(byExternal['Attachable/81'].entity_row_id).toBeUndefined();
    expect(byExternal['Attachable/81'].status).toBe('pending');
  });

  it('re-indexing does NOT walk a stored attachment back to pending', async () => {
    // Attachable is deliberately outside the daily CDC (sync.ts SYNC_ENTITIES),
    // so re-running this phase is the ONLY way new attachments ever arrive —
    // and the mapper stamps 'pending' on every row it emits. Without the
    // stored-row guard, every sweep would reset documents already in R2:
    // the documents phase re-downloads and re-PUTs them, and while the row
    // reads 'pending' the reader route answers 409 for a file that is sitting
    // in the bucket.
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn().mockResolvedValueOnce({
        items: [
          { Id: '80', FileName: 'signed.pdf', ContentType: 'application/pdf', Size: 10, AttachableRef: [{ EntityRef: { type: 'Invoice', value: '101' } }] },
        ],
        orderBy: 'Id',
      }).mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['attachments_index'] },
        phase: 'attachments_index', cursor: { phase: 'attachments_index' },
      })],
      ledger_invoices: [{ id: 'inv-1', source: 'quickbooks', external_id: 'Invoice/101' }],
      // The same attachment, already fetched and stored by an earlier run.
      ledger_documents: [{
        id: 'doc-80', source: 'quickbooks', kind: 'attachment', entity_type: 'Attachable',
        external_id: 'Attachable/80', file_name: 'signed.pdf', status: 'stored',
        storage_path: 'quickbooks/Attachable/80/signed.pdf', size_bytes: 10,
      }],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    const rows = svc.tables.ledger_documents.filter(d => d.external_id === 'Attachable/80');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('stored');
    expect(rows[0].storage_path).toBe('quickbooks/Attachable/80/signed.pdf');
  });

  it('links attachments in `.in()` batches grouped by parent, not one UPDATE per file', async () => {
    // Three attachments on ONE invoice is one UPDATE, not three. A 1,000-row
    // Attachable page issuing a round trip per row is the difference between
    // a chunk that fits its budget and one that keeps halving its page size.
    stubClient({
      count: vi.fn().mockResolvedValue(3),
      page: vi.fn().mockResolvedValueOnce({
        items: ['80', '81', '82'].map(id => ({
          Id: id, FileName: `${id}.pdf`, ContentType: 'application/pdf', Size: 10,
          AttachableRef: [{ EntityRef: { type: 'Invoice', value: '101' } }],
        })),
        orderBy: 'Id',
      }).mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['attachments_index'] },
        phase: 'attachments_index', cursor: { phase: 'attachments_index' },
      })],
      ledger_invoices: [{ id: 'inv-1', source: 'quickbooks', external_id: 'Invoice/101' }],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    const parentLinks = writesTo(svc, 'ledger_documents')
      .filter(w => w.op === 'update' && w.rows.some(r => 'entity_row_id' in r));
    expect(parentLinks).toHaveLength(1);
    // An array-valued filter is `.in()`; `.eq()` would carry a bare string.
    expect(parentLinks[0].filters.some(
      ([col, value]: [string, any]) => col === 'entity_external_id' && Array.isArray(value),
    )).toBe(true);
    expect(svc.tables.ledger_documents.every(d => d.entity_row_id === 'inv-1')).toBe(true);
  });

  it('never stores a TempDownloadUri — it is a short-lived credential', async () => {
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn().mockResolvedValueOnce({
        items: [{ Id: '82', FileName: 'x.pdf', TempDownloadUri: 'https://intuit.example/tmp?sig=secret', AttachableRef: [] }],
        orderBy: 'Id',
      }).mockResolvedValue({ items: [], orderBy: 'Id' }),
    });
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['attachments_index'] },
        phase: 'attachments_index', cursor: { phase: 'attachments_index' },
      })],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    expect(JSON.stringify(svc.tables.ledger_documents)).not.toContain('sig=secret');
    expect(svc.tables.ledger_documents[0].entity_table).toBe('none');
  });

  it('hands the SAME chunk\u2019s fetch the TempDownloadUri from memory', async () => {
    // The URI is dropped from `raw` on purpose, so reading it back out of the
    // stored row was always null and the documented `temp_uri` fallback was
    // dead code. It is carried in memory instead, valid only for the chunk
    // that indexed it (spec §2.2: "both in the same chunk — short-lived").
    process.env.LEDGER_PDFS_ENABLED = 'true';
    vi.spyOn(storage, 'putLedgerObject').mockResolvedValue({ ok: true, key: 'ledger/x', sha256: 'abc', size: 4, existed: false });
    const download = vi.fn().mockResolvedValue({ ok: true, bytes: Buffer.from('data'), via: 'temp_uri' });
    stubClient({
      count: vi.fn().mockResolvedValue(1),
      page: vi.fn().mockResolvedValueOnce({
        items: [{
          Id: '82', FileName: 'x.pdf', ContentType: 'application/pdf', Size: 4,
          TempDownloadUri: 'https://intuit.example/tmp?sig=secret', AttachableRef: [],
        }],
        orderBy: 'Id',
      }).mockResolvedValue({ items: [], orderBy: 'Id' }),
      download,
    });
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['attachments_index', 'attachments_fetch'] },
        phase: 'attachments_index', cursor: { phase: 'attachments_index' },
      })],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });

    expect(download).toHaveBeenCalledWith('82', 'https://intuit.example/tmp?sig=secret');
    // …and it still never reached the database.
    expect(JSON.stringify(svc.tables.ledger_documents)).not.toContain('sig=secret');
  });

  it('passes null when the index ran in an EARLIER chunk — the URI is long gone', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    const download = vi.fn().mockResolvedValue({ ok: false, error: 'nope' });
    stubClient({ download });
    const svc = base({
      ledger_import_runs: [importRun({
        config: { environment: 'production', phases: ['attachments_fetch'] },
        phase: 'attachments_fetch', cursor: { phase: 'attachments_fetch' },
      })],
      ledger_documents: [{
        id: 'doc-1', source: 'quickbooks', kind: 'attachment', entity_type: 'Attachable',
        external_ref: '82', file_name: 'x.pdf', status: 'pending', attempts: 0,
        raw: {}, first_seen_at: iso(-10_000),
      }],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    expect(download).toHaveBeenCalledWith('82', null);
  });

  const attachmentRun = () => importRun({
    config: { environment: 'production', phases: ['attachments_fetch'] },
    phase: 'attachments_fetch', cursor: { phase: 'attachments_fetch' },
  });
  const pendingAttachment = (id: string, entityType: string) => ({
    id, source: 'quickbooks', kind: 'attachment', entity_type: entityType,
    external_ref: id.replace('doc-', ''), file_name: `${id}.pdf`, status: 'pending',
    attempts: 0, raw: {}, first_seen_at: iso(-10_000),
  });

  it('a CAPABILITY write-off sweeps every pending attachment, whatever parent it hangs on', async () => {
    // attachableDownload is GLOBAL — the realm hands back no attachment
    // bytes at all — so scoping the sweep to one parent entity_type would be
    // the wrong axis and leave the rest of the queue spinning.
    process.env.LEDGER_PDFS_ENABLED = 'true';
    stubClient({
      download: vi.fn().mockResolvedValue({
        ok: false, unsupported: true, scope: 'capability',
        reason: 'the download endpoint did not return a URL',
      }),
    });
    const svc = base({
      ledger_import_runs: [attachmentRun()],
      ledger_documents: [
        pendingAttachment('doc-1', 'Invoice'),
        pendingAttachment('doc-2', 'Bill'),
        pendingAttachment('doc-3', 'Customer'),
      ],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    expect(svc.tables.ledger_documents.every(d => d.status === 'unsupported')).toBe(true);
  });

  it('a DOCUMENT-scoped refusal writes off only that row', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    stubClient({
      download: vi.fn()
        .mockResolvedValueOnce({
          ok: false, unsupported: true, scope: 'document',
          reason: 'no download path available for this attachment',
        })
        .mockResolvedValue({ ok: true, bytes: Buffer.from('data'), via: 'temp_uri' }),
    });
    const svc = base({
      ledger_import_runs: [attachmentRun()],
      ledger_documents: [pendingAttachment('doc-1', 'Invoice'), pendingAttachment('doc-2', 'Bill')],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    const byId = Object.fromEntries(svc.tables.ledger_documents.map(d => [d.id, d.status]));
    expect(byId['doc-1']).toBe('unsupported');
    expect(byId['doc-2']).toBe('stored');
  });

  it('a transient download error RETRIES the row and leaves the rest of the queue alone', async () => {
    // The regression this pins: one 5xx used to arrive as `unsupported` and
    // bulk-write-off every pending attachment for that parent type.
    process.env.LEDGER_PDFS_ENABLED = 'true';
    stubClient({ download: vi.fn().mockResolvedValue({ ok: false, error: 'the download URL answered HTTP 500' }) });
    const svc = base({
      ledger_import_runs: [attachmentRun()],
      ledger_documents: [pendingAttachment('doc-1', 'Invoice'), pendingAttachment('doc-2', 'Invoice')],
    });
    await runImportChunk(svc as any, 'run-1', { deadline: Date.now() + 30_000 });
    expect(svc.tables.ledger_documents.map(d => d.status)).toEqual(['pending', 'pending']);
    expect(svc.tables.ledger_documents.map(d => d.attempts)).toEqual([1, 1]);
  });
});

describe('TRANSACTION_ENTITIES', () => {
  it('walks Invoice BEFORE Payment so an application can resolve on the way past', () => {
    expect(TRANSACTION_ENTITIES.indexOf('Invoice')).toBeLessThan(TRANSACTION_ENTITIES.indexOf('Payment'));
    expect(TRANSACTION_ENTITIES.indexOf('Bill')).toBeLessThan(TRANSACTION_ENTITIES.indexOf('BillPayment'));
  });

  it('is the thirteen transaction types, and Employee is never among them', () => {
    // Employee is payroll data the ledger has no use for.
    expect(TRANSACTION_ENTITIES).toHaveLength(13);
    expect(TRANSACTION_ENTITIES).not.toContain('Employee');
  });
});
