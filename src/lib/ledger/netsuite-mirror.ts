import type { SupabaseClient } from '@supabase/supabase-js';
import { getNetSuitePdf, isSuiteqlError, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { compactSuiteqlError } from '@/lib/sales-order-sync';
import { recordHeartbeat } from '@/lib/system-health';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { pingRestlet } from '@/lib/restlet-probe';
import { RESTLET_SPECS } from '@/lib/restlet-versions';
import { safeIntId } from '@/lib/sql-safe';
import { fetchAllRows } from '@/lib/fetch-all';
import { isoDate } from '@/lib/financials-data';
import { sanitizeQboPayload } from '@/lib/quickbooks/sanitize';
import { ledgerPdfsEnabled, readLedgerSettings } from './pdf-gate';
import { ledgerStoragePath, putLedgerObject } from './storage';
import { replaceChildren, stampSynced, upsertRows, writeSyncStateCursor } from './write';

/**
 * The NetSuite half of the one ledger: invoices and credit memos (plus their
 * lines, their PDFs and — behind a permission probe — customer payments and
 * what they were applied to) mirrored into the same `ledger_*` tables the
 * QuickBooks history lands in. Owner item 8; screens read the tables, never
 * this file.
 *
 * Shape is the sales-order sync's, because that job already learned the
 * lessons: a WINDOW of transactions (`lastmodifieddate >= since`) drained
 * NEWEST FIRST in pages, each page written in bulk and followed by a saved
 * cursor, `last_synced_at` advancing only when the window fully drains and
 * only to the time the window was OPENED. What is new here is that the run
 * has five phases with HARD budgets, so a slow phase cannot eat the ones
 * behind it:
 *
 *   (1) headers + lines   150 s   the mirror itself
 *   (2) tombstones         20 s   rows NetSuite no longer returns
 *   (3) payments           30 s   probe, then mirror when permitted
 *   (4) PDFs               25 s   through the PDF RESTlet, R2-gated
 *   (5) repair          the rest  DB-only; the ONE uncapped phase
 *
 * Each capped phase computes `min(now + budget, deadline)` at ITS OWN start,
 * so a phase that drains early donates the remainder to repair rather than
 * to the capped phases between. The defaults sum to 225 s of the 240 s
 * window; the 15 s balance is repair's floor.
 *
 * Repair is uncapped for a reason. Phase (3) writes a
 * `ledger_payment_applications` row with a NULL target whenever the invoice
 * it points at has not been mirrored yet — the NORMAL case while a
 * newest-first window is still draining older invoices. Nothing else in the
 * codebase ever revisits a NetSuite application (§2.5's repair belongs to
 * the QuickBooks importer, needs a QuickBooks client and is scoped to
 * quickbooks rows), so without this phase that row would stay unlinked
 * forever — exactly the state migration 314's COMMENT on the table promises
 * will be repaired.
 *
 * EXACTLY ONE heartbeat per run, at the end. The per-page cursor is a plain
 * `sync_state` upsert (`writeSyncStateCursor`), never `recordHeartbeat`,
 * which would append a `cron_runs` row per page and turn one run into
 * hundreds in the flight recorder.
 *
 * The heartbeat's nested objects use `reason` / `skipped` / `problem` /
 * `samples`. A nested string `error` is what reddens System Health
 * (`errorOf` in system-health.ts walks one level), so it is reserved for
 * real failures — a SuiteQL rejection or a Supabase write failure — which
 * also keep the cursor. "Not permitted" and "gate off" are expected states,
 * not faults.
 */

export const NS_MIRROR_SYNC_TYPE = 'ledger_netsuite_mirror';

/** Where the very first window starts; owner override `app_settings.ledger.netsuite_since`. */
export const FIRST_RUN_SINCE = '2015-01-01T00:00:00Z';

/**
 * `sync_state.last_synced_at` DEFAULTs to this on its first INSERT
 * (migrations/066-sync-state.sql). A partial first run writes a heartbeat
 * with `touchLastSyncedAt: false`, which CREATES the row carrying that
 * default — so reading it back as a watermark would silently move the
 * window forward to 2020 and skip every 2015-2019 transaction. Treated as
 * "no watermark yet".
 */
const SYNC_STATE_DEFAULT_WATERMARK = Date.parse('2020-01-01T00:00:00Z');

/** Headers per SuiteQL page — also the unit of work between deadline checks. */
const NS_PAGE_SIZE = 200;
/** Payment headers per page: fewer, because each page fans out to link rows. */
const PAY_PAGE_SIZE = 100;
/** Transaction ids per line query. */
const LINE_CHUNK = 100;
/** Ids per `.in()` filter — those ride in the request URL. */
const FILTER_CHUNK = 100;
/** Rows per tombstone batch. */
const TOMBSTONE_BATCH = 150;
/** Pending PDF rows pulled per queue read. */
const PDF_QUEUE_LIMIT = 12;
/** PDF fetches in flight. */
const PDF_CONCURRENCY = 2;
/** A single PDF render is the one RESTlet call that can genuinely sit. */
const PDF_TIMEOUT_MS = 40_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };
/** A phase with less than this left is skipped rather than half-run. */
const MIN_PHASE_MS = 2_000;
/** Heartroom before a PDF fetch that plausibly cannot finish (§2.5(8)). */
const PDF_HEADROOM_MS = 15_000;
const DAY_MS = 86_400_000;

/**
 * The cursor a partial run leaves in `sync_state.last_result.resume`.
 *
 * `beforeId` continues the header window (and `windowClosed` says that
 * window is spent); `paymentsBeforeId`, `tombstoneAfter` and `repairAfter`
 * continue the three passes that can outlast one run. `repairAfter` is a
 * COMPOSITE because `applied_external_id` is not unique (two payments may
 * each apply to the same invoice) — see the keyset predicate in phase (5).
 */
export interface NsMirrorResume {
  /** Wall clock when the window was opened — becomes last_synced_at once it drains. */
  windowStartedAt: string;
  /** Lower bound on lastmodifieddate for the window (ISO). */
  since: string;
  /**
   * Continue with NetSuite internal ids strictly below this one.
   *
   * ABSENT means the window is still open but no page has been COMMITTED yet
   * — a run that failed to write its very first page, say. It must NOT be
   * written as `'0'` in that state: `'0'` means "nothing below", so the next
   * run would read one empty page, call the window drained and stamp the
   * watermark past everything the failed run never wrote.
   */
  beforeId?: string;
  /** Headers processed in the window so far. */
  processed: number;
  /**
   * The header window drained AND its watermark was stamped, so the next run
   * opens a FRESH one from that watermark.
   *
   * Without this flag a resume carried purely for a secondary cursor — a
   * tombstone sweep mid-pass is the common case, since it walks the whole
   * mirror 20 s at a time — would pin the header window at its old position,
   * and the mirror would fetch one empty page per run while new and edited
   * NetSuite invoices went unmirrored for hours.
   */
  windowClosed?: true;
  /**
   * Continue the payments pass with CustPymt ids strictly below this one.
   * Without it a 30 s-capped phase re-pages the SAME newest payments on
   * every run and never reaches the older ones — and the moment the header
   * window drains, everything it never reached falls out of scope for good.
   */
  paymentsBeforeId?: string;
  /** Continue the tombstone sweep above this `ledger_invoices.external_ref`. */
  tombstoneAfter?: string;
  /** Continue the repair sweep after this `ledger_payment_applications` row. */
  repairAfter?: { appliedExternalId: string; id: string };
}

export function parseNsMirrorResume(lastResult: unknown): NsMirrorResume | null {
  const r = (lastResult as any)?.resume;
  if (!r || typeof r !== 'object') return null;
  const { windowStartedAt, since, beforeId, processed, windowClosed, paymentsBeforeId, tombstoneAfter, repairAfter } = r;
  if (typeof windowStartedAt !== 'string' || typeof since !== 'string') return null;
  // Absent is a meaning ("this window has committed no page"); a malformed
  // value is not — resuming from one would put a stored string into SQL.
  const hasBeforeId = beforeId !== undefined && beforeId !== null;
  if (hasBeforeId && (typeof beforeId !== 'string' || !/^\d+$/.test(beforeId))) return null;
  if (Number.isNaN(Date.parse(windowStartedAt)) || Number.isNaN(Date.parse(since))) return null;
  const out: NsMirrorResume = {
    windowStartedAt,
    since,
    ...(hasBeforeId ? { beforeId: beforeId as string } : {}),
    processed: Number(processed) || 0,
  };
  if (windowClosed === true) out.windowClosed = true;
  if (typeof paymentsBeforeId === 'string' && /^\d+$/.test(paymentsBeforeId)) out.paymentsBeforeId = paymentsBeforeId;
  if (typeof tombstoneAfter === 'string' && tombstoneAfter) out.tombstoneAfter = tombstoneAfter;
  if (
    repairAfter && typeof repairAfter === 'object'
    && typeof repairAfter.appliedExternalId === 'string' && repairAfter.appliedExternalId
    && typeof repairAfter.id === 'string' && repairAfter.id
  ) {
    out.repairAfter = { appliedExternalId: repairAfter.appliedExternalId, id: repairAfter.id };
  }
  return out;
}

/**
 * The payments verdict the previous run settled, read back defensively.
 *
 * `sync_state.last_result` is data, so every field is re-checked rather than
 * trusted: a malformed blob must degrade to "not probed yet", never to a
 * confident claim about a NetSuite permission.
 */
function carriedPaymentsCapability(lastResult: unknown): NsPaymentsCapability {
  const stored = (lastResult as any)?.capabilities?.payments;
  if (!stored || typeof stored !== 'object') {
    return { permitted: false, linkTable: null, reason: 'not probed yet — the mirror settles this on its next run' };
  }
  const linkTable = stored.linkTable === 'nexttransactionlinelink' || stored.linkTable === 'previoustransactionlinelink'
    ? stored.linkTable
    : null;
  return {
    permitted: !!stored.permitted,
    linkTable,
    reason: typeof stored.reason === 'string' && stored.reason ? stored.reason : null,
  };
}

