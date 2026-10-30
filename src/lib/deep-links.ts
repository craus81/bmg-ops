/**
 * Canonical deep-link builders — the ONE place app entity URL formats live.
 *
 * Every notification (`notify`/`notifyMany` url), mention contextUrl, and
 * email CTA must link to the exact record it references, and the string
 * should come from here so producers and consumers can never drift apart.
 * A link that lands on a list page while a record id was in scope is a bug
 * ("New for you" clicks must always arrive AT the thing, not near it).
 *
 * Adding a page or notification?
 *  1. Add (or reuse) a builder here.
 *  2. Make the destination page actually handle the params the builder emits
 *     (open the record's modal/detail, scroll to it, flash it).
 *  3. Pass the built url at every notify()/reportMentions call site.
 *
 * Pure string helpers — safe in server routes and client components alike.
 * Digest notifications (many records, no single id) may link to the list
 * page; everything else links to the record.
 */

export const deepLinks = {
  /** One @mention: the full note, who wrote it, and an Open button when the
   *  recipient can open the note's record. Every mention notification lands
   *  here, so nobody is left with only the excerpt. */
  mention: (mentionId: string) => `/mentions/${mentionId}`,
  /** Dedicated PO record page. `flag` opens its "needs attention" form. */
  po: (poId: string, opts?: { flag?: boolean }) => `/admin/pos/${poId}${opts?.flag ? '?flag=1' : ''}`,
  /** Dedicated graphics job record page. `schedule` scrolls to the Install
   *  card with its date field open (the "Schedule install" alert). */
  graphicsJob: (jobId: string, opts?: { schedule?: boolean }) =>
    `/graphics/${jobId}${opts?.schedule ? '?schedule=1' : ''}`,
  /** The graphics board's New Job form, filled in from an estimate (the
   *  estimate's "+ Graphics job" button and the "Start designing" alert). */
  graphicsNewFromEstimate: (estimateId: string) => `/graphics?new=1&fromEstimate=${estimateId}`,
  /** The graphics board. `mine` opens it on the My Jobs tab — only ever for
   *  a digest of the recipient's OWN jobs: sent to anyone else it lands on
   *  an empty board, which is a dead click with extra steps. */
  graphicsBoard: (opts?: { mine?: boolean; approved?: boolean }) =>
    `/graphics${opts?.mine ? '?mine=1' : opts?.approved ? '?approved=1' : ''}`,
  /** The graphics board's New Job form, filled in from an existing job (Duplicate). */
  graphicsDuplicate: (jobId: string) => `/graphics?new=1&copyFrom=${jobId}`,
  /** In-Shop board — opens the vehicle's detail modal (optionally flashing one note). */
  vehicle: (checkinId: string, noteId?: string | null) =>
    `/tracking?vehicle=${checkinId}${noteId ? `&note=${noteId}` : ''}`,
  /** Vehicle job card / pick list by VIN. Pass the check-in id whenever one
   *  is in scope: VIN-only links resolve to the VIN's NEWEST visit, so after
   *  a returning vehicle re-checks in (#712), a link about the old visit
   *  would open the new one (Round 3, §7.2.6 — per-visit deep links). */
  pickList: (vin: string, checkinId?: string | null) =>
    `/vehicles/${vin}/pick-list${checkinId ? `?visit=${checkinId}` : ''}`,
  /** Pick list arriving from a Pull In scan: starts (or joins) the job
   *  timer once and opens the tag-techs list. */
  pickListPullIn: (vin: string, checkinId: string) =>
    `/vehicles/${vin}/pick-list?visit=${checkinId}&pullin=1`,
  /** Pull In scanner (shop techs): scan a vehicle into a bay. */
  pullIn: () => '/pull-in',
  /** Camera Installs (T-Mobile camera + GO9B, migration 343): the list, or one install. */
  cameraInstalls: () => '/camera-installs',
  cameraInstall: (id: string) => `/camera-installs?id=${encodeURIComponent(id)}`,
  /** Pricing requests (Masterack, migration 352): the list, or one request. */
  pricingRequests: () => '/pricing-requests',
  pricingRequest: (id: string) => `/pricing-requests?id=${encodeURIComponent(id)}`,
  /** In-app Requests (migration 453): the list, or one request opened. */
  appRequests: () => '/requests',
  appRequest: (id: string) => `/requests?id=${encodeURIComponent(id)}`,
  /** A job task: the job's vehicle on In-Shop once one is checked in (techs
   *  work from the vehicle card, which lists the job's open tasks),
   *  otherwise the job page flashing the task (2026-10-20). */
  jobTask: (task: { projectId: string; taskId: string; vehicleId?: string | null }) =>
    task.vehicleId
      ? `/tracking?vehicle=${task.vehicleId}`
      : `/upfit?id=${task.projectId}&task=${task.taskId}`,
  /** The FleetSuite sales order page (read live from NetSuite; admins edit). */
  salesOrder: (netsuiteId: string | number) => `/sales-orders/${encodeURIComponent(String(netsuiteId))}`,
  /** Upfit board — opens the project detail (optionally flashing a note or
   *  task, or the Parts Readiness / Key Dates card for scheduling alerts). */
  upfitProject: (projectId: string, opts?: { noteId?: string | null; taskId?: string | null; focus?: 'parts' | 'dates' }) =>
    `/upfit?id=${projectId}${opts?.noteId ? `&note=${opts.noteId}` : ''}${opts?.taskId ? `&task=${opts.taskId}` : ''}${opts?.focus ? `&focus=${opts.focus}` : ''}`,
  /** Estimates page — opens the estimate in the builder view; flashNotes
   *  scroll-flashes the Internal Notes field (estimate-note mentions).
   *  from: 'quotes' makes the builder's back button return to that row on
   *  the Quotes page instead of the Estimates list; fromCustomer (the
   *  customer record's route id — a prospects.id or `ns-<id>`) sends it
   *  back to that customer's page. graphicsJobCreated (a graphics job id)
   *  is the New Job form's return trip: the estimate says the job was made
   *  and scrolls to Convert to Sales Order. */
  estimate: (estimateId: string, opts?: { flashNotes?: boolean; from?: 'quotes'; fromCustomer?: string | null; graphicsJobCreated?: string | null }) =>
    `/estimates?id=${estimateId}${opts?.flashNotes ? '&note=field' : ''}${opts?.from ? `&from=${opts.from}` : ''}${opts?.fromCustomer ? `&fromCustomer=${encodeURIComponent(opts.fromCustomer)}` : ''}${opts?.graphicsJobCreated ? `&gfxCreated=${opts.graphicsJobCreated}` : ''}`,
  /** An order's team chat (migration 357), keyed by the estimate id — the
   *  same record once the estimate becomes a sales order. Its own page so
   *  every internal role can open it, Estimates access or not; `message`
   *  scroll-flashes one message. */
  orderChat: (estimateId: string, messageId?: string | null) =>
    `/order-chat/${estimateId}${messageId ? `?message=${messageId}` : ''}`,
  /** Messages → Orders tab: every order chat you're in. */
  orderChats: () => '/messages?tab=orders',
  /** Estimates page — opens the builder on a fresh estimate, optionally
   *  pre-selecting a customer (local customers.id) or a CRM lead
   *  (prospects.id, for records not yet promoted to NetSuite). The straight
   *  path from entering a new client to quoting them. `fromQuickBooks` (a
   *  ledger_invoices id) opens the review grid on that old record's lines;
   *  `fromNetSuite` does the same for a NetSuite invoice, sales order or
   *  estimate by its internal id.
   *  `fromCustomer` works as on `estimate`: the builder's back button
   *  returns to that customer's page. */
  newEstimate: (customerId?: string | null, prospectId?: string | null, opts?: { fromQuickBooks?: string | null; fromNetSuite?: { type: 'invoice' | 'salesOrder' | 'estimate'; id: string } | null; fromCustomer?: string | null }) =>
    `/estimates?new=1${customerId ? `&customer=${customerId}` : ''}${!customerId && prospectId ? `&prospect=${prospectId}` : ''}${opts?.fromQuickBooks ? `&qbo=${opts.fromQuickBooks}` : ''}${opts?.fromNetSuite ? `&ns=${opts.fromNetSuite.type}:${encodeURIComponent(opts.fromNetSuite.id)}` : ''}${opts?.fromCustomer ? `&fromCustomer=${encodeURIComponent(opts.fromCustomer)}` : ''}`,
  /** Signed E-SIGN snapshot viewer — the frozen approval document with its
   *  integrity verdict (type: estimate | wrap_quote | proof). */
  signedDocument: (type: 'estimate' | 'wrap_quote' | 'proof', id: string) =>
    `/signed/${type}/${id}`,
  /** 3D upfit designer — opens a saved design (page reads ?design=). */
  upfitDesign: (designId: string) => `/upfit-designer?design=${designId}`,
  /** 3D upfit designer — starts a fresh design, optionally pre-selecting the
   *  vehicle platform and/or customer. */
  newUpfitDesign: (opts?: { platformId?: string | null; customerId?: string | null }) =>
    `/upfit-designer?new=1${opts?.platformId ? `&platform=${opts.platformId}` : ''}${opts?.customerId ? `&customer=${opts.customerId}` : ''}`,
  /** Parts page — opens the part's record: switches to its catalog tab,
   *  expands the row, scrolls to it, and highlights it (page reads ?part=). */
  part: (partId: string) => `/parts?part=${partId}`,
  /** Wrap-quote list — opens that quote (page reads ?id=). from: 'quotes'
   *  makes closing it return to that row on the Quotes page. */
  wrapQuote: (quoteId: string, opts?: { from?: 'quotes' }) =>
    `/admin/wrap-quote?id=${quoteId}${opts?.from ? `&from=${opts.from}` : ''}`,
  /** The FleetSuite copy of an estimate as PDF bytes (server-rendered — the
   *  same file the customer is emailed). Feed it to `pdfViewer`, never link
   *  a tab straight at it. */
  estimatePdf: (estimateId: string) => `/api/estimates/${estimateId}/pdf`,
  /** The FleetSuite copy of a wrap quote as PDF bytes (server-rendered from
   *  the shared quote-document model). Feed it to `pdfViewer`. */
  /** Graphics Builder opened on a Client Files proof (customer filled in from its folder). */
  graphicsBuilderFromClientFile: (clientFileId: string) => `/admin/wrap-quote?clientFile=${clientFileId}`,
  wrapQuotePdf: (quoteId: string) => `/api/wrap-quote/${quoteId}/pdf`,
  /** Install guide editor — the dimensioned placement guide record page. */
  installGuide: (guideId: string) => `/graphics/install-guides/${guideId}`,
  /** The Estimates list (Quotes was folded into it, 2026-10-27) —
   *  optionally scroll-flashes one quote's row (the list switches to the
   *  filter holding it); with no quote, the "Waiting on customer" filter.
   *  This is where Log Follow-Up / Won / Lost live, so quote-followup
   *  notifications land here, on the exact row they're about. The old
   *  /quotes and /admin/quote-followups URLs redirect here. */
  quoteFollowUps: (type?: 'estimate' | 'wrap', quoteId?: string) =>
    `/estimates${type && quoteId ? `?item=${type}-${quoteId}` : '?status=sent'}`,
  /** One quote itself, for alerts about it (👀 Opened, follow-up
   *  reminders). An estimate opens in the builder (Craig, 2026-10-29:
   *  tapping 👀 should open the estimate, not the list), and its back
   *  button returns to the estimate's row, where ☎ Log and ✉ Follow Up
   *  live. Wrap quotes keep their row on the list. */
  quote: (type: 'estimate' | 'wrap', quoteId: string) =>
    type === 'estimate' ? `/estimates?id=${quoteId}&from=quotes` : `/estimates?item=wrap-${quoteId}`,
  /** AP queue — jumps to the vendor invoice's status tab and highlights it. */
  apInvoice: (invoiceId: string) => `/admin/ap?invoice=${invoiceId}`,
  /** Installer portal invoice list — expands and scrolls to the invoice. */
  installerInvoice: (invoiceId: string) => `/installer/invoices?invoice=${invoiceId}`,
  /** Messages — opens the conversation thread. */
  conversation: (conversationId: string) => `/messages?conversation=${conversationId}`,
  /** Customer-comms inbox — opens one customer thread (admin/sales only). */
  inboxThread: (threadId: string) => `/admin/inbox?thread=${threadId}`,
  /** Schedule — opens a calendar event card (optionally flashing one note). */
  scheduleCard: (eventId: string, noteId?: string | null) =>
    `/admin/schedule?card=${eventId}${noteId ? `&note=${noteId}` : ''}`,
  /** Never-invoiced recovery queue — completed vehicles with no invoice,
   *  bucketed by what each needs. Optionally opens on one bucket. The
   *  destination for the dashboard's never-invoiced tile, which used to
   *  land on the whole In-Shop board with no hint which vehicles leaked. */
  neverInvoicedQueue: (bucket?: 'has_so' | 'estimate_only' | 'no_paperwork') =>
    `/admin/reports/never-invoiced${bucket ? `?bucket=${bucket}` : ''}`,
  /** Month-end close cockpit — one accounting month's gates. Defaults to
   *  the month being closed (last month) when no period is given. */
  monthClose: (period?: string | null) =>
    `/admin/reports/month-close${period ? `?period=${period}` : ''}`,
  /** At-risk report — opens the account's note editor and flashes the row. */
  atRiskCustomer: (customerId: string) => `/admin/reports/at-risk?id=${customerId}`,
  /** Dedicated CNI job record page (admin side). */
  cniJob: (jobId: string) => `/admin/cni/jobs/${jobId}`,
  /** The job's installer photo gallery (admin side) — where a "photos
   *  submitted" alert has to land. `cniJob` drops the reader on the job and
   *  makes them hunt for the tile holding the thing they were told about. */
  cniJobPhotos: (jobId: string) => `/admin/cni/jobs/${jobId}/photos`,
  /** Completion Photos: finished-work photos from every job, filterable. */
  completionPhotos: () => '/completion-photos',
  /** Client Files: Dropbox /OFFICE/Clients searchable in the app. `q` prefills
   *  the search; `folder` (dropbox_client_folders.id) narrows to one client
   *  folder; `matches` opens the Check matches list. */
  clientFiles: (opts?: { q?: string | null; folder?: string | null; customer?: { id: string; name: string } | null; matches?: boolean }) => {
    const p = new URLSearchParams();
    if (opts?.q) p.set('q', opts.q);
    if (opts?.folder) p.set('folder', opts.folder);
    if (opts?.customer) { p.set('customer', opts.customer.id); p.set('customerName', opts.customer.name); }
    if (opts?.matches) p.set('matches', '1');
    const s = p.toString();
    return `/client-files${s ? `?${s}` : ''}`;
  },
  /** After-hours Calls: calls BMG's virtual assistant answered while the office was closed. */
  /** QC Fixes (migration 381): the staff list, or one report. */
  qcFixes: () => '/qc-fixes',
  qcFix: (reportId: string) => `/qc-fixes?id=${encodeURIComponent(reportId)}`,
  /** A customer's shared QC link (no login), optionally opening one report. */
  qcLink: (token: string, reportId?: string | null) =>
    `/qc/${encodeURIComponent(token)}${reportId ? `?report=${encodeURIComponent(reportId)}` : ''}`,
  afterHoursCalls: () => '/after-hours-calls',
  /** One after-hours call: summary, transcript, recording, called-back tick. */
  afterHoursCall: (callId: string) => `/after-hours-calls?id=${callId}`,
  /** Public page for photos shared with a customer (the token is the credential). */
  sharedPhotos: (token: string) => `/shared-photos/${encodeURIComponent(token)}`,
  /** The vehicle record for one VIN — what was installed outside the shop,
   *  where, for whom, and every photo of it. */
  vehicleRecord: (vin: string) => `/vehicles/${encodeURIComponent(vin.trim().toUpperCase())}`,
  /** Installer photos across every job, optionally narrowed to one
   *  installer or company (the gallery reads both off the query string). */
  cniPhotos: (filter?: { installerId?: string | null; companyId?: string | null }) => {
    const params = new URLSearchParams();
    if (filter?.installerId) params.set('installer', filter.installerId);
    if (filter?.companyId) params.set('company', filter.companyId);
    const qs = params.toString();
    return `/admin/cni/photos${qs ? `?${qs}` : ''}`;
  },
  /** Dedicated CNI installer record page (optionally flashing an internal note). */
  cniInstaller: (userId: string, noteId?: string | null) =>
    `/admin/cni/installers/${userId}${noteId ? `?note=${noteId}` : ''}`,
  /** CNI installer company record — contact info, members, documents and
   *  the NetSuite vendor link its bills go to. */
  cniCompany: (companyId: string) => `/admin/cni/companies/${companyId}`,
  /** Opens a NetSuite vendor record in NetSuite (a redirect route, since
   *  the account id behind the NetSuite URL lives in server env only). */
  netsuiteVendor: (vendorId: string) => `/api/cni/vendor-link?id=${encodeURIComponent(vendorId)}`,
  /** Past Due invoices (A/R reminders, migration 357) — every customer with
   *  past-due invoices; `customer` (NetSuite entity id) opens and flashes
   *  that customer's row. */
  pastDue: (entityId?: string | null) => `/invoices/past-due${entityId ? `?customer=${encodeURIComponent(entityId)}` : ''}`,
  /** Dedicated prospect / customer record page. */
  prospect: (prospectId: string) => `/admin/prospects/${prospectId}`,
  /** The same record page with the standard customer compose screen already
   *  open, optionally pre-addressed. Every customer email goes through that
   *  screen (docs/customer-email-standard.md) — this is the link for surfaces
   *  that offer "email this customer" without owning a compose modal of their
   *  own (the command palette's quick action). Works for `ns-<id>` mirror ids
   *  too, since the page resolves those before it renders. */
  prospectCompose: (prospectId: string, to?: string | null) =>
    `/admin/prospects/${prospectId}?compose=1${to ? `&to=${encodeURIComponent(to)}` : ''}`,
  /** One deal on the prospect record — ?opp= scroll-flashes that
   *  opportunity card (R5-8 slippage nudges land on the exact deal). */
  opportunity: (prospectId: string, opportunityId: string) =>
    `/admin/prospects/${prospectId}?opp=${opportunityId}`,
  /** The same record page, addressed by the customer's NetSuite internal id
   *  (the page resolves `ns-<id>` to the prospect row + synced customer, so
   *  records with no CRM row still land). Use when a record only carries
   *  the NetSuite id — estimates, POs, sales orders. */
  customerByNetsuiteId: (netsuiteId: string | number) => `/admin/prospects/ns-${netsuiteId}`,
  /** Purchasing queue — pending purchase requests grouped by vendor;
   *  ?req= scroll-flashes one request's row. */
  purchaseRequests: (requestId?: string | null) =>
    `/admin/purchasing${requestId ? `?req=${requestId}` : ''}`,
  /** Purchasing queue with a BATCH of new requests flashed (the one-click
   *  buy list raises dozens at once). A digest of many records may link to
   *  the list, but it can still land on exactly the rows it is about. */
  purchaseRequestBatch: (requestIds: string[]) => {
    const ids = requestIds.filter(Boolean).slice(0, 40);
    return ids.length === 1
      ? `/admin/purchasing?req=${ids[0]}`
      : `/admin/purchasing${ids.length ? `?reqs=${ids.join(',')}` : ''}`;
  },
  /** Receiving page — ?po= expands and flashes one vendor PO (the local
   *  netsuite_vendor_pos row id). */
  receiving: (poId?: string | null) =>
    `/admin/receiving${poId ? `?po=${poId}` : ''}`,
  /** Credit application review queue — opens the application's detail. */
  creditApplication: (appId: string) => `/admin/credit-applications?app=${appId}`,
  /** Users admin — opens the user's edit modal (e.g. a pending access request). */
  adminUser: (userId: string) => `/admin/users?user=${userId}`,
  /** Invoices hub, Invoiced tab — optionally prefilters to one invoice number. */
  invoicesSent: (invoiceNumber?: string | null) =>
    `/invoices?tab=sent${invoiceNumber ? `&invoice=${encodeURIComponent(invoiceNumber)}` : ''}`,
  /** Invoices hub — opens the create-invoice dialog for a shipped graphics job.
   *  NOTE: this exact string doubles as the match key that marks the prompt
   *  read once the invoice exists (graphics-invoice-notify.ts) — change both
   *  sides together or not at all. */
  createInvoiceForJob: (jobId: string) => `/invoices?invoiceJob=${jobId}`,
  /** Ready-for-install list — highlights the vehicles for one graphics job. */
  readyForInstall: (graphicsJobId?: string | null) =>
    `/installer/ready-for-install${graphicsJobId ? `?job=${graphicsJobId}` : ''}`,
  /** POs page with the pending-import review queue opened on one entry. */
  poPendingReview: (messageId: string) => `/admin/pos?review=${encodeURIComponent(messageId)}`,
  /** Customer portal dashboard — the only in-app destination an external
   *  customer login can open; use for customer email CTAs when no public
   *  page (carrier tracking, approval magic link) fits. */
  customerPortal: () => '/customer/dashboard',
  /** Customer PO-status portal — the shared link on a customer record
   *  (customers.portal_token, migration 260). Public page, no login. */
  customerPoPortal: (token: string) => `/portal/${encodeURIComponent(token)}`,
  /** Customer Order status page for one approved estimate
   *  (estimates.order_status_token, migration 449). Public, no login; the
   *  rep hands it out (approval confirmation email, Copy link). */
  orderStatus: (token: string) => `/order/${encodeURIComponent(token)}`,
  /** The three tokenized approval pages. Public, no login: the token IS
   *  the credential, so these strings are only ever built server-side and
   *  handed straight to the audience the link was minted for — an emailed
   *  customer, or that same customer's own portal page. Never log one,
   *  never return one to staff (stripApprovalSecrets exists for that). */
  approveEstimate: (token: string) => `/approve/estimate/${encodeURIComponent(token)}`,
  approveQuote: (token: string) => `/approve/quote/${encodeURIComponent(token)}`,
  approveProof: (token: string) => `/approve/proof/${encodeURIComponent(token)}`,
  /** The installer's own profile page — documents, insurance expiry, and the
   *  agreements. The destination for every compliance warning: entering a new
   *  expiry here clears the flag on its own. */
  installerProfile: () => '/installer/profile',
  /** Installer compliance panel: every company and installer with their
   *  computed eligibility, worst first. */
  cniCompliance: () => '/admin/cni/compliance',
  /** The weekly Outreach list; `rep` opens another rep's list (admins). */
  outreach: (rep?: string) => `/admin/outreach${rep ? `?rep=${encodeURIComponent(rep)}` : ''}`,
  /** One company on the Outreach list: the page scrolls to and flashes it. */
  outreachTarget: (id: string) => `/admin/outreach?target=${encodeURIComponent(id)}`,
  /** Quiet-lead triage queue (R6-9) — the destination for the dashboard's
   *  quiet-leads tile, which used to land on the bare prospects list. */
  quietLeads: (days?: number) => `/admin/leads/quiet${days ? `?days=${days}` : ''}`,
  /** The installer's own earnings/payout history — the destination for CNI
   *  payout-status notifications (there is no per-payout page). */
  earnings: () => '/earnings',
  /** Installer-portal job detail — the landing for installer-facing CNI
   *  notifications (assigned, schedule proposed). The page renders the
   *  Accept/Decline schedule controls, so it needs no extra param. Distinct
   *  from `cniJob`, which is the admin-side record an installer can't open. */
  installerJob: (jobId: string) => `/installer/jobs/${jobId}`,
  /** Installer photo upload/review page — where denial badges and reviewer
   *  notes actually render (installerJob lands one page short of them). */
  installerJobPhotos: (jobId: string) => `/installer/jobs/${jobId}/photos`,
  /** In-Shop board's arrivals section — scroll-flashes one inbound row
   *  (ShopArrivals reads ?arrival=). The landing for arrival pings with no
   *  check-in to open yet. */
  shopArrival: (inboundId: string) => `/tracking?arrival=${inboundId}`,
  /** Installer-portal AVAILABLE job — where an invited company responds to
   *  a bid invitation (distinct from installerJob, the assigned-work page). */
  installerAvailableJob: (jobId: string) => `/installer/available/${jobId}`,
  /** System health dashboard (checks are keyed by sync type, not record ids). */
  systemHealth: () => '/admin/system-health',
  /** System health's Usage tab (R7-4 browser telemetry), optionally
   *  pre-filtered to one event kind / templated page / form id and window.
   *  The tab reads these params, applies the filter and flashes the row.
   *  Any future alert about client errors must pass this as its url. */
  systemHealthUsage: (opts?: { kind?: string | null; page?: string | null; form?: string | null; days?: 7 | 30 }) => {
    const params = new URLSearchParams({ tab: 'usage' });
    if (opts?.kind) params.set('kind', opts.kind);
    if (opts?.page) params.set('page', opts.page);
    if (opts?.form) params.set('form', opts.form);
    if (opts?.days) params.set('days', String(opts.days));
    return `/admin/system-health?${params.toString()}`;
  },
  /** The audit log pre-filtered to ONE record (R6-13) — the destination for
   *  the History control on estimate, check-in, graphics, upfit and CNI
   *  pages. `table` must be the real table name, since that is what
   *  audit_log.table_name stores. */
  recordHistory: (table: string, recordId: string) =>
    `/admin/audit?table=${encodeURIComponent(table)}&record=${encodeURIComponent(recordId)}`,
  /** System health's Email delivery section — flashes one email_log row.
   *  The bounce-alert fallback when a send has no record context_url. */
  emailDelivery: (logId?: string | null) =>
    `/admin/system-health${logId ? `?email=${logId}` : ''}`,
  /** The ledger admin page (QuickBooks import + the customer review queue).
   *  Params are emitted only when given, so the bare call is the clean page
   *  URL: `run` opens one import run's progress feed, `tab` picks the pane,
   *  and `qboAuth`/`reason` are what the OAuth callback redirects with. */
  ledgerAdmin: (opts?: { run?: string | null; tab?: 'import' | 'review'; qboAuth?: 'success' | 'error'; reason?: string | null }) => {
    const params = new URLSearchParams();
    if (opts?.tab) params.set('tab', opts.tab);
    if (opts?.run) params.set('run', opts.run);
    if (opts?.qboAuth) params.set('qboAuth', opts.qboAuth);
    if (opts?.reason) params.set('reason', opts.reason);
    const q = params.toString();
    return `/admin/ledger${q ? `?${q}` : ''}`;
  },
  /** The review queue, optionally scroll-flashing ONE ledger customer — the
   *  landing for "this QuickBooks customer needs a match" (never the bare
   *  list while a row id is in scope). */
  ledgerCustomerReview: (ledgerCustomerId?: string | null) =>
    `/admin/ledger?tab=review${ledgerCustomerId ? `&customer=${ledgerCustomerId}` : ''}`,
  /** Books → Differences vs NetSuite on one company's month ('YYYY-MM' or
   *  'YYYY-MM-01'), which the page opens from ?company= and ?month=: the
   *  landing for the daily books check's notification
   *  (src/lib/books/daily-check.ts) and Reports' links to a month. Super
   *  admins only, as the books are. */
  booksDifferences: (company: string, month: string) =>
    `/admin/books/differences?${new URLSearchParams({ company, month: month.slice(0, 7) })}`,
  /** Books → Reports on one company's report for the months from `from`
   *  through `to` ('YYYY-MM' or 'YYYY-MM-01'), which the page opens from its
   *  params: the way back from an account's detail. Super admins only. */
  booksReport: (company: string, report: string, from: string, to: string) =>
    `/admin/books/reports?${new URLSearchParams({ company, report, from: from.slice(0, 7), to: to.slice(0, 7) })}`,
  /** Books → Reports → one account line's detail: the documents behind
   *  the line on `report` for the months from `from` through `to`, only
   *  those that differ from NetSuite with `differs` (docs/books.md "Report
   *  detail"). `account` is the line's key, NetSuite's id or 'fs:<id>'.
   *  Super admins only. */
  booksAccountDetail: (company: string, account: string, report: string, from: string, to: string, differs = false) =>
    `/admin/books/reports/detail?${new URLSearchParams({
      company, account, report, from: from.slice(0, 7), to: to.slice(0, 7), ...(differs ? { only: 'differs' } : {}),
    })}`,
  /** Books → Invoices vs NetSuite opened on one NetSuite document's line by
   *  line check: `kind` is the page's switch for it (listKindOf in
   *  src/lib/books/differences.ts) and `month` the month it lists it
   *  under. Super admins only. */
  booksDocument: (company: string, kind: string, month: string, netsuiteId: string) =>
    `/admin/books/invoices?${new URLSearchParams({ company, kind, month: month.slice(0, 7), doc: netsuiteId })}`,
  /** Books → Stock by item, only the items whose count or value differs
   *  from NetSuite's with `differs`: the landing for the daily books
   *  check's notification about several items (src/lib/books/daily-check.ts).
   *  Super admins only. */
  booksStock: (differs = false) => `/admin/books/stock${differs ? '?only=differs' : ''}`,
  /** Books → Stock by item → one item's moves, by its NetSuite id, with
   *  the row of one location (NetSuite's id) picked out: the landing for
   *  the daily books check's notification about one item. Super admins
   *  only. */
  booksStockItem: (itemId: string, locationId?: string | null) =>
    `/admin/books/stock/item?${new URLSearchParams({ item: itemId, ...(locationId ? { location: locationId } : {}) })}`,
  /** Books → Customer and vendor balances on one company's customers
   *  (`kind` 'customer') or vendors ('vendor'), only those whose balance
   *  differs from NetSuite's with `differs`: the landing for the daily
   *  books check's notification about several balances
   *  (src/lib/books/daily-check.ts). Super admins only. */
  booksBalances: (company: string, kind: string, differs = false) =>
    `/admin/books/balances?${new URLSearchParams({ company, kind, ...(differs ? { only: 'differs' } : {}) })}`,
  /** Books → Customer and vendor balances → one customer's (its FleetSuite
   *  id) or vendor's (its NetSuite id) balance and the documents behind it,
   *  '' for the lines FleetSuite can't name ('none' in the address), only
   *  the documents that differ from NetSuite with `differs`: the landing
   *  for the daily books check's notification about one balance. Super
   *  admins only. */
  booksBalance: (company: string, kind: string, party: string, differs = false) =>
    `/admin/books/balances/party?${new URLSearchParams({ company, kind, party: party || 'none', ...(differs ? { only: 'differs' } : {}) })}`,
  /** Books → AR and AP agings on one company's customers (`kind`
   *  'customer') or vendors ('vendor'), only those whose aging differs from
   *  NetSuite's with `differs`. Super admins only. */
  booksAgings: (company: string, kind: string, differs = false) =>
    `/admin/books/agings?${new URLSearchParams({ company, kind, ...(differs ? { only: 'differs' } : {}) })}`,
  /** Books → AR and AP agings → one customer's (its FleetSuite id) or
   *  vendor's (its NetSuite id) open documents, by how late, '' for the
   *  lines FleetSuite can't name ('none' in the address). Super admins
   *  only. */
  booksAging: (company: string, kind: string, party: string) =>
    `/admin/books/agings/party?${new URLSearchParams({ company, kind, party: party || 'none' })}`,
  /** Books → Own invoices on the month ('YYYY-MM' or 'YYYY-MM-01') they
   *  were made in, the newest month when it's left out, only those that
   *  differ from NetSuite's with `differs`: the landing for the daily books
   *  check's notification about several own invoices
   *  (src/lib/books/daily-check.ts). Super admins only. */
  booksOwnInvoices: (month?: string | null, differs = false) => {
    const query = new URLSearchParams({ ...(month ? { month: month.slice(0, 7) } : {}), ...(differs ? { only: 'differs' } : {}) }).toString();
    return `/admin/books/own-invoices${query ? `?${query}` : ''}`;
  },
  /** Books → Own invoices → FleetSuite's own copy of one invoice, by
   *  NetSuite's id for it, next to NetSuite's line by line: the landing for
   *  the daily books check's notification about one own invoice. Super
   *  admins only. */
  booksOwnInvoice: (netsuiteId: string) => `/admin/books/own-invoices/invoice?${new URLSearchParams({ id: netsuiteId })}`,
  /** Books → Own fulfillments on the month ('YYYY-MM' or 'YYYY-MM-01')
   *  they were made in, the newest month when it's left out, only those
   *  that differ from NetSuite's with `differs`: the landing for the daily
   *  books check's notification about several own fulfillments
   *  (src/lib/books/daily-check.ts). Super admins only. */
  booksOwnFulfillments: (month?: string | null, differs = false) => {
    const query = new URLSearchParams({ ...(month ? { month: month.slice(0, 7) } : {}), ...(differs ? { only: 'differs' } : {}) }).toString();
    return `/admin/books/own-fulfillments${query ? `?${query}` : ''}`;
  },
  /** Books → Own fulfillments → FleetSuite's own copy of one fulfillment,
   *  by NetSuite's id for it, next to NetSuite's item by item: the landing
   *  for the daily books check's notification about one own fulfillment.
   *  Super admins only. */
  booksOwnFulfillment: (netsuiteId: string) => `/admin/books/own-fulfillments/fulfillment?${new URLSearchParams({ id: netsuiteId })}`,
  /** Books → Own bills on the month ('YYYY-MM' or 'YYYY-MM-01') they were
   *  made in, the newest month when it's left out, only those that differ
   *  from NetSuite's with `differs`: the landing for the daily books check's
   *  notification about several own bills (src/lib/books/daily-check.ts).
   *  Super admins only. */
  booksOwnBills: (month?: string | null, differs = false) => {
    const query = new URLSearchParams({ ...(month ? { month: month.slice(0, 7) } : {}), ...(differs ? { only: 'differs' } : {}) }).toString();
    return `/admin/books/own-bills${query ? `?${query}` : ''}`;
  },
  /** Books → Own bills → Books' own copy of one bill FleetSuite made, by
   *  NetSuite's id for it, next to NetSuite's line by line: the landing for
   *  the daily books check's notification about one own bill. Super admins
   *  only. */
  booksOwnBill: (netsuiteId: string) => `/admin/books/own-bills/bill?${new URLSearchParams({ id: netsuiteId })}`,
  /** Books → Own receipts on the month ('YYYY-MM' or 'YYYY-MM-01') they
   *  were received in, the newest month when it's left out, only those that
   *  differ from NetSuite's with `differs`: the landing for the daily books
   *  check's notification about several own receipts
   *  (src/lib/books/daily-check.ts). Super admins only. */
  booksOwnReceipts: (month?: string | null, differs = false) => {
    const query = new URLSearchParams({ ...(month ? { month: month.slice(0, 7) } : {}), ...(differs ? { only: 'differs' } : {}) }).toString();
    return `/admin/books/own-receipts${query ? `?${query}` : ''}`;
  },
  /** Books → Own receipts → Books' own copy of one Receive on the Receiving
   *  page, by its key (FleetSuite's first row of it), next to NetSuite's item
   *  receipt item by item: the landing for the daily books check's
   *  notification about one own receipt. Super admins only. */
  booksOwnReceipt: (receiptKey: string) => `/admin/books/own-receipts/receipt?${new URLSearchParams({ key: receiptKey })}`,
  /** Books → Own adjustments on the month ('YYYY-MM' or 'YYYY-MM-01') they
   *  were made in, the newest month when it's left out, only those that
   *  differ from NetSuite's with `differs`: the landing for the daily books
   *  check's notification about several own adjustments
   *  (src/lib/books/daily-check.ts). Super admins only. */
  booksOwnAdjustments: (month?: string | null, differs = false) => {
    const query = new URLSearchParams({ ...(month ? { month: month.slice(0, 7) } : {}), ...(differs ? { only: 'differs' } : {}) }).toString();
    return `/admin/books/own-adjustments${query ? `?${query}` : ''}`;
  },
  /** Books → Own adjustments → one Inventory Adjust, by FleetSuite's id for
   *  it, next to NetSuite's adjustment: the landing for the daily books
   *  check's notification about one own adjustment. Super admins only. */
  booksOwnAdjustment: (id: string) => `/admin/books/own-adjustments/adjustment?${new URLSearchParams({ id })}`,
  /** Books → Snap a bill: a new one, or one already snapped (saved for
   *  later, sent or thrown away) by its id, with its picture. Super admins
   *  only. */
  booksSnapBill: (id?: string | null) => `/admin/books/snap-a-bill${id ? `?${new URLSearchParams({ id })}` : ''}`,
  /** The picture or PDF of one snapped bill, as bytes (same-origin, super
   *  admins only; the books-bills prefix is denied on /api/storage). Feed a
   *  PDF to `pdfViewer`. */
  booksSnapBillFile: (id: string) => `/api/admin/books/snap-a-bill?${new URLSearchParams({ file: id })}`,
  /** Books → Mistake checks on a company's list ('BMG', '1084'), with one
   *  item on it picked out by its id: the landing for the daily books
   *  check's notification about new likely mistakes in the copies of
   *  NetSuite's bills, checks and card charges
   *  (src/lib/books/daily-check.ts). Super admins only. */
  booksMistakeChecks: (company?: string | null, item?: string | null) => {
    const query = new URLSearchParams({ ...(company ? { company } : {}), ...(item ? { item } : {}) }).toString();
    return `/admin/books/mistake-checks${query ? `?${query}` : ''}`;
  },
  /** Bytes of one imported ledger document (QuickBooks/NetSuite PDF or
   *  attachment, migration 314). Same-origin and role-gated
   *  (finance/executive) — `allowedPdfSrc` therefore accepts it, so feed it
   *  to `pdfViewer` rather than opening the raw bytes in a bare tab. Add
   *  `?download=1` for a save-as (a 5-minute presigned URL). Never a public
   *  R2 URL: the `ledger` prefix is denied on the generic storage routes. */
  ledgerDocument: (documentId: string) => `/api/ledger/documents/${documentId}`,
  /** NetSuite's own PDF of one transaction, as bytes (same-origin, staff
   *  only). Feed it to `pdfViewer`. The top bar opens a NetSuite estimate
   *  this way (netsuite_estimates, migration 372); the Purchasing page a
   *  vendor PO (netsuite_vendor_pos.netsuite_id). `fileName` is what Save
   *  calls it (build a PO's with `poPdfFileName`); without one NetSuite's
   *  name is used, which for a PO is only its internal id. */
  netsuitePdf: (type: 'salesOrder' | 'invoice' | 'estimate' | 'purchaseOrder', netsuiteId: string | number, fileName?: string | null) =>
    `/api/netsuite/pdf?type=${type}&id=${encodeURIComponent(String(netsuiteId))}&format=pdf${fileName ? `&name=${encodeURIComponent(fileName)}` : ''}`,
  /** A vendor PO's saved file name: its number, e.g. PO452.pdf (Craig,
   *  2026-10-21; it used to save as PurchaseOrder_<internal id>.pdf). */
  poPdfFileName: (poNumber: string | null | undefined, netsuiteId: string | number) => {
    const n = String(poNumber || '').trim().replace(/^PO\s*#?\s*/i, '');
    return n ? `PO${n}.pdf` : `PO-${netsuiteId}.pdf`;
  },
  /** In-app PDF viewer tab. Use this instead of linking a new tab straight at
   *  PDF bytes: a raw-PDF tab has no app chrome and no working Back button,
   *  so it strands whoever opened it (field bug: opening a PO PDF mid-import).
   *  `src` must be a same-origin path or a URL on our file host — the viewer
   *  refuses anything else. `back` is where its ← lands when the tab can't
   *  close itself; pass the deep link to the record being worked on. */
  pdfViewer: (
    src: string,
    opts?: { name?: string | null; back?: string | null; backLabel?: string | null },
  ) => {
    const params = new URLSearchParams({ src });
    if (opts?.name) params.set('name', opts.name);
    if (opts?.back) params.set('back', opts.back);
    if (opts?.backLabel) params.set('backLabel', opts.backLabel);
    return `/pdf?${params.toString()}`;
  },
  /** Wrap an in-app path so a Supabase auth email lands SIGNED IN.
   *  `exchangeCodeForSession` runs in exactly one place
   *  (src/app/auth/callback/route.ts), so a magic link whose `redirectTo`
   *  points straight at a page arrives with an unexchanged code and dumps
   *  the recipient on /login — which is how every invite this app has ever
   *  sent behaved. Every `generateLink` redirectTo goes through here.
   *  Note the host still has to be on Supabase's Redirect URLs allow-list
   *  (Authentication -> URL Configuration); an unlisted redirect_to is
   *  discarded silently and the Site URL is substituted. */
  authCallback: (next: string) => `/auth/callback?next=${encodeURIComponent(next)}`,
  /** An invite/login email link that points straight at FleetSuite and signs
   *  in wherever it opens (src/app/auth/confirm/page.tsx verifies the token
   *  there). The phone app opens go.bmgfleet.com links itself, so a link
   *  that Safari verified first (the Supabase action_link) left its session
   *  in Safari, not the app. `tokenHash` is generateLink's hashed_token. */
  authConfirm: (tokenHash: string, next: string) =>
    `/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=${encodeURIComponent(next)}`,
};

/** The link to put in an invite email, from supabase.auth.admin.generateLink's
 *  result: the in-app confirm page when a hashed token came back, else the
 *  Supabase action_link, else null. */
export function inviteLinkFrom(linkData: any, appUrl: string, next: string): string | null {
  const hashed = linkData?.properties?.hashed_token;
  if (hashed) return `${appUrl}${deepLinks.authConfirm(hashed, next)}`;
  return linkData?.properties?.action_link || null;
}

import { resolveFeatures } from '@/lib/features';

/**
 * The vehicle deep link a given recipient can actually open. The In-Shop
 * board (`vehicle`) requires the in_shop/fleet_checkin feature; external CNI
 * installers lack both, so a /tracking URL bounces them to /home — but the
 * pick-list page admits installers (and techs) by role, so their link lands
 * on the same vehicle there. Falls back to the board URL when no VIN is on
 * hand. Producers notifying a mixed audience about a vehicle should build
 * each recipient's URL through this, not `vehicle()` directly.
 */
export function vehicleLinkFor(
  roles: string[] | null | undefined,
  checkinId: string,
  vin: string | null | undefined,
): string {
  const features = resolveFeatures(roles?.length ? roles : [], []);
  if (features.has('in_shop') || features.has('fleet_checkin')) return deepLinks.vehicle(checkinId);
  return vin ? deepLinks.pickList(vin, checkinId) : deepLinks.vehicle(checkinId);
}

/**
 * The CNI job link a given recipient can actually open. The admin record
 * page (`cniJob`) sits behind the cni_admin feature; the job's installers
 * live in the installer portal (`installerJob`). The job chat serves BOTH
 * portals from different URLs, so a producer notifying a mixed audience
 * about a CNI job (chat mentions above all) must build each recipient's
 * URL through this — storing the sender's own pathname bounces every
 * cross-portal recipient (Round 3, §7.2.7).
 */
export function cniJobLinkFor(
  roles: string[] | null | undefined,
  jobId: string,
): string {
  const features = resolveFeatures(roles?.length ? roles : [], []);
  if (features.has('cni_admin')) return deepLinks.cniJob(jobId);
  return deepLinks.installerJob(jobId);
}

/**
 * Vet a `pdfViewer` src before the viewer renders it in an iframe.
 *
 * Only same-origin paths/URLs and our public file host are allowed: the
 * viewer draws the app's header and nav around whatever it's given, so an
 * arbitrary URL would turn a link anyone can craft into a convincing
 * phishing frame. Returns the URL to render, or null to refuse.
 */
export function allowedPdfSrc(
  raw: string | null | undefined,
  appOrigin: string,
): string | null {
  if (!raw) return null;
  // Same-origin path. Reject "//host" (protocol-relative, i.e. off-site) and
  // anything that isn't a path at all ("javascript:…", "data:…").
  if (raw.startsWith('/')) return raw.startsWith('//') ? null : raw;
  let fileHost = '';
  try { fileHost = new URL(process.env.NEXT_PUBLIC_R2_PUBLIC_URL || '').origin; } catch { /* unset */ }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (u.origin === appOrigin) return u.toString();
    if (fileHost && u.origin === fileHost) return u.toString();
  } catch { /* not a URL */ }
  return null;
}

