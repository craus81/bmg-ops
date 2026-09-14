import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { deepLinks } from '@/lib/deep-links';
import { fetchAllRows } from '@/lib/fetch-all';
import { notifyMany } from '@/lib/notify';
import { systemHealthAudience } from '@/lib/system-health-audience';
import { LEDGER_PROBE_PATH, ledgerStoragePath, putLedgerObject } from '@/lib/ledger/storage';
import { LEDGER_SETTINGS_KEY, ledgerPdfsEnabled, readLedgerSettings } from '@/lib/ledger/pdf-gate';
import {
  appendEvents,
  replaceChildren,
  stampSynced,
  upsertRows,
  writeImportPointer,
  type EventRow,
  type SlashKeyedTable,
} from '@/lib/ledger/write';
import { createQboClient, entityPath, QboApiError, type QboClient, type QboPage } from './client';
import { maskRealm } from './config';
import { netsuiteFirstInvoiceDate, deriveCutover } from './cutover';
import {
  ALL_PHASES,
  buildMatchReport,
  DRY_RUN_ROW_CAP,
  estimatePlan,
  type DryRunCustomers,
  type DryRunReport,
  type GradedParty,
  type Phase,
} from './dry-run';
import { candidatesFor, gradeInMemory, loadCustomerIndex, type CustomerIndexRow, type MatchGrade } from './customer-match';
import { childTableFor, mapEntityRow } from './map';
import {
  materializeReportPlan,
  parseReportLines,
  REPORT_MAX_BYTES,
  REPORT_PLAN,
  reportSha256,
  summarizeReport,
} from './reports';
import { sanitizeQboPayload } from './sanitize';
import { readConnection, NO_QBO_TOKEN, QBO_NOT_CONNECTED, QBO_REFRESH_BUSY } from './tokens';

/**
 * The resumable QuickBooks importer.
 *
 * Vercel functions cap out, so the bulk pull is CHUNKED: each invocation does
 * a bounded slice of work against a deadline and answers with a cursor. A
 * script (scripts/import-quickbooks.mjs) or the admin page loops it. The
 * logic lives here, once — the route, the cron and the script only call in
 * (owner item 9).
 *
 * The cursor is the whole safety story:
 *
 *   • `ledger_import_runs.cursor` is AUTHORITATIVE and is written BEFORE
 *     every network fetch, naming the page about to be fetched. A killed
 *     invocation re-does at most one page.
 *   • `sync_state.ledger_qbo_import` is a MIRROR written in the same step,
 *     through the plain upsert `writeSyncStateCursor` — never
 *     `recordHeartbeat`, which would append a `cron_runs` row per page.
 *   • A dry run writes NEITHER pointer (`writeImportPointer`'s type forbids
 *     the mode).
 *
 * Exactly-once is structural, not hopeful: every write is an upsert on a full
 * unique key, children are delete+insert stamped only after they land, and an
 * R2 object already present is skipped rather than re-uploaded.
 */

const EVENT_CAP = 5_000 as const;

/**
 * The 5,000-event cap, seeded from what the RUN has already written.
 *
 * It is a per-RUN cap, not a per-invocation one: a bulk import is hundreds of
 * chunks (`scripts/import-quickbooks.mjs` loops the route), and a `seen: 0`
 * reset on every call would let a systematically broken import push seven
 * figures of rows into `ledger_import_events` — a table every
 * finance/admin/super_admin/executive reader can SELECT, and whose own
 * COMMENT in migrations/314-ledger.sql promises 'capped at 5,000 per run'.
 */
export async function newEventCap(
  service: SupabaseClient,
  runId: string,
): Promise<{ seen: number; max: typeof EVENT_CAP }> {
  const { count } = await service
    .from('ledger_import_events')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId);
  return { seen: count ?? 0, max: EVENT_CAP };
}

/** Default per-invocation budget; the route clamps to this ceiling. */
export const DEFAULT_BUDGET_MS = 45_000;
export const MAX_BUDGET_MS = 240_000;
/** Nothing may plan past this, whatever budget was asked for (maxDuration 300). */
const HARD_DEADLINE_MS = 275_000;

/** Reference data: small, and everything downstream names it. */
const REFERENCE_ENTITIES = [
  'Account', 'Item', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate',
  'Class', 'Department', 'CompanyInfo', 'Preferences', 'Vendor',
];

/**
 * Transaction order matters: Invoice before Payment so an application can
 * resolve its target on the way past. What still lags (CreditMemo and Bill
 * targets) is what the `repair` phase exists for.
 */
export const TRANSACTION_ENTITIES = [
  'Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate',
  'Payment', 'Bill', 'VendorCredit', 'Purchase', 'BillPayment',
  'Deposit', 'JournalEntry', 'Transfer',
];
// Employee is never queried — it is payroll data the ledger has no use for.

/** The only phases an import may run WITHOUT a read dry run (§2.5). */
export const GATE_FREE_PHASES: Phase[] = ['pdfs', 'attachments_fetch', 'repair'];

export interface Cursor {
  phase?: Phase;
  entity?: string | null;
  entityIndex?: number;
  startPosition?: number;
  orderBy?: 'Id' | 'MetaData.LastUpdatedTime';
  pageSize?: number;
  expected?: number | null;
  processed?: number;
  /** Dry run: how many of the COUNT(*) probes have landed (§2.6). */
  countIndex?: number;
  matchAfter?: string | null;
  repairAfter?: string | null;
  reportsMaterialized?: boolean;
  restampAfter?: string | null;
}

export type Counts = Record<string, any>;

export interface ChunkResult {
  runId: string;
  mode: string;
  status: string;
  phase: string | null;
  entity: string | null;
  complete: boolean;
  partial: boolean;
  progress: { processed: number; expected: number | null; apiCalls: number; elapsedMs: number };
  counts: Counts;
  events: Record<string, number>;
  lastErrors: string[];
  cutover: unknown;
  report?: DryRunReport | Record<string, unknown> | null;
  capabilities: unknown;
  nextHint: string;
  retryAfterMs?: number;
  error?: string;
}

// ═══════════ RUN ROW HELPERS ═══════════

async function loadRun(service: SupabaseClient, runId: string): Promise<any> {
  const { data, error } = await service.from('ledger_import_runs').select('*').eq('id', runId).maybeSingle();
  if (error) throw new Error(`Could not read the import run: ${error.message}`);
  if (!data) throw new Error('run_not_found');
  return data;
}