/** SuiteQL wants MM/DD/YYYY; the window is date-granular by design. */
function toSuiteqlDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/**
 * Header columns this account's SuiteQL may refuse. Each is nice-to-have:
 *
 *   balance      — `foreignamountunpaid`, the open balance. Refused for some
 *                  roles (src/lib/financials-data.ts degrades the same way);
 *                  without it `balance` is 0 for a paid invoice and NULL
 *                  otherwise, never a copy of `total`.
 *   status_label — BUILTIN.DF(status); the raw letter is stored either way.
 *   due          — `duedate`, absent on credit memos anyway.
 *
 * `createdfrom` is deliberately NOT here: SELECTing it on a transaction
 * header answered 500 UNEXPECTED_ERROR on this account (the sales-order
 * sync's 2026-09-02 probe ladder), and the ledger has no use for it.
 */
export const OPTIONAL_HEADER_COLUMNS = {
  balance: 't.foreignamountunpaid AS balance',
  status_label: 'BUILTIN.DF(t.status) AS status_label',
  due: 't.duedate AS duedate',
} as const;
export type NsOptionalColumn = keyof typeof OPTIONAL_HEADER_COLUMNS;
const ALL_OPTIONAL_COLUMNS: readonly NsOptionalColumn[] = ['balance', 'status_label', 'due'];

/** Column sets a run tries on its first page, richest first. */
export const HEADER_COLUMN_LADDER: readonly (readonly NsOptionalColumn[])[] = [
  ['balance', 'status_label', 'due'],
  ['status_label', 'due'],
  ['due'],
  [],
];

/** One page of invoice/credit-memo headers, newest first. */
export function buildHeaderQuery(sinceIso: string, beforeId: string | null, columns: readonly string[]): string {
  const extras = columns
    .filter((c): c is NsOptionalColumn => c in OPTIONAL_HEADER_COLUMNS)
    .map(c => `, ${OPTIONAL_HEADER_COLUMNS[c]}`)
    .join('');
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.tranid, t.trandate, t.otherrefnum, t.status, t.memo, t.type,
             t.foreigntotal AS total, t.entity AS party_external_id,
             c.companyname AS party_name, c.entityid AS party_entity_id, t.lastmodifieddate${extras}
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.type IN ('CustInvc', 'CustCred')
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

/** Lines for a page of transactions. Tax lines are KEPT (line_kind 'tax'). */
export function buildLinesQuery(ids: string[]): string {
  return `
      SELECT tl.transaction AS txn_id, tl.id AS line_id, tl.linesequencenumber,
             tl.item, i.itemid AS item_number, tl.memo AS description,
             tl.quantity, tl.rate, tl.netamount, tl.taxline
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction IN (${ids.join(', ')})
        AND tl.mainline = 'F'
    `;
}

/** One page of customer-payment headers, the same window shape. */
function buildPaymentHeaderQuery(sinceIso: string, beforeId: string | null): string {
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.tranid, t.trandate, t.memo, t.foreigntotal AS total,
             t.entity AS party_external_id, c.companyname AS party_name,
             c.entityid AS party_entity_id, t.lastmodifieddate
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.type = 'CustPymt'
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

/**
 * Which of a batch of mirrored ids NetSuite still returns, and what it calls
 * their status. `label` rides along only when the account accepts
 * BUILTIN.DF — the same column the header ladder settles.
 */
function buildTombstoneQuery(ids: string[], withLabel: boolean): string {
  const label = withLabel ? ', BUILTIN.DF(t.status) AS label' : '';
  return `
      SELECT t.id, t.status${label}
      FROM transaction t
      WHERE t.type IN ('CustInvc', 'CustCred')
        AND t.id IN (${ids.join(', ')})
    `;
}

/**
 * The customer name to show. NetSuite leaves `companyname` NULL on
 * individual-type customers, and a blank party on an invoice is the kind of
 * hole nobody can search — fall through to the entity id, then to the
 * internal id so the column is never empty.
 */
export function nsPartyName(row: {
  party_name: string | null;
  party_entity_id: string | null;
  party_external_id: string | number | null;
}): string {
  const company = String(row.party_name ?? '').trim();
  if (company) return company;
  const entityId = String(row.party_entity_id ?? '').trim();
  if (entityId) return entityId;
  const id = String(row.party_external_id ?? '').trim();
  return id ? `Customer ${id}` : 'Unknown customer';
}

/**
 * What a failing probe actually means. The distinction that matters: a 400
 * is the app asking for something SuiteQL does not understand — an
 * engineering bug — and must NEVER be reported to the owner as a missing
 * NetSuite grant, which would send them adding permissions that change
 * nothing.
 */
export function classifyProbeError(err: unknown): 'not_permitted' | 'query_shape_rejected' | 'transient' | 'unknown' {
  if (isSuiteqlError(err)) {
    const status = err.status;
    if (status === 401 || status === 403) return 'not_permitted';
    if (status === 400) return 'query_shape_rejected';
    if (status === 429 || status >= 500) return 'transient';
    return 'unknown';
  }
  // A network failure or an abort arrives as a plain Error with no status.
  if (err instanceof Error) return 'transient';
  return 'unknown';
}

export interface NsPaymentsCapability {
  permitted: boolean;
  linkTable: 'nexttransactionlinelink' | 'previoustransactionlinelink' | null;
  reason: string | null;
}

/** The heartbeat payload plus the run's control fields. Declared here, nowhere else. */
export interface NsMirrorResult {
  modified: number;
  synced: number;
  lines: number;
  tombstoned: number;
  voided: number;
  repaired: number;
  droppedColumns: string[];
  /**
   * Did THIS run's header query get accepted (the ladder settled)?
   *
   * `droppedColumns: []` alone cannot say so: a run whose header query was
   * refused outright never settles the ladder and falls back to the previous
   * run's list, which on a first run is empty. System Health reads this
   * before it renders "Header and line queries accepted in full", so a role
   * that cannot read CustInvc/CustCred at all can never show up green.
   */
  columnsSettled: boolean;
  capabilities: { payments: NsPaymentsCapability };
  customers: { duplicateNetsuiteIds: number; samples: string[] };
  /** Set only when the sweep refused to act on what it read (see phase (2)). */
  tombstones?: { problem: string };
  pdfs: { stored: number; failed: number; unsupported: number; skipped?: string };
  payments: { mirrored: number; applications: number } | { permitted: false; reason: string };
  partial: boolean;
  resume?: NsMirrorResume;
  error?: string;
}

/**
 * Hard per-phase caps. Exactly ONE phase — repair, the last — is uncapped
 * and takes whatever the earlier phases left. Every other phase runs until
 * `Math.min(Date.now() + budget, deadline)` computed at ITS OWN start, so a
 * phase that drains early donates its unused time to repair (never to the
 * capped phases between). Defaults sum to 225 s of the 240 s window; the
 * 15 s balance is repair's floor.
 */
export interface NsPhaseBudgets {
  headersMs: number;
  tombstonesMs: number;
  paymentsMs: number;
  pdfsMs: number;
  /** Test-only override; in production repair takes the remainder. */
  repairMs?: number;
}

export const NS_PHASE_BUDGETS: NsPhaseBudgets = {
  headersMs: 150_000,
  tombstonesMs: 20_000,
  paymentsMs: 30_000,
  pdfsMs: 25_000,
};

/** `<NsType>` → the `getNetSuitePdf` mode that renders it. */
const PDF_TYPE_FOR: Record<string, 'invoice' | 'creditMemo'> = {
  CustInvc: 'invoice',
  CustCred: 'creditMemo',
};

const NEEDS_RESTLET_ERROR = 'needs the PDF RESTlet update — see docs/netsuite-ledger-grants.md';
const NOT_PERMITTED_REASON = 'not permitted — see docs/netsuite-ledger-grants.md';

const abs = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Math.abs(parseFloat(String(v)));
  return Number.isFinite(n) ? n : null;
};

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** BUILTIN.DF renders '<Type> : <Status>'; the type half is already `doc_type`. */
function statusLabel(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^[^:]+\s:\s(.+)$/);
  return (m ? m[1] : s).trim() || null;
}

/**
 * One SuiteQL header row → the `ledger_invoices` insert shape, handed
 * straight to `upsertRows`. Pure: the caller adds `ledger_customer_id` and
 * `customer_id`, which need database lookups.
 *
 * `balance` is NEVER a copy of `total`. When the account refuses
 * `foreignamountunpaid` the only honest values are 0 for something the
 * status says is paid and NULL — "not reported" — for everything else
 * (migration 314's COMMENT on the column).
 */
export function mapNsHeader(row: any, opts: { balanceColumn: boolean }): Record<string, unknown> {
  const type = String(row.type || '').trim();
  const id = String(row.id);
  const docType = type === 'CustCred' ? 'credit_memo' : 'invoice';
  const label = statusLabel(row.status_label);
  const status = row.status != null && String(row.status).trim() ? String(row.status).trim() : null;
  const paid = docType === 'invoice' ? status === 'B' || /paid/i.test(label || '') : null;
  const reportedBalance = opts.balanceColumn ? abs(row.balance) : null;

  return {
    source: 'netsuite',
    external_id: `${type}/${id}`,
    external_ref: id,
    doc_type: docType,
    doc_number: row.tranid ? String(row.tranid) : null,
    doc_date: isoDate(row.trandate),
    due_date: isoDate(row.duedate),
    party_external_id: row.party_external_id != null ? String(row.party_external_id) : null,
    party_name: nsPartyName(row),
    customer_netsuite_id: row.party_external_id != null ? String(row.party_external_id) : null,
    po_number: row.otherrefnum ? String(row.otherrefnum) : null,
    memo: row.memo ? String(row.memo) : null,
    status,
    status_label: label,
    total: abs(row.total) ?? 0,
    balance: opts.balanceColumn ? reportedBalance : paid === true ? 0 : null,
    paid,
    // The tombstone pass owns `voided` — it is the only thing that reads a
    // status back out of NetSuite for rows already mirrored.
    //
    // `deleted_at` it does NOT own, because its tombstone is INFERRED from
    // absence and absence is not proof: a narrowed SuiteQL role (a
    // subsidiary or segment restriction, or a role edited and later
    // restored) answers with a smaller row set, not an error. The header
    // window is the authority on presence — a transaction NetSuite just
    // returned is by definition not deleted — so re-mirroring clears the
    // tombstone. Without this the row would be hidden from every reader
    // forever while `last_synced_at` kept moving: PostgREST's upsert only
    // sets the columns it is sent, and the sweep's own enumeration filters
    // `deleted_at IS NULL`, so nothing would ever look at it again.
    deleted_at: null,
    post_cutover: false,
    sync_token: row.lastmodifieddate != null ? String(row.lastmodifieddate) : null,
    source_updated_at: row.lastmodifieddate ?? null,
    // The mirror writes no `ledger_import_runs` row; `last_synced_at` (stamped
    // by upsertRows on every write) is the provenance.
    import_run_id: null,
    raw: sanitizeQboPayload('NetSuite', row).clean,
  };
}

