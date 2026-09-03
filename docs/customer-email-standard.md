# Customer/vendor email compose standard

**The rule: any feature where a staff member emails someone outside the
company (customer or vendor) opens a standard email-compose screen before
anything sends.** No bare "Send" buttons that fire at a hard-coded
address, and no `dialog.prompt` for recipients. This came straight from
the field: staff need to fix a stale contact, copy an AP inbox, keep a
copy for themselves, and see what the customer will actually receive —
on every send, not just estimates.

## Required controls (every compose screen)

| Control | Behavior |
| --- | --- |
| **To** | Editable, multiple addresses (comma/semicolon separated). Prefilled from the record's contact (primary external contact → customer profile), but always changeable at send time. Invalid entries are surfaced, never silently dropped. |
| **Company contacts** | An "Add a company contact…" dropdown under To listing the customer's contacts (`external_contacts`, or the record page's own list); picking one appends it to To. Callers pass `contacts` (when the screen has them) or `customerId` (customers.id — the modal loads them). Hidden when neither is given. |
| **Cc BMG teammates** | A "Cc a teammate…" picker of approved staff (name + email, same directory rule as @mentions) rendered as removable chips; the send carries them as real Cc (`cc: string[]` on `EmailComposeFields`, `cc` on `EmailMeta` → Resend cc). On for every flow; `hideCc` turns it off. |
| **Bcc me** | One click copies the real send to the signed-in user's login email (`useAuth().user.email`). Off by default. |
| **Personal message** | Free-text block rendered at the top of the email body, newlines preserved. |
| **Attachments** | Where the flow has files (job files, PDFs), a picker with per-file sizes and a total-size cap (20MB — `MAX_ATTACHMENT_BYTES` in `src/lib/email-attachments.ts`, one definition for every flow). Flows that let the sender add a file from their device pass `onUploadAttachment` (and `onRemoveAttachment` for files marked `removable`) — the owner stores the file and returns its id, which checks it on for that send. Oversize or missing files are hard errors, never silent drops. |
| **Live preview** | The exact HTML that will go out, rendered by the server (`preview: true` — no token minted, nothing marked sent, nothing dispatched). |
| **Reply-To** | Always the sending user's email (the from address has no mailbox — without this, customer replies bounce). Automated sends fall back to `RESEND_REPLY_TO_EMAIL`. |
| **Signature** | The sender's `profiles.email_signature` (edited on Settings; `email_signature_logo` adds the letterhead logo from `wrap_quote_settings.company` under the text), appended server-side at the bottom of the email — fetch with `getEmailSignature` and render via the builder's `signature` option (`src/lib/email-signature.ts`) **before the preview**, so the preview shows it. Automated sends have no composing user and none. |
| **Dispatch summary** | After sending, tell the sender what actually happened (who got email/SMS, what failed) — from the API's `dispatch` result, not assumptions. |

## How to build it

- **UI:** `src/components/EmailComposeModal.tsx` is the standard screen —
  don't hand-roll a new modal. It handles To parsing/validation, bcc-me,
  message, the attachment picker with the size cap, and the preview
  iframe. Flow-specific controls (e.g. the proof-file picker) go in its
  `intro` slot; bump `previewKey` when they change. Callers supply
  `fetchPreview` and `onSend` against their API route.
- **API route contract:** accept `emails: string[]`, `bccSelf: boolean`,
  `cc: string[]` (BMG teammates, validated like To, max 10),
  `message: string`, `attachmentFileIds`/`attachmentPaths`, and
  `preview: boolean`. Preview returns `{ preview: true, to, subject,
  html }` with **zero side effects**. Real sends pass
  `bcc: [auth.user.email]` when `bccSelf`, `cc` on the `EmailMeta`
  (the send layer hands it to Resend as cc), and `auth.user.email` as
  Reply-To.
- **Send layer:** `sendEmail` / `sendEmailDetailed` (`src/lib/resend.ts`)
  take `to: string | string[]`, attachments, `replyTo`, and `bcc`.
  `buildNotificationEmail` renders the personal note
  (`opts.note`), the attachment list (`opts.attachmentNames`), and a
  CTA footnote (`opts.ctaNote`).
- **Attachments server-side:** validate the files belong to the record,
  check declared sizes against `MAX_ATTACHMENT_BYTES` up front, fetch
  bytes **before** minting tokens or stamping anything, and re-check
  actual size while fetching. `fetchEmailAttachments`
  (`src/lib/email-attachments.ts`) does the fetch half — it returns an
  error rather than throwing, so the caller can bail before any side
  effect. A fetch failure fails the send with the file named. Where a
  document is auto-attached too (e.g. the estimate PDF), it takes its
  share of the budget first and the picked files get what's left.
