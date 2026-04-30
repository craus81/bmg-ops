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

## Why "FS-CUSTOM" matters

If your estimate has any **Custom Line** items (not from the
catalog), they all roll up under one item in NetSuite called
**FS-CUSTOM**. Your admin needs to create that item in NetSuite once
or the SO push will fail with an "unmapped lines" error.

If you see that error: tell your admin.

---

## NetSuite owns the money side

FleetSuite caches NetSuite IDs and numbers but the source of truth for
totals, taxes, and customer balances is always NetSuite. Run reports
at **Admin → Reports**.