async function patchRun(service: SupabaseClient, runId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await service
    .from('ledger_import_runs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw new Error(`Could not update the import run: ${error.message}`);
}

/**
 * Claim the run for this invocation.
 *
 * The freshness test is in the UPDATE's own WHERE clause, so the database
 * decides who holds it: zero rows back means another driver is mid-chunk.
 * A killed invocation's lease simply lapses (≤ 270 s) and the next call
 * takes over — no manual unlock, ever.
 */
export async function claimLease(
  service: SupabaseClient,
  runId: string,
  budgetMs: number,
): Promise<{ ok: true; run: any } | { ok: false; retryAfterMs: number }> {
  const run = await loadRun(service, runId);
  const nowIso = new Date().toISOString();
  const { data, error } = await service
    .from('ledger_import_runs')
    .update({
      lease_until: new Date(Date.now() + budgetMs + 30_000).toISOString(),
      last_invocation_at: nowIso,
      invocations: (Number(run.invocations) || 0) + 1,
      updated_at: nowIso,
    })
    .eq('id', runId)
    .in('status', ['running', 'failed'])
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select('id');
  if (error) throw new Error(`Could not claim the run lease: ${error.message}`);
  if (!data || data.length === 0) return { ok: false, retryAfterMs: 5_000 };
  return { ok: true, run: { ...run, status: 'running' } };
}

// ═══════════ STARTING RUNS ═══════════

export interface StartDryRunInput {
  startedBy: string | null;
  reportsFrom?: string | null;
  budgetMs?: number;
}

export async function startDryRun(service: SupabaseClient, input: StartDryRunInput): Promise<string> {
  const conn = await readConnection(service);
  const { data, error } = await service
    .from('ledger_import_runs')
    .insert({
      source: 'quickbooks',
      mode: 'dry_run',
      status: 'running',
      // Already masked on the way in — this table is reader-visible.
      realm_id: maskRealm(conn.realmId),
      started_by: input.startedBy,
      phase: 'connect',
      cursor: { phase: 'connect' },
      config: {
        environment: conn.environment,
        reportsFrom: input.reportsFrom ?? null,
        budgetMs: input.budgetMs ?? DEFAULT_BUDGET_MS,
      },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Could not start the dry run: ${error?.message || 'no row returned'}`);

  await logAudit(service, {
    actorId: input.startedBy,
    table: 'ledger_import_runs',
    recordId: String(data.id),
    action: 'ledger_dry_run',
    detail: { realmMasked: maskRealm(conn.realmId), environment: conn.environment },
  });
  return String(data.id);
}

export interface StartImportInput {
  startedBy: string | null;
  dryRunId?: string | null;
  phases?: Phase[];
  budgetMs?: number;
}

export type StartImportResult =
  | { ok: true; runId: string }
  | { ok: false; status: 412; error: string; needsDryRun: true };

/**
 * Create an import run — after the dry-run gate.
 *
 * The gate is owner requirement 7 in code: nothing is written until the
 * owner has SEEN the match report (`report_viewed_at`) for THIS realm and
 * THIS environment, and confirmed a cutover AFTER that dry run finished.
 *
 * The only exemption is a phase set inside {pdfs, attachments_fetch,
 * repair}: each of those merely finishes rows an already-gated import
 * created, and the first two are gated again by `ledgerPdfsEnabled`.
 * `reports` is deliberately NOT exempt — it writes fresh financial rows.
 */
export async function startImport(service: SupabaseClient, input: StartImportInput): Promise<StartImportResult> {
  const conn = await readConnection(service);
  const phases = input.phases && input.phases.length > 0 ? input.phases : ALL_PHASES;
  const gateFree = phases.every(p => GATE_FREE_PHASES.includes(p));

  const settings = await readLedgerSettings(service);
  const cutoverDate = settings.cutover?.date ?? null;

  if (!gateFree) {
    const refusal = (why: string): StartImportResult => ({ ok: false, status: 412, error: why, needsDryRun: true });
    if (!input.dryRunId) {
      return refusal('Run a dry run first, read the report, then confirm the cutover — see docs/ledger-import.md §1–2.');
    }
    const { data: dry } = await service
      .from('ledger_import_runs')
      .select('id, mode, status, realm_id, config, report_viewed_at, finished_at')
      .eq('id', input.dryRunId)
      .maybeSingle();
    if (!dry || dry.mode !== 'dry_run') return refusal('That dryRunId is not a dry run.');
    // A dry run that stopped at its deadline has walked SOME of the
    // customers, and its report covers only those. Owner requirement 7 is
    // that the owner approves the whole picture, so an unfinished run is not
    // a gate — and `finished_at` being null is exactly what would make the
    // `confirmedAt > finished_at` comparison below vacuously true.
    if (!dry.finished_at || dry.status !== 'complete') {
      return refusal('That dry run has not finished — re-run it to completion first.');
    }
    if (!dry.report_viewed_at) return refusal('That dry-run report has not been marked as read.');
    if (String(dry.realm_id) !== maskRealm(conn.realmId)) {
      return refusal('That dry run was taken against a different QuickBooks company.');
    }
    if ((dry.config as any)?.environment !== conn.environment) {
      return refusal('That dry run was taken against a different QuickBooks environment.');
    }
    const confirmedAt = settings.cutover?.confirmedAt;
    if (!confirmedAt) return refusal('The cutover date has not been confirmed.');
    // Unconditional now that `finished_at` is guaranteed present above.
    if (new Date(confirmedAt).getTime() <= new Date(dry.finished_at).getTime()) {
      return refusal('The cutover was confirmed before this dry run finished — confirm it again against this report.');
    }
  }

  const { data, error } = await service
    .from('ledger_import_runs')
    .insert({
      source: 'quickbooks',
      mode: 'import',
      status: 'running',
      realm_id: maskRealm(conn.realmId),
      started_by: input.startedBy,
      phase: phases[0],
      cursor: { phase: phases[0] },
      dry_run_id: input.dryRunId ?? null,
      config: {
        environment: conn.environment,
        phases,
        cutoverDate,
        reportsFrom: null,
        budgetMs: input.budgetMs ?? DEFAULT_BUDGET_MS,
      },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Could not start the import: ${error?.message || 'no row returned'}`);

  await logAudit(service, {
    actorId: input.startedBy,
    table: 'ledger_import_runs',
    recordId: String(data.id),
    action: 'ledger_import_started',
    detail: { runId: String(data.id), phases, cutoverDate, dryRunId: input.dryRunId ?? null },
  });
  return { ok: true, runId: String(data.id) };
}

// ═══════════ SMALL MODES ═══════════

/**
 * Stamp "the owner has read this report".
 *
 * It only means anything about a COMPLETED dry run: this stamp is one of the
 * three things `startImport` checks, and stamping a still-`running` dry run
 * (or an import run) would let the driver walk dry-run(partial) →
 * report-viewed → confirm-cutover → import against a report that covers a
 * fraction of the customers. The page's button already requires `complete`;
 * the script and the route go through here.
 */
export async function markReportViewed(
  service: SupabaseClient,
  runId: string,
  userId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: run } = await service
    .from('ledger_import_runs')
    .select('id, mode, status')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return { ok: false, error: 'unknown_dry_run — no dry run has that id' };
  if (run.mode !== 'dry_run') return { ok: false, error: 'That runId is not a dry run.' };
  if (run.status !== 'complete') {
    return { ok: false, error: 'That dry run has not finished — re-run it to completion first.' };
  }
  await patchRun(service, runId, {
    report_viewed_at: new Date().toISOString(),
    report_viewed_by: userId,
  });
  return { ok: true };
}

export async function cancelRun(service: SupabaseClient, runId: string, userId: string | null): Promise<void> {
  await patchRun(service, runId, {
    status: 'cancelled',
    finished_at: new Date().toISOString(),
    lease_until: null,
  });
  await logAudit(service, {
    actorId: userId,
    table: 'ledger_import_runs',
    recordId: runId,
    action: 'ledger_import_cancelled',
    detail: { runId },
  });
}

/**
 * Write the one gate-free object so the owner can prove the R2 privacy flip
 * took BEFORE any financial byte is stored (docs/r2-private-flip.md step 3).
 */
export async function probeR2(service: SupabaseClient): Promise<Record<string, unknown>> {
  const result = await putLedgerObject(
    service,
    LEDGER_PROBE_PATH,
    Buffer.from('FleetSuite ledger probe — if this loads from the public domain the R2 privacy flip is NOT done\n'),
    'text/plain',
    { probe: true },
  );
  const publicBase = (process.env.R2_PUBLIC_URL || '').trim();
  return {
    ok: result.ok,
    key: `ledger/${LEDGER_PROBE_PATH}`,
    existed: result.ok ? result.existed : false,
    error: result.ok ? undefined : result.error,
    // The URL the owner must request and find BLOCKED. null means the custom
    // domain step has not been done yet, which is a different answer from
    // "the object is private".
    publicUrlToTest: publicBase ? `${publicBase.replace(/\/$/, '')}/ledger/${LEDGER_PROBE_PATH}` : null,
    ...(publicBase
      ? {}
      : { note: 'R2_PUBLIC_URL is unset — set the custom domain first (docs/r2-private-flip.md step 1)' }),
  };
}

/** The four tables whose `post_cutover` flag a confirmed date re-stamps. */
const CUTOVER_TABLES: { table: string; dateCol: string }[] = [
  { table: 'ledger_invoices', dateCol: 'doc_date' },
  { table: 'ledger_bills', dateCol: 'doc_date' },
  { table: 'ledger_journal_entries', dateCol: 'doc_date' },
  // This table's date column is payment_date; there is no doc_date on it.
  { table: 'ledger_payments', dateCol: 'payment_date' },
];

export interface ConfirmCutoverResult {
  ok: boolean;
  partial?: boolean;
  restamped?: number;
  date: string;
  nextHint?: string;
  error?: string;
}

/**
 * Confirm the cutover date and re-stamp `post_cutover`.
 *
 * CHUNKED, never one unbounded UPDATE pair. After a full history import
 * these are the four biggest tables and none carries a `(source, doc_date)`
 * index (`idx_ledger_invoices_date` is `(doc_date DESC, id)`), so a bulk
 * UPDATE is the classic PostgREST statement timeout. Instead: enumerate the
 * ids whose stored flag DISAGREES with the new date, then update them in
 * batches of 200 against the same deadline machinery an import chunk uses.
 * The `.neq` is what makes a re-run a no-op, so the mode is freely
 * repeatable.
 */
export async function confirmCutover(
  service: SupabaseClient,
  input: { dryRunId: string; date: string; userId: string | null; deadline: number },
): Promise<ConfirmCutoverResult> {
  // The stored cutover and its audit row must name a dry run that EXISTS.
  // `startImport`'s 412 gate re-reads the dry run by id, so a bogus value
  // could never open the gate — but it could sit in `app_settings` and in
  // `ledger_cutover_confirmed` pointing at nothing, which is the same wall
  // the attach action puts up with `unknown_customer`.
  const { data: dryRun } = await service
    .from('ledger_import_runs')
    .select('id, mode')
    .eq('id', input.dryRunId)
    .maybeSingle();
  if (!dryRun || dryRun.mode !== 'dry_run') {
    // Machine-readable first, then the fix — both the script and the page
    // print this string verbatim.
    return {
      ok: false,
      error: 'unknown_dry_run — no dry run has that id; run --mode dry-run and read its report first',
      date: input.date,
    };
  }

  const settings = await readLedgerSettings(service);
  const restamped0 = settings.cutover?.date && settings.cutover.date !== input.date;
  const next = {
    ...settings,
    cutover: {
      date: input.date,
      // NULLABLE on purpose: the import route is cron-kind, so a run driven
      // with `Authorization: Bearer $CRON_SECRET` has no session user.
      confirmedBy: input.userId,
      confirmedAt: new Date().toISOString(),
      dryRunId: input.dryRunId,
    },
  };
  const { error: settingsError } = await service
    .from('app_settings')
    .upsert({ key: LEDGER_SETTINGS_KEY, value: next }, { onConflict: 'key' });
  if (settingsError) throw new Error(`Could not store the cutover date: ${settingsError.message}`);

  await logAudit(service, {
    actorId: input.userId,
    table: 'app_settings',
    recordId: LEDGER_SETTINGS_KEY,
    action: 'ledger_cutover_confirmed',
    detail: { date: input.date, dryRunId: input.dryRunId, restamped: !!restamped0 },
  });

  let restamped = 0;
  let partial = false;
  let error: string | undefined;

  for (const { table, dateCol } of CUTOVER_TABLES) {
    for (const target of [true, false]) {
      if (Date.now() >= input.deadline) { partial = true; break; }
      const { data, error: readError } = await fetchAllRows<{ id: string }>((from, to) => {
        let q = service.from(table).select('id').eq('source', 'quickbooks').neq('post_cutover', target);
        q = target ? q.gte(dateCol, input.date) : q.lt(dateCol, input.date);
        return q.order('id').range(from, to);
      });
      if (readError) {
        // 57014 is a statement timeout — surfaced as a partial, never a 500.
        error = `${table}: ${readError.message}`;
        partial = true;
        break;
      }
      for (let i = 0; i < data.length; i += 200) {
        if (Date.now() >= input.deadline) { partial = true; break; }
        const batch = data.slice(i, i + 200).map(r => r.id);
        const { error: writeError } = await service.from(table).update({ post_cutover: target }).in('id', batch);
        if (writeError) { error = `${table}: ${writeError.message}`; partial = true; break; }
        restamped += batch.length;
      }
    }
    if (partial) break;
  }

  return {
    ok: true,
    partial,
    restamped,
    date: input.date,
    ...(partial ? { nextHint: 're-run --mode confirm-cutover with the same date' } : {}),
    ...(error ? { error } : {}),
  };
}

// ═══════════ THE CHUNK LOOP ═══════════

interface ChunkState {
  service: SupabaseClient;
  client: QboClient;
  run: any;
  runId: string;
  deadline: number;
  cursor: Cursor;
  counts: Counts;
  events: EventRow[];
  eventCap: { seen: number; max: 5000 };
  lastErrors: string[];
  apiCalls: number;
  customerIndex: CustomerIndexRow[] | null;
  dryRunReport: Partial<DryRunReport> | null;
  tempUris: Map<string, string>;
}

/** The page-write view of a chunk — same objects, by reference. */
function pageCtx(s: ChunkState): PageWriteCtx {
  return {
    service: s.service,
    runId: s.runId,
    cutoverDate: s.run.config?.cutoverDate ?? null,
    phase: s.cursor.phase ?? null,
    counts: s.counts,
    events: s.events,
    errors: s.lastErrors,
    tempUris: s.tempUris,
  };
}

/**
 * Everything a PAGE WRITE needs, and nothing more.
 *
 * The bulk importer builds this from its `ChunkState`; the daily change sync
 * (§2.8) builds one directly, so a CDC page goes through the SAME machinery
 * — headers, then lines, then applications, then `stampSynced`, then the PDF
 * placeholder rows and the customer links. A sync that upserted only headers
 * would leave an edited invoice's stored lines contradicting its own total,
 * forever: `repair` only looks at rows whose `lines_synced_at IS NULL`, and
 * a header-only upsert never clears that stamp.
 */
export interface PageWriteCtx {
  service: SupabaseClient;
  runId: string;
  /** `config.cutoverDate`; null before the owner has confirmed one. */
  cutoverDate: string | null;
  /** Phase name stamped on the events this page raises. */
  phase: string | null;
  counts: Counts;
  events: EventRow[];
  errors: string[];
  /**
   * Attachable id → `TempDownloadUri`, held IN MEMORY for this chunk only.
   *
   * The URI is short-lived (minutes) and `DROP_KEY_RE` strips it from the
   * stored `raw` on purpose, so the documented fallback in `client.download`
   * can only ever work when the index page and the fetch happen in the same
   * chunk — which is exactly what spec §2.2 says ("both in the same chunk —
   * short-lived"). Reading it back out of `raw` would always be null.
   */
  tempUris: Map<string, string>;
}

const bump = (counts: Counts, entity: string, key: string, by = 1) => {
  const c = (counts[entity] ||= {});
  c[key] = (Number(c[key]) || 0) + by;
};

/**
 * Persist the cursor BEFORE the fetch it describes, along with the mirror
 * pointer. The order is the point: the row names the page we are ABOUT to
 * ask for, so a kill mid-fetch resumes on the same page rather than skipping
 * it.
 */
async function checkpoint(s: ChunkState, partial: boolean): Promise<void> {
  await patchRun(s.service, s.runId, {
    cursor: s.cursor,
    phase: s.cursor.phase ?? null,
    counts: s.counts,
    api_calls: s.apiCalls + s.client.stats().calls,
  });
  if (s.run.mode !== 'dry_run') {
    await writeImportPointer(s.service, {
      runId: s.runId,
      mode: s.run.mode === 'cdc' ? 'cdc' : 'import',
      phase: s.cursor.phase ?? null,
      entity: s.cursor.entity ?? null,
      processed: s.cursor.processed ?? 0,
      expected: s.cursor.expected ?? null,
      status: 'running',
      partial,
      startPosition: s.cursor.startPosition,
    });
  }
}

async function flushEvents(s: ChunkState): Promise<void> {
  // A dry run writes NO events at all (§2.6) — the whole point is that it
  // leaves the ledger untouched.
  if (s.run.mode === 'dry_run' || s.events.length === 0) {
    s.events = [];
    return;
  }
  await appendEvents(s.service, s.runId, s.events, s.eventCap);
  s.events = [];
}

/** The phases this run will actually walk, in order. */
function phaseList(run: any): Phase[] {
  const configured: Phase[] | undefined = run.config?.phases;
  if (run.mode === 'dry_run') return ['connect', 'customers', 'finalize'];
  if (!configured || configured.length === 0) return ALL_PHASES;
  const chosen = new Set(configured);
  // Always keep connect and finalize: one establishes the client, the other
  // closes the run out. Neither writes ledger data.
  return ALL_PHASES.filter(p => p === 'connect' || p === 'finalize' || chosen.has(p));
}

function nextPhase(run: any, current: Phase | undefined): Phase | null {
  const list = phaseList(run);
  const i = current ? list.indexOf(current) : -1;
  return i >= 0 && i + 1 < list.length ? list[i + 1] : i < 0 ? list[0] : null;
}

/**
 * One bounded slice of an import (or a dry run, or a CDC sweep).
 *
 * Every phase returns as soon as the deadline passes, leaving a cursor that
 * names exactly where to pick up. `partial: true` is the NORMAL answer for a
 * stopped-early chunk — never `error`, which the driver would treat as a
 * failure worth stopping for.
 */
export async function runImportChunk(
  service: SupabaseClient,
  runId: string,
  opts: { deadline: number },
): Promise<ChunkResult> {
  const run = await loadRun(service, runId);

  // The connection read is the FIRST thing that can fail, and its failure is
  // the one the run row has to agree with: a super admin who disconnected
  // QuickBooks between chunks must not leave a run sitting `running` with a
  // live lease and a null error while the driver gets a 401 (§2.5 Errors).
  // So mark it failed here rather than letting the throw sail past.
  let conn;
  try {
    conn = await readConnection(service);
    if (run.config?.environment && run.config.environment !== conn.environment) {
      throw new Error('This run was started against a different QuickBooks environment.');
    }
  } catch (e: any) {
    const message = String(e?.message || e);
    const reconnect = message === NO_QBO_TOKEN || message === QBO_NOT_CONNECTED;
    await patchRun(service, runId, {
      status: 'failed',
      error: reconnect ? 'reconnect QuickBooks — Settings → Company' : message.slice(0, 500),
      lease_until: null,
    }).catch(() => undefined);
    throw e;
  }

  const client = createQboClient(service, { runId });
  const s: ChunkState = {
    service,
    client,
    run,
    runId,
    deadline: Math.min(opts.deadline, Date.now() + HARD_DEADLINE_MS),
    cursor: (run.cursor && typeof run.cursor === 'object' ? run.cursor : {}) as Cursor,
    counts: (run.counts && typeof run.counts === 'object' ? run.counts : {}) as Counts,
    events: [],
    eventCap: await newEventCap(service, runId),
    lastErrors: [],
    apiCalls: Number(run.api_calls) || 0,
    customerIndex: null,
    dryRunReport: (run.report && typeof run.report === 'object' ? run.report : null) as Partial<DryRunReport> | null,
    tempUris: new Map(),
  };
  if (!s.cursor.phase) s.cursor.phase = phaseList(run)[0];

  const startedAt = Date.now();
  let complete = false;
  let partial = false;
  let retryAfterMs: number | undefined;
  let failure: string | undefined;
  /** Set when the connection died MID-chunk: rethrown after the run is marked failed. */
  let reconnectError: unknown;

  try {
    while (Date.now() < s.deadline) {
      const phase = s.cursor.phase as Phase;
      if (!phase) { complete = true; break; }

      const done = await runPhase(s, phase);
      await flushEvents(s);
      if (!done) { partial = true; break; }
      if (phase === 'finalize') { complete = true; break; }

      const next = nextPhase(run, phase);
      if (!next) { complete = true; break; }
      s.cursor = { phase: next };
      await checkpoint(s, false);
    }
    if (!complete && Date.now() >= s.deadline) partial = true;
  } catch (e: any) {
    const message = String(e?.message || e);
    if (e instanceof QboApiError && e.throttled) {
      // Not a failure — QuickBooks asked us to slow down. Cursor intact.
      partial = true;
      retryAfterMs = 30_000;
    } else if (message === QBO_REFRESH_BUSY) {
      partial = true;
      retryAfterMs = 5_000;
    } else if (message === NO_QBO_TOKEN || message === QBO_NOT_CONNECTED) {
      // Marked failed below, then RETHROWN so the route answers the
      // documented 401 { needsAuth: true } — the same shape a connection
      // that was already gone before the chunk started gets. §2.5's Errors
      // paragraph asks for one answer, not two shapes for one cause.
      failure = 'reconnect QuickBooks — Settings → Company';
      reconnectError = e;
    } else if (e instanceof QboApiError) {
      // A non-throttle API error on a page/count/cdc/report fetch FAILS the
      // run with the Fault text and an INTACT cursor: the page is re-fetched
      // on resume. Never a 500, never a silently empty page.
      failure = `${e.message}${e.code ? ` (${e.code})` : ''}`;
    } else {
      failure = message.slice(0, 500);
    }
    if (failure) s.lastErrors.push(failure);
    await flushEvents(s).catch(() => undefined);
  }

  const status = failure ? 'failed' : complete ? 'complete' : 'running';
  await patchRun(s.service, runId, {
    cursor: s.cursor,
    phase: s.cursor.phase ?? null,
    counts: s.counts,
    api_calls: s.apiCalls + client.stats().calls,
    status,
    error: failure ?? null,
    lease_until: null,
    ...(complete || failure ? {} : {}),
    ...(complete ? { finished_at: new Date().toISOString() } : {}),
    ...(s.dryRunReport ? { report: s.dryRunReport } : {}),
  });

  if (run.mode !== 'dry_run') {
    await writeImportPointer(s.service, {
      runId,
      mode: run.mode === 'cdc' ? 'cdc' : 'import',
      phase: s.cursor.phase ?? null,
      entity: s.cursor.entity ?? null,
      processed: s.cursor.processed ?? 0,
      expected: s.cursor.expected ?? null,
      status,
      partial,
      startPosition: s.cursor.startPosition,
    });
  }

  // The run row and the cursor mirror now agree with reality (failed,
  // resumable, cursor intact) — the caller still needs the documented 401.
  if (reconnectError) throw reconnectError;

  const eventSummary = await summarizeEvents(service, runId, run.mode);
  const settings = await readLedgerSettings(service).catch(() => ({}));
  // Probes that SETTLED during this chunk (orderById, queryTotalCount,
  // pdf[<Entity>], cdc, attachableDownload) are written to
  // quickbooks_tokens.capabilities by the client, so the pre-chunk snapshot
  // in `conn` is already stale by the time we answer. Re-read it — this
  // response is where the driver and the page learn what settled.
  const capabilities = await readConnection(service)
    .then(c => c.capabilities)
    .catch(() => conn.capabilities);

  return {
    runId,
    mode: run.mode,
    status,
    phase: s.cursor.phase ?? null,
    entity: s.cursor.entity ?? null,
    complete,
    partial,
    progress: {
      processed: s.cursor.processed ?? 0,
      expected: s.cursor.expected ?? null,
      apiCalls: s.apiCalls + client.stats().calls,
      elapsedMs: Date.now() - startedAt,
    },
    counts: s.counts,
    events: eventSummary,
    lastErrors: s.lastErrors.slice(0, 10),
    cutover: (settings as any)?.cutover ?? null,
    report: s.dryRunReport ?? null,
    capabilities,
    nextHint: failure
      ? 'fix the cause, then --mode resume --run <id>'
      : complete
        ? 'done'
        : '--mode resume --run <id>',
    ...(retryAfterMs ? { retryAfterMs } : {}),
    ...(failure ? { error: failure } : {}),
  };
}

/**
 * The three phases that FINISH what a change sweep started — run by the daily
 * sync (§2.8) once its window has drained and there is budget left.
 *
 * A CDC change sends the document's stored PDF back to `pending` (its bytes
 * are now the old version) and a killed page can leave children unstamped.
 * Without this pass those rows would sit pending until somebody remembered to
 * run `--phases pdfs,attachments_fetch,repair` by hand. It is deliberately
 * deadline-bounded and never fails the caller's run: leftover work simply
 * stays queued in the rows themselves for tomorrow.
 */
export async function runFollowUpPhases(
  service: SupabaseClient,
  runId: string,
  opts: { deadline: number; client?: QboClient },
): Promise<{ counts: Counts; partial: boolean; errors: string[] }> {
  const run = await loadRun(service, runId);
  const s: ChunkState = {
    service,
    client: opts.client ?? createQboClient(service, { runId }),
    run,
    runId,
    deadline: Math.min(opts.deadline, Date.now() + HARD_DEADLINE_MS),
    cursor: { phase: 'pdfs' },
    counts: {},
    events: [],
    eventCap: await newEventCap(service, runId),
    lastErrors: [],
    apiCalls: Number(run.api_calls) || 0,
    customerIndex: null,
    dryRunReport: null,
    tempUris: new Map(),
  };

  let partial = false;
  for (const phase of ['pdfs', 'attachments_fetch', 'repair'] as Phase[]) {
    if (Date.now() >= s.deadline) { partial = true; break; }
    s.cursor.phase = phase;
    const done = await runPhase(s, phase);
    await flushEvents(s);
    if (!done) { partial = true; break; }
  }
  return { counts: s.counts, partial, errors: s.lastErrors.slice(0, 10) };
}

async function summarizeEvents(
  service: SupabaseClient,
  runId: string,
  mode: string,
): Promise<Record<string, number>> {
  if (mode === 'dry_run') return {};
  const outcomes = ['error', 'skipped', 'dropped_field', 'voided', 'deleted', 'unsupported', 'unmatched', 'ambiguous'];
  const summary: Record<string, number> = {};
  await Promise.all(
    outcomes.map(async outcome => {
      // Head count, never a row select — the events table is unbounded.
      const { count } = await service
        .from('ledger_import_events')
        .select('id', { count: 'exact', head: true })
        .eq('run_id', runId)
        .eq('outcome', outcome);
      if (count) summary[outcome] = count;
    }),
  );
  return summary;
}

// ═══════════ PHASES ═══════════

/** Returns true when the phase finished; false when the deadline stopped it. */
async function runPhase(s: ChunkState, phase: Phase): Promise<boolean> {
  switch (phase) {
    case 'connect': return phaseConnect(s);
    case 'reference': return phaseWalk(s, REFERENCE_ENTITIES, 1000);
    case 'customers': return s.run.mode === 'dry_run' ? phaseDryRunCustomers(s) : phaseWalk(s, ['Customer'], 1000);
    case 'match': return phaseMatch(s);
    case 'transactions': return phaseWalk(s, TRANSACTION_ENTITIES, 200);
    case 'attachments_index': return phaseWalk(s, ['Attachable'], 1000);
    case 'pdfs': return phaseDocuments(s, 'pdf');
    case 'attachments_fetch': return phaseDocuments(s, 'attachment');
    case 'reports': return phaseReports(s);
    case 'repair': return phaseRepair(s);
    case 'finalize': return phaseFinalize(s);
    default: return true;
  }
}

/** Establish the connection facts the report and the run row carry. */
async function phaseConnect(s: ChunkState): Promise<boolean> {
  await checkpoint(s, false);
  const info = await s.client.companyInfo();
  const conn = await readConnection(s.service);
  if (s.run.mode === 'dry_run') {
    // THE COUNTS ARE THE GATE the owner approves (owner item 7), so they are
    // never allowed to come back short and silent: a missing key simply does
    // not render, and `plan.estimatedApiCalls` is computed from this map. The
    // walk therefore carries a cursor and RESUMES, exactly like every other
    // phase, instead of breaking out and declaring the phase done.
    const entities = ['Customer', ...TRANSACTION_ENTITIES];
    const counts: Record<string, number | null> = {
      ...((s.dryRunReport?.counts as Record<string, number | null> | undefined) ?? {}),
    };
    let countIndex = s.cursor.countIndex ?? 0;
    while (countIndex < entities.length) {
      if (Date.now() >= s.deadline) {
        s.cursor.countIndex = countIndex;
        s.dryRunReport = { ...(s.dryRunReport || {}), counts };
        await patchRun(s.service, s.runId, { report: s.dryRunReport, cursor: s.cursor });
        return false;
      }
      await checkpoint(s, true);
      counts[entities[countIndex]] = await s.client.count(entities[countIndex]);
      countIndex += 1;
      s.cursor.countIndex = countIndex;
    }
    // Counts are complete and stored; pick the cutover probes up next chunk
    // rather than half-running them now.
    if (Date.now() >= s.deadline) {
      s.dryRunReport = { ...(s.dryRunReport || {}), counts };
      await patchRun(s.service, s.runId, { report: s.dryRunReport, cursor: s.cursor });
      return false;
    }

    const warnings: string[] = [];
    const qboLastByType: Record<string, string | null> = {};
    let orderByTxnDateSupported = true;
    for (const entity of ['Invoice', 'Payment', 'SalesReceipt', 'Bill']) {
      const r = await s.client.latestTxnDate(entity);
      qboLastByType[entity] = r.date;
      if (!r.supported) orderByTxnDateSupported = false;
    }
    if (!orderByTxnDateSupported) {
      warnings.push(
        'QuickBooks refused ORDERBY TxnDate — last-transaction dates could not be derived; confirm the cutover from the NetSuite side',
      );
    }

    const ns = await netsuiteFirstInvoiceDate(s.service);
    if (ns.warning) warnings.push(ns.warning);

    const postCutoverCounts: Record<string, number | null> = {};
    if (ns.date) {
      let ranOut = false;
      for (const entity of ['Invoice', 'Payment', 'Bill', 'JournalEntry']) {
        if (ranOut || Date.now() >= s.deadline) {
          // NULL and named, never absent: an omitted key would read as
          // "nothing after the cutover".
          postCutoverCounts[entity] = null;
          ranOut = true;
          continue;
        }
        postCutoverCounts[entity] = await s.client.count(entity, `TxnDate >= '${ns.date}'`);
      }
      if (ranOut) {
        warnings.push('Post-cutover counts are incomplete — the chunk ran out of time; re-run the dry run to fill them in.');
      }
    }

    const gate = await ledgerPdfsEnabled(s.service);
    const reportsFrom = Number(s.run.config?.reportsFrom) || new Date().getUTCFullYear() - 1;
    const plan = estimatePlan(counts, ALL_PHASES, REPORT_PLAN(reportsFrom, new Date().getUTCFullYear()).length);

    s.dryRunReport = {
      ...(s.dryRunReport || {}),
      company: {
        name: info.companyName,
        companyInfoProbe: info.probe,
        realmMasked: maskRealm(conn.realmId),
        environment: conn.environment,
        minorVersion: conn.minorVersion || '73',
      },
      capabilities: conn.capabilities,
      counts,
      cutover: deriveCutover({
        qboLastByType,
        netsuiteFirstTrandate: ns.date,
        orderByTxnDateSupported,
        netsuiteSource: ns.source,
        postCutoverCounts,
      }),
      plan,
      pdfGate: { enabled: gate.enabled, reason: gate.reason },
      warnings,
    };
    await patchRun(s.service, s.runId, { report: s.dryRunReport });
  }
  return true;
}

/**
 * The page walker used by reference, customers, transactions and the
 * attachment index.
 *
 * Page size adapts: it starts big and HALVES (floor 50) whenever a page took
 * over 40 s or sanitized to more than 8 MB, and the new size rides in the
 * cursor. A realm with enormous invoices would otherwise time out on the
 * same page forever.
 */
async function phaseWalk(s: ChunkState, entities: string[], initialPageSize: number): Promise<boolean> {
  let index = s.cursor.entityIndex ?? 0;
  while (index < entities.length) {
    const entity = entities[index];
    s.cursor.entity = entity;
    s.cursor.entityIndex = index;
    s.cursor.pageSize ??= initialPageSize;
    s.cursor.startPosition ??= 1;

    if (s.cursor.expected == null) {
      await checkpoint(s, true);
      s.cursor.expected = await s.client.count(entity);
    }

    for (;;) {
      if (Date.now() >= s.deadline) return false;
      // Cursor first, fetch second.
      await checkpoint(s, true);
      const started = Date.now();
      const page: QboPage<any> = await s.client.page<any>(
        entity, null, s.cursor.startPosition ?? 1, s.cursor.pageSize ?? initialPageSize,
      );
      s.cursor.orderBy = page.orderBy;
      const items: any[] = page.items;

      const bytes = await writePage(pageCtx(s), entity, items);

      const tookMs = Date.now() - started;
      if ((tookMs > 40_000 || bytes > 8 * 1024 * 1024) && (s.cursor.pageSize ?? initialPageSize) > 50) {
        s.cursor.pageSize = Math.max(50, Math.floor((s.cursor.pageSize ?? initialPageSize) / 2));
      }

      s.cursor.startPosition = (s.cursor.startPosition ?? 1) + items.length;
      s.cursor.processed = (s.cursor.processed ?? 0) + items.length;
      // A short page is the end of the entity — QuickBooks returns fewer
      // rows than asked for only when there are no more.
      if (items.length < (s.cursor.pageSize ?? initialPageSize)) break;
    }

    index += 1;
    s.cursor.entityIndex = index;
    s.cursor.startPosition = 1;
    s.cursor.expected = null;
    await checkpoint(s, true);
  }
  s.cursor.entity = null;
  return true;
}

/**
 * Sanitize → map → upsert one page. Returns the sanitized byte size.
 *
 * EXPORTED because the daily change sync (§2.8) writes its CDC and paged
 * pages through exactly this, rather than a second header-only path.
 */
export async function writePage(ctx: PageWriteCtx, entity: string, items: any[]): Promise<number> {
  if (items.length === 0) return 0;

  const cutoverDate: string | null = ctx.cutoverDate;
  const headersByTable = new Map<SlashKeyedTable, Record<string, unknown>[]>();
  const linesByExternal = new Map<string, Record<string, unknown>[]>();
  const appsByExternal = new Map<string, Record<string, unknown>[]>();
  const docRows: Record<string, unknown>[] = [];
  const droppedNames = new Set<string>();
  let bytes = 0;

  for (const item of items) {
    const { clean, dropped } = sanitizeQboPayload(entity, item);
    for (const d of dropped) droppedNames.add(d);
    bytes += JSON.stringify(clean).length;

    // The ONE moment `TempDownloadUri` is both present and valid. It never
    // reaches the database (the sanitizer drops it, and it would be stale
    // by the time anything read it back); it lives in this chunk's memory so
    // `client.download`'s documented fallback is reachable when the index
    // and the fetch happen in the same invocation.
    if (entity === 'Attachable' && item?.Id && typeof item?.TempDownloadUri === 'string') {
      ctx.tempUris.set(String(item.Id), item.TempDownloadUri);
    }

    let mapped;
    try {
      mapped = mapEntityRow(entity, item, clean, ctx.runId);
    } catch (e: any) {
      bump(ctx.counts, entity, 'errors');
      ctx.events.push({
        phase: ctx.phase,
        entityType: entity,
        externalId: item?.Id ? `${entity}/${item.Id}` : null,
        outcome: 'error',
        message: String(e?.message || e).slice(0, 500),
      });
      continue;
    }
    if (!mapped) {
      ctx.events.push({
        phase: ctx.phase,
        entityType: entity,
        externalId: item?.Id ? `${entity}/${item.Id}` : null,
        outcome: 'unsupported',
        message: `${entity} has no ledger table`,
      });
      continue;
    }

    const header = mapped.mapped.header as Record<string, unknown>;
    const externalId = String(header.external_id);

    // Post-cutover rows are KEPT and FLAGGED, never dropped — they are real
    // history that also exists in NetSuite. Counted, not evented, so the
    // 5,000-event cap stays free for exceptions.
    const docDate = String(header.doc_date ?? header.payment_date ?? '');
    if (cutoverDate && docDate) {
      const post = docDate >= cutoverDate;
      header.post_cutover = post;
      if (post) bump(ctx.counts, entity, 'postCutover');
    }
    if (header.voided === true) bump(ctx.counts, entity, 'voided');

    const list = headersByTable.get(mapped.table as SlashKeyedTable) || [];
    list.push(header);
    headersByTable.set(mapped.table as SlashKeyedTable, list);
    if (mapped.mapped.lines?.length) linesByExternal.set(externalId, mapped.mapped.lines);
    if (mapped.mapped.applications?.length) appsByExternal.set(externalId, mapped.mapped.applications);
    if (mapped.mapped.documents?.length) docRows.push(...mapped.mapped.documents);
    bump(ctx.counts, entity, 'mapped');
  }

  if (droppedNames.size > 0) {
    // The NAMES of the dropped keys, never their values — this row is
    // reader-visible (appendEvents re-sanitizes anyway).
    ctx.events.push({
      phase: ctx.phase,
      entityType: entity,
      externalId: null,
      outcome: 'dropped_field',
      message: `dropped at intake: ${[...droppedNames].join(', ')}`,
      raw: { dropped: [...droppedNames] },
    });
  }

  // Customer pages only: remember rows whose display name CHANGED at source
  // before the upsert overwrites it, so their grade can be reset afterwards.
  let renamed: string[] = [];
  if (entity === 'Customer') {
    renamed = await detectRenamedCustomers(ctx.service, headersByTable.get('ledger_customers') || []);
  }

  const idsByExternal = new Map<string, string>();
  for (const [table, rows] of headersByTable) {
    // The Attachable index lands here rather than in writeDocumentRows, and
    // its mapper stamps 'pending' on every row — see dropStoredDocuments.
    const writable = table === 'ledger_documents' ? await dropStoredDocuments(ctx.service, rows) : rows;
    if (writable.length === 0) continue;
    const { ids, errors } = await upsertRows(ctx.service, table, writable, { onConflict: 'source,external_id' });
    for (const [k, v] of ids) idsByExternal.set(k, v);
    for (const err of errors) {
      bump(ctx.counts, entity, 'errors');
      ctx.errors.push(`${err.external_id}: ${err.message}`);
      ctx.events.push({
        phase: ctx.phase,
        entityType: entity,
        externalId: err.external_id,
        outcome: 'error',
        message: err.message,
      });
    }
  }

  if (renamed.length > 0) {
    for (const e of await resetCustomerGrades(ctx.service, renamed)) ctx.errors.push(e);
  }

  await writeChildren(ctx, entity, headersByTable, linesByExternal, appsByExternal, idsByExternal);

  if (docRows.length > 0) await writeDocumentRows(ctx, docRows);
  if (entity === 'Attachable') await resolveAttachmentParents(ctx, headersByTable.get('ledger_documents') || []);
  if (entity !== 'Customer') await resolveCustomerLinks(ctx, headersByTable);

  return bytes;
}

/**
 * Point each attachment at the ledger row it hangs on.
 *
 * Grouped by `entity_table` and chunked at 100: a 1,000-row Attachable page
 * must never become one 1,000-id `.in()` in the request URL. A parent that is
 * not mirrored (yet, or at all) leaves `entity_row_id` NULL rather than
 * dropping the attachment — the file is real even when its owner is not here.
 */
async function resolveAttachmentParents(ctx: PageWriteCtx, docs: Record<string, unknown>[]): Promise<void> {
  const byTable = new Map<string, string[]>();
  for (const doc of docs) {
    const table = String(doc.entity_table ?? 'none');
    const externalId = doc.entity_external_id ? String(doc.entity_external_id) : '';
    if (table === 'none' || !externalId) continue;
    const list = byTable.get(table) || [];
    list.push(externalId);
    byTable.set(table, list);
  }

  for (const [table, externalIds] of byTable) {
    const idByExternal = new Map<string, string>();
    for (let i = 0; i < externalIds.length; i += 100) {
      const { data } = await ctx.service
        .from(table)
        .select('id, external_id')
        .eq('source', 'quickbooks')
        .in('external_id', externalIds.slice(i, i + 100));
      for (const row of data || []) idByExternal.set(String(row.external_id), String(row.id));
    }

    // Grouped by TARGET, then `.in()` at 100: several attachments commonly
    // hang on the same invoice, and one UPDATE per attachment would be up to
    // 1,000 sequential round trips for a single Attachable page — the
    // difference between a chunk that fits its budget and one that keeps
    // halving its page size.
    const externalIdsByParent = new Map<string, string[]>();
    for (const [externalId, parentId] of idByExternal) {
      const list = externalIdsByParent.get(parentId) || [];
      list.push(externalId);
      externalIdsByParent.set(parentId, list);
    }
    for (const [parentId, refs] of externalIdsByParent) {
      for (let i = 0; i < refs.length; i += 100) {
        const { error } = await ctx.service
          .from('ledger_documents')
          .update({ entity_row_id: parentId })
          .eq('source', 'quickbooks')
          .eq('kind', 'attachment')
          .in('entity_external_id', refs.slice(i, i + 100));
        if (error) ctx.errors.push(`attachment parent link: ${error.message}`);
      }
    }
  }
}

/**
 * A QuickBooks customer renamed at source has to go back through matching:
 * the name is what the grade was made on. A `manual` or `ignored` decision
 * is a HUMAN's answer and is never reset — and neither is a row still
 * `pending`, which has no grade to lose.
 */
async function detectRenamedCustomers(
  service: SupabaseClient,
  headers: Record<string, unknown>[],
): Promise<string[]> {
  const externalIds = headers.map(h => String(h.external_id));
  const incoming = new Map(headers.map(h => [String(h.external_id), String(h.display_name ?? '')]));
  const renamed: string[] = [];
  for (let i = 0; i < externalIds.length; i += 100) {
    const batch = externalIds.slice(i, i + 100);
    const { data } = await service
      .from('ledger_customers')
      .select('id, external_id, display_name, match_status')
      .eq('source', 'quickbooks')
      .in('external_id', batch);
    for (const row of data || []) {
      if (['manual', 'ignored', 'pending'].includes(String(row.match_status))) continue;
      if (String(row.display_name) !== incoming.get(String(row.external_id))) renamed.push(String(row.id));
    }
  }
  return renamed;
}

/** Send the renamed rows back to the review queue. Returns write failures. */
async function resetCustomerGrades(service: SupabaseClient, ids: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await service
      .from('ledger_customers')
      .update({
        match_status: 'pending',
        customer_id: null,
        customer_netsuite_id: null,
        match_reason: 'display name changed at source',
        candidates: [],
        matched_at: null,
      })
      .in('id', ids.slice(i, i + 100));
    if (error) errors.push(`rename reset: ${error.message}`);
  }
  return errors;
}

