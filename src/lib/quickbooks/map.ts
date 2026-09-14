import { cleanQboName } from './customer-match';
import { sanitizeQboPayload } from './sanitize';

/**
 * QuickBooks payload → ledger row. Pure functions, no I/O.
 *
 * Every mapper returns `{ header, lines?, applications?, documents? }` and
 * obeys the provenance contract in spec §0:
 *
 *   external_id       `'<Entity>/<Id>'`
 *   external_ref      the bare Id
 *   sync_token        SyncToken
 *   source_updated_at MetaData.LastUpdatedTime
 *   raw               the SANITIZED payload (never what arrived)
 *
 * and emits NEITHER `first_seen_at` NOR `last_synced_at`: the column DEFAULT
 * owns the first and `upsertRows` stamps the second on every write
 * (src/lib/ledger/write.ts). A mapper that set either would rewrite history
 * on every re-import.
 *
 * Amounts are POSITIVE MAGNITUDES; `doc_type` carries the sign. `balance` is
 * whatever the source reported and NULL when it reported nothing — never a
 * copied total, because "we don't know" and "zero" are different facts on a
 * ten-year-old invoice.
 */

export type QboRow = Record<string, any>;

export interface MappedDocument {
  header: Record<string, unknown>;
  lines?: Record<string, unknown>[];
  applications?: Record<string, unknown>[];
  documents?: Record<string, unknown>[];
}

const SOURCE = 'quickbooks';

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Positive magnitude, or null. NUMERIC(14,2) in every money column. */
const money = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.abs(n) : null;
};

/** Same, but a column that is NOT NULL DEFAULT 0. */
const money0 = (v: unknown): number => money(v) ?? 0;

const rate = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.abs(n) : null;
};

const date = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  // QuickBooks dates are already 'YYYY-MM-DD'; a full timestamp is trimmed
  // rather than reformatted, so no timezone is invented.
  return s.slice(0, 10);
};

function provenance(entity: string, row: QboRow, clean: unknown, runId: string | null): Record<string, unknown> {
  const id = String(row.Id ?? '');
  return {
    source: SOURCE,
    external_id: `${entity}/${id}`,
    external_ref: id,
    raw: clean ?? {},
    sync_token: str(row.SyncToken),
    source_updated_at: str(row.MetaData?.LastUpdatedTime),
    import_run_id: runId,
  };
}

/**
 * A CHILD row's `raw`, sanitized like every other stored payload.
 *
 * The header gets `raw = clean` from `provenance()`, but a line, a tax line
 * and a LinkedTxn are sub-objects of the payload that ARRIVED, and
 * `ledger_invoice_lines.raw` / `ledger_bill_lines.raw` /
 * `ledger_journal_lines.raw` / `ledger_payment_applications.raw` are
 * SELECT-able by every finance/admin/super_admin/executive reader
 * (migration 314's `is_ledger_reader()` policy). Copying the source subtree
 * straight in would defeat the whole guarantee sanitize.ts exists for —
 * Intuit can add a field inside a line the same way it can inside a header.
 * So every child raw goes through the sanitizer too: spec §2.3's "applied to
 * EVERY payload before `raw` or mapping", with no header/child exception.
 *
 * Sanitizing is idempotent (sanitize.test.ts), so this is safe on a subtree
 * of an already-clean object as well.
 */
function childRaw(entity: string, node: unknown): unknown {
  if (node == null || typeof node !== 'object') return {};
  return sanitizeQboPayload(entity, node).clean ?? {};
}

/**
 * Was this document voided?
 *
 * A HEURISTIC, not a probe — nothing is tried once and no capability records
 * it. It rests on the [H] fact that a voided invoice is still returned with
 * `TotalAmt 0` and a `PrivateNote` that MAY say 'Voided', plus the [M] fact
 * that a voided Payment looks the same. Both halves are required: a paid
 * invoice has `Balance 0` but a real `TotalAmt`, and a genuinely zero-value
 * document with no note is not a void.
 *
 * A wrong guess is silent (`voided = false`), so the run makes the RATE
 * visible instead: every mapped header increments `counts[<Entity>].voided`,
 * shown beside `postCutover` on the report and the progress feed. No
 * per-row event — the 5,000-event cap stays free for real exceptions.
 */
