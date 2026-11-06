# What's new in FleetSuite

<!-- Made from src/lib/release-notes.json. Do not edit by hand: change the JSON, then run
     UPDATE_WHATS_NEW=1 npx vitest run src/lib/release-notes.test.ts -->

New features and fixes, newest first. Everything that went live on the same day is one release, numbered by the date (release 2026.11.06 went live November 6, 2026). In the app: More → What's new. People only see the changes for the parts of the app they use; the area is in brackets.

## Release 2026.11.06 (Friday, Nov 6, 2026)

- New: Tap the parts steps on the job progress bar to see which parts are in and which are still coming. Where: Job progress bar → Parts ordered / Parts in. [Everyone]
- New: Scan extra parts for each vehicle, like its kit and unit-number decal. Where: Scan. [Shop]
- New: Change quantities and prices, or add lines, when you finish a job, then invoice it in one step. Where: In-Shop → completion window → Adjust & invoice. [Admins]
- New: Job orders, packing lists and every printed form share the red BMG headings. Where: Every printed form. [Everyone]
- New: Emails for POs, sales orders and invoices now attach FleetSuite's own PDF. Where: ✉ Email on any PO, sales order or invoice. [Sales, Purchasing]
- New: Create a sales order right from the In-Shop vehicle card, or copy one from an old sales order, invoice or estimate. Where: In-Shop → vehicle card → + Create Sales Order. [Sales, Shop]
- New: Sales orders turn green when every part is on a vendor PO or in stock. Where: Sales → Sales orders. [Sales, Purchasing]
- New: Change a vendor PO in FleetSuite: quantities, prices, dates, ship-to, or move parts to another vendor. Where: More → Purchase Orders → ✎ Edit PO. [Purchasing]
- New: FleetSuite AI can now explain 19 newer features step by step. Where: Ask FleetSuite AI "how do I…". [Everyone]
- New: When FleetSuite AI can't help, it sends your question to Craig as a request. Where: FleetSuite AI chat, on every page. [Everyone]

## Release 2026.11.05 (Thursday, Nov 5, 2026)

- New: A progress bar shows where every job is, from Submitted to Complete. Where: Estimates, sales orders, graphics jobs and the In-Shop card. [Everyone]
- New: Job Stages board: every open job by step. Where: More → Job Stages. [Sales, Shop, Graphics]
- Fixed: POs no longer fail when NetSuite has deleted a part's old item number. Where: Parts ordering → Create PO. [Purchasing]

## Release 2026.11.04 (Wednesday, Nov 4, 2026)

- New: Tick several sales orders and print them as one PDF. Where: More → To Print → Print N selected. [Sales]
- New: Every new sales order lands in To Print so the board copy gets printed. Where: More → To Print. [Sales]
- New: New End user box on estimates and sales orders. Where: Estimate and sales order pages. [Sales]

## Release 2026.11.03 (Tuesday, Nov 3, 2026)

- New: The stock a credit memo puts back posts from Books' own copy. Where: More → Books. [Books]
- New: A credit memo FleetSuite made posts from Books' own copy. Where: More → Books. [Books]
- New: An invoice's cost posts from FleetSuite's own copy. Where: More → Books. [Books]
- New: Mistake checks look at bill credits, card refunds and journal entries. Where: More → Books. [Books]
- New: A PO's other lines, like freight, on FleetSuite's copy and its bills. Where: More → Books. [Books]
- New: Each line of an own fulfillment from where NetSuite takes it. Where: More → Books. [Books]

## Release 2026.11.02 (Monday, Nov 2, 2026)

