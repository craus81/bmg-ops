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
| **Bcc me** | One click copies the real send to the signed-in user's login email (`useAuth().user.email`). Off by default. |
| **Personal message** | Free-text block rendered at the top of the email body, newlines preserved. |
| **Attachments** | Where the flow has files (job files, PDFs), a picker with per-file sizes and a total-size cap (20MB — `MAX_ATTACHMENT_BYTES`). Oversize or missing files are hard errors, never silent drops. |
| **Live preview** | The exact HTML that will go out, rendered by the server (`preview: true` — no token minted, nothing marked sent, nothing dispatched). |
| **Reply-To** | Always the sending user's email (the from address has no mailbox — without this, customer replies bounce). Automated sends fall back to `RESEND_REPLY_TO_EMAIL`. |
| **Dispatch summary** | After sending, tell the sender what actually happened (who got email/SMS, what failed) — from the API's `dispatch` result, not assumptions. |

## How to build it

- **UI:** `src/components/EmailComposeModal.tsx` is the standard screen —
  don't hand-roll a new modal. It handles To parsing/validation, bcc-me,
  message, the attachment picker with the size cap, and the preview
  iframe. Flow-specific controls (e.g. the proof-file picker) go in its
  `intro` slot; bump `previewKey` when they change. Callers supply
  `fetchPreview` and `onSend` against their API route.
- **API route contract:** accept `emails: string[]`, `bccSelf: boolean`,
  `message: string`, `attachmentFileIds`/`attachmentPaths`, and
  `preview: boolean`. Preview returns `{ preview: true, to, subject,
  html }` with **zero side effects**. Real sends pass
  `bcc: [auth.user.email]` when `bccSelf`, and `auth.user.email` as
  Reply-To.
- **Send layer:** `sendEmail` / `sendEmailDetailed` (`src/lib/resend.ts`)
  take `to: string | string[]`, attachments, `replyTo`, and `bcc`.
  `buildNotificationEmail` renders the personal note
  (`opts.note`), the attachment list (`opts.attachmentNames`), and a
  CTA footnote (`opts.ctaNote`).
- **Attachments server-side:** validate the files belong to the record,
  check declared sizes against `MAX_ATTACHMENT_BYTES` up front, fetch
  bytes (R2 `r2Get`) **before** minting tokens or stamping anything, and
  re-check actual size while fetching. A fetch failure fails the send
  with the file named.

## Where each flow stands

| Flow | Compose screen | Notes |
| --- | --- | --- |
| Estimate approval (`/estimates`) | `EmailComposeModal` | Full standard. Approval doc is the email body; no attachments section (estimates carry no files). Delivery tracked on the estimate (Resend webhook → `approval_email_status`); a bounce alerts the sales side. |
| Graphics proof approval (`/graphics/[id]`) | `EmailComposeModal` | Full standard + proof-file picker in the intro slot; attachments from `graphics_job_files`. SMS still rides along when a phone is on file. |
| Invoice emails (`EmailInvoicesModal`) | Own modal, fits the standard | Multi-To, message, bcc-me, invoice-PDF attachments with verify + view, test-send, delivery tracking. Migrate to the shared component if it's ever rebuilt. |
| Wrap quote (`/admin/wrap-quote`) | Own modal, fits the standard | Editable To (prefills customer email + cc), bcc-me, message, per-attachment toggles, live preview. |
| Statement (`/admin/prospects/[id]`) | `EmailComposeModal` | Full standard. Preview predicts the invoice-PDF attachment list without fetching from NetSuite; real filenames land at send time. |
| Customer threads (`customer-threads`) | Chat-style thread | Deliberately not a compose modal (it's a running conversation). Reply-To = sender is in place. |
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
argument: `{ kind, sentBy, contextUrl }` — kind is a flow slug for the
admin view, sentBy routes the bounce alert, contextUrl deep-links the
record (falls back to the log row on System Health). Sends without meta
still log, tagged `other`.

## For every new feature

Adding any "email the customer/vendor" action means: use
`EmailComposeModal`, implement the API contract above (including
`preview`), pass Reply-To + bcc + an `EmailMeta` (kind, sentBy,
contextUrl), and add the flow to the table here.
