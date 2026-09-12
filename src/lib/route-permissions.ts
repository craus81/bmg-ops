import type { FeatureKey } from '@/lib/features';

/**
 * The route→permission manifest (audit Round 2 item 20) — every API route,
 * with the guard it is REQUIRED to carry. api-auth-guard.test.ts walks
 * src/app/api and fails when a route.ts has no entry here, when a file
 * stops containing its declared guard markers, when an entry goes stale,
 * or when a route calls bare requireAuth( without declaring it. The old
 * spot-check covered 7 directories and accepted a route with no guard at
 * all; this makes authorization an exhaustive, diffable surface instead.
 *
 * Adding a route? Add its entry in the same change — the test names this
 * file when it fails. Pick the strongest guard that fits, and for anything
 * weaker than a staff wall (authScoped / token / webhook / public) write
 * the WHY: one reviewable sentence explaining what makes that shape safe.
 * requireAuth admits ANY approved login — customer and external-installer
 * accounts included — so an authScoped entry means "requireAuth on purpose,
 * with the real check inside the handler" and should name a marker string
 * for that check when one exists.
 *
 * `contains` strings are matched VERBATIM against the route file, the same
 * trick the estimates guard test proved out: cheap, dumb, and impossible
 * to satisfy by accident.
 */

export type RouteGuardKind =
  | 'staff'        // requireStaff — internal BMG staff only
  | 'admin'        // requireAdmin
  | 'superAdmin'   // requireSuperAdmin — owner-level wall
  | 'financials'   // requireFinancials — super_admin / executive only
  | 'role'         // requireRole(...) — specific roles (admins auto-pass)
  | 'feature'      // requireFeature(req, key) — role defaults + per-user overrides
  | 'authScoped'   // requireAuth on purpose + in-route scoping (see why)
  | 'token'        // no session: an emailed magic token is the credential
  | 'cron'         // CRON_SECRET, with a staff/admin manual-trigger fallback
  | 'webhook'      // no session: provider signature verification
  | 'public';      // deliberately unauthenticated (see why)

export interface RouteGuard {
  kind: RouteGuardKind;
  /** Strings that must appear verbatim in the route file. */
  contains: readonly string[];
  /** Why this shape is safe — required for every kind weaker than staff. */
  why?: string;
}

const staff = (): RouteGuard => ({ kind: 'staff', contains: ['requireStaff('] });
const admin = (): RouteGuard => ({ kind: 'admin', contains: ['requireAdmin('] });
const superAdmin = (): RouteGuard => ({ kind: 'superAdmin', contains: ['requireSuperAdmin('] });
const financials = (): RouteGuard => ({ kind: 'financials', contains: ['requireFinancials('] });
const role = (): RouteGuard => ({ kind: 'role', contains: ['requireRole('] });
/** Typing the key as FeatureKey ties every server gate to the same
 *  src/lib/features.ts registry the client UI resolves — a renamed or
 *  deleted feature key breaks this file at compile time. */
const feature = (key: FeatureKey, alsoContains?: string): RouteGuard =>
  ({ kind: 'feature', contains: [`requireFeature(req, '${key}')`, ...(alsoContains ? [alsoContains] : [])] });
const featureDynamic = (verbatimCall: string, why: string): RouteGuard =>
  ({ kind: 'feature', contains: [verbatimCall], why });
const authScoped = (why: string, ...alsoContains: string[]): RouteGuard =>
  ({ kind: 'authScoped', contains: ['requireAuth(', ...alsoContains], why });
const cron = (manualFallback: 'requireAdmin(' | 'requireStaff('): RouteGuard =>
  ({ kind: 'cron', contains: ['CRON_SECRET', manualFallback], why: 'fires on the cron secret; the listed guard covers manual triggering' });
const token = (why: string, credentialMarker: string): RouteGuard =>
  ({ kind: 'token', contains: [credentialMarker], why });
const webhook = (why: string, verifyMarker: string): RouteGuard =>
  ({ kind: 'webhook', contains: [verifyMarker], why });
const pub = (why: string): RouteGuard => ({ kind: 'public', contains: [], why });