async function writeChildren(
  ctx: PageWriteCtx,
  entity: string,
  headersByTable: Map<SlashKeyedTable, Record<string, unknown>[]>,
  linesByExternal: Map<string, Record<string, unknown>[]>,
  appsByExternal: Map<string, Record<string, unknown>[]>,
  idsByExternal: Map<string, string>,
): Promise<void> {
  for (const table of headersByTable.keys()) {
    const child = childTableFor(table);
    if (child && linesByExternal.size > 0) {
      const byParent = new Map<string, Record<string, unknown>[]>();
      for (const [externalId, lines] of linesByExternal) {
        const parentId = idsByExternal.get(externalId);
        if (!parentId) continue;
        byParent.set(parentId, lines.map(l => ({ ...l, [child.parentCol]: parentId })));
      }
      if (byParent.size > 0) {
        const { errors } = await replaceChildren(ctx.service, child.table, child.parentCol, byParent);
        for (const e of errors) ctx.errors.push(e);
        // Stamp only AFTER the children landed — a chunk killed between the
        // two leaves the parent pending and `repair` picks it up.
        if (errors.length === 0) await stampSynced(ctx.service, table, 'lines_synced_at', [...byParent.keys()]);
      }
    }
    if (table === 'ledger_payments' && appsByExternal.size > 0) {
      const byParent = new Map<string, Record<string, unknown>[]>();
      for (const [externalId, apps] of appsByExternal) {
        const parentId = idsByExternal.get(externalId);
        if (!parentId) continue;
        byParent.set(parentId, apps.map(a => ({ ...a, payment_id: parentId })));
      }
      if (byParent.size > 0) {
        const { errors } = await replaceChildren(ctx.service, 'ledger_payment_applications', 'payment_id', byParent);
        for (const e of errors) ctx.errors.push(e);
        if (errors.length === 0) {
          await stampSynced(ctx.service, 'ledger_payments', 'applications_synced_at', [...byParent.keys()]);
        }
      }
    }
  }
  void entity;
}