/** One SuiteQL line row → the `ledger_invoice_lines` insert shape. */
function mapNsLine(documentId: string, line: any): Record<string, unknown> {
  const taxLine = String(line.taxline ?? '').toUpperCase() === 'T';
  const seq = Number(line.linesequencenumber);
  return {
    document_id: documentId,
    line_external_id: String(line.line_id),
    line_no: Number.isFinite(seq) ? seq : null,
    line_kind: taxLine ? 'tax' : line.item ? 'item' : 'other',
    item_external_id: line.item != null ? String(line.item) : null,
    item_number: line.item_number ? normalizeItemNumber(line.item_number) : null,
    description: line.description ? String(line.description) : null,
    quantity: abs(line.quantity),
    unit_price: abs(line.rate),
    amount: abs(line.netamount) ?? 0,
    raw: sanitizeQboPayload('NetSuite', line).clean,
  };
}

interface PartyResolution {
  /** external_id in ledger_customers → its uuid. */
  ledgerIds: Map<string, string>;
  /** NetSuite customer id → customers.id, or null when unmatched/duplicated. */
  appIds: Map<string, string | null>;
  /** NetSuite customer id → why it did not resolve. */
  reasons: Map<string, string>;
}

/**
 * Mirror the page's customers into `ledger_customers` and resolve each to
 * `customers.id`.
 *
 * The mapper OMITS every match column, exactly like the QuickBooks one, so
 * an upsert can never overwrite a human decision; the grade is applied
 * afterwards and skips rows a person has marked `manual` or `ignored`.
 * A netsuite_id that appears on more than one `customers` row resolves to
 * NULL and is COUNTED (`customers.duplicateNetsuiteIds`) — guessing between
 * duplicates is how history gets attached to the wrong account.
 */
async function mirrorParties(
  service: SupabaseClient,
  rows: any[],
  dupes: { count: number; samples: string[]; seen: Set<string> },
  errors: string[],
): Promise<PartyResolution> {
  const byNsId = new Map<string, any>();
  for (const row of rows) {
    const nsId = row.party_external_id != null ? String(row.party_external_id).trim() : '';
    if (nsId && !byNsId.has(nsId)) byNsId.set(nsId, row);
  }

  const ledgerRows = [...byNsId.entries()].map(([nsId, row]) => {
    const name = nsPartyName(row);
    return {
      source: 'netsuite',
      external_id: `customer/${nsId}`,
      external_ref: nsId,
      display_name: name,
      cleaned_name: name,
      import_run_id: null,
      raw: sanitizeQboPayload('NetSuite', {
        id: nsId,
        companyname: row.party_name ?? null,
        entityid: row.party_entity_id ?? null,
      }).clean,
    };
  });

  const upserted = await upsertRows(service, 'ledger_customers', ledgerRows, { onConflict: 'source,external_id' });
  for (const e of upserted.errors) errors.push(`ledger_customers ${e.external_id}: ${e.message}`);

  // customers.netsuite_id → customers.id, in one read per 100 parties.
  const appIds = new Map<string, string | null>();
  const reasons = new Map<string, string>();
  const nsIds = [...byNsId.keys()];
  const hits = new Map<string, string[]>();
  for (const batch of chunk(nsIds, FILTER_CHUNK)) {
    const { data, error } = await service.from('customers').select('id, netsuite_id').in('netsuite_id', batch);
    if (error) {
      errors.push(`customers lookup: ${error.message}`);
      continue;
    }
    for (const c of data || []) {
      const key = String(c.netsuite_id);
      if (!hits.has(key)) hits.set(key, []);
      hits.get(key)!.push(String(c.id));
    }
  }
  for (const nsId of nsIds) {
    const found = hits.get(nsId) || [];
    if (found.length === 1) {
      appIds.set(nsId, found[0]);
      continue;
    }
    appIds.set(nsId, null);
    if (found.length > 1) {
      reasons.set(nsId, 'duplicate netsuite_id in customers');
      if (!dupes.seen.has(nsId)) {
        dupes.seen.add(nsId);
        dupes.count++;
        if (dupes.samples.length < 5) dupes.samples.push(nsId);
      }
    } else {
      reasons.set(nsId, `no customers row for netsuite_id ${nsId}`);
    }
  }

  // Grade the ledger rows. Resolved parties share the same (customer_id,
  // netsuite_id) target, so they go in one UPDATE per target rather than one
  // per row; `manual`/`ignored` are human decisions no import touches.
  const resolvedByTarget = new Map<string, { customerId: string; nsId: string; ids: string[] }>();
  const unresolved = new Map<string, string[]>();
  const matchedAt = new Date().toISOString();
  for (const nsId of nsIds) {
    const ledgerId = upserted.ids.get(`customer/${nsId}`);
    if (!ledgerId) continue;
    const customerId = appIds.get(nsId) ?? null;
    if (customerId) {
      const key = `${customerId}:${nsId}`;
      const entry = resolvedByTarget.get(key) || { customerId, nsId, ids: [] };
      entry.ids.push(ledgerId);
      resolvedByTarget.set(key, entry);
    } else {
      const reason = reasons.get(nsId) || `no customers row for netsuite_id ${nsId}`;
      const list = unresolved.get(reason) || [];
      list.push(ledgerId);
      unresolved.set(reason, list);
    }
  }

  // One UPDATE per distinct resolved party, deliberately: the grade cannot
  // ride on the bulk upsert above, because `.neq('match_status','manual')`
  // /`'ignored'` is what stops an import from overwriting a human decision
  // and PostgREST has no per-row WHERE on an upsert. The cost is real — a
  // 200-invoice page with 200 distinct customers is 200 sequential
  // round-trips inside the 150 s header budget — and it is the ceiling on
  // how many pages a first-pass backfill drains per run. Accepted knowingly:
  // repeat pages are cheap (a page's parties are usually a handful of
  // fleets), and losing a manual match would be a correctness bug.
  for (const { customerId, nsId, ids } of resolvedByTarget.values()) {
    for (const batch of chunk(ids, FILTER_CHUNK)) {
      const { error } = await service
        .from('ledger_customers')
        .update({
          match_status: 'exact',
          customer_id: customerId,
          customer_netsuite_id: nsId,
          match_reason: `netsuite_id ${nsId} matched customers.netsuite_id`,
          matched_at: matchedAt,
        })
        .in('id', batch)
        .neq('match_status', 'manual')
        .neq('match_status', 'ignored');
      if (error) errors.push(`ledger_customers grade: ${error.message}`);
    }
  }
  // Unresolved parties stay `pending`, never `unmatched`: the review queue is
  // for names a human has to judge, and "customers has no row with this
  // netsuite_id yet" is something the next run may fix by itself.
  //
  // The whole match is cleared with the status, not just the status. A party
  // that used to grade `exact` and no longer resolves — its
  // `customers.netsuite_id` was cleared, or duplicated onto a second row —
  // would otherwise keep pointing at the old customer while claiming to be
  // ungraded, which is how history gets read against the wrong account.
  for (const [reason, ids] of unresolved) {
    for (const batch of chunk(ids, FILTER_CHUNK)) {
      const { error } = await service
        .from('ledger_customers')
        .update({
          match_status: 'pending',
          match_reason: reason,
          customer_id: null,
          customer_netsuite_id: null,
          matched_at: null,
        })
        .in('id', batch)
        .neq('match_status', 'manual')
        .neq('match_status', 'ignored');
      if (error) errors.push(`ledger_customers grade: ${error.message}`);
    }
  }

  return { ledgerIds: upserted.ids, appIds, reasons };
}

interface MirrorWindow {
  windowStartedAt: string;
  since: string;
  beforeId: string | null;
  processed: number;
}

async function openWindow(
  service: SupabaseClient,
  stateRow: { last_synced_at?: string | null } | null,
  resume: NsMirrorResume | null,
): Promise<MirrorWindow> {
  // A resume whose window already CLOSED (drained, watermark stamped) is
  // carrying a secondary cursor only — tombstones, payments or repair. Its
  // header position is spent, so honouring it would pin the mirror to a
  // window that can never return another row: one empty page per run, for as
  // long as a full-table sweep takes to drain, while new invoices piled up.
  if (resume && !resume.windowClosed) {
    return {
      windowStartedAt: resume.windowStartedAt,
      since: resume.since,
      // Absent means "no page of this window has been committed" — start at
      // the top of it again, NOT below id 0.
      beforeId: resume.beforeId ?? null,
      processed: resume.processed,
    };
  }
  const watermark = stateRow?.last_synced_at ? Date.parse(stateRow.last_synced_at) : NaN;
  let start: number;
  if (Number.isFinite(watermark) && watermark > SYNC_STATE_DEFAULT_WATERMARK) {
    start = watermark;
  } else {
    let configured = FIRST_RUN_SINCE;
    try {
      const settings = await readLedgerSettings(service);
      if (settings.netsuite_since && !Number.isNaN(Date.parse(settings.netsuite_since))) {
        configured = new Date(settings.netsuite_since).toISOString();
      }
    } catch {
      // An unreadable settings row is not a reason to skip history.
    }
    start = Date.parse(configured);
  }
  // Overlap one day so edits right around a run are never missed.
  return {
    windowStartedAt: new Date().toISOString(),
    since: new Date(start - DAY_MS).toISOString(),
    beforeId: null,
    processed: 0,
  };
}