export function isVoided(row: QboRow): boolean {
  return Number(row.TotalAmt) === 0 && /void/i.test(String(row.PrivateNote || ''));
}

// ═══════════ REFERENCE DATA ═══════════

export function mapAccount(row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  return {
    header: {
      ...provenance('Account', row, clean, runId),
      name: str(row.Name) || str(row.FullyQualifiedName) || `Account ${row.Id}`,
      fully_qualified_name: str(row.FullyQualifiedName),
      // The chart-of-accounts number, NOT a bank account number — the
      // sanitizer deliberately keeps `AcctNum` for exactly this column.
      account_number: str(row.AcctNum),
      account_type: str(row.AccountType),
      account_sub_type: str(row.AccountSubType),
      classification: str(row.Classification)?.toLowerCase() ?? null,
      parent_external_id: row.ParentRef?.value ? `Account/${row.ParentRef.value}` : null,
      currency: str(row.CurrencyRef?.value),
      current_balance: row.CurrentBalance == null ? null : Number(row.CurrentBalance),
      active: row.Active !== false,
    },
  };
}

/** QuickBooks entity name → `ledger_entities.entity_type` (snake_case). */
const ENTITY_TYPES: Record<string, string> = {
  Vendor: 'vendor',
  Item: 'item',
  Term: 'term',
  PaymentMethod: 'payment_method',
  TaxCode: 'tax_code',
  TaxRate: 'tax_rate',
  Class: 'class',
  Department: 'department',
  CompanyInfo: 'company_info',
  Preferences: 'preferences',
};

function mapEntity(entity: string, row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  return {
    header: {
      ...provenance(entity, row, clean, runId),
      entity_type: ENTITY_TYPES[entity] || 'other',
      name:
        str(row.DisplayName) ||
        str(row.Name) ||
        str(row.CompanyName) ||
        str(row.FullyQualifiedName) ||
        null,
      active: row.Active !== false,
    },
  };
}

/**
 * Customer → `ledger_customers`.
 *
 * The mapper OMITS every match column (`match_status`, `customer_id`,
 * `customer_netsuite_id`, `match_reason`, `candidates`, `matched_at`,
 * `reviewed_by`, `reviewed_at`). PostgREST's ON CONFLICT updates only the
 * columns sent, so omitting them is what keeps a re-import from wiping a
 * human's `manual`/`ignored` decision. The match phase (§2.5 step 5) sets
 * them explicitly.
 */
export function mapCustomer(row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  const displayName = str(row.DisplayName) || str(row.CompanyName) || `Customer ${row.Id}`;
  return {
    header: {
      ...provenance('Customer', row, clean, runId),
      display_name: displayName,
      company_name: str(row.CompanyName),
      given_name: str(row.GivenName),
      family_name: str(row.FamilyName),
      cleaned_name: cleanQboName(displayName, row.CompanyName),
      email: str(row.PrimaryEmailAddr?.Address),
      phone: str(row.PrimaryPhone?.FreeFormNumber),
      parent_external_id: row.ParentRef?.value ? `Customer/${row.ParentRef.value}` : null,
      is_job: !!row.ParentRef && row.Job === true,
      active: row.Active !== false,
      balance: money(row.Balance),
    },
  };
}

// ═══════════ SALES-SIDE DOCUMENTS ═══════════

const SALES_DOC_TYPES: Record<string, string> = {
  Invoice: 'invoice',
  CreditMemo: 'credit_memo',
  SalesReceipt: 'sales_receipt',
  RefundReceipt: 'refund_receipt',
  Estimate: 'estimate',
};

