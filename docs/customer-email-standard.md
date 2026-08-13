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
| Estimate approval (`/estimates`) | `EmailComposeModal` | Full standard. Approval doc is the email body; no attachments section (estimates carry no files). |
| Graphics proof approval (`/graphics/[id]`) | `EmailComposeModal` | Full standard + proof-file picker in the intro slot; attachments from `graphics_job_files`. SMS still rides along when a phone is on file. |
| Invoice emails (`EmailInvoicesModal`) | Own modal, fits the standard | Multi-To, message, bcc-me, invoice-PDF attachments with verify + view, test-send, delivery tracking. Migrate to the shared component if it's ever rebuilt. |
| Wrap quote (`/admin/wrap-quote`) | Own modal, fits the standard | Editable To (prefills customer email + cc), bcc-me, message, per-attachment toggles, live preview. |
| Statement (`/admin/prospects/[id]`) | `EmailComposeModal` | **Gap: no live preview** — the statement route has no `preview` mode yet. Add one when next touched. |
| Customer threads (`customer-threads`) | Chat-style thread | Deliberately not a compose modal (it's a running conversation). Reply-To = sender is in place. |
| Invites (CNI/admin), reminder crons, digests, notify-pickup | Exempt | Automated/transactional — nobody is composing. Reply-To falls back to `RESEND_REPLY_TO_EMAIL`. |

## For every new feature

Adding any "email the customer/vendor" action means: use
`EmailComposeModal`, implement the API contract above (including
`preview`), pass Reply-To + bcc, and add the flow to the table here.