- **PDF copy of every transaction:** any email that carries a transaction
  (estimate approval, estimate PDF, quote follow-up, wrap quote, invoices,
  statement) auto-attaches a PDF copy of that transaction — the same
  bytes the record's view/print endpoint hands out (`generateEstimatePdf`
  in `src/lib/estimate-pdf-server.ts`, `generateWrapQuotePdf` in
  `src/lib/wrap-quote-pdf-server.ts`, `generateStatementPdf` in
  `src/lib/statement-pdf-server.ts`, NetSuite's PDF for invoices) — so
  the customer can save or forward the document without the original
  email. It rides first, is named in the body's attachment list, the
  preview returns its filename in `attachments` so the compose screen can
  say so (`intro` slot), and a render failure fails the send before any
  side effect rather than emailing a body that promises a file.

## Where each flow stands

| Flow | Compose screen | Notes |
| --- | --- | --- |
| Estimate approval (`/estimates`) | `EmailComposeModal` | Full standard, including the estimate-files picker (below). Approval doc is the email body; every send auto-attaches the estimate PDF (the PDF-copy rule below) — with any linked wrap-quote assets (`wrap_quotes.estimate_attach` — coverage diagram, proofs, vinyl details) merged in, so the customer approves one document. Linked **graphics jobs** get a per-job proof picker in the intro slot (`graphics_jobs.estimate_attach`): checked files render in the email/page/PDF, and the customer's acceptance also approves those jobs' proofs for production (propagated by the approval route). Delivery tracked on the estimate (Resend webhook → `approval_email_status`); a bounce alerts the sales side. |
| Estimate PDF (`/estimates` Email PDF button) | `EmailComposeModal` | Full standard, including the estimate-files picker (below). The FleetSuite enhanced-estimate copy (catalog photos + product links) rendered server-side as a PDF (`/api/estimates/[id]/email-pdf`, kind `estimate_pdf`) and attached — the same bytes the builder's Estimate PDF / Print buttons open (`/api/estimates/[id]/pdf`). Recipients prefill primary contact → customer email. |
| Quote follow-up (`/estimates` and `/admin/wrap-quote` ✉ Follow Up buttons on sent rows) | `EmailComposeModal` | Full standard. One route for both quote types (`/api/quotes/follow-up/email`, kind `quote_followup`, admin/sales). Carries the live Review & Accept link while the approval token is valid; recipients prefill last-sent-to → primary contact → customer email. Every follow-up auto-attaches the PDF copy (estimate PDF or FleetSuite wrap-quote PDF). Estimate follow-ups also offer the estimate-files picker (below); wrap quotes reject `attachmentFileIds`. A real send also logs the follow-up (`last_followup_at` + `quote_followups` row), so the follow-up queue's quiet clock resets. |
| Graphics proof approval (`/graphics/[id]`) | `EmailComposeModal` | Full standard + proof-file picker in the intro slot; attachments from `graphics_job_files`. SMS still rides along when a phone is on file. |
| Invoice emails (`EmailInvoicesModal`) | Own modal, fits the standard | Multi-To, message, bcc-me, invoice-PDF attachments with verify + view, test-send, delivery tracking. Migrate to the shared component if it's ever rebuilt. |
| Wrap quote (`/admin/wrap-quote`) | `EmailComposeModal` | Full standard. Recipients prefill customer email + cc from the send route's first preview; the quote's stored files are the attachment picker (all pre-checked); the Email Content checkboxes (pricing/line items/diagram/NetSuite PDF) stay on the Quote tab and are fixed while the modal is open. Every priced send auto-attaches a PDF copy: the NetSuite quote PDF when that box is checked, otherwise the FleetSuite wrap-quote PDF (`generateWrapQuotePdf`, same bytes as `/api/wrap-quote/[id]/pdf`, itemized as the body is). Coverage-only sends carry no quote PDF — there is no pricing to copy. |
| Statement (`/admin/prospects/[id]`) | `EmailComposeModal` | Full standard. Every send attaches a PDF copy of the statement first (`generateStatementPdf` — the same document the Statement PDF / Print buttons open, via the pure renderer in `src/lib/statement-pdf-doc.ts`; a render failure fails the send), then the open invoices' NetSuite PDFs (best effort, capped). Preview predicts the attachment list without fetching from NetSuite; real invoice filenames land at send time. |
| Install guide (`/graphics/install-guides/[id]`) | `EmailComposeModal` | Full standard. The guide PDF (dimensioned proof or BMG deck) is generated client-side, staged to R2 (`install-guides/<id>/exports/`), and attached by the server (`/api/install-guides/send`, `email_log` kind `install_guide`). No stored recipient — the sender types the installer's address. |
| General customer email (`/admin/prospects/[id]` Email button + contact addresses, Contacts directory) | `EmailComposeModal` | Full standard + a Subject input in the intro slot (`/api/prospects/email`, kind `customer_email`). Replaced the bare `mailto:` links, which opened the DEVICE's mail app — composing from whichever account it defaulted to (iCloud vs BMG on Apple devices) and leaving no record in FleetSuite. |
| Credit application invite (`/admin/prospects/[id]` Credit App button) | `EmailComposeModal` | Same route/flow as the general email with `includeCreditAppLink: true` (kind `credit_app_invite`): the server appends its own templated "Complete your credit application" CTA linking to the public `/credit-application` form — the link is never client-supplied — and the personal message becomes optional (a default intro renders when empty). Submissions land in the review queue (`/admin/credit-applications`, feature `credit_applications`). |
| Customer threads (`customer-threads`) | Chat-style thread | Deliberately not a compose modal (it's a running conversation). Reply-To = sender is in place. Entry points: the inbox itself, Message Customer on the pick-list/tracking pages (vehicle context), and **Reply to customer** on a rejected estimate (`/api/estimates/[id]/rejection-thread` — opens the estimate-context thread seeded with the customer's change request). The staff rejection alert email also carries Reply-To = the customer's address, so a plain mail-client reply reaches them directly. |
| PO receipt confirmation (`src/lib/po-confirmation.ts`) | Exempt — automated | Sent automatically once a customer PO's lines are imported (Gmail import or PDF upload, both paths in `/api/gmail/import-po`), once per PO. To the **Buyer Information** email extracted from the PO PDF (`purchase_orders.buyer_email`, migration 256), else the customer's billing emails; skipped with a reason when neither exists. Lists the PO's lines, quantities, requested dates and total, and attaches the PO PDF from `po_files` as the transaction copy. Logged as kind `po_confirmation`; the PO record shows buyer + "Confirmation sent". Owner decision 2026-09-03: automatic, not a compose screen. |
| Invites (CNI/admin), reminder crons, digests, notify-pickup | Exempt | Automated/transactional — nobody is composing. Reply-To falls back to `RESEND_REPLY_TO_EMAIL`. |