const LINE_KINDS: Record<string, string> = {
  SalesItemLineDetail: 'item',
  SubTotalLineDetail: 'subtotal',
  DiscountLineDetail: 'discount',
  DescriptionOnly: 'description',
  GroupLineDetail: 'group',
};

/** The PO number, from either place QuickBooks puts it. */
function poNumberOf(row: QboRow): string | null {
  const custom = (row.CustomField || []).find((f: any) => /^p\.?o\.?/i.test(String(f?.Name || '')));
  return str(custom?.StringValue) || str(row.PONumber) || null;
}

export function mapSalesDoc(entity: string, row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  const docType = SALES_DOC_TYPES[entity];
  if (!docType) throw new Error(`mapSalesDoc: ${entity} is not a sales-side entity`);

  // Every JSONB column copied whole out of the payload comes off `clean`,
  // never `row` — §2.3's "applied to EVERY payload before raw or mapping",
  // with no header/child exception. These three are reader-visible columns
  // on the biggest money table, so an instrument Intuit starts putting in a
  // BillAddr would land in front of every finance reader.
  const cleanRow = (clean ?? {}) as Record<string, unknown>;

  const header = {
    ...provenance(entity, row, clean, runId),
    doc_type: docType,
    doc_number: str(row.DocNumber),
    doc_date: date(row.TxnDate) || date(row.MetaData?.CreateTime) || '1970-01-01',
    due_date: date(row.DueDate),
    ship_date: date(row.ShipDate),
    party_external_id: row.CustomerRef?.value ? `Customer/${row.CustomerRef.value}` : null,
    party_name: str(row.CustomerRef?.name),
    po_number: poNumberOf(row),
    memo: str(row.CustomerMemo?.value),
    private_note: str(row.PrivateNote),
    customer_memo: str(row.CustomerMemo?.value),
    status: str(row.TxnStatus) || str(row.EmailStatus),
    status_label: str(row.PrintStatus),
    currency: str(row.CurrencyRef?.value) || 'USD',
    subtotal: null as number | null,
    tax_total: money(row.TxnTaxDetail?.TotalTax),
    total: money0(row.TotalAmt),
    // CreditMemo reports what is LEFT as RemainingCredit; everything else
    // uses Balance. NULL when the source reported neither.
    balance: entity === 'CreditMemo' ? money(row.RemainingCredit) : money(row.Balance),
    paid: docType === 'invoice' ? Number(row.Balance) === 0 : null,
    paid_on: null as string | null,
    voided: isVoided(row),
    bill_email: str(row.BillEmail?.Address),
    bill_address: cleanRow.BillAddr ?? null,
    ship_address: cleanRow.ShipAddr ?? null,
    terms: str(row.SalesTermRef?.name),
    class_name: str(row.ClassRef?.name),
    department_name: str(row.DepartmentRef?.name),
    linked_txns: cleanRow.LinkedTxn ?? [],
  };

  const lines: Record<string, unknown>[] = [];
  let lineNo = 0;
  for (const line of row.Line || []) {
    lineNo++;
    const detailType = String(line?.DetailType || '');
    const kind = LINE_KINDS[detailType] || 'other';
    const detail = line?.[detailType] || {};
    lines.push({
      line_external_id: str(line?.Id) || `line:${lineNo}`,
      line_no: Number(line?.LineNum) || lineNo,
      line_kind: kind,
      item_external_id: detail?.ItemRef?.value ? `Item/${detail.ItemRef.value}` : null,
      item_name: str(detail?.ItemRef?.name),
      item_number: str(detail?.ItemRef?.value),
      description: str(line?.Description),
      quantity: detail?.Qty == null ? null : Number(detail.Qty),
      unit_price: rate(detail?.UnitPrice),
      amount: money0(line?.Amount),
      tax_code: str(detail?.TaxCodeRef?.value),
      account_external_id: detail?.IncomeAccountRef?.value ? `Account/${detail.IncomeAccountRef.value}` : null,
      class_name: str(detail?.ClassRef?.name),
      service_date: date(detail?.ServiceDate),
      raw: childRaw(entity, line),
    });
  }
  // Tax lines live outside Line[] in TxnTaxDetail; keyed 'tax:<i>' so they
  // cannot collide with a real line id.
  (row.TxnTaxDetail?.TaxLine || []).forEach((tax: any, i: number) => {
    lines.push({
      line_external_id: `tax:${i}`,
      line_no: null,
      line_kind: 'tax',
      description: str(tax?.DetailType) || 'Tax',
      amount: money0(tax?.Amount),
      tax_code: str(tax?.TaxLineDetail?.TaxRateRef?.value),
      raw: childRaw(entity, tax),
    });
  });

  return { header, lines, documents: documentsFor(entity, row, runId) };
}

