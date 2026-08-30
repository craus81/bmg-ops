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
  /** Dedicated PO record page. */
  po: (poId: string) => `/admin/pos/${poId}`,
  /** Dedicated graphics job record page. */
  graphicsJob: (jobId: string) => `/graphics/${jobId}`,
  /** In-Shop board — opens the vehicle's detail modal (optionally flashing one note). */
  vehicle: (checkinId: string, noteId?: string | null) =>
    `/tracking?vehicle=${checkinId}${noteId ? `&note=${noteId}` : ''}`,
  /** Vehicle job card / pick list by VIN. */
  pickList: (vin: string) => `/vehicles/${vin}/pick-list`,
  /** Upfit board — opens the project detail (optionally flashing a note or task). */
  upfitProject: (projectId: string, opts?: { noteId?: string | null; taskId?: string | null }) =>
    `/upfit?id=${projectId}${opts?.noteId ? `&note=${opts.noteId}` : ''}${opts?.taskId ? `&task=${opts.taskId}` : ''}`,
  /** Estimates page — opens the estimate in the builder view; flashNotes
   *  scroll-flashes the Internal Notes field (estimate-note mentions). */
  estimate: (estimateId: string, opts?: { flashNotes?: boolean }) =>
    `/estimates?id=${estimateId}${opts?.flashNotes ? '&note=field' : ''}`,
  /** Estimates page — opens the builder on a fresh estimate, optionally
   *  pre-selecting a customer (local customers.id) or a CRM lead
   *  (prospects.id, for records not yet promoted to NetSuite). The straight
   *  path from entering a new client to quoting them. */
  newEstimate: (customerId?: string | null, prospectId?: string | null) =>
    `/estimates?new=1${customerId ? `&customer=${customerId}` : ''}${!customerId && prospectId ? `&prospect=${prospectId}` : ''}`,
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
  /** Wrap-quote list — opens that quote (page reads ?id=). */
  wrapQuote: (quoteId: string) => `/admin/wrap-quote?id=${quoteId}`,
  /** Install guide editor — the dimensioned placement guide record page. */
  installGuide: (guideId: string) => `/graphics/install-guides/${guideId}`,
  /** Combined quotes list — optionally scroll-flashes one quote's row
   *  (the page switches to the filter holding it). This is where Log
   *  Follow-Up / Won / Lost live, so quote-followup notifications land
   *  here, on the exact row they're about. The old
   *  /admin/quote-followups URL redirects here with params intact. */
  quoteFollowUps: (type?: 'estimate' | 'wrap', quoteId?: string) =>
    `/quotes${type && quoteId ? `?item=${type}-${quoteId}` : ''}`,
  /** AP queue — jumps to the vendor invoice's status tab and highlights it. */
  apInvoice: (invoiceId: string) => `/admin/ap?invoice=${invoiceId}`,
  /** Installer portal invoice list — expands and scrolls to the invoice. */
  installerInvoice: (invoiceId: string) => `/installer/invoices?invoice=${invoiceId}`,
  /** Messages — opens the conversation thread. */
  conversation: (conversationId: string) => `/messages?conversation=${conversationId}`,
  /** Schedule — opens a calendar event card (optionally flashing one note). */
  scheduleCard: (eventId: string, noteId?: string | null) =>
    `/admin/schedule?card=${eventId}${noteId ? `&note=${noteId}` : ''}`,
  /** At-risk report — opens the account's note editor and flashes the row. */
  atRiskCustomer: (customerId: string) => `/admin/reports/at-risk?id=${customerId}`,
  /** Dedicated CNI job record page (admin side). */
  cniJob: (jobId: string) => `/admin/cni/jobs/${jobId}`,
  /** Dedicated CNI installer record page (optionally flashing an internal note). */
  cniInstaller: (userId: string, noteId?: string | null) =>
    `/admin/cni/installers/${userId}${noteId ? `?note=${noteId}` : ''}`,
  /** Dedicated prospect / customer record page. */
  prospect: (prospectId: string) => `/admin/prospects/${prospectId}`,
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
  /** Tech-facing photo page for one scanned vehicle (photo review verdicts). */
  scanPhotos: (scannedVehicleId: string) => `/photos?id=${scannedVehicleId}`,
  /** POs page with the pending-import review queue opened on one entry. */
  poPendingReview: (messageId: string) => `/admin/pos?review=${encodeURIComponent(messageId)}`,
  /** Customer portal dashboard — the only in-app destination an external
   *  customer login can open; use for customer email CTAs when no public
   *  page (carrier tracking, approval magic link) fits. */
  customerPortal: () => '/customer/dashboard',
  /** The installer's own earnings/payout history — the destination for CNI
   *  payout-status notifications (there is no per-payout page). */
  earnings: () => '/earnings',
  /** Installer-portal job detail — the landing for installer-facing CNI
   *  notifications (assigned, schedule proposed). The page renders the
   *  Accept/Decline schedule controls, so it needs no extra param. Distinct
   *  from `cniJob`, which is the admin-side record an installer can't open. */
  installerJob: (jobId: string) => `/installer/jobs/${jobId}`,
  /** System health dashboard (checks are keyed by sync type, not record ids). */
  systemHealth: () => '/admin/system-health',
  /** System health's Email delivery section — flashes one email_log row.
   *  The bounce-alert fallback when a send has no record context_url. */
  emailDelivery: (logId?: string | null) =>
    `/admin/system-health${logId ? `?email=${logId}` : ''}`,
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
};

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
  return vin ? deepLinks.pickList(vin) : deepLinks.vehicle(checkinId);
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
    case 'calendar_event_note':
      return deepLinks.scheduleCard(sourceId);
    case 'customer_note':
      return deepLinks.atRiskCustomer(sourceId);
    case 'cni_internal_note':
      return deepLinks.cniInstaller(sourceId);
    // cni_job_message always arrives with a contextUrl (the chat page's own
    // pathname, which differs between the admin and installer portals), so
    // this admin-side fallback only catches rows saved with none at all.
    case 'cni_job_message':
      return deepLinks.cniJob(sourceId);
    default:
      return null;
  }
}
