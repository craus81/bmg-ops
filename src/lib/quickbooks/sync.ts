import type { SupabaseClient } from '@supabase/supabase-js';
import { recordHeartbeat } from '@/lib/system-health';
import { readLedgerSettings } from '@/lib/ledger/pdf-gate';
import { appendEvents, writeImportPointer, type EventRow, type SlashKeyedTable } from '@/lib/ledger/write';
import { createQboClient, QboApiError } from './client';
import { maskRealm } from './config';
import { newEventCap, runFollowUpPhases, writePage, type Counts, type PageWriteCtx } from './importer';
import { getAccessToken, QBO_NOT_CONNECTED, QBO_REFRESH_BUSY } from './tokens';

/**
 * The daily QuickBooks change sync (09:57 UTC).
 *
 * Two jobs in one run, in this order:
 *
 *  1. REFRESH-AHEAD, before any other guard. Intuit's refresh token dies
 *     after 100 IDLE days, and rotates roughly daily when used. Renewing it
 *     every day from the day of connection means the idle clock never gets
 *     near 100 even during a slow rollout — so this runs even when the bulk
 *     import has not finished and there is nothing to sync.
 *  2. The change sweep itself, once a bulk import IS complete.
 *
 * THE WATERMARK IS EXPLICIT. The window start comes from
 * `last_result.cdcThrough`, which this job writes, never from
 * `sync_state.last_synced_at`: that column lands at its DEFAULT
 * '2020-01-01' on the first INSERT (migrations/066-sync-state.sql) and,
 * without `touchLastSyncedAt: false` on the skip paths, would read as
 * "recent" after any skipped day. Either way "is it usable" is undecidable,
 * and the first-real-run branch would silently never fire — skipping every
 * change between the bulk import's start and yesterday.
 *
 * Every SKIP heartbeat therefore passes `touchLastSyncedAt: false`
 * (`recordHeartbeat` writes `last_synced_at = now` unless told otherwise):
 * a skip that stamped it would make the CDC watermark look fresh on exactly
 * the days nothing was synced.
 */

export const LEDGER_QBO_SYNC = 'ledger_qbo_sync';

/** CDC's documented look-back ceiling. A wider gap takes the paged path. */
const CDC_MAX_GAP_DAYS = 30;
const DAY_MS = 86_400_000;
/** Refresh whenever the access token expires inside this window (always). */
const REFRESH_AHEAD_MS = 24 * 3_600_000;
/** The soft deadline inside maxDuration 300, so a 09:57 start clears 10:00. */
export const SYNC_SOFT_BUDGET_MS = 150_000;

/** The 13 transaction entities plus the reference rows a change can touch. */
const SYNC_ENTITIES = [
  'Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate',
  'Payment', 'Bill', 'VendorCredit', 'Purchase', 'BillPayment',
  'Deposit', 'JournalEntry', 'Transfer',
  'Customer', 'Vendor', 'Item', 'Account',
];

export interface SyncResult {
  status: 'skipped' | 'ok' | 'error';
  payload: Record<string, unknown>;
}

