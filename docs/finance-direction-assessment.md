# Finance direction assessment — QuickBooks history, NetSuite editing, payments

*2026-09-13. Written against `main` at #943. Companion to `docs/feature-audit-2026-09.md` (Tier 4) and `docs/owner-setup-runbook.md` §4.*

The owner's notes, verbatim, and what the code says about each. Every claim below was
produced by five read-only scouts over the NetSuite, customer, payments, dependency and
import surfaces, then each load-bearing claim was handed to an independent verifier told
to refute it against the cited file. 79 claims stood as written, 56 were
tightened (counts, column origins, exact semantics — no reversals of substance), and 4
are carried as inference only. Where the honest answer is "this is months, not weeks," it says so.

> **The one-paragraph version.** QuickBooks history can come in, but into a *new*
> `legacy_transactions` table — never into the vehicle/scan tables, which would corrupt
> three shipped reports and set the A/R sweep polling NetSuite forever. Cleaning up
> double-name customers is the harder half and cannot be done locally alone: a merge must
> re-point ~11 foreign keys, 8 NetSuite-id columns and ~18 free-text name columns, and the
> losing customer must be inactivated in NetSuite or the sync resurrects it. NetSuite
> transactions are *mixed*: some mirrored by cron, everything money-shaped pulled live;
> there is no generic edit-and-push-back today, only purpose-built writes. Replacing
> NetSuite entirely is a multi-month-to-multi-year program — FleetSuite holds no ledger,
> invoice, payment or account table. Receiving payments through a hosted processor is a
> bounded project; hand-building NACHA files is the one path that forces the app to hold
> the bank data it was designed never to hold, and should be declined in favour of the
> already-decided NetSuite Electronic Bank Payments route or a bank-hosted API.


---

## Note 1

> Bring in QuickBooks data…store in database…merge “double name” customers, (any way to “clean up” the data?) this is important for historical data…

**Feasibility: Substantial — a bounded project.**

Yes, QuickBooks history can be brought in and stored, but nothing exists today: the repo has zero QuickBooks code (the only hits are three prose comments naming a future 'QBO swap'), no local customer-invoice or payment table, and no 'merge customer A into customer B' operation anywhere. The right shape is a new legacy_transactions table (source='quickbooks', keyed UNIQUE(source, external_id)) plus a review queue that attaches each QB customer to a resolved customers.id, followed by a UNION of those rows into the NetSuite-only reports. 'Cleaning up' double-name customers is the harder half: FleetSuite has no same-name-different-id report and a merge must re-point ~11 uuid FKs, 8 NetSuite-internal-id text columns and ~18 free-text name columns, and any local merge is undone by the sync unless the losing NetSuite customer is inactivated in NetSuite.

**Why that verdict.** The import itself is a contained build (one table + optional lines table, an admin importer following the import-installs pattern, a review queue for unresolved names, RLS per the fleet_checkin_invoices pattern, fetchAllRows pagination). The customer clean-up is the bigger piece and cannot be a pure local operation: the surface a merge must touch is far larger than parts/merge, several child tables CASCADE or block deletes, and the mirror is overwritten by NetSuite unless the loser is inactivated there. Do NOT put QB rows into fleet_checkins/scan_logs: Vehicle Job Margin would show $0 revenue (missing tranid -> $0 at vehicle-margin:347), the AR sweep would poll NetSuite for those invoice numbers forever (ar-payment-sync.ts:36-56), and never-invoiced/on-time/days-to-pay tiles would be polluted.

**What exists today**

- customers is a NetSuite mirror keyed on netsuite_id (NetSuite internal id); every NS customer also gets a prospects row bridged only by netsuite_id (customer-linkage.ts:4-8) — no CREATE TABLE migration exists for customers, its DDL is not in the repo
- Dedup guard, not a constraint: findCustomerDuplicates (customer-dupes.ts) matches trimmed case-insensitive name / email / last-10 phone digits across prospects+customers with a `force` bypass; enforced in POST /api/prospects, /api/wrap-quote/create-customer (name = 409), /api/prospects/check-duplicate
- customer-match.ts graded resolver (exact name -> entity_id -> unambiguous prefix -> unambiguous substring) over active customers with a netsuite_id; returns null on ambiguity — the reusable primitive for attributing QB rows
- /admin/reports/netsuite-dupes lists ONLY duplicated netsuite_id / estimate-id VALUES, not same-name-different-id doubles
- The one merge pattern to clone: POST /api/parts/merge (keepId + mergeIds, re-homes PART_ID_REFS, fills keeper fields, deletes losers, never touches NetSuite)
- Hierarchy link (migration 186 parent_customer_id/parent_source, manual wins, survives resync) — a roll-up, not a merge
- Bulk-import precedent: POST /api/admin/import-installs (admin, zod, JSON rows <=500, client-side .xlsx/.csv parse via import-installs-parse.ts whose parseDelimited is server-usable); exceljs already runs server-side in knowledge/upload
- The sync's SET list is explicit, so new columns on customers (e.g. legacy_total_spend) survive the upsert — the same pattern parent_customer_id relies on
- Repo convention for provenance: per-table `source` TEXT column (about half with a CHECK enum)

