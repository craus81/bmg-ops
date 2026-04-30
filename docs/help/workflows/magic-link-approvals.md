# Workflow: magic-link approvals (estimates and proofs)

How customers accept or reject estimates and graphics proofs without
having to log in. Used for both `/approve/estimate/[token]` and
`/approve/proof/[token]`.

The two flows are nearly identical, sharing the
`src/lib/magic-link-approval.ts` helper and the audit infrastructure.
Differences are called out below.

## How a token gets minted (sender side)

**For an estimate** (sales role):
1. `/estimates/[id]` → click **Send to Customer for Approval**.
2. Pick channel: email / SMS / both.
3. `/api/estimates/[id]/send-for-approval` is called.
4. Server generates a 30-day token, writes it to
   `estimates.approval_token` + `approval_token_expires_at`, sets
   `sent_for_approval_at` and `sent_for_approval_by`.
5. Email is dispatched via Resend; SMS via the provider dispatcher
   (`src/lib/sms-provider/`) when `SMS_PROVIDER_ENABLED=true`.
6. Both messages contain the URL
   `${NEXT_PUBLIC_APP_URL}/approve/estimate/${token}`.

**For a proof** (graphics_production role):
1. `/graphics/[id]` → click **Send for Approval**.
2. The proof-file picker appears. Pick exactly one file.
3. Pick channel.
4. `/api/graphics-jobs/[id]/send-for-approval` is called with
   `proofFileId`.
5. Server validates the file belongs to this job, then mints token,
   persists `approval_proof_file_id`, dispatches messages.
6. URL is `${NEXT_PUBLIC_APP_URL}/approve/proof/${token}`.

## What the customer sees

The approval pages are public — no login. They render:
- Title (estimate # / graphics job + vehicle)
- Customer-friendly summary
- For estimates: line items, totals, install context
- For proofs: the embedded image (or PDF deep-link button)
- An **I authorize this work** / **I approve this proof** checkbox
- Two big buttons: **Accept & Authorize Work** / **Approve Proof** and
  **Request Changes** / **Request Revision**

Page-load instrumentation tracks how long they spent on the page, for
the audit record.

## What happens on accept

The accept POST hits `/api/approve/estimate/[token]` or
`/api/approve/proof/[token]`. Both:

1. **Rate-limit**: 20 attempts per hour per IP, tracked in
   `approval_rate_limits`. 429 if exceeded.
2. **Validate**: token exists, not expired, not already accepted.
3. **Capture audit**: IP, user agent, time on page (from client),
   delivery channel/target.
4. **For estimates**: render the estimate as HTML with the audit block
   inline, hash with sha256, upload to private
   `signed-documents/estimates/[id]/`. Persist
   `signed_document_path` + `signed_document_hash`.
5. **For proofs**: download every attached proof file from
   `graphics-proofs` storage, clone the bytes into
   `signed-documents/proofs/[id]/` so the file is immutable. Persist
   the cloned paths in `signed_proof_storage_paths text[]`. Write an
   HTML audit snapshot referencing those paths.
6. Flip status: estimate → `accepted`, graphics job →
   `customer_approved=true`.
7. Notify the sender (sales rep or graphics designer) via in-app +
   email.

The customer sees a success screen.

## What happens on reject (request changes)

Reject is also instrumented but doesn't store a signed snapshot:

1. Same rate-limit check.
2. Capture audit + the rejection reason the customer typed.
3. **For estimates**: status stays so sales can edit and resend; the
   rejection reason is stored on the estimate.
4. **For proofs**: status flips to `revision`, append a
   `graphics_status_history` row with the customer comment.
5. Notify the sender.

The customer can re-approve the next version when sales / graphics
sends a new link.

## Resending after a reject

Senders can resend using the same UI button. Resend mints a fresh
token; the old token stays valid until expiry but the most recent one
is the canonical link.

## Token security

- 30-day expiry.
- Single-purpose: tokens scope to a specific estimate / proof.
- Rate-limited per IP (20/hr) — protects against brute force.
- Tokens are random URL-safe strings, not signed JWTs (rotation
  happens by issuing a new token).
- Storage buckets for signed docs are private — only the service role
  can read.
- Public approval pages embed signed URLs (1-hour expiry) for the
  proof images themselves so the file URL itself isn't shared
  publicly.

## Required environment

- `NEXT_PUBLIC_APP_URL` — required, otherwise links render as
  `http:///approve/...`. Set this in Vercel.
- `RESEND_API_KEY` — for email delivery.
- `SMS_PROVIDER_ENABLED` + `SMS_PROVIDER` + provider creds — for SMS
  delivery. Off by default; flip when A2P 10DLC clears.

## Roles involved

- `sales` (or `admin`) — sends estimate approvals.
- `graphics_production` (or `admin`) — sends proof approvals.
- `customer` (no login required) — accepts / rejects.

## Common issues

**"My approve link is broken / 404."** — Probably the email rendered
with `http:///approve/...` because `NEXT_PUBLIC_APP_URL` wasn't set.
Set the env var, redeploy, and resend.

**"Rate limit exceeded."** — Customer hit reload too many times. Wait
an hour or have the customer use a different network.

**"Customer says they approved but the job is still pending."** — They
might have clicked Reject by accident, or hit the wrong link from an
old email. Check `approval_token_expires_at` and look at
`graphics_status_history` for the rejection comment. Mint a new token
and resend.