- New: Update prices from an Excel or CSV file, and see a nightly list of prices that don't match NetSuite. Where: More → Part setup → Update Prices. [Admins]
- New: A kit's parts on FleetSuite's own fulfillments. Where: More → Books. [Books]
- New: Shipping and handling NetSuite adds to an invoice. Where: More → Books. [Books]
- New: Which company a PO is for. Where: More → Books. [Books]
- New: Parts Mail asks NetSuite before making a bill. Where: More → Books. [Books]
- New: Dates on O'Fallon's day, not UTC's. Where: More → Books. [Books]
- New: How the books work, written down. Where: More → Books. [Books]
- New: Two-step sign-in for money roles. Where: More → Books. [Books]
- New: Change history on the money tables. Where: More → Books. [Books]
- New: The nightly restore drill. Where: More → Books. [Books]
- New: Nightly backups of FleetSuite's books. Where: More → Books. [Books]
- New: FleetSuite AI on FleetSuite's books, switched off. Where: More → Books. [Books]
- New: The portal's billing on FleetSuite's books, switched off. Where: More → Books. [Books]
- New: Financial History on FleetSuite's books, switched off. Where: More → Books. [Books]
- New: Home → Financials on FleetSuite's books, switched off. Where: More → Books. [Books]
- New: The CPA's yearly entries on Year end and in the year-end package. Where: More → Books. [Books]
- New: Each bank account's reconciliation at December 31 in the year-end package. Where: More → Books. [Books]
- New: Each customer's and vendor's balance at December 31 in the year-end package. Where: More → Books. [Books]
- New: The general ledger in the year-end package. Where: More → Books. [Books]
- New: The year-end package, a company's year for the CPA in one Excel file. Where: More → Books. [Books]
- New: Year end, each company's year closed into retained earnings. Where: More → Books. [Books]
- New: Report builder lines by customer and vendor, moving months and saved reports. Where: More → Books. [Books]

## Release 2026.11.01 (Sunday, Nov 1, 2026)

- New: Report builder, FleetSuite's P&L by division, location, month, quarter or year. Where: More → Books. [Books]
- New: Cash flow statement on Reports, laid out as NetSuite's Statement of Cash Flows. Where: More → Books. [Books]
- New: File the 1099s, who gets a 1099-NEC or MISC and the IRS's IRIS file made on the device. Where: More → Books. [Books]
- New: Counts, count sheets by location, a variance review and one approved adjustment, switched off. Where: More → Books. [Books]
- New: FleetSuite's own invoice PDF, attached to NetSuite's invoice, switched off. Where: More → Books. [Books]
- New: FleetSuite's own numbers on sales orders, POs, invoices and credit memos, switched off. Where: More → Books. [Books]
- New: Own invoices taxed at each location's dated rate, and a warning at billing when an exempt customer's certificate has expired. Where: More → Books. [Books]
- New: Missouri sales tax worksheet, dated rates per location, and each return held against it. Where: More → Books. [Books]
- New: Inventory value at a month's end, tied to the inventory accounts. Where: More → Books. [Books]
- New: Inventory adjustments approved before they're posted, switched off. Where: More → Books. [Books]
- New: 1084's bank reconciliation, statement by statement. Where: More → Books. [Books]
- New: 1084's rent and mortgage, month by month. Where: More → Books. [Books]
- New: The First Bank ACH file. Where: More → Books. [Books]
- New: Keep vendor bank numbers encrypted, confirmed on a call-back. Where: More → Books. [Books]
- New: Print a payment run's checks on BMG's check stock. Where: More → Books. [Books]
- New: Pay vendors in payment runs with a second approver, switched off. Where: More → Books. [Books]
- New: Make bank deposits from Undeposited Funds, switched off. Where: More → Books. [Books]
- New: Take check and ACH deposits on sales orders, switched off. Where: More → Books. [Books]
- New: Receive check and ACH payments in FleetSuite, switched off. Where: More → Books. [Books]

## Release 2026.10.31 (Saturday, Oct 31, 2026)