/**
 * Drop the rows whose document is ALREADY stored in R2.
 *
 * Both paths that write `ledger_documents` need this, and for the same
 * reason: their mappers emit `status: 'pending'` unconditionally, so an
 * upsert would walk a stored row back to pending — losing the reader access
 * (`GET /api/ledger/documents/[id]` answers 409 for a non-stored row) and
 * making the next documents phase re-download and re-PUT bytes that are
 * already in the bucket. The PDF placeholders go through
 * `writeDocumentRows`; the Attachable index goes through the generic page
 * upsert, and re-running THAT phase is the only way new attachments ever
 * arrive (sync.ts deliberately leaves Attachable out of the daily CDC), so
 * without this the reset recurs by design on every attachment sweep.
 */
async function dropStoredDocuments(
  service: PageWriteCtx['service'],
  docRows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (docRows.length === 0) return docRows;
  const ids = docRows.map(d => String(d.external_id));
  const stored = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await service
      .from('ledger_documents')
      .select('external_id, status')
      .eq('source', 'quickbooks')
      .in('external_id', ids.slice(i, i + 100));
    for (const row of data || []) if (row.status === 'stored') stored.add(String(row.external_id));
  }
  return docRows.filter(d => !stored.has(String(d.external_id)));
}

/** PDF placeholder rows — never resetting one that is already stored. */
async function writeDocumentRows(ctx: PageWriteCtx, docRows: Record<string, unknown>[]): Promise<void> {
  const fresh = await dropStoredDocuments(ctx.service, docRows);
  if (fresh.length === 0) return;
  const { errors } = await upsertRows(ctx.service, 'ledger_documents', fresh, { onConflict: 'source,external_id' });
  for (const e of errors) ctx.errors.push(`${e.external_id}: ${e.message}`);
}