export async function runLedgerQboSync(
  service: SupabaseClient,
  opts: { startedAt: number; deadline: number },
): Promise<SyncResult> {
  const { data: tokenRow, error: tokenError } = await service
    .from('quickbooks_tokens')
    .select('id, realm_id, environment, access_expires_at, needs_reauth_at, capabilities')
    .eq('id', 1)
    .maybeSingle();

  if (tokenError) {
    const payload = { error: `Could not read the QuickBooks connection: ${tokenError.message}` };
    await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
    return { status: 'error', payload };
  }

  // (1) Not connected at all — a green skip, not a fault. Nobody has asked
  // for QuickBooks yet.
  if (!tokenRow) {
    const payload = { skipped: 'QuickBooks not connected' };
    await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
    return { status: 'skipped', payload };
  }
  // Red on purpose: a connection that needs re-authorizing is a job nobody
  // can do for the app.
  if (tokenRow.needs_reauth_at) {
    const payload = { error: 'QuickBooks needs reconnecting — Settings → Company' };
    await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
    return { status: 'error', payload };
  }

  // (2) Refresh-ahead, BEFORE the import guard — the reason this job matters
  // on day one, long before there is anything to sync.
  let refreshAhead: unknown = 'not due';
  const expiresAt = tokenRow.access_expires_at ? new Date(tokenRow.access_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt < Date.now() + REFRESH_AHEAD_MS) {
    try {
      await getAccessToken(service);
      refreshAhead = 'ok';
    } catch (e: any) {
      const message = String(e?.message || e);
      if (message === QBO_NOT_CONNECTED) {
        const payload = { error: 'QuickBooks needs reconnecting — Settings → Company' };
        await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
        return { status: 'error', payload };
      }
      // Busy or a network blip is not an alarm — the Connections row's
      // 14-day warning escalates if it keeps happening.
      refreshAhead = { problem: message === QBO_REFRESH_BUSY ? 'another refresh was in flight' : message.slice(0, 200) };
    }
  }

  // (3) Nothing to keep current until the bulk import has finished.
  const { data: bulk } = await service
    .from('ledger_import_runs')
    .select('id, started_at, config')
    .eq('source', 'quickbooks')
    .eq('mode', 'import')
    .eq('status', 'complete')
    .order('started_at', { ascending: false })
    .limit(20);
  const completedImport = (bulk || []).find(r => {
    const phases: string[] = (r.config as any)?.phases || [];
    return phases.length === 0 || phases.includes('transactions');
  });
  if (!completedImport) {
    const payload = { skipped: 'bulk import not complete — nothing to keep current yet', refreshAhead };
    await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
    return { status: 'skipped', payload };
  }

  // (4) The real run.
  const { data: state } = await service
    .from('sync_state')
    .select('last_result')
    .eq('sync_type', LEDGER_QBO_SYNC)
    .maybeSingle();
  const previousThrough = (state?.last_result as any)?.cdcThrough as string | undefined;

  // `windowStartedAt` is a LOCAL captured before the first fetch, never a
  // column read: anything changed mid-run must be picked up next time, not
  // skipped because the clock moved on while we worked.
  const windowStartedAt = new Date().toISOString();
  const sinceBase = previousThrough
    ? new Date(previousThrough).getTime()
    // The genuine first real run: reach back to the completing import's own
    // start. `ledger_import_runs` has no windowStartedAt column, only
    // started_at, and everything after it is what CDC has never seen.
    : new Date(completedImport.started_at).getTime();
  const since = new Date(sinceBase - DAY_MS).toISOString();
  const gapDays = (Date.now() - new Date(since).getTime()) / DAY_MS;

  const { data: runRow, error: runError } = await service
    .from('ledger_import_runs')
    .insert({
      source: 'quickbooks',
      mode: 'cdc',
      status: 'running',
      realm_id: maskRealm(String(tokenRow.realm_id)),
      phase: 'transactions',
      cursor: { phase: 'transactions', since },
      config: { environment: tokenRow.environment, since, windowStartedAt },
    })
    .select('id')
    .single();
  if (runError || !runRow) {
    const payload = { error: `Could not start the change sync: ${runError?.message || 'no row returned'}`, refreshAhead };
    await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
    return { status: 'error', payload };
  }
  const runId = String(runRow.id);

  const client = createQboClient(service, { runId });
  const counts: Counts = {};
  const capabilities = (tokenRow.capabilities || {}) as { cdc?: boolean };
  let partial = false;
  let failure: string | undefined;
  let resume: Record<string, unknown> | null = null;

  const bump = (entity: string, key: string, by = 1) => {
    const c = (counts[entity] ||= {});
    c[key] = (Number(c[key]) || 0) + by;
  };

  // The same page-write context the bulk importer builds — one
  // implementation, so a CDC page lands children, stamps and links exactly
  // as an import page does.
  const settings = await readLedgerSettings(service).catch(() => ({} as Awaited<ReturnType<typeof readLedgerSettings>>));
  const events: EventRow[] = [];
  const eventCap = await newEventCap(service, runId);
  const ctx: PageWriteCtx = {
    service,
    runId,
    cutoverDate: settings.cutover?.date ?? null,
    phase: 'transactions',
    counts,
    events,
    errors: [],
    tempUris: new Map(),
  };
  const flushEvents = async () => {
    if (events.length === 0) return;
    await appendEvents(service, runId, events.splice(0, events.length), eventCap);
  };

  try {
    const useCdc = gapDays <= CDC_MAX_GAP_DAYS && capabilities.cdc !== false;
    if (useCdc) {
      for (let i = 0; i < SYNC_ENTITIES.length; i += 5) {
        if (Date.now() >= opts.deadline) { partial = true; resume = { entityIndex: i }; break; }
        const group = SYNC_ENTITIES.slice(i, i + 5);
        await writeImportPointer(service, {
          runId, mode: 'cdc', phase: 'transactions', entity: group[0], status: 'running', partial: false,
        });
        const result = await client.cdc(group, since);
        if (!result.ok) {
          // CDC refused — fall through to the paged path for everything.
          // Its stop marker is HONOURED exactly as in the else branch below:
          // the paged fallback has 17 entities and a 30-day window to walk
          // inside 150 s, so it stopping early is the NORMAL case on the very
          // run that records `capabilities.cdc = false`. Dropping the marker
          // here would report the run drained and advance `cdcThrough` past a
          // window that was never swept.
          const stoppedFallback = await pagedSweep(
            service, client, ctx, runId, SYNC_ENTITIES, since, opts.deadline, bump, flushEvents,
          );
          if (stoppedFallback) { partial = true; resume = stoppedFallback; }
          break;
        }
        for (const [entity, change] of Object.entries(result.changes)) {
          await applyChanges(service, ctx, entity, change.items, bump);
          await tombstone(service, entity, change.deleted, bump);
        }
        await flushEvents();
      }
    } else {
      const stopped = await pagedSweep(
        service, client, ctx, runId, SYNC_ENTITIES, since, opts.deadline, bump, flushEvents,
      );
      if (stopped) { partial = true; resume = stopped; }
    }
    await flushEvents();
  } catch (e: any) {
    await flushEvents().catch(() => undefined);
    if (e instanceof QboApiError && !e.throttled) {
      failure = `${e.message}${e.code ? ` (${e.code})` : ''}`;
    } else {
      failure = String(e?.message || e).slice(0, 500);
    }
  }

  // Then finish what the sweep re-queued, inside whatever budget is left: a
  // changed document's PDF went back to `pending` above, and `repair` picks
  // up children a killed page left unstamped. Only after the change window
  // itself drained — the watermark below is about the WINDOW, and leftover
  // document work stays queued in the rows for tomorrow, so a follow-up that
  // runs out of time is reported, never a reason to re-sweep the window.
  let followUp: Record<string, unknown> | undefined;
  if (!failure && !partial && opts.deadline - Date.now() > 5_000) {
    try {
      const result = await runFollowUpPhases(service, runId, { deadline: opts.deadline, client });
      for (const [key, value] of Object.entries(result.counts)) counts[key] = value;
      followUp = { partial: result.partial, ...(result.errors.length ? { errors: result.errors } : {}) };
    } catch (e: any) {
      // `problem`, not `error`: the change sweep itself succeeded, and a
      // nested `error` key is reserved for a run that really failed.
      followUp = { problem: String(e?.message || e).slice(0, 200) };
    }
  }

  await service.from('ledger_import_runs').update({
    status: failure ? 'failed' : partial ? 'running' : 'complete',
    finished_at: failure || !partial ? new Date().toISOString() : null,
    counts,
    error: failure ?? null,
    api_calls: client.stats().calls,
    updated_at: new Date().toISOString(),
  }).eq('id', runId);

  const records = Object.values(counts).reduce((sum: number, c: any) => sum + (Number(c?.changed) || 0), 0);

  if (failure) {
    const payload = { error: failure, refreshAhead, counts, runId };
    await recordHeartbeat(service, LEDGER_QBO_SYNC, payload, { startedAt: opts.startedAt, touchLastSyncedAt: false });
    return { status: 'error', payload };
  }

  // Drained → the watermark advances to the instant this run OPENED its
  // window. Partial → it must NOT advance (the window has not been swept),
  // and because `last_result` is replaced wholesale, carrying the previous
  // value forward is what keeps it alive at all.
  const payload = {
    ...counts,
    refreshAhead,
    ...(followUp ? { followUp } : {}),
    // Per-row write failures the page machinery collected. They do not fail
    // the run (the row stays for tomorrow), but they are never swallowed.
    ...(ctx.errors.length ? { writeErrors: ctx.errors.slice(0, 10) } : {}),
    partial,
    resume,
    runId,
    cdcThrough: partial ? (previousThrough ?? null) : windowStartedAt,
  };
  await recordHeartbeat(
    service,
    LEDGER_QBO_SYNC,
    payload,
    partial
      ? { startedAt: opts.startedAt, records, touchLastSyncedAt: false }
      : { startedAt: opts.startedAt, records, lastSyncedAt: windowStartedAt },
  );
  return { status: 'ok', payload };
}