/**
 * Public carrier tracking page for a shipment — the right CTA for
 * customer-facing shipped emails (customers can't open internal app pages).
 * Returns null when the carrier/number don't identify a known carrier.
 */
export function carrierTrackingUrl(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!trackingNumber) return null;
  const c = (carrier || '').toLowerCase();
  const t = trackingNumber.trim();
  if (c.includes('ups') || /^1Z/i.test(t)) return `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`;
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`;
  return null;
}

/**
 * Canonical URL for a note @mention's source entity — the server-side
 * fallback when a surface saves a mention without a contextUrl, and the
 * rebuild map MentionsInbox uses for legacy rows whose stored URL predates
 * deep links. Keys are the sourceType strings surfaces pass to /api/mentions.
 */
export function mentionSourceUrl(
  sourceType: string | null | undefined,
  sourceId: string | null | undefined,
): string | null {
  if (!sourceId) return null;
  switch (sourceType) {
    case 'checkin_note':
    case 'vehicle_note':
      return deepLinks.vehicle(sourceId);
    case 'po_note':
      return deepLinks.po(sourceId);
    case 'graphics_note':
      return deepLinks.graphicsJob(sourceId);
    case 'upfit_note':
      return deepLinks.upfitProject(sourceId);
    case 'estimate_note':
      return deepLinks.estimate(sourceId);
    case 'order_chat':
      return deepLinks.orderChat(sourceId);
    case 'calendar_event_note':
      return deepLinks.scheduleCard(sourceId);
    case 'customer_note':
      return deepLinks.atRiskCustomer(sourceId);
    case 'cni_internal_note':
      return deepLinks.cniInstaller(sourceId);
    case 'prospect_note':
      return deepLinks.prospect(sourceId);
    case 'wrap_quote_note':
      return deepLinks.wrapQuote(sourceId);
    case 'credit_app_note':
      return deepLinks.creditApplication(sourceId);
    case 'receiving_note':
      return deepLinks.receiving(sourceId);
    case 'vendor_invoice_note':
      return deepLinks.apInvoice(sourceId);
    case 'purchase_request_note':
      return deepLinks.purchaseRequests(sourceId);
    // cni_job_message mentions are resolved per recipient by the mentions
    // route (cniJobLinkFor — the chat serves two portals from different
    // URLs); this admin-side fallback covers legacy inbox rows and rows
    // saved with no recipient resolution.
    case 'cni_job_message':
      return deepLinks.cniJob(sourceId);
    default:
      return null;
  }
}