export async function runNetSuiteMirror(
  service: SupabaseClient,
  opts: { deadline: number; phaseBudgets?: Partial<NsPhaseBudgets> },
): Promise<NsMirrorResult> {
  const startedAt = Date.now();
  const deadline = opts.deadline;
  const budgets: NsPhaseBudgets = { ...NS_PHASE_BUDGETS, ...(opts.phaseBudgets || {}) };

  const { data: stateRow } = await service
    .from('sync_state')
    .select('last_synced_at, last_result')
    .eq('sync_type', NS_MIRROR_SYNC_TYPE)
    .maybeSingle();
  const lastResult = (stateRow?.last_result ?? null) as Record<string, unknown> | null;
  // Everything the previous run reported EXCEPT its control fields, so a
  // mid-run cursor write keeps `capabilities.payments` and the last counts
  // instead of blanking System Health between pages.
  const baseResult: Record<string, unknown> = { ...(lastResult || {}) };
  delete baseResult.resume;
  delete baseResult.partial;
  delete baseResult.error;
  delete baseResult.updatedAt;

  const resume = parseNsMirrorResume(lastResult);
  const win = await openWindow(service, stateRow ?? null, resume);
  let tombstoneAfter: string | null = resume?.tombstoneAfter ?? null;
  let repairAfter: { appliedExternalId: string; id: string } | null = resume?.repairAfter ?? null;
  // The payments pass is capped at 30 s and pages newest-first, so it takes
  // many runs to walk a decade of CustPymt history. Without this cursor every
  // run would re-page the same newest payments and the older ones would fall
  // out of scope the moment the header window drained.
  let paymentsBeforeId: string | null = resume?.paymentsBeforeId ?? null;

  let modified = 0;
  let synced = 0;
  let lineCount = 0;
  let tombstoned = 0;
  let voided = 0;
  let repaired = 0;
  const dupes = { count: 0, samples: [] as string[], seen: new Set<string>() };
  const pdfs: { stored: number; failed: number; unsupported: number; skipped?: string } =
    { stored: 0, failed: 0, unsupported: 0 };
  let paymentsMirrored = 0;
  let applicationsWritten = 0;
  // Seeded from the LAST run's verdict, not from a blank "not permitted".
  // A run that never reaches the probe (the header query failed, or there
  // was no time) would otherwise publish "not permitted — see runbook" to
  // System Health and send the owner granting a permission they already
  // granted.
  let paymentsCap: NsPaymentsCapability = carriedPaymentsCapability(lastResult);
  const writeErrors: string[] = [];

  /** Optional header columns this account accepts — settled on the first
   *  page inside `fetchHeaderPage`, hence the cast: TS would otherwise
   *  narrow this to its initial null at every read below. */
  let columns = null as readonly NsOptionalColumn[] | null;
  let drained = false;
  let tombstonesDone = true;
  let tombstoneProblem: string | null = null;
  let paymentsDone = true;
  let pdfsDone = true;
  let repairDone = true;
  let error: string | undefined;

  const fail = (message: string) => {
    if (!error) error = message.slice(0, 500);
  };
  const flushWriteErrors = (stage: string) => {
    if (writeErrors.length > 0) fail(`${stage}: ${writeErrors[0]}`);
  };

  const saveCursor = async () => {
    await writeSyncStateCursor(service, NS_MIRROR_SYNC_TYPE, {
      ...baseResult,
      partial: true,
      resume: buildResume(),
    });
  };

  /** Did this run close the window — i.e. is `last_synced_at` about to move? */
  const windowClosed = () => drained && !error && paymentsDone;

  /**
   * `beforeId` is OMITTED while the window has committed no page: absent
   * means "retry this window from the top", and writing the old `'0'`
   * fallback there would tell the next run there is nothing below — it would
   * read one empty page, call the window drained and stamp the watermark
   * past every transaction this run failed to write.
   *
   * `windowClosed` is the opposite signal: the window drained AND its
   * watermark was stamped, so the resume is carrying a secondary cursor only
   * and the next run must open a fresh window rather than re-fetch a spent
   * one.
   */
  const buildResume = (): NsMirrorResume => ({
    windowStartedAt: win.windowStartedAt,
    since: win.since,
    ...(win.beforeId ? { beforeId: win.beforeId } : {}),
    processed: win.processed,
    ...(windowClosed() ? { windowClosed: true as const } : {}),
    ...(paymentsBeforeId ? { paymentsBeforeId } : {}),
    ...(tombstoneAfter ? { tombstoneAfter } : {}),
    ...(repairAfter ? { repairAfter } : {}),
  });

  // ── (1) headers + lines ────────────────────────────────────────────────
  const headersDeadline = Math.min(Date.now() + budgets.headersMs, deadline);
  let stage = 'opening the window';
  let page = 0;

  const fetchHeaderPage = async (): Promise<any[]> => {
    // Settle the optional columns on the FIRST page, richest set first. A
    // rejected column is deterministic, so the ladder's rungs carry no retry
    // budget; only the bare core query (the last rung) does, since a failure
    // there is either transient or real.
    if (columns === null) {
      for (let i = 0; i < HEADER_COLUMN_LADDER.length; i++) {
        const set = HEADER_COLUMN_LADDER[i];
        const lastRung = i === HEADER_COLUMN_LADDER.length - 1;
        try {
          const result = await suiteqlQuery(
            buildHeaderQuery(win.since, win.beforeId, set), NS_PAGE_SIZE, 0, lastRung ? SUITEQL_OPTS : undefined,
          );
          columns = set;
          return result?.items || [];
        } catch (err) {
          // Only a REJECTED SHAPE (400) is evidence that this account will
          // not give us that column. A 429, a 5xx or a 401 says nothing
          // about the SELECT list, and stepping down on one would record
          // "SuiteQL refused foreignamountunpaid" permanently, publish a
          // warn row naming a column the account actually accepts, and
          // write NULL over the page's correct balances. Fail honestly
          // instead — the cursor is intact and the next run retries.
          if (lastRung || classifyProbeError(err) !== 'query_shape_rejected') throw err;
        }
      }
    }
    const result = await suiteqlQuery(buildHeaderQuery(win.since, win.beforeId, columns || []), NS_PAGE_SIZE, 0, SUITEQL_OPTS);
    return result?.items || [];
  };

  if (deadline - Date.now() < MIN_PHASE_MS) {
    // No room even for the first page; leave every cursor exactly as found.
  } else {
    try {
      for (;;) {
        page++;
        stage = `ledger headers, page ${page}${win.beforeId ? ` (ids below ${win.beforeId})` : ''}`;
        const rows = await fetchHeaderPage();
        modified += rows.length;
        if (rows.length === 0) { drained = true; break; }

        const balanceColumn = (columns || []).includes('balance');
        const ids = rows.map(r => safeIntId(r.id, 'transaction id'));

        stage = `ledger lines, page ${page}`;
        const linesByTxn = new Map<string, any[]>();
        for (const batch of chunk(ids, LINE_CHUNK)) {
          const lines = await suiteqlQueryAll(buildLinesQuery(batch), 1000, SUITEQL_OPTS);
          for (const line of lines) {
            const key = String(line.txn_id);
            if (!linesByTxn.has(key)) linesByTxn.set(key, []);
            linesByTxn.get(key)!.push(line);
          }
        }

        stage = `writing ledger page ${page}`;
        const parties = await mirrorParties(service, rows, dupes, writeErrors);

        const headerRows: Record<string, unknown>[] = [];
        for (const row of rows) {
          const mapped = mapNsHeader(row, { balanceColumn });
          if (!mapped.doc_date) {
            // `doc_date` is NOT NULL and a NetSuite transaction always has a
            // trandate; a row without one would sink the page's bulk upsert,
            // so it is left out and shows up as synced < modified.
            console.error('[ledger-ns-mirror] skipping', mapped.external_id, '— no parseable trandate');
            continue;
          }
          const nsCustomerId = String(row.party_external_id ?? '').trim();
          headerRows.push({
            ...mapped,
            ledger_customer_id: nsCustomerId ? parties.ledgerIds.get(`customer/${nsCustomerId}`) ?? null : null,
            customer_id: nsCustomerId ? parties.appIds.get(nsCustomerId) ?? null : null,
          });
        }

        const invoices = await upsertRows(service, 'ledger_invoices', headerRows, { onConflict: 'source,external_id' });
        for (const e of invoices.errors) writeErrors.push(`ledger_invoices ${e.external_id}: ${e.message}`);
        synced += invoices.ids.size;

        const byParent = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          const externalId = `${String(row.type || '').trim()}/${String(row.id)}`;
          const documentId = invoices.ids.get(externalId);
          if (!documentId) continue;
          byParent.set(documentId, (linesByTxn.get(String(row.id)) || []).map(l => mapNsLine(documentId, l)));
        }
        const children = await replaceChildren(service, 'ledger_invoice_lines', 'document_id', byParent);
        for (const e of children.errors) writeErrors.push(e);
        lineCount += children.inserted;
        // Stamp only AFTER the children landed. `replaceChildren` DELETEs
        // first and then inserts, so a failed insert leaves the invoice with
        // ZERO lines — and `idx_ledger_invoices_lines_pending`
        // (WHERE lines_synced_at IS NULL) is the only thing that could ever
        // find it again. Stamping regardless would hide it from that index
        // forever, because the header window only returns a transaction
        // whose lastmodifieddate moves again.
        if (children.errors.length === 0) {
          await stampSynced(service, 'ledger_invoices', 'lines_synced_at', [...byParent.keys()]);
        }

        await queuePdfDocuments(rows, invoices.ids, writeErrors);

        // The cursor moves only over a page that actually LANDED. A page
        // whose every row failed to write — a statement timeout on the big
        // table, an RLS problem, a value Postgres refuses — must not be
        // stepped past: `sync_state` is a tiny upsert that succeeds while
        // the page did not, so the mirror would walk the whole history one
        // empty page per run and never revisit those transactions. A page
        // that landed SOME rows does advance (`upsertRows` already retried
        // the failures row by row), because re-reading it forever on one
        // poison row wedges the mirror just as badly; that row shows up as
        // synced < modified.
        const landed = invoices.ids.size > 0 || headerRows.length === 0;
        if (landed) {
          // Everything at or above the smallest id on this page is done.
          const minId = ids.reduce((min, id) => (Number(id) < Number(min) ? id : min), ids[0]);
          win.beforeId = minId;
          win.processed += rows.length;
          await saveCursor();
        }

        flushWriteErrors(stage);
        if (error) break;
        if (!landed) {
          // Unreachable in practice — `upsertRows` reports an error per row
          // it could not write, so `flushWriteErrors` has already broken out
          // — but never advance silently past a page that wrote nothing.
          fail(`${stage}: the page wrote no rows`);
          break;
        }
        if (rows.length < NS_PAGE_SIZE) { drained = true; break; }
        if (Date.now() >= headersDeadline) break;
      }
    } catch (err) {
      fail(`${stage}: ${compactSuiteqlError(err)}`);
      console.error('[ledger-ns-mirror]', error);
    }
  }

  const settled = columns;
  // "The ladder settled" = a header query came back accepted THIS run. It is
  // what System Health gates its green credit-memos row on, so it is never
  // carried forward from a previous run: a role that lost SuiteQL access
  // must stop reading "accepted in full" on the very next run.
  const columnsSettled = settled !== null;
  // Unsettled means the ladder was never run this time (no header page was
  // fetched), which is not evidence that every column is accepted — carry
  // the last run's answer rather than publishing a fresh, unearned "in full".
  const droppedColumns: string[] = settled
    ? ALL_OPTIONAL_COLUMNS.filter(c => !settled.includes(c))
    : (Array.isArray(baseResult.droppedColumns) ? baseResult.droppedColumns as string[] : []);

  // ── (2) tombstones ─────────────────────────────────────────────────────
  // Only after a drained window: a mid-drain sweep would ask NetSuite about
  // rows the window has not reached yet, which is pointless, not wrong.
  if (drained && !error) {
    if (deadline - Date.now() < MIN_PHASE_MS) {
      tombstonesDone = false;
    } else {
      const tombstoneDeadline = Math.min(Date.now() + budgets.tombstonesMs, deadline);
      // A batch whose ids ALL came back missing is ambiguous: either those
      // transactions really were deleted, or this role can no longer see
      // them (a subsidiary or segment restriction answers with an empty set,
      // not an error). Soft-deleting the whole mirror 150 rows at a time on
      // that reading is not a risk worth taking, so such a batch is HELD
      // until another batch in the same run proves the query still returns
      // rows. If none ever does, nothing is tombstoned and the run says why.
      const deferredGone: string[] = [];
      const tombstoneEntry = tombstoneAfter;
      let sawAlive = false;
      try {
        for (;;) {
          if (Date.now() >= tombstoneDeadline) { tombstonesDone = false; break; }
          // external_ref is the NetSuite internal id, which is unique across
          // transaction TYPES — a CustInvc and a CustCred can never share
          // one — so ordering by it is a total order and `.gt()` skips
          // nothing at a batch boundary.
          let q = service
            .from('ledger_invoices')
            .select('id, external_ref, voided')
            .eq('source', 'netsuite')
            .is('deleted_at', null)
            .order('external_ref')
            .order('id')
            .limit(TOMBSTONE_BATCH);
          if (tombstoneAfter) q = q.gt('external_ref', tombstoneAfter);
          const { data, error: readError } = await q;
          if (readError) throw new Error(`tombstone enumeration: ${readError.message}`);
          const batch = data || [];
          if (batch.length === 0) { tombstoneAfter = null; break; }

          const refs = batch.map(r => safeIntId(r.external_ref, 'external_ref'));
          const alive = await suiteqlQueryAll(
            buildTombstoneQuery(refs, (settled || []).includes('status_label')), 1000, SUITEQL_OPTS,
          );
          const byId = new Map<string, any>(alive.map((r: any) => [String(r.id), r]));

          const gone = batch.filter(r => !byId.has(String(r.external_ref))).map(r => String(r.id));
          const nowVoid = batch
            .filter(r => !r.voided && /void/i.test(String(byId.get(String(r.external_ref))?.label ?? '')))
            .map(r => String(r.id));

          if (byId.size === 0) {
            // Nothing at all came back for these ids. Hold them.
            deferredGone.push(...gone);
            tombstoneAfter = String(batch[batch.length - 1].external_ref);
            // Five batches in a row and still not one live id: stop paying
            // for queries that cannot produce a tombstone either way.
            if (!sawAlive && deferredGone.length >= TOMBSTONE_BATCH * 5) break;
            if (batch.length < TOMBSTONE_BATCH) { tombstoneAfter = null; break; }
            continue;
          }
          sawAlive = true;

          const deletedAt = new Date().toISOString();
          for (const ids of chunk(gone, FILTER_CHUNK)) {
            const { error: updateError } = await service.from('ledger_invoices').update({ deleted_at: deletedAt }).in('id', ids);
            if (updateError) throw new Error(`tombstone write: ${updateError.message}`);
            tombstoned += ids.length;
          }
          for (const ids of chunk(nowVoid, FILTER_CHUNK)) {
            const { error: updateError } = await service.from('ledger_invoices').update({ voided: true }).in('id', ids);
            if (updateError) throw new Error(`void write: ${updateError.message}`);
            voided += ids.length;
          }

          tombstoneAfter = String(batch[batch.length - 1].external_ref);
          if (batch.length < TOMBSTONE_BATCH) { tombstoneAfter = null; break; }
        }

        if (deferredGone.length > 0) {
          if (sawAlive) {
            // Another batch this run proved the query still returns rows, so
            // absence really does mean deleted.
            const deletedAt = new Date().toISOString();
            for (const ids of chunk(deferredGone, FILTER_CHUNK)) {
              const { error: updateError } = await service.from('ledger_invoices').update({ deleted_at: deletedAt }).in('id', ids);
              if (updateError) throw new Error(`tombstone write: ${updateError.message}`);
              tombstoned += ids.length;
            }
          } else {
            // Not one id in the whole sweep came back. That reads as a
            // narrowed role, not as history disappearing — nothing is
            // tombstoned, and the next run retries the same rows.
            tombstonesDone = false;
            tombstoneAfter = tombstoneEntry;
            tombstoneProblem = `${deferredGone.length} mirrored rows came back missing and no batch returned a single live id — read as a narrowed SuiteQL role, not as deletions; nothing was tombstoned (docs/netsuite-ledger-grants.md)`;
          }
        }
      } catch (err) {
        tombstonesDone = false;
        fail(`tombstone sweep: ${compactSuiteqlError(err)}`);
        console.error('[ledger-ns-mirror]', error);
      }
    }
  } else if (!drained) {
    tombstonesDone = false;
  }

  // ── (3) payments: probe, then mirror when permitted ────────────────────
  if (!error) {
    if (deadline - Date.now() < MIN_PHASE_MS) {
      paymentsDone = false;
    } else {
      const paymentsDeadline = Math.min(Date.now() + budgets.paymentsMs, deadline);
      paymentsCap = await probePayments();
      if (paymentsCap.permitted) {
        try {
          // `mirrorPayments` advances `paymentsBeforeId` itself, page by
          // page, and clears it when the pass drains.
          const outcome = await mirrorPayments(paymentsDeadline, paymentsCap.linkTable);
          paymentsMirrored = outcome.mirrored;
          applicationsWritten = outcome.applications;
          paymentsDone = outcome.done;
          flushWriteErrors('customer payments');
        } catch (err) {
          paymentsDone = false;
          fail(`customer payments: ${compactSuiteqlError(err)}`);
          console.error('[ledger-ns-mirror]', error);
        }
      } else {
        // Nothing to resume: a cursor left over from when the grant existed
        // would pin the window open forever.
        paymentsBeforeId = null;
      }
    }
  } else {
    paymentsDone = false;
  }

  // ── (4) PDFs ───────────────────────────────────────────────────────────
  // Guarded by `!error` like (2) and (3): the PDF RESTlet authenticates with
  // the SAME NetSuite credentials as the header query, so running it after
  // an auth failure spends every pending document's `attempts` on the same
  // outage. Three such runs (six hours) park them at `failed`, which
  // `queuePdfDocuments` never re-queues — an outage would permanently cost
  // us those PDFs.
  if (error) {
    pdfsDone = false;
  } else if (deadline - Date.now() < MIN_PHASE_MS) {
    pdfsDone = false;
  } else {
    const pdfDeadline = Math.min(Date.now() + budgets.pdfsMs, deadline);
    try {
      pdfsDone = await pullPdfs(pdfDeadline);
    } catch (err) {
      pdfsDone = false;
      fail(`PDF pull: ${String((err as any)?.message || err)}`);
      console.error('[ledger-ns-mirror]', error);
    }
  }

  // ── (5) repair — the one uncapped phase ────────────────────────────────
  if (deadline - Date.now() < MIN_PHASE_MS) {
    repairDone = false;
  } else {
    const repairDeadline = budgets.repairMs == null ? deadline : Math.min(Date.now() + budgets.repairMs, deadline);
    try {
      const outcome = await repairApplications(repairDeadline);
      repaired = outcome.repaired;
      repairDone = outcome.done;
      repairAfter = outcome.repairAfter;
    } catch (err) {
      repairDone = false;
      fail(`application repair: ${String((err as any)?.message || err)}`);
      console.error('[ledger-ns-mirror]', error);
    }
  }

  const partial = !error && (!drained || !tombstonesDone || !paymentsDone || !pdfsDone || !repairDone);
  const carriesCursor = !drained || !!paymentsBeforeId || !!tombstoneAfter || !!repairAfter;
  const result: NsMirrorResult = {
    modified,
    synced,
    lines: lineCount,
    tombstoned,
    voided,
    repaired,
    droppedColumns,
    columnsSettled,
    capabilities: { payments: paymentsCap },
    customers: { duplicateNetsuiteIds: dupes.count, samples: dupes.samples },
    ...(tombstoneProblem ? { tombstones: { problem: tombstoneProblem } } : {}),
    pdfs,
    payments: paymentsCap.permitted
      ? { mirrored: paymentsMirrored, applications: applicationsWritten }
      : { permitted: false, reason: paymentsCap.reason || NOT_PERMITTED_REASON },
    partial,
    ...(carriesCursor ? { resume: buildResume() } : {}),
    ...(error ? { error } : {}),
  };

  // EXACTLY ONE heartbeat per run. `last_synced_at` advances only when the
  // header window drained, and only to the time that window was OPENED, so
  // nothing modified during a long drain is skipped by the next window.
  //
  // `paymentsDone` is part of that condition for the same reason: advancing
  // the watermark closes the window, and the next one starts ~2 hours back.
  // Every CustPymt the 30 s payments pass had not reached yet would be out
  // of scope for good — a silent hole in payment history rather than a
  // visible partial run.
  await recordHeartbeat(
    service,
    NS_MIRROR_SYNC_TYPE,
    { ...result },
    drained && !error && paymentsDone
      ? { startedAt, records: synced, lastSyncedAt: win.windowStartedAt }
      : { startedAt, records: synced, touchLastSyncedAt: false },
  );

  return result;

  // ── phase implementations (closures over the run's state) ──────────────

  /**
   * Can this integration role read customer payments, and which link table
   * carries what a payment was applied to?
   *
   * Two separate questions with two separate answers, because conflating
   * them is how an engineering bug gets reported as a missing NetSuite
   * grant. A 400 means SuiteQL did not understand the query — never that
   * someone needs to tick a permission box.
   */
  async function probePayments(): Promise<NsPaymentsCapability> {
    try {
      await suiteqlQuery(`SELECT t.id FROM transaction t WHERE t.type = 'CustPymt' FETCH FIRST 1 ROWS ONLY`, 1, 0);
    } catch (err) {
      const kind = classifyProbeError(err);
      return {
        permitted: false,
        linkTable: null,
        reason: kind === 'not_permitted'
          ? NOT_PERMITTED_REASON
          : kind === 'query_shape_rejected'
            ? `query shape rejected: ${compactSuiteqlError(err)}`
            : `probe failed: ${compactSuiteqlError(err)}`,
      };
    }

    const tables: NsPaymentsCapability['linkTable'][] = ['nexttransactionlinelink', 'previoustransactionlinelink'];
    let shapeReason: string | null = null;
    for (const table of tables) {
      try {
        await suiteqlQuery(`SELECT previousdoc, nextdoc, foreignamount, linktype FROM ${table} FETCH FIRST 1 ROWS ONLY`, 1, 0);
        return { permitted: true, linkTable: table, reason: null };
      } catch (err) {
        const kind = classifyProbeError(err);
        if (kind === 'query_shape_rejected') {
          shapeReason = `query shape rejected: ${compactSuiteqlError(err)}`;
          continue;
        }
        if (kind === 'not_permitted') {
          return { permitted: false, linkTable: null, reason: NOT_PERMITTED_REASON };
        }
        return { permitted: false, linkTable: null, reason: `probe failed: ${compactSuiteqlError(err)}` };
      }
    }
    // The payments themselves ARE readable; only the link table is not, so
    // headers still mirror and the reason says what is missing.
    return { permitted: true, linkTable: null, reason: shapeReason };
  }

  /**
   * Customer payments for the window, newest first.
   *
   * The pass is capped (30 s by default) and the history is deep, so it
   * walks the window across MANY runs: the position lives in the run's
   * `paymentsBeforeId`, which this function advances page by page and clears
   * only when the pass drains. Restarting at the head every run — the shape
   * this had before — re-upserted the same newest payments forever and left
   * everything older permanently unmirrored once the header window closed.
   */
  async function mirrorPayments(
    phaseDeadline: number,
    linkTable: NsPaymentsCapability['linkTable'],
  ): Promise<{ mirrored: number; applications: number; done: boolean }> {
    let mirrored = 0;
    let applications = 0;

    for (;;) {
      if (Date.now() >= phaseDeadline) return { mirrored, applications, done: false };
      const result = await suiteqlQuery(buildPaymentHeaderQuery(win.since, paymentsBeforeId), PAY_PAGE_SIZE, 0, SUITEQL_OPTS);
      const rows: any[] = result?.items || [];
      if (rows.length === 0) {
        paymentsBeforeId = null;
        return { mirrored, applications, done: true };
      }

      const parties = await mirrorParties(service, rows, dupes, writeErrors);
      const paymentRows = rows
        .filter(row => {
          // ledger_payments.payment_date is NOT NULL, so one unparseable
          // trandate would sink the page's bulk statement. Skip the row —
          // but say so, exactly as the invoice path does (line ~907); a
          // payment that silently never arrives is the hardest kind of gap
          // to notice in a financial mirror.
          if (isoDate(row.trandate)) return true;
          console.error('[ledger-ns-mirror] skipping CustPymt/' + String(row.id) + ' — no parseable trandate');
          return false;
        })
        .map(row => {
          const nsCustomerId = String(row.party_external_id ?? '').trim();
          return {
            source: 'netsuite',
            external_id: `CustPymt/${String(row.id)}`,
            external_ref: String(row.id),
            direction: 'in',
            party_kind: 'customer',
            doc_number: row.tranid ? String(row.tranid) : null,
            payment_date: isoDate(row.trandate),
            ledger_customer_id: nsCustomerId ? parties.ledgerIds.get(`customer/${nsCustomerId}`) ?? null : null,
            customer_id: nsCustomerId ? parties.appIds.get(nsCustomerId) ?? null : null,
            customer_netsuite_id: nsCustomerId || null,
            party_external_id: nsCustomerId || null,
            party_name: nsPartyName(row),
            total: abs(row.total) ?? 0,
            memo: row.memo ? String(row.memo) : null,
            post_cutover: false,
            sync_token: row.lastmodifieddate != null ? String(row.lastmodifieddate) : null,
            source_updated_at: row.lastmodifieddate ?? null,
            import_run_id: null,
            raw: sanitizeQboPayload('NetSuite', row).clean,
          };
        });

      const upserted = await upsertRows(service, 'ledger_payments', paymentRows, { onConflict: 'source,external_id' });
      for (const e of upserted.errors) writeErrors.push(`ledger_payments ${e.external_id}: ${e.message}`);
      mirrored += upserted.ids.size;

      if (linkTable) {
        applications += await writeApplications(rows, upserted.ids, linkTable);
      }

      const ids = rows.map(r => safeIntId(r.id, 'transaction id'));
      // Everything at or above this page's smallest id is mirrored; the
      // cursor survives the run in `resume.paymentsBeforeId`.
      paymentsBeforeId = ids.reduce((min, id) => (Number(id) < Number(min) ? id : min), ids[0]);
      if (rows.length < PAY_PAGE_SIZE) {
        paymentsBeforeId = null;
        return { mirrored, applications, done: true };
      }
    }
  }

  /**
   * What each payment on this page was applied to.
   *
   * `applied_kind` AND `applied_external_id` both come from the resolved
   * `ledger_invoices` row, so the pair is always self-consistent: a
   * credit-memo target written as `credit_memo` + `'CustInvc/<id>'` would
   * match nothing and stay NULL-targeted forever. Only a previousdoc that is
   * not mirrored yet gets the provisional `invoice` + `'CustInvc/<id>'`
   * shape with a NULL target — the normal state while a newest-first window
   * is still draining older invoices — which phase (5) rewrites.
   */
  async function writeApplications(
    rows: any[],
    paymentIds: Map<string, string>,
    linkTable: NonNullable<NsPaymentsCapability['linkTable']>,
  ): Promise<number> {
    const nsIds = rows.map(r => safeIntId(r.id, 'transaction id'));
    const trandateById = new Map<string, string | null>(rows.map(r => [String(r.id), isoDate(r.trandate)]));

    const links: any[] = [];
    for (const batch of chunk(nsIds, FILTER_CHUNK)) {
      const query = `
      SELECT previousdoc, nextdoc, foreignamount, linktype
      FROM ${linkTable}
      WHERE nextdoc IN (${batch.join(', ')})
    `;
      links.push(...await suiteqlQueryAll(query, 1000, SUITEQL_OPTS));
    }

    // Resolve every previousdoc in one read per 100.
    const wanted = [...new Set(links.map(l => String(l.previousdoc)).filter(Boolean))];
    const targets = new Map<string, { id: string; external_id: string; doc_type: string; paid: boolean | null }>();
    for (const batch of chunk(wanted, FILTER_CHUNK)) {
      const { data, error: readError } = await service
        .from('ledger_invoices')
        .select('id, external_id, external_ref, doc_type, paid')
        .eq('source', 'netsuite')
        .in('external_ref', batch);
      if (readError) {
        writeErrors.push(`application target lookup: ${readError.message}`);
        continue;
      }
      for (const row of data || []) {
        targets.set(String(row.external_ref), {
          id: String(row.id),
          external_id: String(row.external_id),
          doc_type: String(row.doc_type),
          paid: row.paid ?? null,
        });
      }
    }

    // Seeded with an EMPTY list for every payment that landed, so a payment
    // whose applications were removed in NetSuite has them removed here too
    // — `replaceChildren` only touches the parents it is handed — and so
    // `applications_synced_at` gets stamped on a payment that legitimately
    // has none.
    const byParent = new Map<string, Record<string, unknown>[]>();
    for (const paymentId of paymentIds.values()) byParent.set(paymentId, []);
    const seen = new Set<string>();
    const paidOnByInvoice = new Map<string, string>();
    for (const link of links) {
      const paymentNsId = String(link.nextdoc);
      const paymentId = paymentIds.get(`CustPymt/${paymentNsId}`);
      if (!paymentId) continue;
      const previous = String(link.previousdoc ?? '').trim();
      if (!previous) continue;
      const target = targets.get(previous);
      const appliedKind = target ? target.doc_type : 'invoice';
      const appliedExternalId = target ? target.external_id : `CustInvc/${previous}`;
      // UNIQUE (payment_id, applied_kind, applied_external_id): two link rows
      // for the same pair (partial applications) collapse to one row.
      const key = `${paymentId}|${appliedKind}|${appliedExternalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const appliedOn = trandateById.get(paymentNsId) ?? null;
      const rowsFor = byParent.get(paymentId) ?? [];
      rowsFor.push({
        payment_id: paymentId,
        applied_kind: appliedKind,
        applied_external_id: appliedExternalId,
        applied_invoice_id: target ? target.id : null,
        amount: abs(link.foreignamount) ?? 0,
        applied_on: appliedOn,
        raw: sanitizeQboPayload('NetSuite', link).clean,
      });
      byParent.set(paymentId, rowsFor);
      if (target && target.paid === true && appliedOn) {
        const current = paidOnByInvoice.get(target.id);
        if (!current || appliedOn > current) paidOnByInvoice.set(target.id, appliedOn);
      }
    }

    const written = await replaceChildren(service, 'ledger_payment_applications', 'payment_id', byParent);
    for (const e of written.errors) writeErrors.push(e);
    // Same rule as the invoice lines: the delete half of `replaceChildren`
    // has already landed, so stamping over a failed insert would leave the
    // payment claiming applications it does not have, invisible to
    // `idx_ledger_payments_apps_pending` (WHERE applications_synced_at IS
    // NULL) for good.
    if (written.errors.length === 0) {
      await stampSynced(service, 'ledger_payments', 'applications_synced_at', [...byParent.keys()]);
    }

    // `paid_on` = the LATEST application against a paid invoice. Grouped by
    // date so a page costs a handful of updates, not one per invoice.
    //
    // The write is MONOTONIC, and it has to be: `paidOnByInvoice` is built
    // per page, the window is walked newest-first across pages AND across
    // runs, so an invoice settled by two payments gets its older one on a
    // later page. An unguarded update would then walk the date backwards and
    // leave the backfill's own archive wrong — the `or()` below lets a date
    // land only on a row that has none or an earlier one.
    const byDate = new Map<string, string[]>();
    for (const [invoiceId, date] of paidOnByInvoice) {
      const list = byDate.get(date) || [];
      list.push(invoiceId);
      byDate.set(date, list);
    }
    for (const [date, invoiceIds] of byDate) {
      for (const batch of chunk(invoiceIds, FILTER_CHUNK)) {
        const { error: updateError } = await service
          .from('ledger_invoices')
          .update({ paid_on: date })
          .in('id', batch)
          .eq('paid', true)
          .or(`paid_on.is.null,paid_on.lt.${date}`);
        if (updateError) writeErrors.push(`paid_on: ${updateError.message}`);
      }
    }

    return written.inserted;
  }

  /**
   * Pull the pending PDFs through the NetSuite PDF RESTlet.
   *
   * Three gates, and they say different things. `ledgerPdfsEnabled` is the
   * R2 privacy flip (owner item 4) — with it shut, nothing is fetched and
   * the heartbeat names the runbook rather than reporting a silent zero.
   * REACHABILITY is next: a RESTlet that does not answer skips the whole
   * phase, because every fetch would fail identically and three runs of that
   * park each document at `failed`, which nothing re-queues. Only then the
   * VERSION gate, which is narrower still: credit-memo rendering exists in
   * `2026-09-15.1` and later, so while an older copy is deployed those
   * documents are parked at `needs_restlet` with the runbook in `error`,
   * invoice PDFs keep flowing, and a later current version flips them back
   * to `pending`.
   */
  async function pullPdfs(phaseDeadline: number): Promise<boolean> {
    const gate = await ledgerPdfsEnabled(service);
    if (!gate.enabled) {
      // "Shut" and "we could not read the gate" are different facts, and the
      // gate distinguishes them precisely so no downstream surface prints
      // the first when the second is true (pdf-gate.ts, R7-1). Writes are
      // blocked either way.
      pdfs.skipped = gate.readError
        ? `Could not read the PDF gate — ${gate.readError}`
        : 'LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md';
      return true;
    }
    // Said plainly rather than discovered one failed document at a time: with
    // no RESTlet URL every fetch would fail identically and burn each row's
    // three attempts on a configuration gap.
    if (!(process.env.NETSUITE_PDF_RESTLET_URL || '').trim()) {
      pdfs.skipped = 'NETSUITE_PDF_RESTLET_URL is not set — docs/netsuite-ledger-grants.md';
      return true;
    }

    // An UNREACHABLE RESTlet is not an out-of-date one. Parking every pending
    // credit memo at `needs_restlet` would tell the owner to re-upload a
    // script that is already current, and carrying on into the invoice queue
    // would spend every document's three attempts against the same dead
    // endpoint — three runs (six hours) and they are `failed`, a state
    // nothing in the codebase ever re-queues. Skip the phase and say why,
    // exactly like the missing-URL branch above.
    const restlet = await pdfRestletState();
    if (restlet.state === 'unreachable') {
      pdfs.skipped = `PDF RESTlet unreachable — ${restlet.error}`;
      return true;
    }
    if (restlet.state === 'outdated') {
      const { error: parkError } = await service
        .from('ledger_documents')
        .update({ status: 'needs_restlet', error: NEEDS_RESTLET_ERROR })
        .eq('source', 'netsuite')
        .eq('kind', 'pdf')
        .eq('entity_type', 'CustCred')
        .eq('status', 'pending');
      if (parkError) writeErrors.push(`needs_restlet sweep: ${parkError.message}`);
      flushWriteErrors('credit-memo PDF gate');
    } else {
      const { error: releaseError } = await service
        .from('ledger_documents')
        .update({ status: 'pending', error: null })
        .eq('source', 'netsuite')
        .eq('kind', 'pdf')
        .eq('entity_type', 'CustCred')
        .eq('status', 'needs_restlet');
      if (releaseError) writeErrors.push(`needs_restlet release: ${releaseError.message}`);
      flushWriteErrors('credit-memo PDF gate');
    }

    const attempted = new Set<string>();
    let slowestMs = 1_000;
    // Stop before a fetch that plausibly cannot finish, rather than being
    // killed halfway through an upload. The 15 s reserve is CLAMPED to half
    // the phase's own budget: this phase gets 25 s by default, and a flat
    // 15 s floor against a short budget would make the phase do nothing at
    // all while still reporting itself unfinished — a permanent `partial`.
    const phaseBudget = Math.max(0, phaseDeadline - Date.now());
    const reserve = Math.min(PDF_HEADROOM_MS, Math.max(3_000, Math.floor(phaseBudget / 2)));
    const headroom = () => Math.max(reserve, 1.5 * slowestMs);

    for (;;) {
      if (phaseDeadline - Date.now() < headroom()) return false;
      const { data, error: queueError } = await service
        .from('ledger_documents')
        .select('id, external_ref, entity_type, file_name, attempts')
        .eq('source', 'netsuite')
        .eq('kind', 'pdf')
        .eq('status', 'pending')
        // Newest first: the documents anyone is likely to open are the recent
        // ones, and history backfills behind them.
        .order('first_seen_at', { ascending: false })
        .order('id')
        .limit(PDF_QUEUE_LIMIT);
      if (queueError) throw new Error(`document queue read failed: ${queueError.message}`);
      // "The queue is empty" and "this window is all rows we already tried"
      // are different answers. The read is capped at 12, so a window whose
      // rows all failed transiently (they stay `pending`) comes back
      // identical every time — reporting the phase DONE there would claim
      // the pending rows below it had been dealt with.
      if ((data || []).length === 0) return true;
      const queue = (data || []).filter(d => !attempted.has(String(d.id)));
      if (queue.length === 0) return false;
      for (const d of queue) attempted.add(String(d.id));

      for (const slice of chunk(queue, PDF_CONCURRENCY)) {
        if (phaseDeadline - Date.now() < headroom()) return false;
        await Promise.all(slice.map(async doc => {
          const started = Date.now();
          try {
            const mode = PDF_TYPE_FOR[String(doc.entity_type)];
            if (!mode) {
              await service.from('ledger_documents')
                .update({ status: 'unsupported', error: `no PDF mode for ${doc.entity_type}` })
                .eq('id', doc.id);
              pdfs.unsupported++;
              return;
            }
            const rendered = await getNetSuitePdf(mode, String(doc.external_ref), { timeoutMs: PDF_TIMEOUT_MS });
            if (!rendered.success || !rendered.pdfBase64) {
              await failDocument(doc, rendered.error || 'the RESTlet returned no PDF');
              return;
            }
            const bytes = Buffer.from(rendered.pdfBase64, 'base64');
            const fileName = rendered.filename || String(doc.file_name);
            const path = ledgerStoragePath('netsuite', String(doc.entity_type), String(doc.external_ref), fileName);
            // A re-fetch must REPLACE: the key is derived from the tranid,
            // unchanged when an edit moved only the amounts, so the existence
            // short-circuit would leave the pre-edit bytes in the bucket
            // while this row claimed the new digest.
            const isRefetch = (Number(doc.attempts) || 0) > 0;
            const put = await putLedgerObject(service, path, bytes, 'application/pdf', isRefetch ? { replace: true } : undefined);
            if (!put.ok) {
              await failDocument(doc, put.error);
              return;
            }
            await service.from('ledger_documents').update({
              storage_path: path,
              file_name: fileName,
              sha256: put.sha256,
              size_bytes: put.size,
              status: 'stored',
              error: null,
              fetched_at: new Date().toISOString(),
            }).eq('id', doc.id);
            pdfs.stored++;
          } catch (e: any) {
            await failDocument(doc, String(e?.message || e));
          } finally {
            slowestMs = Math.max(slowestMs, Date.now() - started);
          }
        }));
      }
    }
  }

  async function failDocument(doc: { id: string; attempts?: unknown }, reason: string): Promise<void> {
    const attempts = (Number(doc.attempts) || 0) + 1;
    await service.from('ledger_documents').update({
      attempts,
      error: String(reason).slice(0, 500),
      status: attempts >= 3 ? 'failed' : 'pending',
    }).eq('id', doc.id);
    if (attempts >= 3) pdfs.failed++;
  }

  /**
   * Is the DEPLOYED PDF RESTlet new enough to render a credit memo?
   *
   * THREE answers, not two. "The script that answered is older than
   * `2026-09-15.1`" is a real, actionable state (`outdated` → park the credit
   * memos, keep invoices flowing). "Nothing answered at all" is an outage,
   * and reporting it as `outdated` would send the owner re-uploading a
   * current script while every invoice PDF burned its attempts against the
   * same dead endpoint.
   */
  async function pdfRestletState(): Promise<{ state: 'ready' | 'outdated' | 'unreachable'; error?: string }> {
    const spec = RESTLET_SPECS.find(s => s.key === 'pdf');
    const url = (process.env.NETSUITE_PDF_RESTLET_URL || '').trim();
    // Neither can happen here (the caller checked the URL, and RESTLET_SPECS
    // carries 'pdf'), but "we could not tell" must never read as "ready".
    if (!spec || !url) return { state: 'outdated' };
    const probe = await pingRestlet('pdf', url);
    if (!probe.reachable) return { state: 'unreachable', error: probe.error || 'no answer' };
    // Reachable but no version field: a deployment older than the ping
    // action, which still answers 200. Genuinely out of date.
    if (!probe.version) return { state: 'outdated' };
    return { state: probe.version >= spec.expectedVersion ? 'ready' : 'outdated' };
  }

  /**
   * The mirror's OWN repair pass — DB only, no SuiteQL, and the one phase
   * with no cap.
   *
   * `ledger_payment_applications` grows one row per application over the
   * whole history and must never be read unpaginated (CLAUDE.md's 1000-row
   * rule), so the enumeration goes through `fetchAllRows` ordered to match
   * `idx_ledger_pay_apps_unresolved` with a unique `id` tiebreaker.
   *
   * The resume cursor is COMPOSITE. `applied_external_id` is not unique —
   * two payments may each apply to the same invoice — so a plain
   * `.gt('applied_external_id', …)` would skip the sibling rows sharing that
   * id. The keyset predicate is the standard
   * `a.gt.X OR (a.eq.X AND id.gt.Y)`.
   */
  async function repairApplications(phaseDeadline: number): Promise<{
    repaired: number;
    done: boolean;
    repairAfter: { appliedExternalId: string; id: string } | null;
  }> {
    // The cursor is data we wrote, but it lands inside a PostgREST filter
    // string, so it is shape-checked before it gets there.
    const after = repairAfter
      && /^[A-Za-z]+\/\d+$/.test(repairAfter.appliedExternalId)
      && /^[\w-]+$/.test(repairAfter.id)
      ? repairAfter
      : null;
    // The enumeration itself is bounded by the phase deadline. `fetchAllRows`
    // has no time or size limit of its own, and this predicate deliberately
    // has no source scope (the netsuite/quickbooks split happens in memory
    // below), so on a backfill it can walk tens of thousands of rows before
    // the first per-chunk deadline check. Stopping it mid-enumeration is
    // safe because the cursor below resumes from the last row EXAMINED.
    let truncated = false;
    const { data: unresolved, error: readError } = await fetchAllRows<{
      id: string; payment_id: string; applied_kind: string; applied_external_id: string;
    }>((from, to) => {
      if (Date.now() >= phaseDeadline) {
        truncated = true;
        return Promise.resolve({ data: [], error: null });
      }
      let q = service
        .from('ledger_payment_applications')
        .select('id, payment_id, applied_kind, applied_external_id')
        .is('applied_invoice_id', null)
        .is('applied_bill_id', null)
        .order('applied_external_id')
        .order('id');
      if (after) {
        q = q.or(
          `applied_external_id.gt.${after.appliedExternalId},`
          + `and(applied_external_id.eq.${after.appliedExternalId},id.gt.${after.id})`,
        );
      }
      return q.range(from, to);
    });
    if (readError) throw new Error(`repair enumeration failed: ${readError.message}`);

    let count = 0;
    let last: { appliedExternalId: string; id: string } | null = null;
    for (const batch of chunk(unresolved, FILTER_CHUNK)) {
      if (Date.now() >= phaseDeadline) {
        // `last ?? after`, never a bare `last`: a resumed pass whose
        // ENUMERATION ran out of time examines no row at all, and returning
        // null there would throw away the cursor the previous run saved and
        // restart the whole sweep from the head.
        return { repaired: count, done: false, repairAfter: last ?? after };
      }
      // The join to `ledger_payments WHERE source='netsuite'` is done here,
      // in ≤100-id chunks, rather than as an embedded filter: this pass must
      // not touch a QuickBooks application (its `external_ref` numbering is
      // a different namespace and could collide with a NetSuite id), and the
      // QuickBooks importer's own repair phase owns those rows.
      const ownerSource = new Map<string, string>();
      const paymentIds = [...new Set(batch.map(r => String(r.payment_id)))];
      for (const idBatch of chunk(paymentIds, FILTER_CHUNK)) {
        const { data, error: ownerError } = await service
          .from('ledger_payments')
          .select('id, source')
          .in('id', idBatch);
        if (ownerError) throw new Error(`repair owner lookup failed: ${ownerError.message}`);
        for (const row of data || []) ownerSource.set(String(row.id), String(row.source));
      }
      const mine = batch.filter(r => ownerSource.get(String(r.payment_id)) === 'netsuite');

      // The id half of `<Type>/<id>` is what identifies the transaction; the
      // type half is provisional and may be wrong (see writeApplications).
      const refs = [...new Set(mine.map(r => String(r.applied_external_id).split('/').pop() || ''))].filter(Boolean);
      const targets = new Map<string, { id: string; external_id: string; doc_type: string }>();
      for (const refBatch of chunk(refs, FILTER_CHUNK)) {
        const { data, error: lookupError } = await service
          .from('ledger_invoices')
          .select('id, external_id, external_ref, doc_type')
          .eq('source', 'netsuite')
          .in('external_ref', refBatch);
        if (lookupError) throw new Error(`repair lookup failed: ${lookupError.message}`);
        for (const row of data || []) {
          targets.set(String(row.external_ref), {
            id: String(row.id),
            external_id: String(row.external_id),
            doc_type: String(row.doc_type),
          });
        }
      }

      // The cursor advances over every row EXAMINED, QuickBooks ones
      // included, so a resumed pass never re-reads what it has already
      // stepped past.
      for (const row of batch) {
        last = { appliedExternalId: String(row.applied_external_id), id: String(row.id) };
        if (ownerSource.get(String(row.payment_id)) !== 'netsuite') continue;
        const ref = String(row.applied_external_id).split('/').pop() || '';
        const target = targets.get(ref);
        // Still not mirrored: NULL means "not mirrored yet", never
        // "unapplied". Retried next run.
        if (!target) continue;
        const { error: updateError } = await service
          .from('ledger_payment_applications')
          .update({
            applied_invoice_id: target.id,
            applied_kind: target.doc_type,
            applied_external_id: target.external_id,
          })
          .eq('id', row.id);
        if (updateError) {
          // 23505 on UNIQUE (payment_id, applied_kind, applied_external_id):
          // the CORRECT pair already exists, so this provisional row is a
          // duplicate of it. Delete it rather than failing the pass.
          if (String((updateError as any).code) === '23505' || /duplicate key/i.test(updateError.message)) {
            await service.from('ledger_payment_applications').delete().eq('id', row.id);
            count++;
            continue;
          }
          throw new Error(`repair write failed: ${updateError.message}`);
        }
        count++;
      }
    }

    // A truncated enumeration is NOT a drained one: resume from the last row
    // examined (or, if the deadline hit before the first page, from exactly
    // where this pass started).
    if (truncated) return { repaired: count, done: false, repairAfter: last ?? after };

    // Drained: start from the head again next run.
    return { repaired: count, done: true, repairAfter: null };
  }

  /**
   * Queue one pending `ledger_documents` row per mirrored transaction.
   *
   * Created HERE, in phase (1), because `file_name` is NOT NULL and phase
   * (4) only learns the RESTlet's own filename later (it overwrites this
   * one). Rows that already exist are left ALONE: re-upserting `pending`
   * over a `stored` row would orphan the object in R2 and re-download every
   * PDF on every run.
   */
  async function queuePdfDocuments(
    rows: any[],
    invoiceIds: Map<string, string>,
    errors: string[],
  ): Promise<void> {
    const wanted = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const type = String(row.type || '').trim();
      const id = String(row.id);
      const entityExternalId = `${type}/${id}`;
      const entityRowId = invoiceIds.get(entityExternalId);
      if (!entityRowId || !PDF_TYPE_FOR[type]) continue;
      wanted.set(`pdf:${entityExternalId}`, {
        source: 'netsuite',
        external_id: `pdf:${entityExternalId}`,
        external_ref: id,
        kind: 'pdf',
        entity_table: 'ledger_invoices',
        entity_row_id: entityRowId,
        entity_external_id: entityExternalId,
        entity_type: type,
        file_name: `${row.tranid ? String(row.tranid) : id}.pdf`,
        // Known and constant — it is what phase (4) uploads with. The column
        // describes the stored object, so leaving it NULL for the whole
        // NetSuite half would make any reader that trusts it (a viewer
        // deciding to render inline, a listing showing a type badge) fall
        // back to R2's metadata or guess.
        content_type: 'application/pdf',
        status: 'pending',
        import_run_id: null,
      });
    }
    if (wanted.size === 0) return;

    const keys = [...wanted.keys()];
    for (const batch of chunk(keys, FILTER_CHUNK)) {
      const { data, error: readError } = await service
        .from('ledger_documents')
        .select('external_id')
        .eq('source', 'netsuite')
        .in('external_id', batch);
      if (readError) {
        errors.push(`document queue lookup: ${readError.message}`);
        return;
      }
      for (const row of data || []) wanted.delete(String(row.external_id));
    }
    if (wanted.size === 0) return;

    const written = await upsertRows(service, 'ledger_documents', [...wanted.values()], { onConflict: 'source,external_id' });
    for (const e of written.errors) errors.push(`ledger_documents ${e.external_id}: ${e.message}`);
  }
}