## Delivery tracking (all flows, automatic)

Every email — composed or automated — is logged to `email_log` by the
send layer itself (`sendEmailDetailed`), and the Resend webhook
(`/api/webhooks/resend`) updates each row's delivery state
(sent → delivered, or bounced/complained/failed). On a bounce:

- **Composed sends** (a `sentBy` user on the log row) push an alert to
  that sender — "your email died, fix the address and resend" — unless a
  specialized handler already alerted (invoices → finance, estimates →
  the sales targets).
- **Automated sends** (crons, digests, notifications) alert nobody;
  they surface on **Admin → System Health → Email delivery**, which
  lists the last 100 sends with real status and a problems-only filter.
- **Customer-thread messages** also carry the Resend id on their
  `customer_messages` row, so the inbox shows delivered/failed per
  message (same as SMS).

Callers pass an `EmailMeta` as `sendEmail`/`sendEmailDetailed`'s last
argument: `{ kind, sentBy, contextUrl, customerId?, prospectId?,
netsuiteCustomerId? }` — kind is a flow slug for the admin view, sentBy
routes the bounce alert, contextUrl deep-links the record (falls back to
the log row on System Health). Sends without meta still log, tagged
`other`.

## Account history (composed sends, automatic)

Pass whichever customer id the flow holds (`customerId` = customers.id,
`prospectId`, or `netsuiteCustomerId`) and the send layer resolves the
rest (customers ↔ prospects bridge via `netsuite_id`), stamps both ids on
the `email_log` row, keeps the rendered HTML for human-composed sends
(`body_html`), and writes one `type: 'email'` row on the customer's
`prospect_activities` timeline pointing at the log row — the record page's
activity feed shows "Emailed … — subject" with a **View email** opener.
Never insert your own timeline row for a send; the send layer owns it
(the statement route's bespoke insert was removed for exactly that).

## Estimate files (all three estimate email flows)

Reps needed to send pictures and spec sheets alongside an estimate, so the
estimate carries its own file library: `estimate_files` (migration 250) +
R2 under the `estimate-files` prefix, managed by
`/api/estimates/[id]/files` (`presign` → browser PUT → `record`, plus GET
and DELETE). Uploading goes browser → R2 direct, because the API route
body caps at ~4.5MB on Vercel.

The files belong to the ESTIMATE, not to one send: the approval send, the
Email PDF send, and every follow-up show the same picker, so a spec sheet
uploaded in March rides on the June follow-up without being re-picked.
Nothing is pre-checked — a file that went out once shouldn't silently go
out again.

Server side, all three routes take `attachmentFileIds` and resolve it
through `src/lib/estimate-attachments.ts`
(`loadEstimateAttachmentRows` → ownership + declared-size check, in the
sender's order; `fetchEstimateAttachments` → bytes). The names render in
the email body — `buildNotificationEmail`'s `attachmentNames` on the PDF
and follow-up emails, `renderEstimateDocument`'s `attachmentNames` (an
"Attached" section) on the approval document — so the preview shows
exactly what the customer will get.

## For every new feature

Adding any "email the customer/vendor" action means: use
`EmailComposeModal`, implement the API contract above (including
`preview`), pass Reply-To + bcc + an `EmailMeta` (kind, sentBy,
contextUrl), and add the flow to the table here.