/**
 * Point transaction rows at the FleetSuite customer their QuickBooks
 * customer already resolved to, so a page of invoices is joined once rather
 * than per row.
 */
async function resolveCustomerLinks(
  ctx: PageWriteCtx,
  headersByTable: Map<SlashKeyedTable, Record<string, unknown>[]>,
): Promise<void> {
  for (const table of ['ledger_invoices', 'ledger_payments'] as SlashKeyedTable[]) {
    const rows = headersByTable.get(table);
    if (!rows?.length) continue;
    const partyIds = [...new Set(rows.map(r => String(r.party_external_id ?? '')).filter(Boolean))];
    if (partyIds.length === 0) continue;

    const byExternal = new Map<string, { id: string; customer_id: string | null; customer_netsuite_id: string | null }>();
    for (let i = 0; i < partyIds.length; i += 100) {
      const { data } = await ctx.service
        .from('ledger_customers')
        .select('id, external_id, customer_id, customer_netsuite_id')
        .eq('source', 'quickbooks')
        .in('external_id', partyIds.slice(i, i + 100));
      for (const row of data || []) {
        byExternal.set(String(row.external_id), {
          id: String(row.id),
          customer_id: row.customer_id,
          customer_netsuite_id: row.customer_netsuite_id,
        });
      }
    }
    if (byExternal.size === 0) continue;

    // One UPDATE per distinct customer, not per row.
    for (const [externalId, link] of byExternal) {
      const targets = rows.filter(r => r.party_external_id === externalId).map(r => String(r.external_id));
      if (targets.length === 0) continue;
      for (let i = 0; i < targets.length; i += 100) {
        const { error } = await ctx.service
          .from(table)
          .update({
            ledger_customer_id: link.id,
            customer_id: link.customer_id,
            customer_netsuite_id: link.customer_netsuite_id,
          })
          .eq('source', 'quickbooks')
          .in('external_id', targets.slice(i, i + 100));
        if (error) ctx.errors.push(`${table} customer link: ${error.message}`);
      }
    }
  }
}