**What is missing**

- Any QuickBooks importer, parser (IIF/CSV/QBO export), mapping table, or review queue
- A local home for historical transactions: no `invoices`, `payments`, or `transactions` table; invoice facts today are only invoice-number stamps on fleet_checkins/scan_logs/graphics_jobs/po_invoices with no amounts or lines (except scan_logs.invoiced_amount and graphics_jobs.invoice_amount caches)
- A same-name / same-email different-netsuite_id duplicate report (the 'double name' case)
- A customer merge endpoint: must re-point estimates, quotes, external_contacts, customer_threads, wrap_quotes, customer_files (CASCADE!), customer_tags (CASCADE!), upfit_designs, fleet_checkins, email_log, parent_customer_id, FK-less cni_jobs.customer_id; 8 customer_netsuite_id text columns; ~18 name-only columns (scan_logs.billable_customer, graphics_proofs, work_shifts, invoice_emails, shop_inbound, ...); ~13 prospects.id-keyed child tables; billable_customers name/aliases
- A NetSuite-side step: NetSuite has no merge API in this codebase — only deleteCustomer/deactivateCustomer; the loser must be re-pointed in the NetSuite UI and inactivated or the syncs resurrect it (full sync upserts every isinactive='F' customer; cron re-upserts on lastmodifieddate)
- Report plumbing: sales-by-customer-detail, invoices-list, invoiced-summary, customer-profile 12-month series, exec-metrics revenue_mtd are pure SuiteQL — imported history is invisible until each is UNIONed (query local rows uncached in the handler; the `netsuite:invoices` tag would not invalidate local writes)
- Sync-safe spend columns or compute-on-read: writing QB spend into total_spend/ytd_spend/last_year_spend/last_order_date is clobbered by the next sync that touches the customer
- Fixes to name-keyed readers: customer-thread.ts:31-35, customer-notify.ts:56-61, update-status:350-354 use .ilike(company_name).maybeSingle() and silently treat two same-named rows as 'no customer' (inferred from supabase-js semantics) — status emails/digests/threads silently drop today whenever a double exists
- A production schema dump (pg_dump --schema-only) before writing the migration — customers' column types/NOT NULLs and whether uniq_customers_netsuite_id actually built (migration 264 skips on dirty data) cannot be read from the repo


---

## Note 2

> NetSuite transactions (are they in our storage or pulled with each request?) need the ability to search, open and edit those transactions then push back to NetSuite…keep in mind the end goal is to replace NetSuite entirely.

**Feasibility: Major — a program, not a feature.**

Mixed. Some NetSuite objects ARE stored locally as mirrors written by cron (customers/prospects, netsuite_parts, netsuite_vendor_pos/_lines, netsuite_sales_orders/_lines, netsuite_vendors, po_invoices links) and refreshed by /api/cron/netsuite-sync every 2h at :52 and parts-sync hourly at :37; everything money-shaped is pulled live per request (invoices, open transactions by customer/VIN, AR aging, statements, payment history, P&L, transaction PDFs). There is NO generic 'search, open, edit, push back' capability: the only Record-API GET in the codebase is customer?expandSubResources, and every PATCH is a purpose-built function with a hard-coded body shape. Search/open of transactions is feasible on top of the existing SuiteQL surface; a generic editor with write-back is a from-scratch build; and 'replace NetSuite entirely' is a multi-month-to-multi-year program, not a feature.

**Why that verdict.** Scoped tightly — search + open (read-only detail) for SO/invoice/estimate/PO via SuiteQL plus a small set of whitelisted edits (memo, otherrefnum/PO, VIN, location, lines via ?replace=item) — this is 'substantial': the transports, auth and several PATCH shapes already exist and would be consolidated into the lib. A true generic 'edit any field of any transaction and push back' is 'major': it needs the loader, resolver, whitelist, concurrency and UI from scratch, plus NetSuite role permissions per record type that are not catalogued anywhere in the repo (no permission matrix exists). Treating this as a stepping stone to replacing NetSuite is the wrong frame — see netsuite_replacement: FleetSuite's coupling is 64 of 360 API routes, 24 lib files, ~49 SuiteQL caller files, 37-48 migrations referencing netsuite_*_id columns, 4 live crons, 20 env vars, and every accounting object (GL, AR, AP, tax, inventory costing, numbering, statutory PDFs) lives in NetSuite with no local foundation.