- New: The CPA's own adjustments journal. Where: More → Books. [Books]
- New: A bookkeeper and a CPA login for the books. Where: More → Books. [Books]
- New: NetSuite's 1099 report next to FleetSuite's totals. Where: More → Books. [Books]
- New: The 1099 dry run, each vendor's 1099 totals from the NetSuite copy. Where: More → Books. [Books]
- New: FleetSuite's record wins for items too, switched off. Where: More → Books. [Books]
- New: FleetSuite's record wins for customers and vendors, switched off. Where: More → Books. [Books]
- New: Estimates stay in FleetSuite, switched off. Where: More → Books. [Books]
- New: An item's accounts changed in FleetSuite, switched off. Where: More → Books. [Books]
- New: The NetSuite feed, every send to NetSuite kept with its answer. Where: More → Books. [Books]
- New: Close a month in FleetSuite's books, reopen it for a reason. Where: More → Books. [Books]
- New: Go live on the tap, opening entry posted once live. Where: More → Books. [Books]
- Fixed: The button that drops your edits now reads "Leave without saving" instead of "Cancel". Where: Top Save bar. [Everyone]
- Fixed: The vendor list copy refreshes again, and System Health watches it. Where: More → System Health. [Admins]
- New: The Sent box shows the approval send for fleet and batch estimates. Where: Sent Emails. [Sales]
- New: Going live page with the opening entry and a rehearsal. Where: More → Books. [Books]
- New: Make a new sales order from nothing. Where: Sales orders → + New. [Sales]
- Fixed: Items starting with 06 are treated as untaxed services. Where: Estimates, sales orders and invoices. [Sales]
- New: Customer and vendor details changed in FleetSuite and sent on to NetSuite, built switched off. Where: More → Books. [Books]
- New: See if, when and to whom every document was sent. Where: Estimates, sales orders and invoices. [Sales]
- New: Bills fixed in FleetSuite and sent on to NetSuite, built switched off. Where: More → Books. [Books]
- New: Invoices fixed in FleetSuite and sent on to NetSuite, built switched off. Where: More → Books. [Books]
- New: Inventory transfers made in FleetSuite and sent on to NetSuite, built switched off. Where: More → Books. [Books]
- New: Journal entries typed in FleetSuite, approved, and sent on to NetSuite, built switched off. Where: More → Books. [Books]
- New: Chase card charges coded in FleetSuite and sent to NetSuite as a journal entry a month, built switched off. Where: More → Books. [Books]
- New: Vendor credits entered in FleetSuite and applied to the vendor's open bills, built switched off. Where: More → Books. [Books]
- New: Credit memos made in FleetSuite against an invoice, built switched off. Where: More → Books. [Books]
- New: On hand, available and on order show wherever parts are requested. Where: Part requests. [Sales, Shop, Purchasing]
- New: Fulfill & Invoice from the sales order page, with Print and Email on each invoice. Where: Sales order page → Fulfill & Invoice. [Sales]
- New: Estimates get Approved, Parts ordered and Parts in stock tags, with a green banner. Where: Estimates list and estimate page. [Sales]
- New: New Sales and Purchasing groups in More, each with List and + New, plus a Sales orders list. Where: More. [Sales, Purchasing]
- Fixed: Misc lines become one row, one request, one PO line and one receipt each. Where: Parts ordering and Receiving. [Purchasing]
- New: Set Miscellaneous labor on one estimate line. Where: Estimate → line → Misc labor. [Sales]
- New: Invoices show their linked sales order on the estimate and its vehicles. Where: Estimate page. [Sales]
- New: Excel downloads of each report and an account line's documents. Where: More → Books. [Books]
- New: Type your own vinyl, laminate and premask on graphics jobs. Where: Graphics job → Materials. [Graphics]

## Release 2026.10.30 (Friday, Oct 30, 2026)

- New: After you create a graphics job from an estimate, you land back on the estimate. Where: Estimate → + Graphics job. [Sales, Graphics]
- New: One Save bar pinned at the top of long forms and transactions. Where: Estimates, sales orders, POs and long forms. [Everyone]
- New: AR and AP agings next to NetSuite's. Where: More → Books. [Books]
- New: Own adjustments, Inventory Adjusts checked against NetSuite's and posted from FleetSuite's copy. Where: More → Books. [Books]
- New: Post FleetSuite's own fulfillments, receipts and bills. Where: More → Books. [Books]
- New: Match to a real part shows the best matches first, with Show more. Where: Estimate → Match to a real part. [Sales]
- Fixed: The graphics check on Convert to SO now counts fleet-order graphics jobs. Where: Estimate → Convert to SO. [Sales]
- New: Add parts to a vendor PO that's still open, right from the purchasing queue. Where: More → Purchase Requests. [Purchasing]
- New: Tracking numbers on POs: shown on the PO page, searchable, and jobs link to their PO. Where: Purchase Orders → open a PO. [Purchasing]

## Release 2026.10.29 (Thursday, Oct 29, 2026)

- New: Inventory Adjust button, and stock now comes from NetSuite every 15 minutes. Where: More → Inventory → Adjust. [Purchasing]
- New: Requests: report a problem, ask for a feature or ask a question. FleetSuite AI answers there. Where: More → Requests, or the card at the bottom of Home. [Everyone]
- New: 👀 alerts open the estimate and say who opened it. Where: Bell → 👀 estimate opened. [Sales]
- New: Estimates check labor and freight before they're sent. Where: Estimate → Send. [Sales]
- New: Make several email PDFs at once. If one fails, the real reason shows in red. Where: ✉ Email on estimates, sales orders and invoices. [Sales]
- Fixed: Two part numbers typed into one scan box now split into one line per part. Where: Scan. [Shop]
