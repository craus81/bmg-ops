# Fulfill → invoice, in one step

Field report (2026-08-28):

> "I tried to invoice from a sales order during the completion process and it
> sort of worked, but there was an issue because the sales order has to be
> fulfilled first, otherwise the invoice will only show items that aren't
> 'fulfillable' like labor and freight."

## Why it happened

This NetSuite account runs **Advanced Shipping**. Our own status map proves
it — sales orders here move through Pending Fulfillment (B) → Partially
Fulfilled (D) → Pending Billing (F), see `VehicleCheckIn.tsx`.

With Advanced Shipping on, NetSuite's **SO → Invoice transform carries only
the lines that need no fulfillment**: labor, freight, other charges. Every
inventory item must pass through an **Item Fulfillment** first. The old
`/api/vehicle-tracking/invoice` did a bare SO→Invoice transform, so parts
silently fell off the bill.

## What the flow does now

`POST /api/vehicle-tracking/invoice` (admin only, from the completion modal):

1. **Read state** — `getSalesOrderFulfillmentState()` returns the SO's status
   and every Item Fulfillment already created from it (transaction type
   `ItemShip`, linked by `createdfrom`).
2. **Decide** — `decideFulfillment()` in `src/lib/so-fulfillment.ts`, pure and
   unit-tested:

   | SO status | Decision |
   |---|---|
   | ≥1 existing fulfillment, ≥1 of them Shipped | **skip** — never fulfill twice |
   | ≥1 existing fulfillment, none Shipped | **block** — mark it Shipped in NetSuite (its parts are not billable, and a second fulfillment is never the answer) |
   | B / D / E (pending or partially fulfilled) | **fulfill** |
   | F (Pending Billing) | **skip** — nothing left to ship |
   | A (Pending Approval) | **block** — approve it in NetSuite first |
   | C cancelled · G billed · H closed | **block** |
   | anything unrecognized | **block** — never guess with inventory |

3. **Claim** — insert into `netsuite_so_fulfillments` (migration 235), which is
   `UNIQUE(netsuite_so_id)`. A second click gets 23505 and never reaches
   NetSuite.
4. **Fulfill** — `POST /record/v1/salesOrder/{id}/!transform/itemFulfillment`
   with `shipStatus` **C (Shipped)**, full order, no line overrides.
5. **Verify** — read the fulfillment back. Created ≠ shipped: a Picked or
   Packed fulfillment has **not** relieved inventory, so a PATCH pushes it to
   Shipped, and if it still isn't, the run stops with the fulfillment id.
6. **Invoice** — the existing SO→Invoice transform, now carrying the parts.
7. **Stamp** the check-in's invoice fields, as before.

## This moves real stock

Fulfilling **relieves inventory and posts COGS**. That is intended (confirmed
2026-08-28) and it is why the guard is layered:

- NetSuite's own fulfillment records are the source of truth — re-read before
  anything is created.
- The claim row closes the race a SuiteQL read can't (two admins, same
  second).
- A claim is released **only** when NetSuite confirms nothing was created. An
  unknown outcome keeps the claim, so the worst case is a stuck sales order a
  human resolves in NetSuite — never a second fulfillment.
- A failed fulfillment **does not** fall through to invoicing. Billing anyway
  would recreate the labor-and-freight-only invoice this exists to stop.

## Role permissions

The integration role needs **Transactions › Fulfill Sales Orders** plus the
**Item Fulfillment** record permission (create). Without them NetSuite returns
a permission violation, `describeFulfillmentError()` turns it into that
sentence, and **no invoice is created** — so until the role is granted, the
completion screen's invoice button fails loudly instead of billing short.
Same caveat class as the vendor-bill role limits in `docs/cni-vendor-bills.md`.

## Scope

- **Full sales order only.** This runs at completion, when the order is done.
- Partial / installed-quantity billing is a different path and is unchanged:
  `/api/netsuite/create-invoice` (batch from sales orders, `quantities` map)
  and `/api/pos/invoice-open`.
- `shipStatus` is sent as `{ id: 'C' }` first and retried as the bare string
  `'C'` only if NetSuite rejects the field's *shape* — and only after
  re-reading NetSuite, so a "failed" first attempt that actually created a
  record can never be duplicated.