**What exists today**

- One hand-rolled OAuth1 client (src/lib/netsuite.ts, 2,987 lines, ~60 exports) with three transports: SuiteQL, REST Record API (POST/PATCH/DELETE + !transform), and three hand-deployed RESTlets (financials, item, pdf) pinned at 2026-09-10.1 and pinged by System Health
- Mirrors (cron-written): customers/prospects/prospect_contacts + spend rollups; netsuite_parts (+quantities every 2h); netsuite_vendor_pos/_lines (161); netsuite_sales_orders/_lines (196, with estimate matching and a column ladder); netsuite_vendors (288); po_invoices links (007/141)
- Status write-back without a mirror: vendor_invoices/payouts billed->paid and fleet_checkins/scan_logs is_paid via SuiteQL sweeps
- Live pulls: GET sales-orders (SalesOrd/CustInvc/Estimate by customer or VIN tail), sales-order-lines/[id], transaction-packing/[id], so-invoices, invoices (60s cache on the unsearched list), customer-invoices, customer-profile, customer-statement, lookup-transaction?tranid&type, customers/search, vendors; financials RESTlet for payments/P&L/collections/balances; PDF RESTlet for SO/invoice/estimate PDFs
- Existing write-backs (fixed shapes): customer/lead create, contact CRUD, note, vendor, item (create; field edits via item RESTlet), estimate (create/PATCH replace=item/DELETE/close via probability=0), sales order (create; PATCH VIN; PATCH ?replace=item lines guarded by soContentHash), purchase order, item receipt, vendor bill (+PO transform), item fulfillment, invoice (direct create, SO transform, PATCH location, PATCH memo/otherrefnum in fix-invoice-po), customer delete/deactivate
- Manual triggers for most sync phases (sync-sales-orders, sync-pos, sync-invoices, ar-sync-paid, sync-paid, parts/sync, GET /api/netsuite/customers, contacts/sync)

**What is missing**

- A record loader (GET record/v1/{type}/{id}) and a transaction record-type resolver — the item RESTlet exists precisely because the code does not know an item's endpoint (scripts/netsuite-item-restlet.js:14-19)
- A record-type-agnostic update helper with a field whitelist, optimistic concurrency, and error surfacing; today every PATCH body is hand-shaped
- Any UI that loads a transaction for editing; today's transaction views are read-only lists/PDFs
- A local mirror of customer invoices, credit memos, or payments (no CustInvc/CustPymt tables; CustPymt is invisible even to the SuiteQL role — RESTlet only)
- One client: estimates/push, fix-invoice-po and the customers route re-implement OAuth signing and PATCH/DELETE outside the lib, so header/timeout/error fixes do not reach them
- Deploy pipeline for RESTlets (hand-uploaded to the File Cabinet; version pings detect lag, they do not fix it)
- Freshness guarantees: sales-order mirror is bounded by a ~40s budget inside a 120s cron that runs ~12 phases serially; only six phases write a heartbeat, so PO-invoice, vendor-master, bill-payment, AR-payment, estimate-close and quantity-verify silently have no staleness signal
- Two-way conflict handling: several write-backs are fire-and-forget (updateSalesOrderVin at check-in, closeNetSuiteEstimate at convert), so FleetSuite and NetSuite can disagree until a sweep catches it


---

## Note 3