export const ROUTE_GUARDS: Record<string, RouteGuard> = {
  'src/app/api/admin/bulk-upload-proofs/route.ts': admin(),
  'src/app/api/admin/bulk-upload-templates/route.ts': admin(),
  'src/app/api/admin/calibrate-templates/route.ts': staff(),
  'src/app/api/admin/create-user/route.ts': admin(),
  'src/app/api/admin/credits/route.ts': admin(),
  'src/app/api/admin/delete-template/route.ts': admin(),
  'src/app/api/admin/delete-user/route.ts': admin(),
  'src/app/api/admin/import-installs/route.ts': admin(),
  // Reading which NetSuite item labor bills to is admin (it exposes item
  // ids); setting it is super-admin, like the tax rate — it decides which
  // GL account every labor dollar posts to.
  'src/app/api/admin/labor-item/route.ts': { kind: 'superAdmin', contains: ['requireSuperAdmin(', 'requireAdmin('] },
  'src/app/api/admin/link-customer/route.ts': admin(),
  // ZIP centroids for invite distance ranking (R6-5): reference data an
  // admin loads once, never customer data.
  'src/app/api/admin/zip-centroids/route.ts': admin(),
  // Booking hours/slots/blocked days (R5-17): day-to-day ops config, so
  // plain admin on both verbs (unlike the financial settings' super-admin
  // writes).
  'src/app/api/admin/booking-settings/route.ts': admin(),
  // Blended shop labor cost rate (R3-21 job costing): reading is admin
  // (cost data); writing is super-admin — it moves every reported margin.
  'src/app/api/admin/shop-labor-rate/route.ts': { kind: 'superAdmin', contains: ['requireSuperAdmin(', 'requireAdmin('] },
  // Shop fallback ink/premask $/ft² (R6-1): reading is admin (cost data);
  // writing is super-admin — it moves every graphics job's material cost.
  'src/app/api/admin/material-defaults/route.ts': { kind: 'superAdmin', contains: ['requireSuperAdmin(', 'requireAdmin('] },
  // Shop crew capacity (R5-16 week planner): reading the crew/shift config
  // is admin; writing is super-admin — it recolors every load bar.
  'src/app/api/admin/shop-capacity/route.ts': { kind: 'superAdmin', contains: ['requireSuperAdmin(', 'requireAdmin('] },
  'src/app/api/admin/payouts/route.ts': admin(),
  'src/app/api/admin/payroll/route.ts': admin(),
  'src/app/api/admin/resend-invite/route.ts': admin(),
  // Reading the company sales tax rate is staff-wide (both quote builders
  // show it); changing it is super-admin only, matching the DB trigger in
  // migration 245.
  'src/app/api/admin/sales-tax/route.ts': { kind: 'superAdmin', contains: ['requireSuperAdmin(', 'requireStaff('] },
  'src/app/api/admin/sync-help-docs/route.ts': admin(),
  'src/app/api/admin/upload-zip/route.ts': admin(),
  'src/app/api/admin/user-settings/route.ts': superAdmin(),
  'src/app/api/ai-agent/chat/route.ts': authScoped('the caller\'s role is resolved server-side and per-role capability checks decide which data sources each query may touch', 'rolesOf'),
  'src/app/api/approve/condition/[token]/route.ts': token('customer acknowledgment of the vehicle condition report via the emailed magic link; the token is the credential and expiry is enforced', '\'condition_token\''),
  'src/app/api/badges/route.ts': authScoped('attention-queue counts for the caller only: the queues computed are exactly the ones their own resolved features and admin flag allow, so a customer login gets an empty set rather than a 403', 'resolveFeatures('),
  'src/app/api/approve/estimate/[token]/route.ts': token('customer approval via the emailed magic link; the token is the credential and expiry is enforced', '\'approval_token\''),
  'src/app/api/approve/proof/[token]/route.ts': token('customer proof approval via the emailed magic link; token + expiry enforced', '\'approval_token\''),
  'src/app/api/cni/schedule/[token]/route.ts': token('installer install-calendar subscription; the token is the credential, reads are rate-limited and the feed carries only the jobs already assigned to that company', '\'schedule_token\''),
  'src/app/api/portal/[token]/route.ts': token('customer PO-status portal via the shared link; the token is the credential, reads are rate-limited and the payload is the customer-safe projection in src/lib/po-portal.ts', '\'portal_token\''),
  'src/app/api/portal/[token]/ask/route.ts': token('portal invoice question → customer_threads; the token is the credential, rate-limited, and the invoice id is verified against the token customer\'s own open set', 'resolvePortalCustomer('),
  'src/app/api/portal/[token]/fresh-link/route.ts': token('customer-requested fresh approval link; the token is the credential, rate-limited per IP AND per record, and the named record is re-verified against the token customer by id before anything is minted — the new link is emailed to the address on file and never returned', 'resolvePortalCustomer('),
  'src/app/api/portal/[token]/billing/route.ts': token('portal billing read (balance/aging/open invoices) keyed on the token customer\'s netsuite_id; rate-limited + cached', 'resolvePortalCustomer('),
  'src/app/api/portal/[token]/preferences/route.ts': token('customer email preferences behind the portal token; rate-limited, the contact must belong to the token customer, and the only writable surface is three booleans per contact — addresses are returned masked and can never be added, read or edited here', 'resolvePortalCustomer('),
  'src/app/api/portal/[token]/invoice-pdf/route.ts': token('token-guarded invoice-PDF stream; the id must belong to the token customer\'s open set before any fetch', 'resolvePortalCustomer('),
  'src/app/api/portal/[token]/statement/route.ts': token('portal statement download/email; recipients locked to the customer\'s own record, never free input', 'resolvePortalCustomer('),
  'src/app/api/approve/quote/[token]/route.ts': token('customer wrap-quote approval via the emailed magic link; token + expiry enforced', '\'approval_token\''),
  // R5-17: pickup/drop-off booking. The token IS the credential (a
  // check-in's portal token or an approved estimate's approval token);
  // rate-limited both verbs, slot race settled by a partial unique index.
  'src/app/api/book/[token]/route.ts': token('customer pickup/drop-off booking via the completion-email or approval-page link; token resolved + state-gated before any write', 'resolveBookingToken('),
  'src/app/api/auth/google/callback/route.ts': staff(),
  'src/app/api/auth/google/route.ts': staff(),
  'src/app/api/auth/signup/route.ts': pub('account creation; new profiles land status=pending and every guard rejects them until an admin approves'),
  'src/app/api/calendar/sync-event/route.ts': staff(),
  'src/app/api/calendar/sync-graphics/route.ts': staff(),
  'src/app/api/calendar/sync-upfit/route.ts': staff(),
  'src/app/api/checkins/condition/route.ts': staff(),
  'src/app/api/checkins/route.ts': staff(),
  'src/app/api/cni/add-completed-vin/route.ts': admin(),
  'src/app/api/cni/assign-company/route.ts': feature('cni_admin'),
  'src/app/api/cni/bid/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/compliance/route.ts': feature('cni_admin'),
  'src/app/api/cni/invite-sla/route.ts': feature('cni_admin'),
  'src/app/api/cni/job-pnl/route.ts': feature('cni_admin'),
  'src/app/api/cni/complete-job/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/complete-vin/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/create-vendor/route.ts': admin(),
  'src/app/api/cni/delete-installer/route.ts': admin(),
  'src/app/api/cni/edit-vin-devices/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/import-scans/route.ts': admin(),
  'src/app/api/cni/installers/route.ts': admin(),
  'src/app/api/cni/invite-company/route.ts': feature('cni_admin'),
  'src/app/api/cni/invite-matches/route.ts': feature('cni_admin'),
  'src/app/api/cni/invites-seen/route.ts': authScoped('external installer flow; the update is scoped in-route to invites addressed to the caller (their installer id or company) and stamps seen_at only', 'getCniCompanyId('),
  'src/app/api/cni/invite/route.ts': admin(),
  'src/app/api/cni/job-billing/route.ts': feature('cni_admin'),
  'src/app/api/cni/job-message/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/job-photos/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/job-tasks/route.ts': authScoped('checklist toggle is an external installer flow checked in-route against the CNI job; authoring/removing tasks requires the cni_admin feature per-verb', 'canActOnCniJob('),
  'src/app/api/cni/mark-messages-read/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/materials-received/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/my-docs/route.ts': role(),
  'src/app/api/cni/my-schedule-link/route.ts': role(),
  'src/app/api/leads/quiet/route.ts': role(),
  'src/app/api/cni/my-invoices/route.ts': role(),
  'src/app/api/cni/propose-schedule/route.ts': admin(),
  'src/app/api/cni/refresh-vendor/route.ts': admin(),
  'src/app/api/cni/resend-invite/route.ts': admin(),
  'src/app/api/cni/photos/route.ts': feature('cni_admin'),
  'src/app/api/cni/scorecards/route.ts': feature('cni_admin'),
  'src/app/api/cni/schedule-link/route.ts': feature('cni_admin'),
  'src/app/api/cni/scan-vehicle/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/search-vendors/route.ts': admin(),
  'src/app/api/cni/submit-photos/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/update-pay-rate/route.ts': admin(),
  'src/app/api/cni/update-schedule/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/company-profile/route.ts': authScoped('the company letterhead printed on customer-facing documents; intentionally readable by any approved login (documented in-file)'),
  'src/app/api/credit-application/submit/route.ts': pub('the public credit-application form; honeypot + fake bot success, service-role insert only, and the review side is feature-gated'),
  'src/app/api/credit-applications/[id]/route.ts': feature('credit_applications'),
  'src/app/api/credit-applications/route.ts': feature('credit_applications'),
  'src/app/api/cron/at-risk-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/auto-archive-shipped/route.ts': cron('requireAdmin('),
  'src/app/api/cron/calendar-pull/route.ts': cron('requireAdmin('),
  'src/app/api/cron/deal-forecast-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/exceptions-digest/route.ts': cron('requireAdmin('),
  'src/app/api/cron/heartbeat-sentinel/route.ts': cron('requireAdmin('),
  'src/app/api/cron/health-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/netsuite-sync/route.ts': cron('requireAdmin('),
  'src/app/api/cron/owner-brief/route.ts': cron('requireAdmin('),
  'src/app/api/cron/parts-email-scan/route.ts': cron('requireAdmin('),
  'src/app/api/cron/pickup-nudges/route.ts': cron('requireAdmin('),
  'src/app/api/cron/parts-sync/route.ts': cron('requireAdmin('),
  'src/app/api/cron/promised-back-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/proof-reminder-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/prospect-reminder-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/quote-followup-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/reorder-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/metric-snapshots/route.ts': cron('requireAdmin('),
  'src/app/api/cron/cni-sweep/route.ts': cron('requireAdmin('),
  'src/app/api/cron/field-shift-sweep/route.ts': cron('requireAdmin('),
  'src/app/api/cron/shop-shift-sweep/route.ts': cron('requireAdmin('),
  'src/app/api/cron/stale-purchase-requests/route.ts': cron('requireAdmin('),
  'src/app/api/cron/stuck-vehicle-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/weekly-customer-digest/route.ts': cron('requireAdmin('),
  'src/app/api/customer-threads/[id]/messages/route.ts': staff(),
  'src/app/api/customer-threads/[id]/route.ts': staff(),
  'src/app/api/customer-threads/route.ts': staff(),
  'src/app/api/customers/portal-link/route.ts': staff(),
  'src/app/api/customer/billing/route.ts': authScoped('logged-in customer billing card; scoped by the caller\'s own profiles.customer_netsuite_id, with the same admin preview path as customer/portal', 'customer_netsuite_id'),
  'src/app/api/customer/portal/route.ts': authScoped('customer-facing portal; scoped by the caller\'s profiles.customer_netsuite_id, with an admin preview path', 'customer_netsuite_id'),
  'src/app/api/customers/files/route.ts': staff(),
  'src/app/api/dropbox/auth/route.ts': staff(),
  'src/app/api/dropbox/copy-to-r2/route.ts': staff(),
  'src/app/api/dropbox/search/route.ts': staff(),
  'src/app/api/dropbox/status/route.ts': staff(),
  'src/app/api/dropbox/thumbnail/route.ts': staff(),
  'src/app/api/estimates/[id]/add-lines/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/add-wrap-quote/route.ts': feature('estimates'),
  'src/app/api/estimates/draft-from-text/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/approval-preview/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/revision-diff/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/duplicate/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/email-pdf/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/files/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/link-so/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/push-so/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/pdf-debug/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/pdf/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/rejection-thread/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/send-for-approval/route.ts': feature('estimates'),
  'src/app/api/estimates/convert-to-so/route.ts': feature('estimates'),
  'src/app/api/estimates/push/route.ts': feature('estimates'),
  'src/app/api/estimates/route.ts': feature('estimates'),
  'src/app/api/external-contacts/[id]/route.ts': staff(),
  'src/app/api/external-contacts/route.ts': staff(),
  'src/app/api/fleet/lookup-vin/route.ts': authScoped('VIN decode passthrough; returns vehicle spec data, no company records'),
  'src/app/api/gmail/attachment/route.ts': staff(),
  'src/app/api/gmail/auto-import-status/route.ts': cron('requireStaff('),
  'src/app/api/gmail/auto-import/route.ts': cron('requireAdmin('),
  'src/app/api/gmail/dismiss-po/route.ts': staff(),
  'src/app/api/gmail/import-po/route.ts': staff(),
  'src/app/api/gmail/pending-po-note/route.ts': staff(),
  'src/app/api/gmail/search-pos/route.ts': staff(),
  'src/app/api/gmail/search-proofs/route.ts': staff(),
  'src/app/api/graphics-jobs/[id]/download-all/route.ts': staff(),
  'src/app/api/graphics-jobs/[id]/send-for-approval/route.ts': staff(),
  'src/app/api/graphics-jobs/assign-po/route.ts': staff(),
  'src/app/api/graphics/awaiting-prefill/route.ts': staff(),
  'src/app/api/graphics/create-estimate/route.ts': staff(),
  'src/app/api/graphics/create-invoice/route.ts': staff(),
  'src/app/api/graphics/from-estimate/route.ts': staff(),
  'src/app/api/graphics/from-wrap-quote/route.ts': staff(),
  'src/app/api/graphics/invoice-pdf/route.ts': staff(),
  'src/app/api/graphics/invoice-preview/route.ts': staff(),
  'src/app/api/graphics/packing-list/route.ts': staff(),
  'src/app/api/graphics/pack-checklist/route.ts': staff(),
  'src/app/api/graphics/mark-invoiced/route.ts': staff(),
  'src/app/api/graphics/notify-assignees/route.ts': staff(),
  'src/app/api/graphics/notify-pickup/route.ts': staff(),
  'src/app/api/graphics/notify-ready/route.ts': staff(),
  'src/app/api/graphics/notify-shipped-invoice/route.ts': staff(),
  'src/app/api/install-checklists/[id]/route.ts': admin(),
  'src/app/api/install-checklists/route.ts': { kind: 'staff', contains: ['requireStaff(', 'requireAdmin('] },
  'src/app/api/install-guides/templates/route.ts': staff(),
  'src/app/api/install-guides/send/route.ts': staff(),
  'src/app/api/installer/ready-for-install/route.ts': authScoped('field installer flow; vehicle status transition validated in-route'),
  'src/app/api/invoices/backfill-emails/route.ts': admin(),
  'src/app/api/jobs/assign/route.ts': staff(),
  'src/app/api/knowledge/reprocess/route.ts': admin(),
  'src/app/api/knowledge/upload/route.ts': admin(),
  'src/app/api/mentions/route.ts': staff(),
  'src/app/api/messages/send-sms/route.ts': authScoped('sender is forced to the authenticated caller and must be a participant of the conversation being notified', 'participant'),
  'src/app/api/messages/sms-webhook/route.ts': webhook('inbound SMS from the provider; the signature is verified and mismatches are rejected', 'verifyWebhookSignature'),
  'src/app/api/messages/twilio-webhook/route.ts': webhook('inbound Twilio SMS; x-twilio-signature validated, secure by default', 'validateTwilioSignature'),
  'src/app/api/my/earnings/route.ts': authScoped('self-scoped: returns only the caller\'s own earnings rows'),
  'src/app/api/netsuite/backfill-invoice-locations/route.ts': admin(),
  'src/app/api/netsuite/contacts/sync/route.ts': staff(),
  'src/app/api/netsuite/create-invoice/route.ts': admin(),
  'src/app/api/netsuite/create-item/route.ts': admin(),
  'src/app/api/netsuite/create-sales-order/route.ts': admin(),
  'src/app/api/netsuite/customer-invoices/route.ts': staff(),
  'src/app/api/netsuite/customer-payments/route.ts': staff(),
  'src/app/api/netsuite/customer-profile/route.ts': staff(),
  'src/app/api/netsuite/customer-statement/route.ts': staff(),
  'src/app/api/netsuite/customers/route.ts': staff(),
  'src/app/api/netsuite/customers/search/route.ts': staff(),
  'src/app/api/netsuite/email-invoices/route.ts': role(),
  'src/app/api/netsuite/email-statement/route.ts': role(),
  'src/app/api/netsuite/fix-invoice-po/route.ts': role(),
  'src/app/api/netsuite/invoice-vehicles/route.ts': role(),
  'src/app/api/netsuite/invoices/route.ts': staff(),
  'src/app/api/netsuite/lookup-transaction/route.ts': staff(),
  'src/app/api/netsuite/pdf/route.ts': staff(),
  'src/app/api/netsuite/sales-order-lines/[id]/route.ts': staff(),
  'src/app/api/netsuite/sales-orders/route.ts': staff(),
  'src/app/api/netsuite/so-invoices/route.ts': staff(),
  'src/app/api/netsuite/transaction-packing/[id]/route.ts': staff(),
  'src/app/api/netsuite/vendors/route.ts': admin(),
  'src/app/api/notifications/send/route.ts': staff(),
  'src/app/api/parts-mail/bill-match/route.ts': role(),
  'src/app/api/parts-mail/create-bill/route.ts': role(),
  'src/app/api/parts-mail/link/route.ts': staff(),
  'src/app/api/parts-mail/sync-pos/route.ts': admin(),
  'src/app/api/parts/[id]/attach-dropbox-proof/route.ts': admin(),
  'src/app/api/parts/[id]/attach-proof/route.ts': admin(),
  'src/app/api/parts/[id]/description/route.ts': admin(),
  'src/app/api/parts/[id]/route.ts': admin(),
  'src/app/api/parts/browse/route.ts': staff(),
  'src/app/api/parts/catalog-health/route.ts': admin(),
  'src/app/api/parts/categorize/route.ts': admin(),
  'src/app/api/parts/cost-history/route.ts': staff(),
  'src/app/api/parts/category-rules/apply/route.ts': admin(),
  'src/app/api/parts/category-rules/route.ts': admin(),
  'src/app/api/parts/dimensions/route.ts': admin(),
  'src/app/api/parts/enrich/route.ts': admin(),
  'src/app/api/parts/fitment/route.ts': admin(),
  'src/app/api/parts/install-photos/route.ts': staff(),
  'src/app/api/parts/import-profiles/route.ts': admin(),
  'src/app/api/parts/import-vendor-assets/route.ts': admin(),
  'src/app/api/parts/merge/route.ts': admin(),
  'src/app/api/parts/mirror/route.ts': staff(),
  'src/app/api/parts/proof-sweep/route.ts': admin(),
  'src/app/api/parts/route.ts': staff(),
  'src/app/api/parts/sync/route.ts': admin(),
  'src/app/api/parts/transactions/route.ts': staff(),
  'src/app/api/pay-rates/route.ts': { kind: 'staff', contains: ['requireStaff(', 'requireAdmin('] },
  'src/app/api/po-receipts/route.ts': feature('parts_ordering'),
  'src/app/api/receiving/exceptions/route.ts': feature('parts_ordering'),
  'src/app/api/pos/audit-invoices/route.ts': admin(),
  'src/app/api/pos/backfill-customers/route.ts': admin(),
  'src/app/api/pos/backfill-pdfs/route.ts': admin(),
  'src/app/api/pos/delete-line/route.ts': admin(),
  'src/app/api/pos/delete/route.ts': admin(),
  'src/app/api/pos/extract-ship-to/route.ts': admin(),
  'src/app/api/pos/invoice-open/route.ts': admin(),
  'src/app/api/pos/send-confirmation/route.ts': admin(),
  'src/app/api/pos/sync-invoices/route.ts': admin(),
  'src/app/api/pos/verify-invoices/route.ts': admin(),
  'src/app/api/prospects/check-duplicate/route.ts': staff(),
  'src/app/api/prospects/contacts/primary/route.ts': staff(),
  'src/app/api/prospects/contacts/route.ts': staff(),
  'src/app/api/prospects/email/route.ts': staff(),
  'src/app/api/prospects/files/route.ts': staff(),
  'src/app/api/prospects/segment-email/route.ts': role(),
  'src/app/api/prospects/push-to-netsuite/route.ts': staff(),
  'src/app/api/prospects/route.ts': { kind: 'staff', contains: ['requireStaff(', 'requireAdmin('] },
  'src/app/api/prospects/scan-card/route.ts': staff(),
  'src/app/api/prospects/sync-notes/route.ts': staff(),
  'src/app/api/prospects/voice-note/route.ts': staff(),
  'src/app/api/purchasing/demand/route.ts': feature('parts_ordering'),
  'src/app/api/purchasing/demand/dismiss/route.ts': feature('parts_ordering'),
  'src/app/api/purchasing/sync-sales-orders/route.ts': admin(),
  'src/app/api/purchase-requests/create-po/route.ts': feature('parts_ordering', 'requireAdmin('),
  'src/app/api/purchase-requests/route.ts': feature('parts_ordering'),
  'src/app/api/push/register-native/route.ts': authScoped('self-scoped push-token registration'),
  'src/app/api/push/subscribe/route.ts': authScoped('self-scoped web-push subscription'),
  'src/app/api/push/test/route.ts': authScoped('sends a test push to the caller only'),
  'src/app/api/quotes/follow-up/email/route.ts': role(),
  'src/app/api/quotes/follow-up/route.ts': role(),
  'src/app/api/quotes/route.ts': role(),
  'src/app/api/reports/alert-scoreboard/route.ts': admin(),
  'src/app/api/reports/email-reach/route.ts': admin(),
  'src/app/api/reports/accounting-package/route.ts': role(),
  'src/app/api/reports/ar-sync-paid/route.ts': staff(),
  'src/app/api/reports/at-risk/route.ts': role(),
  'src/app/api/reports/executive-summary/route.ts': financials(),
  'src/app/api/reports/financials/accounts/route.ts': financials(),
  'src/app/api/reports/financials/ap-bills/route.ts': financials(),
  'src/app/api/reports/financials/ar-trends/route.ts': financials(),
  'src/app/api/reports/financials/ar-invoices/route.ts': financials(),
  'src/app/api/reports/financials/invoice-pdf/route.ts': financials(),
  'src/app/api/reports/financials/pnl/route.ts': financials(),
  'src/app/api/reports/financials/route.ts': financials(),
  'src/app/api/reports/graphics-costs/route.ts': role(),
  'src/app/api/reports/material-yield/route.ts': role(),
  'src/app/api/reports/proof-revisions/route.ts': admin(),
  'src/app/api/reports/purchasing-kpis/route.ts': feature('parts_ordering'),
  'src/app/api/reports/installer-costs/route.ts': role(),
  'src/app/api/reports/invoice-reconciliation/route.ts': admin(),
  'src/app/api/reports/invoiced-summary/route.ts': staff(),
  'src/app/api/reports/netsuite-dupes/route.ts': admin(),
  'src/app/api/reports/invoices-list/route.ts': staff(),
  'src/app/api/reports/sales-by-customer-detail/route.ts': staff(),
  'src/app/api/reports/on-time/route.ts': role(),
  'src/app/api/reports/never-invoiced/route.ts': role(),
  'src/app/api/reports/month-close/route.ts': role(),
  'src/app/api/reports/throughput/route.ts': role(),
  'src/app/api/reports/cash-outlook/route.ts': financials(),
  'src/app/api/reports/crew-utilization/route.ts': role(),
  'src/app/api/reports/order-book/route.ts': role(),
  'src/app/api/reports/quoted-margin/route.ts': role(),
  'src/app/api/reports/vehicle-margin/route.ts': role(),
  'src/app/api/reports/sales-performance/route.ts': role(),
  'src/app/api/reports/vendors/route.ts': staff(),
  'src/app/api/scan-worksheet/route.ts': authScoped('installer scan worksheet; external installer accounts are the intended callers'),
  'src/app/api/scans/bulk-update/route.ts': admin(),
  'src/app/api/scans/delete/route.ts': admin(),
  'src/app/api/scans/log/route.ts': authScoped('external installer companies log field scans by design; the route enforces an internal-staff-or-installer allowlist itself', 'isInternalStaffRole('),
  'src/app/api/scans/match-po/route.ts': staff(),
  'src/app/api/scans/photos/route.ts': authScoped('completion photos ride the same field-scanner flow and enforce the same staff-or-installer allowlist as scans/log', 'isInternalStaffRole('),
  // Actual-consumption import (R6-1): graphics production owns the
  // printer's own numbers, so they can reconcile without an admin.
  'src/app/api/materials/import/route.ts': role(),
  // Material stock (R6-2): the people who need to know whether a job can
  // print are the people standing at the printer, so reads and receiving
  // are staff-wide; only the reorder POINT (which makes the nightly sweep
  // spend money) is admin.
  'src/app/api/prospects/log-call/route.ts': staff(),
  'src/app/api/materials/rolls/route.ts': staff(),
  'src/app/api/materials/rolls/draw/route.ts': staff(),
  'src/app/api/materials/stock-settings/route.ts': { kind: 'admin', contains: ['requireAdmin(', 'requireStaff('] },
  'src/app/api/search/route.ts': staff(),
  'src/app/api/shifts/end/route.ts': authScoped('ends the caller\'s own shift'),
  'src/app/api/shifts/members/route.ts': authScoped('crew presence for the shift flow; techs + installers'),
  'src/app/api/shifts/part/route.ts': authScoped('part usage logged against the caller\'s own shift'),
  'src/app/api/shifts/route.ts': authScoped('time clock for techs AND external installers; CNI job membership checked via canActOnCniJob, field/shop contexts FIELD_ROLES-gated in-route', 'canActOnCniJob'),
  'src/app/api/shop-inbound/arrival/route.ts': staff(),
  'src/app/api/shop-inbound/route.ts': staff(),
  'src/app/api/shop-week/route.ts': staff(),
  'src/app/api/signed-documents/route.ts': featureDynamic('requireFeature(req, spec.feature)', 'gated per record type on the record\'s own feature key (estimates / graphics)'),
  // R3-22: all three storage routes tier the caller via storageAccessOf —
  // staff read/write broadly, external installers only floor prefixes,
  // customer-only accounts nothing — on top of the path/prefix ACL.
  'src/app/api/storage/download/route.ts': authScoped('read presigns pass the tiered storage-guard ACL first', 'checkStoragePath'),
  'src/app/api/storage/presign/route.ts': authScoped('write presigns pass the tiered storage-guard ACL first', 'checkStoragePath'),
  'src/app/api/storage/route.ts': authScoped('every bucket/path goes through the tiered storage-guard ACL', 'checkStoragePath'),
  'src/app/api/system-health/route.ts': cron('requireAdmin('),
  // Narrower than its sibling above on purpose: a map of which
  // integrations are unconfigured is a map of where the app is soft, so
  // it stays with the owner-level feature rather than all admins.
  'src/app/api/system-health/runs/route.ts': staff(),
  'src/app/api/system-health/connections/route.ts': feature('system_health'),
  'src/app/api/upfit-projects/allocations/route.ts': staff(),
  'src/app/api/upfit-projects/link-po/route.ts': staff(),
  'src/app/api/upfit-projects/notes/route.ts': staff(),
  'src/app/api/upfit-projects/parts-readiness/route.ts': staff(),
  'src/app/api/upfit-projects/readiness-board/route.ts': staff(),
  'src/app/api/upfit-projects/route.ts': staff(),
  'src/app/api/upfit-projects/tasks/route.ts': staff(),
  'src/app/api/vehicle-tracking/[id]/refresh-checklist/route.ts': staff(),
  'src/app/api/vehicle-tracking/graphics-install-status/route.ts': staff(),
  'src/app/api/vehicle-tracking/labor-burn/route.ts': staff(),
  'src/app/api/vehicle-tracking/invoice/route.ts': admin(),
  'src/app/api/vehicle-tracking/turnaround-suggest/route.ts': staff(),
  'src/app/api/vehicle-tracking/update-status/route.ts': staff(),
  'src/app/api/vehicles/[vin]/installs/route.ts': staff(),
  'src/app/api/vehicles/[vin]/photos/route.ts': staff(),
  'src/app/api/vehicles/archive/route.ts': admin(),
  'src/app/api/vehicles/delete/route.ts': admin(),
  'src/app/api/vendor-invoices/extract/route.ts': role(),
  'src/app/api/vendor-invoices/rates/route.ts': admin(),
  'src/app/api/vendor-invoices/route.ts': { kind: 'admin', contains: ['requireAdmin(', 'requireRole('] },
  'src/app/api/vendor-invoices/sync-paid/route.ts': role(),
  'src/app/api/vendor-invoices/workflow/route.ts': role(),
  'src/app/api/webhooks/resend/route.ts': webhook('Resend delivery events; svix HMAC verified', 'verifySvixSignature'),
  // Dialpad Event Subscriptions (R6-3): deliveries are HS256 JWTs signed
  // with the shared secret set on the subscription, verified fail-closed —
  // no secret configured means reject, since this route writes CRM rows.
  'src/app/api/webhooks/dialpad/route.ts': webhook('Dialpad signs every delivery as an HS256 JWT with the subscription secret; an unverifiable payload is rejected before any write', 'verifyDialpadJwt('),
  'src/app/api/wrap-quote/[id]/pdf/route.ts': staff(),
  'src/app/api/wrap-quote/create-customer/route.ts': staff(),
  'src/app/api/wrap-quote/netsuite/route.ts': staff(),
  'src/app/api/wrap-quote/send/route.ts': staff(),
};
