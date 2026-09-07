# R2 goes private — the C2 flip runbook (R3-22)

Owner decision 2026-09-07: **C2** — keep the public R2 domain, but
edge-limit it to an allowlist of non-sensitive paths, so images embedded in
already-sent customer emails keep rendering while everything sensitive
(photos, proofs, signed documents, prospect files, invoices, …) goes dark.

The app-side work shipped first (see the PR that added this file): every
signed-in surface reads through the auth-gated `/api/storage` stream or a
presigned URL, sessionless approval pages presign server-side, and the
generic storage routes tier callers (staff / external installer /
customer-only — see `src/lib/storage-guard.ts`). Nothing in the app depends
on the public domain any more, **except** the two allowlisted path families
below. The flip itself is a Cloudflare dashboard action — nothing to deploy.

## The allowlist

Only these path families stay publicly served, because they ride inside
customer emails (past and future) where a session or a presign can't work:

| Path prefix | What it is |
|---|---|
| `/vehicle-templates/*` | Company logo + wrap coverage-diagram templates (every email letterhead/signature, wrap-quote diagrams, quote-approval page) |
| `/photos/parts/*` | Vendor part product shots (estimate approval emails' line thumbnails) |

Everything else on the public domain should be blocked.

## Step 1 — which kind of public domain do you have?

Check `R2_PUBLIC_URL` in Vercel → Project → Settings → Environment
Variables (same value as `NEXT_PUBLIC_R2_PUBLIC_URL`).

**A. It's a custom domain you own (e.g. `files.bmgfleet.com`)** — the clean
C2 case. Go to step 2.

**B. It's an `*.r2.dev` URL (e.g. `pub-….r2.dev`)** — r2.dev cannot be
path-filtered (it isn't in your Cloudflare zone), so pure C2 isn't
available on it. Two choices:

- **B1 (recommended): migrate to a custom domain, then C2.** Cloudflare →
  R2 → the `fleetsuite` bucket → Settings → Custom Domains → connect one
  (e.g. `files.bmgfleet.com`); update `R2_PUBLIC_URL` and
  `NEXT_PUBLIC_R2_PUBLIC_URL` in Vercel and redeploy; apply the step-2 rule
  to the new domain; then disable the r2.dev public URL (same Settings
  page). **Trade-off:** images in emails sent while r2.dev was the base
  break when r2.dev is disabled — those URLs bake the old host. That's
  C1-for-history; the attached PDFs in those emails are unaffected.
- **B2: accept C1 outright** — just disable the r2.dev public URL. All old
  email images break (logos/diagrams/part thumbnails only — attachments
  survive); new emails keep working only if you also do B1's domain +
  allowlist, so B2 alone means also stripping the allowlist reliance
  (a follow-up code change — ask for it).

## Step 2 — the WAF rule (custom-domain case)

Cloudflare dashboard → the zone that serves the domain → **Security → WAF →
Custom rules → Create rule**:

- **Name:** `R2 public allowlist (R3-22 C2)`
- **Expression** (edit the hostname):

  ```
  (http.host eq "files.bmgfleet.com") and not (
    starts_with(http.request.uri.path, "/vehicle-templates/") or
    starts_with(http.request.uri.path, "/photos/parts/")
  )
  ```

- **Action:** Block.
- Deploy.

Rollback at any time: disable or delete the rule — everything is exactly as
before, which is what makes C2 the safe first move.

## Step 3 — verify (10 minutes, in the live app)

Signed-in surfaces (staff account):
- Tracking → expand a vehicle → photos render; proof thumbnail + View Proof open (legacy rows included).
- A vehicle pick-list → proof preview renders; photo timeline renders; a photo upload works.
- Parts page + upfit designer → part images render.
- A record (prospect/customer) → Files list opens each file.
- An estimate → attached files open.

External + sessionless:
- Log in as (or with) a CNI installer → their job photos page, invoices
  list, and profile docs still open; a proof on the pick-list renders.
- Open a wrap-quote approval link (token) → coverage diagram renders.
- Open an estimate approval link (token) → proof images + part thumbnails render.
- Open an OLD sent email → logo (and diagram, if present) still render.
- Directly request a sensitive object's public URL (e.g. a `photos/…`
  vehicle photo URL from an old DB row) → **blocked**. That's the win.

If anything sensitive still loads publicly, the rule expression's hostname
or path list is off; if an in-app image broke, check the browser network
tab — a 403 from `/api/storage` means the caller tier (storage-guard) needs
that prefix, a 403 from the public domain means a missed call site (grep
`r2PublicUrl(`/`getPublicUrl(` and compare against the allowlist).

## Later, if ever — full C1

Going fully dark (no public paths at all) additionally requires moving
email-embedded images (logo, diagrams, part thumbnails) to inline CID
attachments so new emails carry their images inside the message, and
accepting broken images in all previously sent email bodies. Ask for that
build when wanted; nothing else remains.
