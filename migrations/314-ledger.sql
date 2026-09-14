-- Migration 314: FleetSuite ledger — one ledger, three sources (owner decisions 2026-09-13/14).

CREATE OR REPLACE FUNCTION public.is_ledger_reader()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.get_my_roles() && ARRAY['finance','admin','super_admin','executive'], false)
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';
COMMENT ON FUNCTION public.is_ledger_reader() IS 'Migration 314: finance/admin/super_admin/executive may read ledger_* rows (includes executive, which is_internal_staff excludes, and super_admin, which is_admin excludes).';

CREATE TABLE IF NOT EXISTS quickbooks_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  realm_id TEXT NOT NULL,                      -- the ONLY place the full realm id is stored
  environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  company_name TEXT,                           -- NULL when the CompanyInfo probe failed; the connection is still valid
  access_token TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token TEXT NOT NULL,                 -- ROTATES: persisted on every refresh
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  minor_version TEXT,
  connected_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at TIMESTAMPTZ,
  refresh_lease_until TIMESTAMPTZ,             -- refresh serialization lease, claimed BEFORE the token POST
  needs_reauth_at TIMESTAMPTZ,
  last_error TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quickbooks_oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite')),
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','import','cdc')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed','cancelled')),
  realm_id TEXT,                               -- ALWAYS the masked form ('…1234', maskRealm()) — never the full id
  started_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  last_invocation_at TIMESTAMPTZ,
  invocations INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  phase TEXT,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,   -- AUTHORITATIVE resume point, written before every network fetch
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  api_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  report JSONB,
  report_viewed_at TIMESTAMPTZ,
  report_viewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  dry_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()  -- bumped on every cursor write; deliberately not indexed
);
CREATE INDEX IF NOT EXISTS idx_ledger_import_runs_recent ON ledger_import_runs(source, started_at DESC);

CREATE TABLE IF NOT EXISTS ledger_import_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ledger_import_runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  phase TEXT,
  entity_type TEXT NOT NULL,
  external_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('error','skipped','dropped_field','voided','deleted','unsupported','unmatched','ambiguous')),
  message TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_import_events_run ON ledger_import_events(run_id, outcome, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  fully_qualified_name TEXT,
  account_number TEXT,
  account_type TEXT,
  account_sub_type TEXT,
  classification TEXT CHECK (classification IN ('asset','liability','equity','revenue','expense')),
  parent_external_id TEXT,
  currency TEXT,
  current_balance NUMERIC(16,2),
  active BOOLEAN NOT NULL DEFAULT true,
  netsuite_account_id TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_type ON ledger_accounts(source, account_type, name);

CREATE TABLE IF NOT EXISTS ledger_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('vendor','item','term','payment_method','tax_code','tax_rate','class','department','company_info','preferences','other')),
  name TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  netsuite_vendor_id TEXT,                     -- TEXT bridge to netsuite_vendors.netsuite_id, never a FK
  netsuite_item_id TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_entities_type_name ON ledger_entities(source, entity_type, name);

CREATE TABLE IF NOT EXISTS ledger_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  company_name TEXT,
  given_name TEXT,
  family_name TEXT,
  cleaned_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  parent_external_id TEXT,
  is_job BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  balance NUMERIC(14,2),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,   -- app uuid; never a FK on customers.netsuite_id (264 is conditional)
  customer_netsuite_id TEXT,
  match_status TEXT NOT NULL DEFAULT 'pending' CHECK (match_status IN ('pending','exact','cleaned','ambiguous','unmatched','manual','ignored')),
  match_reason TEXT,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  matched_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_customers_status ON ledger_customers(match_status, cleaned_name, id);
