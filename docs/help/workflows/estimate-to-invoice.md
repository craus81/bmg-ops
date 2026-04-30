# Workflow: estimate → Sales Order → invoice

Full lifecycle from sales building an estimate to BMG getting paid.
Touches sales, graphics production, admins, and NetSuite.

## Sequence

1. **Sales builds the estimate.** `/estimates` → **New Estimate**.
   Pick customer + vehicle(s), add line items from catalog or as
   custom lines, fill install context.
2. **Sales sends for approval.** **Send to Customer for Approval**;
   token + email + (optional) SMS dispatch. See
   `magic-link-approvals.md`.
3. **Customer accepts.** Status flips to `accepted`. Signed HTML
   snapshot lands in `signed-documents/estimates/[id]/`.
4. **Sales pushes to NetSuite as a Sales Order.** **Convert to Sales
   Order** on the accepted estimate.
   - Catalog line items map to their NetSuite items.
   - Custom line items route through the permanent **FS-CUSTOM**
     NetSuite item (must exist or push fails 400).
   - Install context + estimate notes go into the NS memo.
   - Returns the new SO ID + number, persists `netsuite_so_id` on the
     estimate.
5. **Vehicle arrives + check-in.** Shop tech does the check-in at
   `/fleet`. The check-in form pulls install context from the SO
   memo via `netsuite_so_id`, falling back to the customer's
   delivery instructions.
6. **Graphics + upfit work happens.** Graphics production runs the
   queue, hits the magic-link proof approval flow, produces the
   pieces, and either ships them or the vehicle gets installed
   in-shop.
7. **Mark complete.** Installer marks the vehicle complete (see
   `install-completion.md`).
8. **Invoice.** Two paths depending on whether it's a graphics-only
   shipped job or a full upfit:

### Graphics-only shipped job → direct invoice

When a graphics job hits `shipped` status:

1. `/api/graphics/notify-shipped-invoice` notifies Craig George +
   Jessie Whittington (UUIDs hardcoded) that an invoice is needed.
2. They get a bell notification with **Create Invoice** action.
3. Clicking it opens `/graphics/[id]?invoiceJob=<id>` which auto-opens
   the `GraphicsInvoiceModal`.
4. They pick customer + line items + qty/rate.
5. **Create Invoice** calls `/api/netsuite/create-invoice-direct`,
   which uses `createDirectInvoice` to create a standalone NetSuite
   invoice — no SO required.
6. Result writes back: `netsuite_invoice_id`,
   `netsuite_invoice_number`, `invoiced_at` on the graphics job.

### Full upfit → SO-linked invoice

For full upfits, the SO created at step 4 above is the bill-of-record.
At install completion or later, ops creates the NetSuite invoice from
the SO via NetSuite's normal flow (this is done in NetSuite directly,
not in FleetSuite).

## Why FS-CUSTOM is required

Estimates can include line items that don't map to any catalog SKU
(e.g. "custom labor 2 hrs", "ladder rack passthrough drilling"). The
old behavior silently dropped these on SO push. The current behavior
routes them through a single permanent NS item called **FS-CUSTOM**
with the line description carrying the actual content.

If FS-CUSTOM doesn't exist in your NetSuite, the push returns 400 with
an `unmappedLines` list. Your admin needs to create the item (see
`admin.md` → "How do I set up the FS-CUSTOM NetSuite item?").

## What about the original NS quotes?

Legacy `quotes` exist in the schema but the canonical pre-SO record
moving forward is `estimates`. Open quotes still surface in the
**Open Quotes** widget but new sales work should use Estimates.

## Roles involved

- `sales` — builds the estimate, sends for approval, pushes to SO.
- `customer` — approves the estimate.
- `graphics_production` — runs the proof approval + production loop.
- `admin` — handles edge cases (FS-CUSTOM creation, force-completing
  a vehicle, manual NS pushes).

## Where the financial truth lives

NetSuite is the system of record for SOs and invoices. FleetSuite
caches IDs / numbers (`netsuite_so_id`, `netsuite_invoice_id`,
`netsuite_invoice_number`) and the install context, but financial
totals, taxes, and customer balances always come from NetSuite via
SuiteQL.

## Common issues

**"Push to SO failed with 400 / unmappedLines."** — FS-CUSTOM doesn't
exist in NetSuite. Create it.

**"NS sync overwrote our install instructions."** — It shouldn't.
Customer install context fields (`delivery_instructions`,
`default_site_contact`, `notes_for_ops`) are FleetSuite-owned and the
sync explicitly skips them. If they got overwritten, file a bug — the
sync code lives in `src/lib/netsuite/customer-sync.ts`.

**"Graphics-shipped invoice prompt didn't fire."** — The notification
recipients are hardcoded UUIDs. If staff changed and the UUIDs are
stale, you'll see no bell prompt. Update the UUIDs in
`/api/graphics/notify-shipped-invoice` and redeploy.
