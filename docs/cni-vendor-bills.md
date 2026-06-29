# CNI installer payouts → NetSuite vendor bills

How an individual-mode CNI payout becomes a NetSuite **vendor bill**, and the
NetSuite specifics that are easy to get wrong. (Hard-won — most of these only
surfaced as opaque `500 UNEXPECTED_ERROR`s during the first rollout.)

## Flow

1. **Generate Payout Statements** — one `payouts` row per installer from their
   completed-vehicle credits (status `draft`).
2. **Approve** — `draft → approved` (no NetSuite call).
3. **Create Bill in NetSuite** — creates the vendor bill and stores its id
   (`approved → billed`). Code: `POST /api/admin/payouts` action `create_bill`
   → `createVendorBill()` in `src/lib/netsuite.ts`.
4. **Mark Paid** — `billed → paid` (after you actually pay it).

A manual fallback remains: paste a Bill ID → **Record Bill** (`record_bill`).

## Vendor bill body — required fields and exact values

NetSuite's UI form ("BMG Fleet - Vendor Bill") marks these required; the REST
create fails (often as an opaque 500) if any is wrong:

| Field | Value | Notes |
|---|---|---|
| `entity` (Vendor) | installer's vendor **Internal ID** (numeric) | from `cni_profiles.netsuite_vendor_id`. **THE big gotcha** — see below. |
| `tranId` (Reference No.) | `<job_number>-<short payout id>` | required when bills aren't auto-numbered. |
| `subsidiary` | **BMG Fleet Installations** = internal id **2** | required; NetSuite does *not* derive it from the vendor here. |
| `location` (header only) | one of Wentzville / Kansas City / O'Fallon / Social Circle | resolved by name via `findLocation`. Do **not** also set it on the expense line (that 500s unless per-line locations are enabled). |
| expense line `account` | **Subcontractors** (#53000) = internal id **223** | |
| expense line `amount` | payout total | |

Currency, exchange rate, and posting period auto-derive — we don't send them.

## The Vendor ID must be the **Internal ID**, not the **Entity ID**

This caused the entire first-rollout failure. A NetSuite vendor has:

- **Entity ID** = the vendor's *name* (e.g. "Corban Peters"). NetSuite labels
  this just "ID" on the record, which is the trap.
- **Internal ID** = a system **number** (e.g. 2617). This is what the REST API
  `entity.id` needs.

`cni_profiles.netsuite_vendor_id` must hold the **Internal ID (number)**.
A name there makes the bill 500 with no useful detail. The `create_bill` route
now rejects a non-numeric value with a clear message, and the Vendor IDs page
says to use the Internal ID. Find it: Lists → Relationships → Vendors →
Internal ID column (enable Home → Set Preferences → ✓ Show Internal IDs), or
the `&id=NNNN` in the vendor record URL.

## NetSuite role / SuiteQL limitations

- The integration's role needs the **Transactions → Bills** permission (Create)
  or create returns `403 INSUFFICIENT_PERMISSION`.
- This role **cannot SuiteQL the `account` or `subsidiary` tables** ("Record
  'account' was not found") — only `location` is queryable. So the account and
  subsidiary are sent as **hardcoded internal ids** (223 / 2), overridable via
  `NETSUITE_SUBCONTRACTOR_ACCOUNT_ID` / `NETSUITE_SUBSIDIARY_ID`. Don't "fix"
  this by reintroducing a SuiteQL lookup for them.

## Debugging opaque 500s

`UNEXPECTED_ERROR` hides the cause. `createVendorBill` appends the exact JSON
body we sent to the returned error (`| sent: {…}`) — that's how the bad
`entity.id` was caught. The Error ID in NetSuite's response can be looked up in
Script Execution Logs only if a SuiteScript is involved; a bad field *value*
(like the vendor id) won't appear there.