CREATE INDEX IF NOT EXISTS idx_ledger_customers_customer ON ledger_customers(customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_customers_name ON ledger_customers(lower(display_name));

CREATE TABLE IF NOT EXISTS ledger_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf','attachment')),
  entity_table TEXT NOT NULL CHECK (entity_table IN ('ledger_invoices','ledger_bills','ledger_payments','ledger_journal_entries','ledger_customers','ledger_entities','none')),
  entity_row_id UUID,
  entity_external_id TEXT,
  entity_type TEXT,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  storage_path TEXT,                           -- RELATIVE to the 'ledger' prefix; NULL until stored; never a URL
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','stored','unsupported','failed','skipped','needs_restlet')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  note TEXT,
  include_on_send BOOLEAN,
  fetched_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_documents_entity ON ledger_documents(entity_table, entity_row_id);
CREATE INDEX IF NOT EXISTS idx_ledger_documents_pending ON ledger_documents(source, kind, first_seen_at, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ledger_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice','credit_memo','sales_receipt','refund_receipt','estimate')),
  doc_number TEXT,
  doc_date DATE NOT NULL,
  due_date DATE,
  ship_date DATE,
  ledger_customer_id UUID REFERENCES ledger_customers(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_netsuite_id TEXT,
  party_external_id TEXT,
  party_name TEXT,
  po_number TEXT,
  memo TEXT,
  private_note TEXT,
  customer_memo TEXT,
  status TEXT,
  status_label TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal NUMERIC(14,2),
  tax_total NUMERIC(14,2),
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance NUMERIC(14,2),                       -- QBO Balance / NetSuite foreignamountunpaid; NULL when not reported (never total)
  paid BOOLEAN,
  paid_on DATE,
  voided BOOLEAN NOT NULL DEFAULT false,
  post_cutover BOOLEAN NOT NULL DEFAULT false,
  bill_email TEXT,
  bill_address JSONB,
  ship_address JSONB,
  terms TEXT,
  class_name TEXT,
  department_name TEXT,
  linked_txns JSONB NOT NULL DEFAULT '[]'::jsonb,
  lines_synced_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_date ON ledger_invoices(doc_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_customer ON ledger_invoices(customer_id, doc_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_ledger_customer ON ledger_invoices(ledger_customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_number ON ledger_invoices(lower(doc_number));
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_party ON ledger_invoices(lower(party_name));
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_total ON ledger_invoices(total);
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_ref ON ledger_invoices(source, external_ref);
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_lines_pending ON ledger_invoices(source, id) WHERE lines_synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_invoices_open ON ledger_invoices(source, doc_type, due_date) WHERE paid = false AND deleted_at IS NULL AND voided = false;

CREATE TABLE IF NOT EXISTS ledger_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES ledger_invoices(id) ON DELETE CASCADE,
  line_external_id TEXT NOT NULL,
  line_no INTEGER,
  line_kind TEXT NOT NULL CHECK (line_kind IN ('item','subtotal','discount','description','group','tax','shipping','other')),
  item_external_id TEXT,
  item_name TEXT,
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(14,2),
  unit_price NUMERIC(14,4),
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_code TEXT,
  account_external_id TEXT,
  class_name TEXT,
  service_date DATE,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (document_id, line_external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice_lines_doc ON ledger_invoice_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice_lines_item ON ledger_invoice_lines(item_number);

CREATE TABLE IF NOT EXISTS ledger_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('bill','vendor_credit','expense','check','card_charge')),
  doc_number TEXT,
  doc_date DATE NOT NULL,
  due_date DATE,
  vendor_external_id TEXT,
  vendor_name TEXT,
  netsuite_vendor_id TEXT,
  ledger_entity_id UUID REFERENCES ledger_entities(id) ON DELETE SET NULL,
  status TEXT,
  status_label TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance NUMERIC(14,2),
  paid BOOLEAN,
  memo TEXT,
  private_note TEXT,
  account_external_id TEXT,
  payment_type TEXT,
  voided BOOLEAN NOT NULL DEFAULT false,
  post_cutover BOOLEAN NOT NULL DEFAULT false,
  linked_txns JSONB NOT NULL DEFAULT '[]'::jsonb,
  lines_synced_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_bills_date ON ledger_bills(doc_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_ledger_bills_vendor ON ledger_bills(lower(vendor_name), doc_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_bills_number ON ledger_bills(lower(doc_number));
CREATE INDEX IF NOT EXISTS idx_ledger_bills_ref ON ledger_bills(source, external_ref);
CREATE INDEX IF NOT EXISTS idx_ledger_bills_lines_pending ON ledger_bills(source, id) WHERE lines_synced_at IS NULL;

CREATE TABLE IF NOT EXISTS ledger_bill_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES ledger_bills(id) ON DELETE CASCADE,
  line_external_id TEXT NOT NULL,
  line_no INTEGER,
  line_kind TEXT NOT NULL CHECK (line_kind IN ('account','item','tax','description','other')),
  account_external_id TEXT,
  item_external_id TEXT,
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(14,2),
  unit_price NUMERIC(14,4),
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  billable BOOLEAN,
  customer_external_id TEXT,
  class_name TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (document_id, line_external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_bill_lines_doc ON ledger_bill_lines(document_id);

CREATE TABLE IF NOT EXISTS ledger_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  party_kind TEXT NOT NULL CHECK (party_kind IN ('customer','vendor')),
  doc_number TEXT,
  payment_date DATE NOT NULL,                  -- this table's date column (there is no doc_date here)
  ledger_customer_id UUID REFERENCES ledger_customers(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_netsuite_id TEXT,
  party_external_id TEXT,
  party_name TEXT,
  method TEXT,
  reference_no TEXT,
  deposit_account_external_id TEXT,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  unapplied NUMERIC(14,2),
  memo TEXT,
  private_note TEXT,
  voided BOOLEAN NOT NULL DEFAULT false,
  post_cutover BOOLEAN NOT NULL DEFAULT false,
  applications_synced_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_payments_date ON ledger_payments(payment_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_ledger_payments_customer ON ledger_payments(customer_id, payment_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_ledger_payments_party ON ledger_payments(lower(party_name));
CREATE INDEX IF NOT EXISTS idx_ledger_payments_total ON ledger_payments(total);
CREATE INDEX IF NOT EXISTS idx_ledger_payments_apps_pending ON ledger_payments(source, id) WHERE applications_synced_at IS NULL;

CREATE TABLE IF NOT EXISTS ledger_payment_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES ledger_payments(id) ON DELETE CASCADE,
  applied_kind TEXT NOT NULL CHECK (applied_kind IN ('invoice','credit_memo','bill','vendor_credit','journal_entry','deposit','expense','other')),
  applied_external_id TEXT NOT NULL,
  applied_invoice_id UUID REFERENCES ledger_invoices(id) ON DELETE SET NULL,
  applied_bill_id UUID REFERENCES ledger_bills(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  applied_on DATE,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (payment_id, applied_kind, applied_external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_pay_apps_invoice ON ledger_payment_applications(applied_invoice_id);
CREATE INDEX IF NOT EXISTS idx_ledger_pay_apps_bill ON ledger_payment_applications(applied_bill_id);
CREATE INDEX IF NOT EXISTS idx_ledger_pay_apps_unresolved ON ledger_payment_applications(applied_kind, applied_external_id) WHERE applied_invoice_id IS NULL AND applied_bill_id IS NULL;

CREATE TABLE IF NOT EXISTS ledger_journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('journal_entry','deposit','transfer')),
  doc_number TEXT,
  doc_date DATE NOT NULL,
  memo TEXT,
  private_note TEXT,
  total_debit NUMERIC(14,2),
  total_credit NUMERIC(14,2),
  total NUMERIC(14,2),
  account_external_id TEXT,
  to_account_external_id TEXT,
  adjustment BOOLEAN,
  voided BOOLEAN NOT NULL DEFAULT false,
  post_cutover BOOLEAN NOT NULL DEFAULT false,
  lines_synced_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_token TEXT,
  source_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  is_read_only BOOLEAN GENERATED ALWAYS AS (source <> 'fleetsuite') STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_date ON ledger_journal_entries(doc_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_lines_pending ON ledger_journal_entries(source, id) WHERE lines_synced_at IS NULL;

CREATE TABLE IF NOT EXISTS ledger_journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES ledger_journal_entries(id) ON DELETE CASCADE,
  line_external_id TEXT NOT NULL,
  line_no INTEGER,
  posting_type TEXT CHECK (posting_type IN ('debit','credit')),
  account_external_id TEXT,
  account_id UUID REFERENCES ledger_accounts(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  description TEXT,
  entity_kind TEXT,
  entity_external_id TEXT,
  linked_kind TEXT,
  linked_external_id TEXT,
  class_name TEXT,
  department_name TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (entry_id, line_external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_lines_entry ON ledger_journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_lines_account ON ledger_journal_lines(account_id);

CREATE TABLE IF NOT EXISTS ledger_report_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('quickbooks','netsuite','fleetsuite')),
  external_id TEXT NOT NULL,                   -- '<report_type>:<basis>:<period_start>:<period_end>:<summarize_by>' (no '/': exempt from the write.ts guard)
  report_type TEXT NOT NULL CHECK (report_type IN ('ProfitAndLoss','ProfitAndLossDetail','BalanceSheet','CashFlow','TrialBalance','GeneralLedger','AgedReceivables','AgedReceivableDetail','AgedPayables','AgedPayableDetail','CustomerBalance','VendorBalance','TransactionList','SalesByCustomer','SalesByProduct')),
  basis TEXT NOT NULL CHECK (basis IN ('accrual','cash','none')),
  period_kind TEXT NOT NULL CHECK (period_kind IN ('month','quarter','year','as_of','custom')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  summarize_by TEXT NOT NULL DEFAULT 'Total',
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_raw TEXT,
  sha256 TEXT,
  payload JSONB,
  summary JSONB,
  generated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','stored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at TIMESTAMPTZ,
  import_run_id UUID REFERENCES ledger_import_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_reports_lookup ON ledger_report_snapshots(source, report_type, basis, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_ledger_reports_pending ON ledger_report_snapshots(source, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ledger_report_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES ledger_report_snapshots(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,
  label TEXT NOT NULL,
  section_path TEXT NOT NULL DEFAULT '',
  depth INTEGER NOT NULL DEFAULT 0,
  row_type TEXT NOT NULL CHECK (row_type IN ('data','section_total','grand_total')),
  column_key TEXT NOT NULL,
  amount NUMERIC(16,2),
  account_external_id TEXT,
  UNIQUE (snapshot_id, line_key, column_key)
);
CREATE INDEX IF NOT EXISTS idx_ledger_report_lines_key ON ledger_report_lines(line_key, column_key);

ALTER TABLE quickbooks_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE quickbooks_oauth_states ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ledger_import_runs','ledger_import_events','ledger_accounts','ledger_entities','ledger_customers','ledger_documents',
    'ledger_invoices','ledger_invoice_lines','ledger_bills','ledger_bill_lines','ledger_payments','ledger_payment_applications',
    'ledger_journal_entries','ledger_journal_lines','ledger_report_snapshots','ledger_report_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_ledger_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (public.is_ledger_reader())', t || '_ledger_select', t);
  END LOOP;
END $$;

-- House convention (migrations 308, 313): every new table states its writer and reader, and every
-- column whose NULL or format is load-bearing says so. Re-running these is a no-op.
COMMENT ON TABLE quickbooks_tokens IS 'Migration 314: the single QuickBooks Online connection (id = 1). Service-role write, RLS on with NO policies — the only place a full realm id or a token is stored.';
COMMENT ON TABLE quickbooks_oauth_states IS 'Migration 314: single-use OAuth state nonces, deleted on consume. Service-role only, RLS on with no policies.';
COMMENT ON TABLE ledger_import_runs IS 'Migration 314: one row per QuickBooks dry-run / import / CDC run. Service-role write, is_ledger_reader() read — reader-visible only because realm_id is stored masked and no token value ever touches this table.';
COMMENT ON COLUMN ledger_import_runs.realm_id IS 'ALWAYS the masked form maskRealm() produces (''…1234''). The full realm id lives only in quickbooks_tokens.';
COMMENT ON TABLE ledger_import_events IS 'Migration 314: per-row exceptions from one run (error, skipped, dropped_field, voided, unmatched, …), capped at 5,000 per run. Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_accounts IS 'Migration 314: chart of accounts, one row per (source, external_id). Service-role write (importers only), is_ledger_reader() read.';
COMMENT ON COLUMN ledger_accounts.account_number IS 'The GL chart-of-accounts number (QuickBooks Account.AcctNum) — NOT a bank or card account number. Bank/card AcctNum only ever appears under CheckPayment/BankAccount, which the intake sanitizer drops whole.';
COMMENT ON TABLE ledger_entities IS 'Migration 314: vendors, items, terms, payment methods, tax codes, classes, departments and company preferences. Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_customers IS 'Migration 314: the source-side customer as imported plus its graded match to customers.id. Service-role write; match_status ''manual''/''ignored'' is a human decision no import overwrites.';
COMMENT ON TABLE ledger_documents IS 'Migration 314: PDFs and attachments belonging to ledger rows. Service-role write, is_ledger_reader() read; bytes are served ONLY by GET /api/ledger/documents/[id], never from a public URL.';
COMMENT ON COLUMN ledger_documents.storage_path IS 'RELATIVE to the R2 ''ledger'' prefix — never a URL and never a public link; NULL until status = ''stored''.';
COMMENT ON TABLE ledger_invoices IS 'Migration 314: sales-side documents (invoice, credit_memo, sales_receipt, refund_receipt, estimate) from every source. Service-role write, is_ledger_reader() read; is_read_only = (source <> ''fleetsuite'').';
COMMENT ON COLUMN ledger_invoices.balance IS 'Outstanding amount AS THE SOURCE REPORTED IT. NULL = not reported (unknown) — never copy total into it; a paid invoice reports 0.';
COMMENT ON TABLE ledger_invoice_lines IS 'Migration 314: the lines of one ledger_invoices row, replaced wholesale by the importer. Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_bills IS 'Migration 314: purchase-side documents (bill, vendor_credit, expense, check, card_charge). Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_bill_lines IS 'Migration 314: the lines of one ledger_bills row, replaced wholesale. Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_payments IS 'Migration 314: customer payments (direction ''in'') and bill payments (direction ''out''). Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_payment_applications IS 'Migration 314: what one payment was applied to. applied_invoice_id / applied_bill_id NULL means the target is not mirrored yet — a repair pass resolves it later (QuickBooks: the importer''s repair phase; NetSuite: the mirror''s own repair phase) — it does NOT mean unapplied.';
COMMENT ON TABLE ledger_journal_entries IS 'Migration 314: journal entries, deposits and transfers. Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_journal_lines IS 'Migration 314: the lines of one ledger_journal_entries row. Service-role write, is_ledger_reader() read.';
COMMENT ON TABLE ledger_report_snapshots IS 'Migration 314: reports stored exactly as the source rendered them. READER-VISIBLE to is_ledger_reader() by owner decision 2026-09-13 item 11 (staff-read finance/admin/executive) — deliberately UNLIKE metric_snapshots and ar_snapshots, which stay service-role-only. Service-role write.';
COMMENT ON TABLE ledger_report_lines IS 'Migration 314: the parsed cells of one snapshot. amount NULL = the source printed no value in that cell, not 0.';
