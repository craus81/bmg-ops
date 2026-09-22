import type { CustomerIndexRow, MatchGrade } from './customer-match';
import type { QboCapabilities } from './client';
import type { QboEnvironment } from './config';
import type { CutoverSummary } from './cutover';

/**
 * The dry-run report — the thing the owner reads BEFORE anything is written.
 *
 * Owner requirement 7 makes this a gate, not a preview: nothing lands in the
 * ledger until the four match buckets and the cutover window have been seen
 * and confirmed. So the walk is FULL COVERAGE, not a sample — every Customer
 * page, chunked across invocations against the same deadline/lease machinery
 * an import uses — and the buckets ALWAYS sum to `customers.total`.
 * `truncated` caps only the per-row detail list (5,000 rows), never a count.
 *
 * What a dry run writes, exhaustively: its own `ledger_import_runs` row, one
 * `audit_log` row, and the `quickbooks_tokens.capabilities` merge the probes
 * settle. No ledger data rows, no `ledger_import_events`, no `sync_state`
 * pointer (`writeImportPointer`'s type forbids `dry_run`), no R2 bytes.
 */

export type Phase =
  | 'connect'
  | 'reference'
  | 'customers'
  | 'match'
  | 'transactions'
  | 'attachments_index'
  | 'pdfs'
  | 'attachments_fetch'
  | 'reports'
  | 'repair'
  | 'finalize';

export const ALL_PHASES: Phase[] = [
  'connect',
  'reference',
  'customers',
  'match',
  'transactions',
  'attachments_index',
  'pdfs',
  'attachments_fetch',
  'reports',
  'repair',
  'finalize',
];

/** Row detail cap. A bucket COUNT is never capped — only this list. */
export const DRY_RUN_ROW_CAP = 5_000;

export interface MatchedRef {
  customerId: string;
  companyName: string | null;
  netsuiteId: string;
}

export interface DryRunRow {
  externalId: string;
  displayName: string;
  cleanedName: string;
  bucket: string;
  matched: MatchedRef | null;
  candidates: MatchedRef[];
}

export interface DryRunCustomers {
  total: number;
  buckets: { exact: number; cleaned: number; ambiguous: number; unmatched: number; alreadyManual: number };
  rows: DryRunRow[];
  truncated: number;
}

export interface DryRunReport {
  company: {
    name: string | null;
    companyInfoProbe: 'ok' | 'failed';
    realmMasked: string;
    environment: QboEnvironment;
    minorVersion: string;
  };
  capabilities: QboCapabilities;
  /** null when COUNT(*) is unsupported — never 0, which would read as empty. */
  counts: Record<string, number | null>;
  cutover: CutoverSummary;
  customers: DryRunCustomers;
  plan: { phases: Phase[]; estimatedApiCalls: number; estimatedInvocationsAt240s: number; reportRows: number };
  pdfGate: { enabled: boolean; reason: string };
  warnings: string[];
}

const refOf = (c: CustomerIndexRow): MatchedRef => ({
  customerId: c.id,
  companyName: c.company_name,
  netsuiteId: c.netsuite_id,
});

export interface GradedParty {
  externalId: string;
  displayName: string;
  cleanedName: string;
  /** Rows a human already decided are excluded from grading entirely. */
  alreadyManual?: boolean;
}

/**
 * Fold graded parties into the four buckets plus `alreadyManual`.
 *
 * Accumulative on purpose: a chunked dry run calls this once per invocation
 * and merges into the run's stored report, so the buckets are the totals
 * over every page walked, not the last page's.
 */
export function buildMatchReport(
  parties: GradedParty[],
  grades: (MatchGrade | null)[],
  previous?: DryRunCustomers,
): DryRunCustomers {
  const buckets = previous
    ? { ...previous.buckets }
    : { exact: 0, cleaned: 0, ambiguous: 0, unmatched: 0, alreadyManual: 0 };
  const rows: DryRunRow[] = previous ? [...previous.rows] : [];
  let truncated = previous?.truncated ?? 0;

  parties.forEach((party, i) => {
    const grade = grades[i];
    let bucket: keyof typeof buckets;
    let matched: MatchedRef | null = null;
    let candidates: MatchedRef[] = [];

    if (party.alreadyManual) {
      bucket = 'alreadyManual';
    } else if (!grade || grade.status === 'unmatched') {
      bucket = 'unmatched';
    } else if (grade.status === 'ambiguous') {
      bucket = 'ambiguous';
      candidates = grade.candidates.map(refOf);
    } else {
      bucket = grade.status;
      matched = refOf(grade.customer);
    }

    buckets[bucket] += 1;
    if (rows.length < DRY_RUN_ROW_CAP) {
      rows.push({
        externalId: party.externalId,
        displayName: party.displayName,
        cleanedName: party.cleanedName,
        bucket,
        matched,
        candidates,
      });
    } else {
      truncated += 1;
    }
  });

  // `total` is the number of customers actually WALKED AND GRADED — the sum
  // of the buckets by construction, so this can never disagree with itself.
  // The real invariant (it equals `count('Customer')`) is checked where both
  // numbers exist: `phaseDryRunCustomers` compares it against
  // `report.counts.Customer` when the walk drains and raises a warning if the
  // walk came up short. Asserting it here would be a tautology.
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  return { total, buckets, rows, truncated };
}

/**
 * How much work the real import will be, from the counts we just took.
 *
 * An ESTIMATE, clearly labelled: one page per 200 transaction rows, one PDF
 * call per pdf-able document, plus the reference walk. It exists so the
 * owner can decide between the page's loop and the script before starting,
 * not as a budget anything enforces.
 */
export function estimatePlan(
  counts: Record<string, number | null>,
  phases: Phase[],
  reportRows: number,
): DryRunReport['plan'] {
  const known = (k: string) => counts[k] ?? 0;
  const txnEntities = ['Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate', 'Payment', 'Bill', 'VendorCredit', 'Purchase', 'BillPayment', 'Deposit', 'JournalEntry', 'Transfer'];
  const txnRows = txnEntities.reduce((sum, e) => sum + known(e), 0);
  const pdfDocs = ['Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate', 'Bill'].reduce(
    (sum, e) => sum + known(e),
    0,
  );

  let calls = Math.ceil(txnRows / 200) + txnEntities.length;
  calls += Math.ceil(known('Customer') / 1000) + 1;
  calls += 8; // the reference entities, one small page each
  if (phases.includes('pdfs')) calls += pdfDocs;
  if (phases.includes('reports')) calls += reportRows;

  // ~4 calls/second sustained under the limiter, so a 240 s invocation gets
  // through roughly 900 of them.
  return {
    phases,
    estimatedApiCalls: calls,
    estimatedInvocationsAt240s: Math.max(1, Math.ceil(calls / 900)),
    reportRows,
  };
}