// ═══════════ PAYMENTS ═══════════

const APPLIED_KINDS: Record<string, string> = {
  Invoice: 'invoice',
  CreditMemo: 'credit_memo',
  Bill: 'bill',
  VendorCredit: 'vendor_credit',
  JournalEntry: 'journal_entry',
  Deposit: 'deposit',
  Expense: 'expense',
  Purchase: 'expense',
};

function applicationsOf(entity: string, row: QboRow): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const line of row.Line || []) {
    for (const link of line?.LinkedTxn || []) {
      const txnType = String(link?.TxnType || '');
      const txnId = String(link?.TxnId || '');
      if (!txnType || !txnId) continue;
      const kind = APPLIED_KINDS[txnType] || 'other';
      const externalId = `${txnType}/${txnId}`;
      // UNIQUE (payment_id, applied_kind, applied_external_id) — a payment
      // that touches the same invoice on two lines must not insert twice.
      const key = `${kind}|${externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        applied_kind: kind,
        applied_external_id: externalId,
        amount: money0(line?.Amount),
        applied_on: date(row.TxnDate),
        raw: childRaw(entity, link),
      });
    }
  }
  return out;
}

/** Customer payment — money IN. */
export function mapPayment(row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  return {
    header: {
      ...provenance('Payment', row, clean, runId),
      direction: 'in',
      party_kind: 'customer',
      doc_number: str(row.DocNumber),
      payment_date: date(row.TxnDate) || '1970-01-01',
      party_external_id: row.CustomerRef?.value ? `Customer/${row.CustomerRef.value}` : null,
      party_name: str(row.CustomerRef?.name),
      method: str(row.PaymentMethodRef?.name),
      // PaymentRefNum is a cheque/reference NUMBER, not an instrument — the
      // sanitizer keeps it deliberately.
      reference_no: str(row.PaymentRefNum),
      deposit_account_external_id: row.DepositToAccountRef?.value ? `Account/${row.DepositToAccountRef.value}` : null,
      total: money0(row.TotalAmt),
      unapplied: money(row.UnappliedAmt),
      memo: str(row.PrivateNote),
      private_note: str(row.PrivateNote),
      voided: isVoided(row),
    },
    applications: applicationsOf('Payment', row),
  };
}

/** Bill payment — money OUT. */
export function mapBillPayment(row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  return {
    header: {
      ...provenance('BillPayment', row, clean, runId),
      direction: 'out',
      party_kind: 'vendor',
      doc_number: str(row.DocNumber),
      payment_date: date(row.TxnDate) || '1970-01-01',
      party_external_id: row.VendorRef?.value ? `Vendor/${row.VendorRef.value}` : null,
      party_name: str(row.VendorRef?.name),
      method: str(row.PayType),
      reference_no: str(row.DocNumber),
      total: money0(row.TotalAmt),
      unapplied: null,
      memo: str(row.PrivateNote),
      private_note: str(row.PrivateNote),
      voided: isVoided(row),
    },
    applications: applicationsOf('BillPayment', row),
  };
}

// ═══════════ PURCHASE-SIDE DOCUMENTS ═══════════

const BILL_LINE_KINDS: Record<string, string> = {
  AccountBasedExpenseLineDetail: 'account',
  ItemBasedExpenseLineDetail: 'item',
  DescriptionOnly: 'description',
};

/** Purchase.PaymentType → the ledger's purchase-side doc_type. */
const PURCHASE_DOC_TYPES: Record<string, string> = {
  Cash: 'expense',
  Check: 'check',
  CreditCard: 'card_charge',
};

export function mapBill(entity: string, row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  const docType =
    entity === 'Bill'
      ? 'bill'
      : entity === 'VendorCredit'
        ? 'vendor_credit'
        : PURCHASE_DOC_TYPES[String(row.PaymentType || '')] || 'expense';

  // Sanitized source for the one JSONB column copied whole — see mapSalesDoc.
  const cleanRow = (clean ?? {}) as Record<string, unknown>;

  const header = {
    ...provenance(entity, row, clean, runId),
    doc_type: docType,
    doc_number: str(row.DocNumber),
    doc_date: date(row.TxnDate) || '1970-01-01',
    due_date: date(row.DueDate),
    vendor_external_id: row.VendorRef?.value
      ? `Vendor/${row.VendorRef.value}`
      : row.EntityRef?.value
        ? `Vendor/${row.EntityRef.value}`
        : null,
    vendor_name: str(row.VendorRef?.name) || str(row.EntityRef?.name),
    status: null as string | null,
    status_label: null as string | null,
    currency: str(row.CurrencyRef?.value) || 'USD',
    total: money0(row.TotalAmt),
    balance: money(row.Balance),
    paid: row.Balance == null ? null : Number(row.Balance) === 0,
    memo: str(row.PrivateNote),
    private_note: str(row.PrivateNote),
    account_external_id: row.APAccountRef?.value
      ? `Account/${row.APAccountRef.value}`
      : row.AccountRef?.value
        ? `Account/${row.AccountRef.value}`
        : null,
    payment_type: str(row.PaymentType),
    voided: isVoided(row),
    linked_txns: cleanRow.LinkedTxn ?? [],
  };

  const lines: Record<string, unknown>[] = [];
  let lineNo = 0;
  for (const line of row.Line || []) {
    lineNo++;
    const detailType = String(line?.DetailType || '');
    const detail = line?.[detailType] || {};
    lines.push({
      line_external_id: str(line?.Id) || `line:${lineNo}`,
      line_no: Number(line?.LineNum) || lineNo,
      line_kind: BILL_LINE_KINDS[detailType] || 'other',
      account_external_id: detail?.AccountRef?.value ? `Account/${detail.AccountRef.value}` : null,
      item_external_id: detail?.ItemRef?.value ? `Item/${detail.ItemRef.value}` : null,
      item_number: str(detail?.ItemRef?.value),
      description: str(line?.Description),
      quantity: detail?.Qty == null ? null : Number(detail.Qty),
      unit_price: rate(detail?.UnitPrice),
      amount: money0(line?.Amount),
      billable: detail?.BillableStatus ? detail.BillableStatus === 'Billable' : null,
      customer_external_id: detail?.CustomerRef?.value ? `Customer/${detail.CustomerRef.value}` : null,
      class_name: str(detail?.ClassRef?.name),
      raw: childRaw(entity, line),
    });
  }

  return { header, lines, documents: documentsFor(entity, row, runId) };
}

// ═══════════ JOURNAL-SIDE DOCUMENTS ═══════════

const JOURNAL_DOC_TYPES: Record<string, string> = {
  JournalEntry: 'journal_entry',
  Deposit: 'deposit',
  Transfer: 'transfer',
};

export function mapJournal(entity: string, row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  const docType = JOURNAL_DOC_TYPES[entity];
  if (!docType) throw new Error(`mapJournal: ${entity} is not a journal-side entity`);

  let totalDebit = 0;
  let totalCredit = 0;
  const lines: Record<string, unknown>[] = [];
  let lineNo = 0;
  for (const line of row.Line || []) {
    lineNo++;
    const detailType = String(line?.DetailType || '');
    const detail = line?.[detailType] || {};
    const posting =
      detail?.PostingType === 'Debit' ? 'debit' : detail?.PostingType === 'Credit' ? 'credit' : null;
    const amount = money0(line?.Amount);
    if (posting === 'debit') totalDebit += amount;
    if (posting === 'credit') totalCredit += amount;
    const link = (line?.LinkedTxn || [])[0];
    lines.push({
      line_external_id: str(line?.Id) || `line:${lineNo}`,
      line_no: Number(line?.LineNum) || lineNo,
      posting_type: posting,
      account_external_id: detail?.AccountRef?.value ? `Account/${detail.AccountRef.value}` : null,
      amount,
      description: str(line?.Description),
      entity_kind: str(detail?.Entity?.Type)?.toLowerCase() ?? null,
      entity_external_id: detail?.Entity?.EntityRef?.value
        ? `${detail.Entity.Type}/${detail.Entity.EntityRef.value}`
        : null,
      // A Deposit's lines point back at the Payment or SalesReceipt they
      // deposited — the only place that link exists.
      linked_kind: link?.TxnType ? String(link.TxnType) : null,
      linked_external_id: link?.TxnType && link?.TxnId ? `${link.TxnType}/${link.TxnId}` : null,
      class_name: str(detail?.ClassRef?.name),
      department_name: str(detail?.DepartmentRef?.name),
      raw: childRaw(entity, line),
    });
  }

  return {
    header: {
      ...provenance(entity, row, clean, runId),
      doc_type: docType,
      doc_number: str(row.DocNumber),
      doc_date: date(row.TxnDate) || '1970-01-01',
      memo: str(row.PrivateNote),
      private_note: str(row.PrivateNote),
      total_debit: totalDebit || null,
      total_credit: totalCredit || null,
      total: money(row.TotalAmt) ?? (totalDebit || null),
      account_external_id: row.DepositToAccountRef?.value
        ? `Account/${row.DepositToAccountRef.value}`
        : row.FromAccountRef?.value
          ? `Account/${row.FromAccountRef.value}`
          : null,
      to_account_external_id: row.ToAccountRef?.value ? `Account/${row.ToAccountRef.value}` : null,
      adjustment: row.Adjustment == null ? null : !!row.Adjustment,
      voided: isVoided(row),
    },
    lines,
  };
}

// ═══════════ DOCUMENTS ═══════════

/** The `AttachableRef.EntityRef.type` values we can hang an attachment on. */
const ATTACH_TABLES: Record<string, string> = {
  Invoice: 'ledger_invoices',
  CreditMemo: 'ledger_invoices',
  SalesReceipt: 'ledger_invoices',
  RefundReceipt: 'ledger_invoices',
  Estimate: 'ledger_invoices',
  Bill: 'ledger_bills',
  VendorCredit: 'ledger_bills',
  Purchase: 'ledger_bills',
  Payment: 'ledger_payments',
  BillPayment: 'ledger_payments',
  JournalEntry: 'ledger_journal_entries',
  Deposit: 'ledger_journal_entries',
  Transfer: 'ledger_journal_entries',
  Customer: 'ledger_customers',
  Vendor: 'ledger_entities',
};

export function mapAttachable(row: QboRow, clean: unknown, runId: string | null): MappedDocument {
  // First ref decides where it hangs; the rest stay in `raw` rather than
  // being dropped — an attachment shared across three invoices is real, and
  // the ledger has one row per attachment, not per link.
  const refs = row.AttachableRef || [];
  const first = refs[0];
  const type = str(first?.EntityRef?.type);
  const value = str(first?.EntityRef?.value);
  return {
    header: {
      ...provenance('Attachable', row, clean, runId),
      kind: 'attachment',
      entity_table: (type && ATTACH_TABLES[type]) || 'none',
      entity_external_id: type && value ? `${type}/${value}` : null,
      entity_type: type,
      file_name: str(row.FileName) || `Attachment_${row.Id}`,
      content_type: str(row.ContentType),
      size_bytes: row.Size == null ? null : Number(row.Size),
      note: str(row.Note),
      include_on_send: first?.IncludeOnSend == null ? null : !!first.IncludeOnSend,
      status: 'pending',
    },
  };
}

/** The six types QuickBooks renders a PDF for — Bill and the two memos [probe]. */
const PDF_TYPES: Record<string, string> = {
  Invoice: 'ledger_invoices',
  Estimate: 'ledger_invoices',
  SalesReceipt: 'ledger_invoices',
  CreditMemo: 'ledger_invoices',
  RefundReceipt: 'ledger_invoices',
  Bill: 'ledger_bills',
};

/**
 * The `ledger_documents` row that says "there is a PDF to fetch for this".
 *
 * Never emitted for Payment, Deposit, JournalEntry, Purchase or Transfer:
 * QuickBooks renders no PDF for those ([H]), and a pending row that can
 * never be satisfied is a permanent false backlog on the documents queue.
 */
export function documentsFor(entity: string, row: QboRow, runId: string | null): Record<string, unknown>[] {
  const table = PDF_TYPES[entity];
  if (!table) return [];
  const id = String(row.Id ?? '');
  const number = str(row.DocNumber) || id;
  return [
    {
      source: SOURCE,
      external_id: `pdf:${entity}/${id}`,
      external_ref: id,
      kind: 'pdf',
      entity_table: table,
      entity_external_id: `${entity}/${id}`,
      entity_type: entity,
      file_name: `${entity}_${number}.pdf`,
      content_type: 'application/pdf',
      status: 'pending',
      raw: {},
      import_run_id: runId,
    },
  ];
}

/**
 * The one dispatcher the importer calls. Returns null for an entity with no
 * ledger home, so an unexpected type is an event, not a crash.
 */
export function mapEntityRow(
  entity: string,
  row: QboRow,
  clean: unknown,
  runId: string | null,
): { table: string; mapped: MappedDocument } | null {
  if (entity === 'Account') return { table: 'ledger_accounts', mapped: mapAccount(row, clean, runId) };
  if (entity === 'Customer') return { table: 'ledger_customers', mapped: mapCustomer(row, clean, runId) };
  if (entity === 'Attachable') return { table: 'ledger_documents', mapped: mapAttachable(row, clean, runId) };
  if (entity in ENTITY_TYPES) return { table: 'ledger_entities', mapped: mapEntity(entity, row, clean, runId) };
  if (entity in SALES_DOC_TYPES) return { table: 'ledger_invoices', mapped: mapSalesDoc(entity, row, clean, runId) };
  if (entity === 'Payment') return { table: 'ledger_payments', mapped: mapPayment(row, clean, runId) };
  if (entity === 'BillPayment') return { table: 'ledger_payments', mapped: mapBillPayment(row, clean, runId) };
  if (entity === 'Bill' || entity === 'VendorCredit' || entity === 'Purchase') {
    return { table: 'ledger_bills', mapped: mapBill(entity, row, clean, runId) };
  }
  if (entity in JOURNAL_DOC_TYPES) {
    return { table: 'ledger_journal_entries', mapped: mapJournal(entity, row, clean, runId) };
  }
  return null;
}

/** Which child table a mapped entity's `lines` belong in. */
export function childTableFor(table: string): { table: string; parentCol: 'document_id' | 'entry_id' } | null {
  if (table === 'ledger_invoices') return { table: 'ledger_invoice_lines', parentCol: 'document_id' };
  if (table === 'ledger_bills') return { table: 'ledger_bill_lines', parentCol: 'document_id' };
  if (table === 'ledger_journal_entries') return { table: 'ledger_journal_lines', parentCol: 'entry_id' };
  return null;
}
