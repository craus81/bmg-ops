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
  'src/app/api/approve/estimate/[token]/route.ts': token('customer approval via the emailed magic link; the token is the credential and expiry is enforced', '\'approval_token\''),
  'src/app/api/approve/proof/[token]/route.ts': token('customer proof approval via the emailed magic link; token + expiry enforced', '\'approval_token\''),
  'src/app/api/approve/quote/[token]/route.ts': token('customer wrap-quote approval via the emailed magic link; token + expiry enforced', '\'approval_token\''),
  'src/app/api/auth/google/callback/route.ts': staff(),
  'src/app/api/auth/google/route.ts': staff(),
  'src/app/api/auth/signup/route.ts': pub('account creation; new profiles land status=pending and every guard rejects them until an admin approves'),
  'src/app/api/calendar/sync-event/route.ts': staff(),
  'src/app/api/calendar/sync-graphics/route.ts': staff(),
  'src/app/api/calendar/sync-upfit/route.ts': staff(),
  'src/app/api/cni/add-completed-vin/route.ts': admin(),
  'src/app/api/cni/assign-company/route.ts': feature('cni_admin'),
  'src/app/api/cni/bid/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/complete-job/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/complete-vin/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/create-vendor/route.ts': admin(),
  'src/app/api/cni/delete-installer/route.ts': admin(),
  'src/app/api/cni/edit-vin-devices/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/import-scans/route.ts': admin(),
  'src/app/api/cni/installers/route.ts': admin(),
  'src/app/api/cni/invite-company/route.ts': feature('cni_admin'),
  'src/app/api/cni/invite/route.ts': admin(),
  'src/app/api/cni/job-billing/route.ts': feature('cni_admin'),
  'src/app/api/cni/job-message/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/job-photos/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/mark-messages-read/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/materials-received/route.ts': authScoped('external installer / coordinator flow; requireStaff would wrongly reject the installer side, so membership is checked in-route against the CNI job'),
  'src/app/api/cni/my-docs/route.ts': role(),
  'src/app/api/cni/my-invoices/route.ts': role(),
  'src/app/api/cni/propose-schedule/route.ts': admin(),
  'src/app/api/cni/refresh-vendor/route.ts': admin(),
  'src/app/api/cni/resend-invite/route.ts': admin(),
  'src/app/api/cni/review-photo/route.ts': feature('cni_admin'),
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
  'src/app/api/cron/calendar-pull/route.ts': cron('requireAdmin('),
  'src/app/api/cron/health-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/netsuite-sync/route.ts': cron('requireAdmin('),
  'src/app/api/cron/parts-email-scan/route.ts': cron('requireAdmin('),
  'src/app/api/cron/parts-sync/route.ts': cron('requireAdmin('),
  'src/app/api/cron/proof-reminder-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/prospect-reminder-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/quote-followup-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/stuck-vehicle-check/route.ts': cron('requireAdmin('),
  'src/app/api/cron/weekly-customer-digest/route.ts': cron('requireAdmin('),
  'src/app/api/customer-threads/[id]/messages/route.ts': staff(),
  'src/app/api/customer-threads/[id]/route.ts': staff(),
  'src/app/api/customer-threads/route.ts': staff(),
  'src/app/api/customer/portal/route.ts': authScoped('customer-facing portal; scoped by the caller\'s profiles.customer_netsuite_id, with an admin preview path', 'customer_netsuite_id'),
  'src/app/api/customers/files/route.ts': staff(),
  'src/app/api/dropbox/auth/route.ts': staff(),
  'src/app/api/dropbox/copy-to-r2/route.ts': staff(),
  'src/app/api/dropbox/search/route.ts': staff(),
  'src/app/api/dropbox/status/route.ts': staff(),
  'src/app/api/dropbox/thumbnail/route.ts': staff(),
  'src/app/api/estimates/[id]/add-lines/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/add-wrap-quote/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/approval-preview/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/duplicate/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/email-pdf/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/link-so/route.ts': feature('estimates'),
  'src/app/api/estimates/[id]/pdf/route.ts': feature('estimates'),
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
  'src/app/api/graphics/create-estimate/route.ts': staff(),
  'src/app/api/graphics/create-invoice/route.ts': staff(),
  'src/app/api/graphics/from-estimate/route.ts': staff(),
  'src/app/api/graphics/from-wrap-quote/route.ts': staff(),
  'src/app/api/graphics/invoice-pdf/route.ts': staff(),
  'src/app/api/graphics/invoice-preview/route.ts': staff(),
  'src/app/api/graphics/packing-list/route.ts': staff(),
  'src/app/api/graphics/mark-invoiced/route.ts': staff(),
  'src/app/api/graphics/notify-assignees/route.ts': staff(),
  'src/app/api/graphics/notify-pickup/route.ts': staff(),
  'src/app/api/graphics/notify-ready/route.ts': staff(),
  'src/app/api/graphics/notify-shipped-invoice/route.ts': staff(),
  'src/app/api/install-checklists/[id]/route.ts': admin(),
  'src/app/api/install-checklists/route.ts': { kind: 'staff', contains: ['requireStaff(', 'requireAdmin('] },
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
  'src/app/api/parts-mail/create-bill/route.ts': role(),
  'src/app/api/parts-mail/link/route.ts': staff(),
  'src/app/api/parts-mail/sync-pos/route.ts': admin(),
  'src/app/api/parts/[id]/attach-dropbox-proof/route.ts': admin(),
  'src/app/api/parts/[id]/attach-proof/route.ts': admin(),
  'src/app/api/parts/[id]/description/route.ts': admin(),
  'src/app/api/parts/[id]/route.ts': admin(),
  'src/app/api/parts/browse/route.ts': staff(),
  'src/app/api/parts/categorize/route.ts': admin(),
  'src/app/api/parts/category-rules/apply/route.ts': admin(),
  'src/app/api/parts/category-rules/route.ts': admin(),
  'src/app/api/parts/dimensions/route.ts': admin(),
  'src/app/api/parts/fitment/route.ts': admin(),
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
  'src/app/api/pos/audit-invoices/route.ts': admin(),
  'src/app/api/pos/backfill-customers/route.ts': admin(),
  'src/app/api/pos/backfill-pdfs/route.ts': admin(),
  'src/app/api/pos/delete-line/route.ts': admin(),
  'src/app/api/pos/delete/route.ts': admin(),
  'src/app/api/pos/extract-ship-to/route.ts': admin(),
  'src/app/api/pos/invoice-open/route.ts': admin(),
  'src/app/api/pos/sync-invoices/route.ts': admin(),
  'src/app/api/pos/verify-invoices/route.ts': admin(),
  'src/app/api/prospects/check-duplicate/route.ts': staff(),
  'src/app/api/prospects/contacts/route.ts': staff(),
  'src/app/api/prospects/email/route.ts': staff(),
  'src/app/api/prospects/files/route.ts': staff(),
  'src/app/api/prospects/push-to-netsuite/route.ts': staff(),
  'src/app/api/prospects/route.ts': { kind: 'staff', contains: ['requireStaff(', 'requireAdmin('] },
  'src/app/api/prospects/scan-card/route.ts': staff(),
  'src/app/api/prospects/voice-note/route.ts': staff(),
  'src/app/api/purchase-requests/create-po/route.ts': feature('parts_ordering', 'requireAdmin('),
  'src/app/api/purchase-requests/route.ts': feature('parts_ordering'),
  'src/app/api/push/register-native/route.ts': authScoped('self-scoped push-token registration'),
  'src/app/api/push/subscribe/route.ts': authScoped('self-scoped web-push subscription'),
  'src/app/api/push/test/route.ts': authScoped('sends a test push to the caller only'),
  'src/app/api/quotes/follow-up/email/route.ts': role(),
  'src/app/api/quotes/follow-up/route.ts': role(),
  'src/app/api/quotes/route.ts': role(),
  'src/app/api/reports/accounting-package/route.ts': role(),
  'src/app/api/reports/ar-sync-paid/route.ts': staff(),
  'src/app/api/reports/at-risk/route.ts': role(),
  'src/app/api/reports/financials/accounts/route.ts': financials(),
  'src/app/api/reports/financials/ap-bills/route.ts': financials(),
  'src/app/api/reports/financials/ar-invoices/route.ts': financials(),
  'src/app/api/reports/financials/invoice-pdf/route.ts': financials(),
  'src/app/api/reports/financials/route.ts': financials(),
  'src/app/api/reports/graphics-costs/route.ts': role(),
  'src/app/api/reports/installer-costs/route.ts': role(),
  'src/app/api/reports/invoice-reconciliation/route.ts': admin(),
  'src/app/api/reports/invoiced-summary/route.ts': staff(),
  'src/app/api/reports/invoices-list/route.ts': staff(),
  'src/app/api/reports/sales-by-customer-detail/route.ts': staff(),
  'src/app/api/reports/sales-performance/route.ts': role(),
  'src/app/api/scan-worksheet/route.ts': authScoped('installer scan worksheet; external installer accounts are the intended callers'),
  'src/app/api/scans/bulk-update/route.ts': admin(),
  'src/app/api/scans/delete/route.ts': admin(),
  'src/app/api/scans/log/route.ts': authScoped('external installer companies log field scans by design; the route enforces approved-account + non-customer-role checks itself'),
  'src/app/api/scans/match-po/route.ts': staff(),
  'src/app/api/scans/photos/route.ts': authScoped('completion photos ride the same field-scanner flow and enforce the same in-route checks as scans/log'),
  'src/app/api/search/route.ts': staff(),
  'src/app/api/shifts/end/route.ts': authScoped('ends the caller\'s own shift'),
  'src/app/api/shifts/members/route.ts': authScoped('crew presence for the shift flow; techs + installers'),
  'src/app/api/shifts/part/route.ts': authScoped('part usage logged against the caller\'s own shift'),
  'src/app/api/shifts/route.ts': authScoped('time clock for techs AND external installers; job membership checked via canActOnCniJob', 'canActOnCniJob'),
  'src/app/api/shop-inbound/arrival/route.ts': staff(),
  'src/app/api/shop-inbound/route.ts': staff(),
  'src/app/api/signed-documents/route.ts': featureDynamic('requireFeature(req, spec.feature)', 'gated per record type on the record\'s own feature key (estimates / graphics)'),
  'src/app/api/storage/download/route.ts': authScoped('read presigns pass the storage-guard ACL first', 'checkStoragePath'),
  'src/app/api/storage/presign/route.ts': authScoped('write presigns pass the storage-guard ACL first', 'checkStoragePath'),
  'src/app/api/storage/route.ts': authScoped('every bucket/path goes through the storage-guard ACL before any presign', 'checkStoragePath'),
  'src/app/api/system-health/route.ts': cron('requireAdmin('),
  'src/app/api/upfit-projects/allocations/route.ts': staff(),
  'src/app/api/upfit-projects/notes/route.ts': staff(),
  'src/app/api/upfit-projects/parts-readiness/route.ts': staff(),
  'src/app/api/upfit-projects/route.ts': staff(),
  'src/app/api/upfit-projects/tasks/route.ts': staff(),
  'src/app/api/vehicle-tracking/[id]/refresh-checklist/route.ts': staff(),
  'src/app/api/vehicle-tracking/graphics-install-status/route.ts': staff(),
  'src/app/api/vehicle-tracking/invoice/route.ts': admin(),
  'src/app/api/vehicle-tracking/update-status/route.ts': staff(),
  'src/app/api/vehicles/[vin]/photos/route.ts': staff(),
  'src/app/api/vehicles/archive/route.ts': admin(),
  'src/app/api/vehicles/delete/route.ts': admin(),
  'src/app/api/vendor-invoices/extract/route.ts': role(),
  'src/app/api/vendor-invoices/rates/route.ts': admin(),
  'src/app/api/vendor-invoices/route.ts': { kind: 'admin', contains: ['requireAdmin(', 'requireRole('] },
  'src/app/api/vendor-invoices/sync-paid/route.ts': role(),
  'src/app/api/vendor-invoices/workflow/route.ts': role(),
  'src/app/api/webhooks/resend/route.ts': webhook('Resend delivery events; svix HMAC verified', 'verifySvixSignature'),
  'src/app/api/wrap-quote/[id]/pdf/route.ts': staff(),
  'src/app/api/wrap-quote/create-customer/route.ts': staff(),
  'src/app/api/wrap-quote/netsuite/route.ts': staff(),
  'src/app/api/wrap-quote/send/route.ts': staff(),
};