/**
 * The windowed fallback when CDC cannot be used (gap > 30 days, or the
 * company rejected it).
 *
 * `ORDERBY MetaData.LastUpdatedTime` is FORCED here (`page`'s `order`
 * option, not the `orderById` probe): it is the [H] clause, and it is also
 * the column being filtered, so paging stays stable while rows keep changing
 * underneath. Returns the `{ entity, startPosition }` the caller must resume
 * from when the deadline stopped it — a marker the caller MUST honour, or
 * the watermark advances past a window nothing swept.
 */
async function pagedSweep(
  service: SupabaseClient,
  client: ReturnType<typeof createQboClient>,
  ctx: PageWriteCtx,
  runId: string,
  entities: string[],
  since: string,
  deadline: number,
  bump: (entity: string, key: string, by?: number) => void,
  flush: () => Promise<void>,
): Promise<Record<string, unknown> | null> {
  for (const entity of entities) {
    let startPosition = 1;
    for (;;) {
      if (Date.now() >= deadline) return { entity, startPosition };
      await writeImportPointer(service, {
        runId, mode: 'cdc', phase: 'transactions', entity, status: 'running', partial: false, startPosition,
      });
      const page = await client.page<any>(
        entity, `MetaData.LastUpdatedTime > '${since}'`, startPosition, 200,
        { order: 'MetaData.LastUpdatedTime' },
      );
      await applyChanges(service, ctx, entity, page.items, bump);
      await flush();
      startPosition += page.items.length;
      if (page.items.length < 200) break;
    }
  }
  return null;
}

