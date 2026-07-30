# Estimate → Sales Order → invoice

The flow from quote to getting paid. For the full narrative version,
see `full-job-walkthrough.md`.

---

## The flow

1. **Sales builds the estimate.**
   - **Estimates** → **+** → pick customer, add line items, save.
2. **Sales sends for approval.**
   - **Send to Customer for Approval** → email / SMS.
3. **Customer accepts.**
   - Estimate flips to **Accepted**.
4. **Sales pushes to NetSuite as a Sales Order.**
   - **Convert to Sales Order in NetSuite**.
5. **Vehicle arrives. Check-in.**
   - **Check In** tab. Install instructions pre-fill from the SO.
6. **Work happens — upfit + graphics.**
7. **Vehicle is marked complete.**
   - Pick-list → **Mark Complete**.
8. **Invoice gets created.**
   - For combined upfit + graphics jobs: accounting creates the
     invoice in NetSuite from the SO.
   - For graphics-only shipped jobs: tap **Create Invoice** from the
     bell notification when the job hits **Shipped**.

---

## Every line needs a NetSuite item

NetSuite estimate/SO lines require a real item — there's no free-text
line type. If you add a **Custom Line** (typed description + price
instead of picking from the catalog), the builder flags it with an
amber warning and blocks **Push to NetSuite** until you either:

- **Match NetSuite item** on that line and pick the real catalog item, or
- Fall back to the **FS-CUSTOM** placeholder item (used automatically
  by **Convert to Sales Order**, and by **Push to NetSuite as
  Estimate** if no catalog match exists). Your admin needs to create
  that item in NetSuite once, or the push/conversion will fail with an
  "unmapped lines" error and tell you which lines couldn't be sent.

If you see that error: tell your admin. Before this, a custom line
with no item could silently vanish from the pushed NetSuite record
with no warning — now it's blocked in the UI or reported back by name.

## Downloading the estimate PDF

Once an estimate has been pushed to NetSuite, a **View PDF** button
appears (in the builder's NetSuite status banner, and next to each
pushed estimate in the list) — opens the NetSuite-generated PDF in a
new tab.

---

## NetSuite owns the money side

FleetSuite caches NetSuite IDs and numbers but the source of truth for
totals, taxes, and customer balances is always NetSuite. Run reports
at **Admin → Reports**.