/** The dry run's Customer walk: grade in memory, write nothing. */
async function phaseDryRunCustomers(s: ChunkState): Promise<boolean> {
  const pageSize = s.cursor.pageSize ?? 1000;
  s.cursor.entity = 'Customer';
  s.cursor.startPosition ??= 1;
  if (!s.customerIndex) s.customerIndex = await loadCustomerIndex(s.service);

  for (;;) {
    if (Date.now() >= s.deadline) return false;
    await checkpoint(s, true);
    const page: QboPage<any> = await s.client.page<any>('Customer', null, s.cursor.startPosition ?? 1, pageSize);
    s.cursor.orderBy = page.orderBy;

    const parties: GradedParty[] = [];
    const grades: (MatchGrade | null)[] = [];
    const staged: { party: GradedParty }[] = [];
    for (const row of page.items) {
      const { clean } = sanitizeQboPayload('Customer', row);
      const mapped = mapEntityRow('Customer', row, clean, null);
      if (!mapped) continue;
      const header = mapped.mapped.header as Record<string, any>;
      staged.push({
        party: {
          externalId: String(header.external_id),
          displayName: String(header.display_name),
          cleanedName: String(header.cleaned_name),
        },
      });
    }

    // A row a HUMAN already decided (attached by hand, or ignored) is not
    // re-graded and never lands in ambiguous/unmatched: a second dry run
    // taken after the review queue has been worked would otherwise read as
    // though those decisions had come undone. This is the only thing the
    // `alreadyManual` bucket counts, and reading it here is what makes it
    // non-zero — no ledger row is written, so the dry run stays read-only.
    const decided = await alreadyDecidedCustomers(s.service, staged.map(x => x.party.externalId));
    for (const { party } of staged) {
      if (decided.has(party.externalId)) {
        parties.push({ ...party, alreadyManual: true });
        grades.push(null);
        continue;
      }
      parties.push(party);
      grades.push(gradeInMemory(s.customerIndex, party));
    }

    const previous = (s.dryRunReport?.customers as DryRunCustomers | undefined) ?? undefined;
    s.dryRunReport = {
      ...(s.dryRunReport || {}),
      customers: buildMatchReport(parties, grades, previous),
    };
    await patchRun(s.service, s.runId, { report: s.dryRunReport });

    s.cursor.startPosition = (s.cursor.startPosition ?? 1) + page.items.length;
    s.cursor.processed = (s.cursor.processed ?? 0) + page.items.length;
    if (page.items.length < pageSize) break;
  }

  // The four buckets ALWAYS sum to the total, and `truncated` caps only the
  // row list — the owner's decision rests on the counts being complete.
  const customers = s.dryRunReport?.customers;
  const extraWarnings: string[] = [];
  if (customers && customers.rows.length >= DRY_RUN_ROW_CAP) {
    extraWarnings.push(
      `Only the first ${DRY_RUN_ROW_CAP.toLocaleString()} customer rows are listed in detail; the bucket counts cover all ${customers.total.toLocaleString()}.`,
    );
  }

  // THE REAL INVARIANT, checked where both numbers exist: the buckets sum to
  // the rows we walked, and the walk should have covered every Customer
  // QuickBooks counted. A short page mid-walk would otherwise produce a
  // report that looks internally consistent (buckets sum to total) while
  // hundreds of customers were never graded at all.
  const expected = (s.dryRunReport?.counts as Record<string, number | null> | undefined)?.Customer;
  if (customers && typeof expected === 'number' && expected !== customers.total) {
    extraWarnings.push(
      `Graded ${customers.total.toLocaleString()} customers but QuickBooks counts ${expected.toLocaleString()} — ` +
      `${Math.abs(expected - customers.total).toLocaleString()} were not walked. Re-run the dry run before importing.`,
    );
  }

  if (extraWarnings.length > 0) {
    s.dryRunReport = {
      ...(s.dryRunReport || {}),
      warnings: [...((s.dryRunReport?.warnings as string[]) || []), ...extraWarnings],
    };
  }
  return true;
}

/**
 * Which of these QuickBooks customers a human has already decided.
 *
 * `manual` (attached by hand) and `ignored` are the two grades the importer
 * never touches — §2.5 step 5 skips them, and step 4 never resets them. The
 * dry run has to skip them too, or its report tells the owner their own
 * decisions came undone. Chunked at 100 like every other `.in()` read.
 */
async function alreadyDecidedCustomers(
  service: SupabaseClient,
  externalIds: string[],
): Promise<Set<string>> {
  const decided = new Set<string>();
  for (let i = 0; i < externalIds.length; i += 100) {
    const { data } = await service
      .from('ledger_customers')
      .select('external_id, match_status')
      .eq('source', 'quickbooks')
      .in('external_id', externalIds.slice(i, i + 100));
    for (const row of data || []) {
      if (['manual', 'ignored'].includes(String(row.match_status))) decided.add(String(row.external_id));
    }
  }
  return decided;
}

/**
 * Persist grades for `pending` QuickBooks customers, then backfill the
 * transactions that already point at them.
 *
 * `manual` and `ignored` rows are never touched — they are not `pending`,
 * and the rename detector above never resets them either.
 */
async function phaseMatch(s: ChunkState): Promise<boolean> {
  if (!s.customerIndex) s.customerIndex = await loadCustomerIndex(s.service);

  for (;;) {
    if (Date.now() >= s.deadline) return false;
    await checkpoint(s, true);

    let q = s.service
      .from('ledger_customers')
      .select('id, external_id, display_name, cleaned_name, email, phone')
      .eq('source', 'quickbooks')
      .eq('match_status', 'pending')
      .order('id')
      .limit(50);
    if (s.cursor.matchAfter) q = q.gt('id', s.cursor.matchAfter);
    const { data, error } = await q;
    if (error) throw new Error(`match phase read failed: ${error.message}`);
    const batch = data || [];
    if (batch.length === 0) break;

    const linked: string[] = [];
    for (const row of batch) {
      const grade = gradeInMemory(s.customerIndex, {
        displayName: String(row.display_name || ''),
        cleanedName: String(row.cleaned_name || ''),
      });
      const now = new Date().toISOString();

      if (grade.status === 'exact' || grade.status === 'cleaned') {
        await s.service
          .from('ledger_customers')
          .update({
            match_status: grade.status,
            customer_id: grade.customer.id,
            customer_netsuite_id: grade.customer.netsuite_id,
            match_reason: grade.reason,
            matched_at: now,
          })
          .eq('id', row.id);
        linked.push(String(row.id));
        bump(s.counts, 'Customer', grade.status);
      } else {
        const { candidates, described } = await candidatesFor(s.service, {
          cleanedName: String(row.cleaned_name || row.display_name || ''),
          email: row.email,
          phone: row.phone,
        });
        const status = grade.status === 'ambiguous' ? 'ambiguous' : 'unmatched';
        await s.service
          .from('ledger_customers')
          .update({
            match_status: status,
            match_reason: grade.status === 'ambiguous' ? grade.reason : 'no confident match',
            // Every candidate here is a `customers` row — candidatesFor
            // resolves or drops prospects hits, so the reviewer can never be
            // offered an id the FK would reject.
            candidates: candidates.map((c, i) => ({
              customerId: c.id,
              companyName: c.company_name,
              netsuiteId: c.netsuite_id,
              why: described[i] ?? null,
            })),
            matched_at: null,
          })
          .eq('id', row.id);
        bump(s.counts, 'Customer', status);
        s.events.push({
          phase: 'match',
          entityType: 'Customer',
          externalId: String(row.external_id),
          outcome: status,
          message: grade.status === 'ambiguous' ? grade.reason : 'no confident match',
        });
      }
      s.cursor.matchAfter = String(row.id);
    }

    if (linked.length > 0) await backfillLinkedTransactions(s, linked);
    s.cursor.processed = (s.cursor.processed ?? 0) + batch.length;
  }
  return true;
}

/**
 * Push a freshly graded customer's app ids onto the transactions that point
 * at it (spec §2.5 step 5).
 *
 * Grouped by TARGET value and issued as `.in()` batches of 100, not one pair
 * of UPDATEs per customer: a 50-row match batch would otherwise be 100
 * sequential round trips against the two biggest tables.
 */
async function backfillLinkedTransactions(s: ChunkState, ledgerCustomerIds: string[]): Promise<void> {
  // key = `${customer_id}\0${customer_netsuite_id ?? ''}` — the pair
  // being written; value = the ledger_customers ids that take it.
  const byTarget = new Map<string, { customerId: string; netsuiteId: string | null; ids: string[] }>();

  for (let i = 0; i < ledgerCustomerIds.length; i += 100) {
    const batch = ledgerCustomerIds.slice(i, i + 100);
    const { data } = await s.service
      .from('ledger_customers')
      .select('id, customer_id, customer_netsuite_id')
      .in('id', batch);
    for (const row of data || []) {
      if (!row.customer_id) continue;
      const customerId = String(row.customer_id);
      const netsuiteId = row.customer_netsuite_id == null ? null : String(row.customer_netsuite_id);
      const key = `${customerId}\0${netsuiteId ?? ''}`;
      const entry = byTarget.get(key) || { customerId, netsuiteId, ids: [] };
      entry.ids.push(String(row.id));
      byTarget.set(key, entry);
    }
  }

  for (const { customerId, netsuiteId, ids } of byTarget.values()) {
    for (const table of ['ledger_invoices', 'ledger_payments']) {
      for (let i = 0; i < ids.length; i += 100) {
        const { error } = await s.service
          .from(table)
          .update({ customer_id: customerId, customer_netsuite_id: netsuiteId })
          .in('ledger_customer_id', ids.slice(i, i + 100));
        if (error) s.lastErrors.push(`${table} backfill: ${error.message}`);
      }
    }
  }
}