> Can we do this without QuickBooks too? Need basic features of QB online…receive payments (stripe, etc.?) pay bills via ACH (create nacha file and do it through the bank like we're doing or maybe a simpler method?) security concerns (storing card numbers bank account information, etc)

**Feasibility: Major — a program, not a feature.**

Technically yes, but not soon and not cheaply: FleetSuite has no payment capture, no payment origination, no payments table, no Stripe/Plaid/NACHA code, no payment SDK dependency, and 'paid' on every local record is learned FROM NetSuite by 2-hourly sweeps. Receiving payments via Stripe (pay link on the portal/invoice email + webhook + local payment record + a NetSuite customerPayment write that does not exist today) is a bounded, doable project; ACH bill-pay is better done through NetSuite Electronic Bank Payments (the locked 2026-06-29 decision in docs/cni-redesign.md) or a processor than by hand-building NACHA files, because that path forces you to hold routing/account numbers the app was deliberately designed never to store. Replacing 'basic QB Online features' outright (GL, AR/AP subledgers, tax) is the same multi-month build as replacing NetSuite.

**Why that verdict.** The Stripe intake slice on its own is 'substantial' (roughly seven components, each bounded, but one of them — a NetSuite payment write and role grant — is outside the repo). ACH origination from the app is 'not-advisable' as a home-built NACHA pipeline: it requires storing exactly the data the app was designed not to hold, with no encryption primitive in place, and it inverts the current single-source-of-truth (NetSuite tells FleetSuite what is paid; syncVendorBillPayments would fight app-originated state). Using NetSuite EBP (or a bank/processor-hosted ACH API where the bank holds the account data) keeps FleetSuite forward-only with last-4. Doing all of it without NetSuite or QuickBooks means FleetSuite owns the ledger — a multi-month build at minimum.

**What exists today**

- A/R: is_paid is flipped only by syncArInvoicePayments asking NetSuite for CustInvc status 'B' every 2h (paid_at = 'noticed' time, not the payment date); manual ticks on the tracking and scans pages write is_paid directly with the browser Supabase client (no API, no audit, no paid_at)
- A/P: vendor_invoices and payouts run recorded/draft -> approved -> billed (createVendorBill / createBillFromPo, subsidiary 2, account 223 hard-coded in the callers) -> paid, where 'paid' is again learned from NetSuite by syncVendorBillPayments/syncPayoutBillPayments or a manual mark_paid; three-way match with audited override on parts-mail create-bill; finance role (migration 148)
- Read-only money views: open AR/AP via SuiteQL headers, GL balances via financials RESTlet (bank/card/AP/sales-tax/payroll env id lists), 4-week cash outlook (forecast only), portal billing (read-only projection, PDF fetch only)
- Security posture already taken: no card data anywhere; no structured bank account numbers (cni_profiles annotated 'NO financial data in app'); bank info exists only as uploaded voided-check/authorization PDFs under cni-docs in R2 (migrations 165/166); credit_applications (EIN, bank reference fields, ip_address) are plaintext but service-role-only RLS (237), finance/admin feature gate, summary-only list route, AI-agent denylist; inbound webhooks (Resend Svix HMAC + timingSafeEqual, Dialpad JWT, Twilio signature) are a template for a payment webhook
- Design intent on record: NetSuite EBP as the vendor-payment rail with forward-only last-4 posture (docs/cni-redesign.md); 'Stripe / ACH onboarding' listed as a Tier 4 owner decision (docs/owner-setup-runbook.md); a proposed, owner-blocked 'Pay-Now Links' feature in docs/feature-audit-2026-09.md

**What is missing**

- Receive payments (inferred build list, none exists): payment SDK + STRIPE_* env entries in ENV_SPECS (the checkup test fails on uncatalogued env); a pay surface keyed to the NetSuite invoice internal id and foreignamountunpaid reusing portal-billing's token->customer check; /api/webhooks/stripe with signature verification; a local payments table with idempotency on event id; a NetSuite customerPayment write (record/v1/customerPayment) plus the role permission — the SuiteQL role cannot even READ CustPymt today; reconciliation with the AR sweep so an unposted Stripe payment does not leave FleetSuite and NetSuite disagreeing; receipt email + notification + deep-links.ts builder
- Pay bills via ACH (inferred build list, none exists): structured routing/account/account-type for vendors and installers (today only a PDF); the company's own ODFI details; a NACHA builder (no library), prenotes, returns/reversals (R01 etc.), delivery to the bank (SFTP/portal); a payment-run model over approved/billed vendor_invoices + payouts with maker-checker (finance role exists, no dual control); a NetSuite vendorPayment write (does not exist — today 'paid' is learned FROM NetSuite, so app-originated payment inverts the source of truth); structured tax IDs for 1099 vendors (createVendor sends no taxIdNum/is1099Eligible)
- Alternative rail schema: none of the sketched bank_last4 / bank_synced_at / is_1099 / tax_synced_at columns or any entitybankdetails RESTlet exists
- Encryption at rest: no pgcrypto/KMS/crypto-at-rest anywhere (grep finds only pdf-lib's ignoreEncryption)
- QBO-level accounting if QB is dropped: GL/CoA, invoice + payment application records, credit memos, statements from local data, sales-tax liability/remittance — same list as the NetSuite replacement


---

## "Replace NetSuite entirely" — the honest assessment

Replacing NetSuite entirely with FleetSuite-owned accounting is a multi-month-to-multi-year build, not an extension of what exists. NetSuite is the system of record for every accounting object (GL/CoA, item master, customer master, SOs, invoices, fulfillments, POs, receipts, bills, payments, AR aging, AP, sales tax, transaction PDFs, P&L, cash balances) and FleetSuite holds no invoice, payment, journal or account table. The only replacement intent written anywhere in the repo is a 'QBO swap' (vendor-po-sync.ts:9-10, docs/inventory-guide.md:200-203) — i.e. swapping to another accounting system, not FleetSuite owning accounting — and even that 'only replace this file's queries' claim is true for one file. The defensible path is incremental ownership: keep an accounting system of record for the GL/tax/subledgers (NetSuite today; QBO is a plausible cheaper successor for a company this size), move the operational layer (customer identity, transaction search/edit, payment intake, legacy history) into FleetSuite behind a single consolidated NetSuite client, and decide later — with usage data — whether any subledger is worth owning. Nobody should scope this as 'replace NetSuite' in one program.

### Already local (own records live in Supabase)

- Quoting/estimating: estimates + estimate_line_items with local subtotal/labor/tax_rate/tax_amount/grand_total (021), wrap_quotes, quotes, quoted-margin freeze (275), FS-CUSTOM/labor-item mapping (only the push is NetSuite)
- Document numbering for estimates/graphics/wrap quotes/schedule jobs via next_job_number (194) and CNI job numbers via generate_cni_job_number
- CRM/lead tier: prospects (046), prospect_contacts, opportunities, activities, cadences, reminders — netsuite_id optional
- Customer portal, approvals/e-sign, customer files, tags, billing workflow flags, notification preferences
- CNI installer payouts + install_credits + pay splits (110/277), field payroll CSV (never NetSuite-billed), credit_applications (055), month_close_periods (294), accounting-package ZIP export
- Purchase-request queue, receiving workflow (po_receipts), three-way match, vendor-invoice intake (vendor_invoices, vendor_parts_invoices, Gmail capture) — BUT each terminates in a NetSuite posting (PO, item receipt, vendor bill) and carries NetSuite ids/FKs to netsuite_vendor_pos, so these are 'local workflow, NetSuite ledger'
- Cost analytics that are not valuation: part-cost-book (weighted avg buy rate from the PO mirror), cni-pnl per-job P&L, shop-labor/pay-credits
- Materials/roll stock and film costing; part allocations/readiness; metric_snapshots/ar_snapshots (local storage of NetSuite-sourced values, history only since Rounds 4-5)

### What FleetSuite would have to newly own, ranked by difficulty

| Size | Capability | Where it stands |
|---|---|---|
| **XL** | Double-entry GL, chart of accounts, posting for every transaction type, period close, balance sheet / income statement | Zero local foundation: no ledger, journal or account table; every finance tile keys on NetSuite account internal IDs in env vars (NETSUITE_BANK/CARD/AP/SALES_TAX/PAYROLL_ACCOUNT_IDS) and reads balances via the financials RESTlet; P&L is the RESTlet incomeStatement bucketed in pnl.ts |
| **XL** | AR subledger: invoice records, credit memos, payment application, open-balance math, statements, terms/credit limits, aging | No invoice or payment table exists; computeArAging is local arithmetic over a live SuiteQL pull; terms/credit limit/balance are read live from the NetSuite customer record and never stored; tranids are stamped verbatim into fleet_checkins/scan_logs/graphics_jobs and drive AR sync, reconciliation, portal billing and PDF lookups |
| **L** | Sales-tax calculation, liability accrual, remittance reporting | NetSuite's tax engine computes tax on every transaction (no tax lines are sent); the local 7.95% fallback single rate is quoting-only and wrong as a filing basis across 4 NetSuite locations (MO/GA/KS) |
| **L** | AP subledger: vendor bills, bill payments, vendor credits, card charges, 1099 data | Local tables are intake/workflow staging, not a subledger; bill headers are read live, balances via RESTlet, 'paid' is polled from NetSuite; no vendorPayment write, no structured tax IDs |
| **XL** | Inventory subledger: cost layers, valuation, COGS posting, commitments, fulfillment/receipt movements | Only quantities are mirrored (refreshed every 2h); movements are posted in NetSuite by fulfillSalesOrder/createItemReceiptFromPo; docs/inventory-guide.md: 'NetSuite is still the master for physical counts' |
| **M** | Item master with price levels and income/expense account mapping | netsuite_parts is already the pricing authority for sales_price (resolveSalesPrice) and holds many FleetSuite-owned columns; identity, description, cost and GL mapping would flip write direction across ~60 reader files |
| **M** | Customer/vendor master (addresses, terms, hierarchy, subsidiary/location) | customers has no CREATE migration and is keyed on netsuite_id with 8 customer_netsuite_id text columns and profiles.customer_netsuite_id scoping portal logins; re-keying touches ~59 reader files and 37-48 migrations |
| **L** | Sales-order lifecycle: fulfillment, partial billing, quantity_billed, status | SOs are created/updated in NetSuite and mirrored back; order book, parts demand and SO matchmaker read the mirror; the invoicing rule 'fulfil every line first' is a NetSuite transform today |
| **M** | Transaction numbering (tranid) and statutory-quality SO/invoice/bill/receipt PDFs | Numbering authority change breaks every tranid-keyed reader; PDFs for SO/invoice come from the PDF RESTlet — estimates, wrap quotes, statements and packing lists already have local renderers, so an invoice renderer is a bounded add |
| **L** | Payment rails (receive card/ACH, pay vendors) and bank reconciliation | Nothing exists; see note 3. Without an ERP behind it the app must also own settlement, fees and bank rec |
| **XL** | Migrating the integration surface itself | 64 of 360 API routes and 24 lib files import the NetSuite lib, ~49 files issue live SuiteQL, 44 more import a NetSuite-dependent lib, 16 client files call /api/netsuite/*, 4 crons hit NetSuite live and 3 read mirrors, 3 RESTlets, 17 env vars; the 'only replace this file's queries' boundary is true only for vendor-po-sync.ts |
| **L** | Historical data migration | Financial history (metric_snapshots, ar_snapshots) began accruing only recently and cannot be backfilled; any cutover loses NetSuite's own history unless migrated — the same problem note 1 poses for QuickBooks, but larger |


---

## Security — what must never be stored, and the pattern that avoids it

**Must never be stored in FleetSuite**

- Full card numbers (PAN), CVV, or card expiry in any FleetSuite table, log, R2 object, email body or AI-agent-reachable table — today there is none and it should stay that way (grep card_number|cc_number|last4|credit_card -> no hits); payments must be tokenized by the processor so the app holds only a provider customer/payment-method id and last-4/brand
- Full bank routing + account numbers for vendors, installers or customers in structured columns — the locked design (docs/cni-redesign.md 2026-06-29) is forward-only: push bank details to NetSuite EBP / the processor and retain only last-4 + bank_synced_at; the existing 'NO financial data in app' annotation on cni_profiles should hold
- The company's own ODFI credentials, bank portal/SFTP passwords, or NACHA originator secrets in the database or in a session-reachable env; if a bank-file flow is ever built, those live in a secrets manager and the file is never written to R2 under a readable prefix
- Stripe secret keys or webhook secrets anywhere except Vercel env, catalogued in ENV_SPECS (integration-checkup) so the checkup test enforces presence and the AI-agent denylist covers any new payments table

**Must be encrypted or isolated (some of this is a gap today)**

- credit_applications.tax_id (EIN) and bank reference fields (bank_name/contact/phone/account_type) plus submitter ip_address — plaintext today, protected only by service-role-only RLS (237), a finance/admin feature gate, and a summary-only list route; a service-role key leak or a mis-gated route exposes every applicant's EIN. Add column-level encryption (pgcrypto or app-side envelope encryption with a KMS key — none exists today) and a retention/deletion policy (no DELETE handler found)
- Direct-deposit documents (voided checks / authorization forms) under the cni-docs R2 prefix — they contain full routing/account numbers even though no column does; storage-guard checks prefix + traversal only and does not scope cni-docs reads to the caller's own userId folder (inferred, not reproduced). Move them to a dedicated prefix readable only by finance/admin via streamed download (the customer-files pattern), never presign-readable by installer tier
- Any resale/tax-exemption certificates carrying EINs under customer-files — already staff-gated and streamed, keep it that way
- The R2 public-domain allowlist (C2, docs/r2-private-flip.md) — the app-side work shipped but the Cloudflare dashboard action cannot be verified from the repo; until confirmed, invoices/, cni-docs/, customer-files/ may be fetchable by anyone holding a public URL
- Manual is_paid writes from the browser Supabase client (tracking page and scans page) — unaudited, RLS-only, never stamp paid_at; before any payment capture exists these should route through an audited API so 'paid' state has provenance (paid_by null = sync, actor = manual)
- A future payments table and webhook event log: service-role-only RLS, idempotency on provider event id, timingSafeEqual signature verification (Resend route is the template), and inclusion in the AI-agent denylist

**Recommended pattern.** Keep FleetSuite out of PCI and NACHA scope by design. For receivables, use a hosted processor (Stripe Checkout / hosted invoice pay links, with Stripe-managed ACH debit if wanted): FleetSuite stores provider ids, amount, NetSuite invoice internal id, status and last-4 only; a signature-verified webhook writes the local payment record and posts a NetSuite customerPayment (or deposit) on the same invoice so the existing AR sweep sees Paid In Full instead of fighting it. For payables, use NetSuite Electronic Bank Payments (the locked decision) or a bank/processor-hosted ACH API where the bank holds account data and FleetSuite only submits a payment run and receives a reference; write the NetSuite vendorPayment so syncVendorBillPayments remains the single source of 'paid'. If any sensitive identifier must be held (EIN, last-4, bank reference), encrypt at the column level with a key outside the database, expose it only through per-record finance-gated routes, audit every read, and keep it out of list endpoints, exports, emails and the AI agent. Add maker-checker (finance submits, admin approves) before any app-originated money movement — the finance role exists (148) but no dual control does.


---

## Recommended sequence

Each step names what it depends on; nothing here is optional ordering.

1. **Get ground truth from production: pg_dump --schema-only for customers/purchase_orders/catalog_proofs, the latest Vercel build log for migration 264 (did uniq_customers_netsuite_id build or RAISE WARNING?), and a one-off SQL count of same-name/same-email different-netsuite_id customer pairs**
   *Why here:* The customers base DDL is not in the repo and Postgres is unreachable from session containers; every migration for notes 1-3 depends on knowing column types, NOT NULLs and whether the unique index exists. Also establishes how bad the 'double name' problem actually is
   *Needs:* nothing

2. **Ship a same-name/same-email duplicate report next to /admin/reports/netsuite-dupes, and fix the three .ilike(company_name).maybeSingle() readers (customer-thread.ts, customer-notify.ts, update-status) to resolve by customer_id / netsuite_id with an explicit 'ambiguous' branch**
   *Why here:* Cheap, immediately stops silent notification loss caused by existing doubles, and produces the worklist the merge tool will consume
   *Needs:* step 1

3. **Build the customer merge tool: admin-only, audited, modeled on POST /api/parts/merge, re-pointing all 11 uuid FKs + cni_jobs.customer_id, the 8 customer_netsuite_id text columns, the ~18 name-only columns, billable_customers aliases, and the prospects-side child tables; re-home customer_files/customer_tags BEFORE deleting (CASCADE); mark the loser active:false rather than deleting when wrap_quotes/fleet_checkins block; require the operator to confirm the losing NetSuite customer has been re-pointed and inactivated in NetSuite (deactivateCustomer exists) so the syncs do not resurrect it**
   *Why here:* History import should attribute to a clean customers.id; merging after import means re-pointing legacy rows too. Doing it with NetSuite still live is also the only time the NetSuite-side inactivation is easy to enforce
   *Needs:* step 1, step 2

4. **QuickBooks history: obtain a sample export, add legacy_transactions (+ optional legacy_transaction_lines) with source TEXT CHECK DEFAULT 'quickbooks', UNIQUE(source, external_id), nullable customer_id + customer_name_raw, lines JSONB; staff-SELECT/service-role-write RLS; an admin importer following import-installs (server-side parse with parseDelimited/exceljs, chunked, zod) with a review queue for names customer-match cannot resolve; then UNION rows (source-tagged) into sales-by-customer-detail, invoices-list, customer-profile and optionally vehicle-margin by VIN, querying local rows uncached in the handler; add legacy_* spend columns or compute on read — never write into total_spend/ytd_spend**
   *Why here:* This is the highest-value, lowest-risk item on the list and it is independent of any NetSuite decision; it must not touch fleet_checkins/scan_logs/fleet_checkin_invoices
   *Needs:* step 1, step 3

5. **Owner decision on the accounting system of record (stay on NetSuite / move to QBO / FleetSuite-owned) and its timeline**
   *Why here:* Everything after this fork changes shape: transaction editing, payment posting and 'paid' semantics all target whichever ledger survives. The repo's only written intent is a QBO swap, which contradicts 'replace NetSuite entirely'
   *Needs:* step 4

6. **Consolidate the NetSuite client: fold estimates/push, fix-invoice-po and the customers route's inline OAuth/PATCH/DELETE into src/lib/netsuite.ts; add a generic getRecord(type, id) and a field-whitelisted patchRecord(type, id, fields) with timeouts/retries; add heartbeats to the six phases that have none; then build transaction search (SuiteQL over SalesOrd/CustInvc/Estimate/PurchOrd by tranid/customer/VIN/PO — lookup-transaction and sales-orders routes are the seeds), an open/detail view, and a small edit surface (memo, otherrefnum/PO, VIN, location, lines) that pushes back and refreshes the mirror**
   *Why here:* Delivers note 2's practical need (search/open/edit/push back) without pretending to be a NetSuite replacement, and every later write (payments) needs the single client anyway
   *Needs:* step 5

7. **Receive payments: Stripe hosted pay link on the portal billing tab and invoice/statement emails (via the standard compose screen), /api/webhooks/stripe with Svix-style verification, a service-role-only payments table with event-id idempotency, a NetSuite customerPayment write applied to the invoice (requires a role grant — the SuiteQL role cannot read CustPymt today), receipt notification with a deep-links.ts builder, and reconciliation so syncArInvoicePayments confirms rather than contradicts; catalogue STRIPE_* in ENV_SPECS; add to the AI-agent denylist**
   *Why here:* Bounded, revenue-relevant, and keeps NetSuite (or QBO) as the ledger so 'paid' stays single-sourced; it is also the SAQ-A-scoped way to answer the card-storage concern
   *Needs:* step 6

8. **Pay bills: implement the locked NetSuite EBP path (Entity Bank Details RESTlet, bank_last4/bank_synced_at/is_1099 columns, forward-only) with a FleetSuite payment run over approved/billed vendor_invoices + payouts, maker-checker approval, and a vendorPayment write; build NACHA generation only if the owner explicitly rejects EBP and a bank-hosted API, and then with encrypted-at-rest bank data and secrets outside the DB**
   *Why here:* Depends on the ledger decision and on the payment-run/audit model from step 7; the hand-built NACHA route is the one most likely to introduce data the app was designed never to hold
   *Needs:* step 5, step 7

9. **Only if step 5 chose FleetSuite-owned accounting: local AR subledger first (invoice + payment + credit-memo tables, local invoice PDF renderer, tranid authority), then AP, then tax, then inventory costing, then GL — each behind a feature flag with parallel run against the ERP until reconciled**
   *Why here:* AR is where FleetSuite already stamps the most facts and where notes 1 and 3 converge; GL last because it has zero foundation and everything else posts into it. This is the multi-month/multi-year phase
   *Needs:* step 5, step 6, step 7, step 8


---

## Questions only the owner can answer

These gate the decisions above. The first five change the shape of everything after them.

- Which QuickBooks export can you produce — IIF, CSV from Reports (header-only vs line-level), or a QBO API export — and what date range? Line-level Sales by Customer needs line detail; IIF invoices are unreliable for lines
- How far back does history need to be searchable/reportable, and does it need to appear on the Customer Record 12-month chart and portal billing tab, or only in admin reports?
- Did migration 264 build uniq_customers_netsuite_id in production, or did it RAISE WARNING on dirty data? (Vercel build log.) How many same-name/different-id customer pairs exist today?
- For 'double name' customers: is the NetSuite side also duplicated (two NetSuite customers)? Merging in FleetSuite only sticks if the loser is re-pointed and inactivated in NetSuite — who owns that step?
- What is the real end state: NetSuite stays as the ledger, a move to QuickBooks Online (the only intent written in the repo), or FleetSuite owning the GL? And on what timeline — this decision changes the shape of every payment and edit feature
- For transaction editing: which record types and which fields do staff actually need to change (memo, PO number, VIN, location, lines, dates, amounts)? A whitelisted set is weeks; 'any field on any transaction' is a different project
- Can the NetSuite integration role be granted customerPayment / vendorPayment create (and CustPymt read)? Today it cannot even read CustPymt; without the grant, app-originated payments cannot be posted and the sweeps will disagree
- Receivables: card + ACH via Stripe hosted pages acceptable (fees passed on or absorbed)? Any customers requiring lockbox/EFT that would not use a pay link?
- Payables: what exactly is the current bank flow ('create nacha file and do it through the bank')? Does the bank offer an ACH API or hosted payment portal, and is NetSuite Electronic Bank Payments licensed/enabled? That determines whether FleetSuite ever needs to hold account numbers
- Who should be able to initiate vs approve a payment run (maker-checker), and is the current finance role the right boundary?
- Has the Cloudflare R2 public-domain allowlist flip (C2) actually been executed? Until confirmed, uploaded voided checks and invoices may be publicly fetchable by URL
- Are plaintext EINs in credit_applications acceptable with today's access controls, or should column encryption and a retention policy be added before any new sensitive data (last-4, bank references) is introduced?
- Do Paychex payroll journals post into NetSuite? This determines whether Net Profit % is honest today and whether a future local P&L could be
- Sales tax: do you file in MO/GA/KS by location today from NetSuite reports? Any local replacement must reproduce that, which is far beyond the single quoting rate in quote_settings
- If NetSuite is ever left, does its history need to migrate into FleetSuite (same class of problem as the QuickBooks import, but larger)?

---

## Method, so this can be re-run

Five scouts (NetSuite surface · customer model · payments/AR/AP · dependency scale · QuickBooks history), each returning claims tagged verified / likely / inferred with file:line evidence. Every verified-or-likely claim went to an independent verifier instructed to refute it by opening the cited code and to default to *refuted* when uncertain. Only standing claims fed the synthesis; tightened claims were carried as caveats; inferred claims were never promoted. 141 agents, 783 file reads.
