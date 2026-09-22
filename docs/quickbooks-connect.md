# Connecting QuickBooks Online

FleetSuite's ledger reads the company's QuickBooks Online history — invoices,
payments, bills, journal entries, the chart of accounts, the documents QBO
renders and the reports it prints — into the same tables the NetSuite mirror
and future FleetSuite-native documents use. Nothing is imported until this
connection exists, and the connection is a one-time, ~20-minute task split
between Intuit's developer site, Vercel and one click in the app.

The app only ever GETs and queries: the accounting scope has no read-only
variant, so "read-only" is a property of our code, not of the grant. No
customer card number, CVV or bank routing/account number is ever stored —
those fields are dropped at intake, not masked.

> **Verifying afterwards.** System Health → Connections → Connected apps
> shows a **QuickBooks Online** row: `Off · Not configured` before the keys
> exist, `Connected — <company>` with both token expiries once the handshake
> has run. That row is the check that each step below actually took; the five
> `QBO_*` variables also appear under Environment variables → QuickBooks
> Online as plain "Not set" rows until they are provisioned (deliberately not
> amber — an app that was never created is not a fault).

## 1. Create the Intuit app (~5 minutes)

1. Sign in at **developer.intuit.com → Dashboard → Create app → QuickBooks
   Online and Payments**, scope **com.intuit.quickbooks.accounting**.
2. Take the **PRODUCTION** keys (Keys & credentials → Production). Development
   keys pair ONLY with a sandbox deployment — see step 7; putting development
   keys on production is refused by the app, not just discouraged.

## 2. Register the redirect URI (~2 minutes)

On the app's **Redirect URIs** list add EXACTLY:

```
https://go.bmgfleet.com/api/auth/quickbooks/callback
```

Intuit's production-key profile also asks for these; FleetSuite serves the
two legal pages publicly (no login) for exactly this form:

| Field | Value |
|---|---|
| Host domain | `go.bmgfleet.com` |
| Launch URL | `https://go.bmgfleet.com` |
| Connect/Reconnect URL | `https://go.bmgfleet.com/settings` |
| Disconnect URL | `https://go.bmgfleet.com/settings` |
| Privacy policy URL | `https://go.bmgfleet.com/privacy` |
| EULA URL | `https://go.bmgfleet.com/terms` |

Intuit matches the redirect URI character for character. The production host was
settled as `go.bmgfleet.com` (owner decision 2026-09-19, replacing
`bmg-ops.vercel.app`) — register it only once that domain is live in Vercel,
because re-registering means coming back to Intuit. Vercel preview
deployments get a different hostname every build, so **previews cannot
complete OAuth**; always authorize from the production URL.

## 3. Set the Vercel environment (~3 minutes)

Vercel → Project → Settings → Environment Variables, **Production** scope:

```
QBO_CLIENT_ID=<from the Intuit app>
QBO_CLIENT_SECRET=<from the Intuit app>
QBO_REDIRECT_URI=https://go.bmgfleet.com/api/auth/quickbooks/callback
QBO_ENVIRONMENT=production
QBO_MINOR_VERSION=            # optional; the app pins a default
```

Redeploy. Until the redeploy lands, the Connections app row reads
`Off · Not configured` — that is the honest state, not a failure.

## 4. Authorize (~2 minutes)

Settings → Company → **QuickBooks Online → Connect** (admin or super admin
only). Intuit asks which company to connect; approve, and the callback
returns to `/admin/ledger?qboAuth=success`.

If it comes back with a failure reason instead:

| Reason | What it means |
|---|---|
| `state_mismatch` | The one-time nonce didn't match — start the connect again from the app, never from a bookmarked Intuit URL. |
| `expired` | The authorize page sat open too long. Start again. |
| `user_mismatch` | A different signed-in user finished a handshake someone else started. The person who clicks Connect must be the person who approves. |
| `forbidden` | The signed-in account is not an admin/super admin. |
| `missing_realm` | Intuit returned no company id. Retry; if it repeats, the Intuit app is misconfigured. |
| `exchange_failed` | The token POST was rejected — usually a wrong `QBO_CLIENT_SECRET` or a redirect URI that doesn't match the registered string exactly. |
| `another_realm_connected` | A different QuickBooks company is already connected. Disconnect it first (step 6); one realm at a time. |
| `sandbox_on_production` | A sandbox realm was offered to a deployment carrying production secrets. See step 7. |
| `production_off_production` | A production realm was offered to a non-production deployment. Connect it from production. |

"Company name unavailable" after a **success** means only the CompanyInfo
probe failed. The connection is stored and valid; the name fills in on the
next successful call.

## 5. Verify (~2 minutes)

System Health → Connections → Connected apps:

- The QuickBooks Online row reads `Connected — <company>` and shows both the
  access-token and the refresh-token expiry.
- Refresh tokens **rotate**, and die after 100 idle days. The daily ledger
  sync (09:57 UTC) renews the token EVERY day from the first run after
  connecting — before the bulk import has even finished — so an idle
  connection cannot age out. The row warns 14 days ahead of the refresh
  expiry so a genuinely stalled connection is visible before it breaks.

Then continue with **docs/ledger-import.md** for the dry run and the import.

## 6. Rollback

Settings → Company → **Disconnect** (super admin) revokes the grant at Intuit
and clears the stored tokens. Everything already imported stays — the ledger
rows are ours, not a live view of QuickBooks. Reconnecting is step 4 again.

## 7. Sandbox pairing (only if you want a practice run)

A QuickBooks **sandbox** company may only ever be connected from a sandbox
deployment: Intuit development keys, `QBO_ENVIRONMENT=sandbox`, a
non-production Supabase ref, and NO `NETSUITE_*` credential in the
environment. In practice that means running it **locally** — `npm run dev`
per docs/sandbox-setup.md, where `VERCEL_ENV` is unset.

One surprise worth spelling out: `assertEnvironmentPairing` refuses
`sandbox` whenever `VERCEL_ENV === 'production'`. So a sandbox hosted as its
OWN Vercel project cannot complete the handshake even though it carries no
production secret — its main deployment reports
`VERCEL_ENV='production'`. That is intentional
belt-and-braces on top of the Supabase-ref and `NETSUITE_*` discriminators.
The fix is to connect the sandbox realm from the local sandbox, not to relax
the check.

## Later

- Once the connection is live, the five `QBO_*` rows can be escalated from
  "optional" to a warning so a later key deletion raises an amber Connections
  row. They ship optional so an unprovisioned Intuit app never fills the
  Needs-attention filter with rows the owner deliberately hasn't set.