/**
 * Fetch document bytes — PDFs, then attachments.
 *
 * Gated by `ledgerPdfsEnabled` (owner item 4): with the gate shut this phase
 * records ONE skipped event and a count that names the runbook, rather than
 * failing or silently doing nothing. `putLedgerObject` enforces the same
 * gate itself, so a future caller cannot route around this check.
 */
async function phaseDocuments(s: ChunkState, kind: 'pdf' | 'attachment'): Promise<boolean> {
  const gate = await ledgerPdfsEnabled(s.service);
  if (!gate.enabled) {
    s.counts[kind === 'pdf' ? 'pdfs' : 'attachments'] = {
      skipped: 'LEDGER_PDFS_ENABLED not set — verify docs/r2-private-flip.md first',
    };
    s.events.push({
      phase: s.cursor.phase ?? null,
      entityType: kind === 'pdf' ? 'pdf' : 'Attachable',
      externalId: null,
      outcome: 'skipped',
      message: gate.reason,
    });
    return true;
  }

  const limit = kind === 'pdf' ? 40 : 25;
  const unsupportedTypes = new Set<string>();
  // A document this chunk already tried is not tried again in the same
  // chunk: the queue re-read would hand back the row that just failed, and
  // re-running a failing fetch immediately spends the budget discovering the
  // same failure. It stays `pending` for the next invocation, which is what
  // `attempts` (3, then `failed`) is counting.
  const attemptedThisChunk = new Set<string>();
  // Set once `capabilities.attachableDownload` settles false: the whole
  // pending queue has just been written off, so there is nothing left to walk.
  let attachmentsUnsupported = false;
  let slowestMs = 1_000;
  const budgetLeft = () => s.deadline - Date.now();

  for (;;) {
    // Headroom: stop before a fetch that plausibly cannot finish, rather
    // than being killed halfway through an upload.
    if (budgetLeft() < Math.max(15_000, 1.5 * slowestMs)) return false;
    await checkpoint(s, true);

    const { data, error } = await s.service
      .from('ledger_documents')
      .select('id, external_ref, entity_type, file_name, content_type, raw, attempts, fetched_at')
      .eq('source', 'quickbooks')
      .eq('kind', kind)
      .eq('status', 'pending')
      .order('first_seen_at')
      .order('id')
      .limit(limit);
    if (error) throw new Error(`document queue read failed: ${error.message}`);
    const queue = (data || []).filter(
      d => !unsupportedTypes.has(String(d.entity_type)) && !attemptedThisChunk.has(String(d.id)),
    );
    if (queue.length === 0) return true;
    for (const d of queue) attemptedThisChunk.add(String(d.id));

    // Four at a time: enough to hide the round trip, few enough that the
    // limiter never becomes the bottleneck.
    for (let i = 0; i < queue.length; i += 4) {
      if (budgetLeft() < Math.max(15_000, 1.5 * slowestMs)) return false;
      const slice = queue.slice(i, i + 4);
      await Promise.all(slice.map(async doc => {
        const started = Date.now();
        try {
          const entityType = String(doc.entity_type || '');
          const result = kind === 'pdf'
            ? await s.client.pdf(entityPath(entityType), String(doc.external_ref))
            // In-memory only — see PageWriteCtx.tempUris. Reading the URI
            // back out of the stored `raw` would always be null (the
            // sanitizer strips it) and stale even if it were not.
            : await s.client.download(String(doc.external_ref), s.tempUris.get(String(doc.external_ref)) ?? null);

          if (!result.ok && 'unsupported' in result) {
            if (kind === 'pdf') {
              // `capabilities.pdf[<Entity>]` is per entity type, so the
              // write-off is too.
              unsupportedTypes.add(entityType);
              await markPdfTypeUnsupported(s, entityType, result.reason);
            } else if ((result as { scope?: string }).scope === 'capability') {
              // `attachableDownload` is a GLOBAL capability: QuickBooks has
              // no download path for THIS realm, so every pending attachment
              // is unsupported regardless of which entity it hangs on.
              attachmentsUnsupported = true;
              await markAttachmentsUnsupported(s, result.reason);
            } else {
              // One document QuickBooks will not hand over (no download path
              // for it). Not evidence about any other row.
              await markOneUnsupported(s, doc, result.reason);
            }
            return;
          }
          if (!result.ok) {
            await failDocument(s, doc, result.error);
            return;
          }
          if (kind === 'attachment' && result.bytes.byteLength > 25 * 1024 * 1024) {
            await s.service.from('ledger_documents')
              .update({ status: 'failed', error: 'too large', attempts: (Number(doc.attempts) || 0) + 1 })
              .eq('id', doc.id);
            bump(s.counts, 'attachments', 'failed');
            return;
          }

          const path = ledgerStoragePath(
            'quickbooks',
            kind === 'pdf' ? String(doc.entity_type) : 'Attachable',
            String(doc.external_ref),
            String(doc.file_name),
          );
          // A RE-FETCH must replace the object, not skip it. The key is
          // `<Entity>/<Id>/<Entity>_<DocNumber|Id>.pdf` — unchanged when an
          // edit moved only the amounts — so the existence short-circuit
          // would leave the PRE-edit bytes in the bucket while this row went
          // on to claim the new digest. A row that has ever been fetched
          // (CDC sends it back to `pending` with `storage_path` NULL but
          // keeps `fetched_at`) or that is on a retry is a re-fetch.
          const isRefetch = !!doc.fetched_at || (Number(doc.attempts) || 0) > 0;
          const put = await putLedgerObject(
            s.service,
            path,
            result.bytes,
            kind === 'pdf' ? 'application/pdf' : String(doc.content_type || 'application/octet-stream'),
            isRefetch ? { replace: true } : undefined,
          );
          if (!put.ok) {
            await failDocument(s, doc, put.error);
            return;
          }
          await s.service.from('ledger_documents').update({
            storage_path: path,
            sha256: put.sha256,
            size_bytes: put.size,
            status: 'stored',
            error: null,
            fetched_at: new Date().toISOString(),
          }).eq('id', doc.id);
          bump(s.counts, kind === 'pdf' ? 'pdfs' : 'attachments', 'stored');
        } catch (e: any) {
          if (e instanceof QboApiError && e.throttled) throw e;
          await failDocument(s, doc, String(e?.message || e));
        } finally {
          slowestMs = Math.max(slowestMs, Date.now() - started);
        }
      }));
      if (attachmentsUnsupported) return true;
    }
  }
}

/**
 * Write off one PDF entity type. `capabilities.pdf[<Entity>]` is per type, so
 * the sweep is per type — one bulk UPDATE rather than re-probing each row
 * and spending the chunk discovering the same "no".
 */
async function markPdfTypeUnsupported(s: ChunkState, entityType: string, reason: string): Promise<void> {
  const { error } = await s.service
    .from('ledger_documents')
    .update({ status: 'unsupported', error: reason.slice(0, 500) })
    .eq('source', 'quickbooks')
    .eq('kind', 'pdf')
    .eq('status', 'pending')
    .eq('entity_type', entityType);
  if (error) s.lastErrors.push(`unsupported sweep: ${error.message}`);
  s.events.push({
    phase: s.cursor.phase ?? null,
    entityType,
    externalId: null,
    outcome: 'unsupported',
    message: reason.slice(0, 500),
  });
  bump(s.counts, 'pdfs', 'unsupported');
}

/**
 * Write off EVERY pending attachment.
 *
 * `attachableDownload` is a global capability — whether this realm hands
 * bytes back at all — so the axis is the capability, never the parent
 * `entity_type` an attachment happens to hang on. Reached only when the
 * client says the rejection was definitive (400/404/415/501 or a download
 * endpoint that answered something other than a URL); a network blip, a 401
 * or an exhausted 5xx comes back as an error and is retried instead.
 */
async function markAttachmentsUnsupported(s: ChunkState, reason: string): Promise<void> {
  const { error } = await s.service
    .from('ledger_documents')
    .update({ status: 'unsupported', error: reason.slice(0, 500) })
    .eq('source', 'quickbooks')
    .eq('kind', 'attachment')
    .eq('status', 'pending');
  if (error) s.lastErrors.push(`unsupported sweep: ${error.message}`);
  s.events.push({
    phase: s.cursor.phase ?? null,
    entityType: 'Attachable',
    externalId: null,
    outcome: 'unsupported',
    message: reason.slice(0, 500),
  });
  bump(s.counts, 'attachments', 'unsupported');
}

/** One document QuickBooks will not hand over — no claim about any other. */
async function markOneUnsupported(s: ChunkState, doc: any, reason: string): Promise<void> {
  const { error } = await s.service
    .from('ledger_documents')
    .update({ status: 'unsupported', error: reason.slice(0, 500) })
    .eq('id', doc.id);
  if (error) s.lastErrors.push(`unsupported ${doc.id}: ${error.message}`);
  s.events.push({
    phase: s.cursor.phase ?? null,
    entityType: String(doc.entity_type || 'Attachable'),
    externalId: String(doc.external_ref ?? ''),
    outcome: 'unsupported',
    message: reason.slice(0, 500),
  });
  bump(s.counts, 'attachments', 'unsupported');
}

async function failDocument(s: ChunkState, doc: any, message: string): Promise<void> {
  const attempts = (Number(doc.attempts) || 0) + 1;
  await s.service
    .from('ledger_documents')
    .update({ attempts, error: String(message).slice(0, 500), status: attempts >= 3 ? 'failed' : 'pending' })
    .eq('id', doc.id);
  bump(s.counts, 'documents', attempts >= 3 ? 'failed' : 'retrying');
  s.lastErrors.push(`document ${doc.id}: ${message}`);
}

