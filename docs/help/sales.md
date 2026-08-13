# Sales

Each section is one task. Read the one you need.

For the full story of one job from prospect to ship, see
`full-job-walkthrough.md`.

---

## Add a new client

1. Tap **Customers** in the bottom nav.
2. Tap **+ New** (or **Scan Card** to read a business card with the
   camera).
3. Type the company name and any contact info you have.
4. Tap **Create Customer** — or **Create + Start Estimate** to land
   straight in a new estimate with the client already selected.

Creating a customer also creates them in NetSuite automatically, and
the contact person you typed becomes the record's first contact. More
contacts can be added on the customer's record page under
**Contacts → + Add**.

Already on a customer's record page and need to quote them? Tap
**+ New Estimate** in the header — it opens the estimate builder with
that customer pre-selected.

---

## Mark a customer "Hot"

1. Tap the customer's row in **Customers** to open their record.
2. Tap **Mark Hot** in the header.

The flame icon shows up. Hot customers rise on your dashboard.

---

## Track a deal through the pipeline

Pipeline stages live on **deals**, on the customer's record page:

1. Tap the customer's row in **Customers** to open their record.
2. Under **Deals**, tap **+ Add** and give the deal a title (and a
   value, if you have one).
3. On the deal's row, tap the stage you're at:
   **Lead → Quoted → Negotiating → Won** (or **Lost**).

Stages feed the Sales band on your dashboard. They don't change
anything else in the app.

---

## Build an estimate

1. Tap **Estimates** in the bottom nav.
2. Tap the **+** button.
3. Type the customer's name and pick them from the list.
   - Don't see them? They haven't been entered yet — go to
     **Customers → + New** and use **Create + Start Estimate** (see
     "Add a new client" above), which lands you right back here with
     the new customer selected.
4. Type an **Estimate Title** (anything that makes sense to you).
5. Tap **+ Add Line Item** for each part or labor entry.
   - Search by part number or name to pull from the catalog.
   - For one-off items, pick **Custom Line** and type the description
     and price.
6. Scroll down. Fill in the **Install Instructions** field with
   anything the shop needs to know.
7. Tap **Save Draft**.

You can edit and add more lines any time. The estimate stays a draft
until you send it.

---

## Send an estimate for customer approval

1. Open the saved estimate.
2. Tap **Send to Customer for Approval**.
3. The compose screen opens: check the **To** addresses (pre-filled
   from the customer's primary contact, editable), add a personal
   message if you want, and turn on **Bcc me** to get a copy in your
   own inbox.
4. The preview shows the exact email the customer will receive.
5. Tap **Send**.

The customer gets the estimate document with a **Review & Approve**
link. They click it, see the estimate on a public page, and tap
**Accept & Authorize Work** or **Request Changes**. No login needed.

You get a notification when they respond, and the estimate's status
updates (Sent → Accepted or Rejected).

---

## When you email a customer from FleetSuite

**Does it come from my email?** No — every email the app sends comes
from **BMG Fleet** (`notifications@bmgfleet.com`), so customers see a
consistent company sender. But the email's Reply-To is set to *your*
work email, so when the customer hits Reply, their reply lands in
**your** regular inbox like any other email.

**How do I know it worked?** Three ways:

- Right after sending, the app shows a summary of what actually
  happened — who got the email (and SMS, if used), or the error if a
  send failed.
- The record updates: an estimate flips from **Draft** to **Sent**,
  with the send date stamped on it.
- Turn on **Bcc me** when composing and the exact email that went to
  the customer arrives in your own inbox too.
- Delivery is tracked end-to-end on **every** email the app sends. If
  an email you sent bounces, fails, or gets flagged as spam, you get a
  push notification naming the recipient and the reason — a typo'd
  address can't sit unnoticed. Estimates show their approval email's
  status right in the builder (with a red **✉ Bounced** badge on the
  list), invoice emails show delivery on the Invoices **Sent** tab
  (bounces alert finance), and admins can see every send's status
  under **Admin → System Health → Email delivery**.

**What happens when the customer responds?** Two different paths:

- **They click the button in the email** (approve an estimate or
  proof): the record updates in FleetSuite and you get a notification
  ("New for you" + push) that they accepted or requested changes.
- **They reply to the email**: the reply goes straight to your inbox
  (because Reply-To is you). It does *not* flow back into FleetSuite —
  keep the conversation in email, or use **Message Customer** threads
  if you want it tracked in the app.

---

## Resend an approval link

1. Open the estimate.
2. Tap **Send to Customer for Approval** again — the same compose
   screen opens, so you can fix the address or add a note.
3. Tap **Send**.

A fresh link goes out and **the old links stop working immediately** —
resending rotates the secure link on purpose, so only the newest email
can approve the estimate. If a customer says their link doesn't work,
don't troubleshoot the old email; just resend and have them use the
new one.

---

## Convert an accepted estimate to a Sales Order

After the customer accepts:

1. Open the accepted estimate.
2. Tap **Convert to Sales Order in NetSuite**.
3. Confirm.

The Sales Order number shows up on the estimate page. NetSuite now has
the record. The shop can start ordering parts.

If you see an "unmapped lines" error, tell your admin — they need to
add a placeholder item in NetSuite (one-time setup).

---

## Save customer defaults so estimates auto-fill

1. From any estimate, pick the customer.
2. Tap the **pencil icon** next to the customer's name.
3. Fill in:
   - **Delivery Instructions**
   - **Default Site Contact**
   - **Notes for Ops**
4. Tap **Save**.

Every new estimate or check-in for this customer pre-fills these
fields. You can still override per-estimate.

---

## When a customer isn't in NetSuite yet

There is no separate "convert to customer" step anymore — every record
you create is pushed to NetSuite as a customer automatically, the
moment you create it.

If that automatic push failed, the record shows a **Not in NetSuite
yet** badge. Open the record and tap **Add to NetSuite** to retry.
Clear this before quoting — estimates can't push to NetSuite without
the link.

---

## Message a customer

From most pages with a vehicle or estimate row, tap **💬 Message
Customer**.

1. The thread opens.
2. Type your message.
3. Tap **Send**.

Reply notifications go to whoever's assigned to the thread (usually
you or an admin).