/**
 * Write one page of changed rows — through the IMPORTER's page machinery.
 *
 * Header-only was the bug this replaces: an invoice edited from $500/3 lines
 * to $400/2 lines had its header upserted while the three stale
 * `ledger_invoice_lines` rows stayed put, summing to a total the header no
 * longer claimed, forever. `repair` could not save it either — it only looks
 * at rows whose `lines_synced_at IS NULL`, and a header-only upsert leaves
 * that stamp exactly where the bulk import left it.
 *
 * `writePage` is the one implementation (§2.5 step 4): headers →
 * `replaceChildren(lines)` → `replaceChildren(applications)` → `stampSynced`
 * → pdf placeholder rows → customer links, with the Customer rename
 * detection and the post-cutover flag included.
 */
async function applyChanges(
  service: SupabaseClient,
  ctx: PageWriteCtx,
  entity: string,
  items: any[],
  bump: (entity: string, key: string, by?: number) => void,
): Promise<void> {
  if (!items?.length) return;

  // A changed SyncToken means the document itself moved, so any PDF we
  // already stored for it is now the OLD version — back to pending. Read the
  // targets BEFORE the write, while `writePage`'s "skip rows already stored"
  // rule still sees the old status.
  const externalIds = items.map(i => `${entity}/${i.Id}`);
  const changedPdfTargets: string[] = [];
  for (let i = 0; i < externalIds.length; i += 100) {
    const batch = externalIds.slice(i, i + 100);
    const { data } = await service
      .from('ledger_documents')
      .select('id, entity_external_id')
      .eq('source', 'quickbooks')
      .eq('kind', 'pdf')
      .in('entity_external_id', batch);
    for (const row of data || []) changedPdfTargets.push(String(row.id));
  }

  const before = Number(ctx.counts[entity]?.mapped) || 0;
  await writePage(ctx, entity, items);
  bump(entity, 'changed', (Number(ctx.counts[entity]?.mapped) || 0) - before);

  for (let i = 0; i < changedPdfTargets.length; i += 100) {
    await service
      .from('ledger_documents')
      .update({
        status: 'pending',
        storage_path: null,
        // The digest and byte count described the OLD render; a row that
        // points at nothing must not still claim to know what is in it.
        sha256: null,
        size_bytes: null,
        error: null,
        // `fetched_at` is deliberately KEPT: it is how the pdfs phase knows
        // this is a re-fetch and must REPLACE the object in R2 rather than
        // let putLedgerObject's existence short-circuit leave the pre-edit
        // bytes behind under the same key.
      })
      .in('id', changedPdfTargets.slice(i, i + 100));
  }
}

/**
 * A CDC `status: 'Deleted'` stub is the ONLY way a delete is ever visible —
 * query never returns one. It is recorded as a TOMBSTONE, never a physical
 * delete: the ledger keeps what it saw.
 */
async function tombstone(
  service: SupabaseClient,
  entity: string,
  ids: string[],
  bump: (entity: string, key: string, by?: number) => void,
): Promise<void> {
  if (!ids?.length) return;
  const externalIds = ids.map(id => `${entity}/${id}`);
  const tables: SlashKeyedTable[] = [
    'ledger_invoices', 'ledger_bills', 'ledger_payments', 'ledger_journal_entries',
    'ledger_customers', 'ledger_entities', 'ledger_accounts',
  ];
  const at = new Date().toISOString();
  for (const table of tables) {
    for (let i = 0; i < externalIds.length; i += 100) {
      const { data } = await service
        .from(table)
        .update({ deleted_at: at })
        .eq('source', 'quickbooks')
        .in('external_id', externalIds.slice(i, i + 100))
        .select('id');
      if (data?.length) bump(entity, 'deleted', data.length);
    }
  }
}