/** Fetch and store the planned report snapshots. */
async function phaseReports(s: ChunkState): Promise<boolean> {
  if (!s.cursor.reportsMaterialized) {
    const from = Number(s.run.config?.reportsFrom) || new Date().getUTCFullYear() - 1;
    const { errors } = await materializeReportPlan(s.service, REPORT_PLAN(from, new Date().getUTCFullYear()), s.runId);
    for (const e of errors) s.lastErrors.push(`report plan: ${e}`);
    s.cursor.reportsMaterialized = true;
    await checkpoint(s, true);
  }

  for (;;) {
    if (Date.now() >= s.deadline) return false;
    await checkpoint(s, true);
    const { data, error } = await s.service
      .from('ledger_report_snapshots')
      .select('id, report_type, params, attempts, period_kind')
      .eq('source', 'quickbooks')
      .eq('status', 'pending')
      .order('id')
      .limit(40);
    if (error) throw new Error(`report queue read failed: ${error.message}`);
    const queue = data || [];
    if (queue.length === 0) return true;

    for (let i = 0; i < queue.length; i += 4) {
      if (Date.now() >= s.deadline) return false;
      await Promise.all(queue.slice(i, i + 4).map(async row => {
        try {
          // As-of reports (aging, balances) take `{ report_date }` and
          // nothing else — spec §2.7. `summarize_column_by` belongs to the
          // period reports, and sending it on an as-of URL is a parameter
          // QuickBooks never asked for.
          const stored = row.params as Record<string, string>;
          const params = row.period_kind === 'as_of'
            ? { ...stored }
            : { ...stored, summarize_column_by: 'Total' };
          const { rawText, json, generatedAt } = await s.client.report(String(row.report_type), params);
          if (rawText.length > REPORT_MAX_BYTES) {
            await s.service.from('ledger_report_snapshots').update({
              status: 'failed',
              error: 'too large — narrow the period',
              attempts: (Number(row.attempts) || 0) + 1,
              payload_raw: null,
            }).eq('id', row.id);
            bump(s.counts, 'reports', 'failed');
            return;
          }
          await s.service.from('ledger_report_snapshots').update({
            payload_raw: rawText,
            sha256: reportSha256(rawText),
            payload: json,
            summary: summarizeReport(json),
            generated_at: generatedAt,
            status: 'stored',
            error: null,
            fetched_at: new Date().toISOString(),
          }).eq('id', row.id);

          const lines = parseReportLines(json).map(l => ({ ...l, snapshot_id: row.id }));
          await s.service.from('ledger_report_lines').delete().eq('snapshot_id', row.id);
          for (let j = 0; j < lines.length; j += 500) {
            const { error: insertError } = await s.service.from('ledger_report_lines').insert(lines.slice(j, j + 500));
            if (insertError) s.lastErrors.push(`report lines: ${insertError.message}`);
          }
          bump(s.counts, 'reports', 'stored');
        } catch (e: any) {
          if (e instanceof QboApiError && e.throttled) throw e;
          // Each report is its own unit — one failure does not fail the run.
          const attempts = (Number(row.attempts) || 0) + 1;
          await s.service.from('ledger_report_snapshots').update({
            attempts,
            error: String(e?.message || e).slice(0, 500),
            status: attempts >= 3 ? 'failed' : 'pending',
            payload_raw: null,
          }).eq('id', row.id);
          bump(s.counts, 'reports', attempts >= 3 ? 'failed' : 'retrying');
          s.lastErrors.push(`report ${row.report_type}: ${String(e?.message || e).slice(0, 200)}`);
        }
      }));
    }
  }
}

/**
 * Finish what the walk left behind: documents whose children never landed,
 * and payment applications whose target was not mirrored yet.
 *
 * BOTH enumerations paginate. The application one especially: there is one
 * row per application over the whole history, and mid-import the NULL-target
 * subset is large BY DESIGN (Invoice is walked before Payment, but
 * CreditMemo and Bill targets still lag). A plain select would stop silently
 * at 1000 and leave the surplus looking unapplied forever.
 */
async function phaseRepair(s: ChunkState): Promise<boolean> {
  const pending: { table: string; col: 'lines_synced_at' | 'applications_synced_at'; entity: string }[] = [
    { table: 'ledger_invoices', col: 'lines_synced_at', entity: 'Invoice' },
    { table: 'ledger_bills', col: 'lines_synced_at', entity: 'Bill' },
    { table: 'ledger_journal_entries', col: 'lines_synced_at', entity: 'JournalEntry' },
    { table: 'ledger_payments', col: 'applications_synced_at', entity: 'Payment' },
  ];

  for (const { table, col, entity } of pending) {
    if (Date.now() >= s.deadline) return false;
    const { data, error } = await fetchAllRows<{ id: string; external_ref: string; external_id: string }>((from, to) =>
      s.service
        .from(table)
        .select('id, external_ref, external_id')
        .eq('source', 'quickbooks')
        .is(col, null)
        .order('id')
        .range(from, to),
    );
    if (error) throw new Error(`repair enumeration failed for ${table}: ${error.message}`);

    // GROUPED BY ENTITY FIRST. One ledger table holds several QuickBooks
    // entities — `ledger_invoices` carries Invoice, CreditMemo, SalesReceipt,
    // RefundReceipt and Estimate — while `Id IN (…)` is scoped to the ONE
    // entity in the FROM clause, and QuickBooks ids are per-entity. Asking
    // Invoice for a CreditMemo's id therefore returns nothing (the row stays
    // unrepaired on every future run) or, worse, an unrelated Invoice that
    // happens to share the number.
    const byEntity = new Map<string, typeof data>();
    for (const row of data) {
      const name = String(row.external_id).split('/')[0] || entity;
      const list = byEntity.get(name) || [];
      list.push(row);
      byEntity.set(name, list);
    }

    for (const [realEntity, rows] of byEntity) {
      for (let i = 0; i < rows.length; i += 30) {
        if (Date.now() >= s.deadline) return false;
        const batch = rows.slice(i, i + 30);
        // Re-fetch by id list: 30 documents in one call instead of 30 calls.
        const inList = batch.map(r => `'${String(r.external_ref).replace(/'/g, "''")}'`).join(',');
        await checkpoint(s, true);
        const page = await s.client.page<any>(realEntity, `Id IN (${inList})`, 1, batch.length);
        await writePage(pageCtx(s), realEntity, page.items);
        bump(s.counts, 'repair', 'refetched', page.items.length);
      }
    }
  }

  // Resolve applications whose target has since been mirrored.
  const { data: unresolved, error: unresolvedError } = await fetchAllRows<{
    id: string; payment_id: string; applied_kind: string; applied_external_id: string;
  }>((from, to) =>
    s.service
      .from('ledger_payment_applications')
      .select('id, payment_id, applied_kind, applied_external_id')
      .is('applied_invoice_id', null)
      .is('applied_bill_id', null)
      // Matches idx_ledger_pay_apps_unresolved, with a unique id tiebreaker.
      .order('applied_external_id')
      .order('id')
      .range(from, to),
  );
  if (unresolvedError) throw new Error(`repair enumeration failed for applications: ${unresolvedError.message}`);

  const invoiceKinds = new Set(['invoice', 'credit_memo']);
  for (let i = 0; i < unresolved.length; i += 100) {
    if (Date.now() >= s.deadline) return false;
    const batch = unresolved.slice(i, i + 100);
    const wantInvoices = batch.filter(r => invoiceKinds.has(r.applied_kind)).map(r => r.applied_external_id);
    const wantBills = batch.filter(r => !invoiceKinds.has(r.applied_kind)).map(r => r.applied_external_id);

    const invoiceIds = new Map<string, string>();
    if (wantInvoices.length > 0) {
      const { data } = await s.service
        .from('ledger_invoices').select('id, external_id').eq('source', 'quickbooks').in('external_id', wantInvoices);
      for (const row of data || []) invoiceIds.set(String(row.external_id), String(row.id));
    }
    const billIds = new Map<string, string>();
    if (wantBills.length > 0) {
      const { data } = await s.service
        .from('ledger_bills').select('id, external_id').eq('source', 'quickbooks').in('external_id', wantBills);
      for (const row of data || []) billIds.set(String(row.external_id), String(row.id));
    }

    for (const row of batch) {
      const invoiceId = invoiceIds.get(row.applied_external_id);
      const billId = billIds.get(row.applied_external_id);
      // A target still not mirrored stays NULL for the next pass — NULL means
      // "not mirrored yet", never "unapplied".
      if (!invoiceId && !billId) continue;
      await s.service
        .from('ledger_payment_applications')
        .update(invoiceId ? { applied_invoice_id: invoiceId } : { applied_bill_id: billId })
        .eq('id', row.id);
      bump(s.counts, 'repair', 'resolved');
    }
  }

  return true;
}

async function phaseFinalize(s: ChunkState): Promise<boolean> {
  const report =
    s.run.mode === 'dry_run'
      ? s.dryRunReport
      : { counts: s.counts, finishedAt: new Date().toISOString(), apiCalls: s.apiCalls + s.client.stats().calls };
  await patchRun(s.service, s.runId, {
    status: 'complete',
    finished_at: new Date().toISOString(),
    report,
    lease_until: null,
  });
  if (s.run.mode !== 'dry_run') {
    await writeImportPointer(s.service, {
      runId: s.runId,
      mode: s.run.mode === 'cdc' ? 'cdc' : 'import',
      phase: 'finalize',
      status: 'complete',
      partial: false,
    });
  }
  // A DRY RUN's complete write set is its own run row, ONE `audit_log` row
  // (`ledger_dry_run`, written by `startDryRun`) and the capabilities merge
  // (§2.6) — nothing else. A second audit row here, and a push to every
  // super admin, would both be writes the mode is defined not to make: the
  // owner runs it precisely to decide whether to import at all.
  if (s.run.mode !== 'dry_run') {
    await logAudit(s.service, {
      actorId: s.run.started_by ?? null,
      table: 'ledger_import_runs',
      recordId: s.runId,
      action: 'ledger_import_finished',
      detail: { runId: s.runId, counts: s.counts, mode: s.run.mode },
    });
    await notifyImportFinished(s.service, s.runId, s.run.mode, s.counts);
  }
  s.cursor = { phase: 'finalize' };
  return true;
}

/**
 * Tell the people who can act on it. NEVER `[startedBy]` alone: a run driven
 * with the cron secret has no session user at all, and the audience for
 * "the ledger import finished" is the System Health audience by the same
 * reasoning the health check uses.
 */
async function notifyImportFinished(
  service: SupabaseClient,
  runId: string,
  mode: string,
  counts: Counts,
): Promise<void> {
  try {
    const audience = await systemHealthAudience(service);
    if (audience.length === 0) return;
    const total = Object.values(counts).reduce((sum: number, c: any) => sum + (Number(c?.mapped) || 0), 0);
    await notifyMany(audience, {
      type: 'ledger_import',
      title: mode === 'cdc' ? 'QuickBooks ledger change sync finished' : 'QuickBooks ledger import finished',
      body: `${total.toLocaleString()} records processed. Open the run to see counts, exceptions and the match buckets.`,
      url: deepLinks.ledgerAdmin({ run: runId }),
      channels: ['in_app', 'push'],
    });
  } catch (e: any) {
    console.error('[ledger] import notification failed:', e?.message || e);
  }
}

/** The failure counterpart, for a run that ended `failed`. */
export async function notifyImportFailed(
  service: SupabaseClient,
  runId: string,
  error: string,
): Promise<void> {
  try {
    const audience = await systemHealthAudience(service);
    if (audience.length === 0) return;
    await notifyMany(audience, {
      type: 'ledger_import',
      title: 'QuickBooks ledger import needs attention',
      body: `The run stopped: ${error.slice(0, 400)}`,
      url: deepLinks.ledgerAdmin({ run: runId }),
      channels: ['in_app', 'push'],
    });
  } catch (e: any) {
    console.error('[ledger] import failure notification failed:', e?.message || e);
  }
}
