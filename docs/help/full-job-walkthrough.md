# A full job, start to finish

This is the plain-English walkthrough of one job from "I just met a
prospect" to "the truck is back on the road with the upfit installed
and graphics applied." It follows a fictional customer — **Acme
Plumbing** — who wants 8 service vans upfitted (shelving, partitions,
lighting) and wrapped (logo, phone number, license info).

If you only read one help doc, read this one. The role-specific docs
(`admin.md`, `sales.md`, etc.) go deeper on individual buttons and
edge cases — this one ties everything together.

---

## Step 1 — You meet the prospect

You're at the chamber of commerce mixer. You meet Sara, the operations
manager at Acme Plumbing. She mentions they just bought 8 new Transit
vans and need them set up for plumbers — shelves inside, the company
logo and phone number on the outside. You exchange business cards.

**What to do back at the office:**

1. Open BMG Fleet on your laptop and click **Customers** in the bottom nav
   (or go to `/admin/prospects`).
2. Click **+ New** to add the client — or **Scan Card** and let it read
   Sara's business card for you.
3. Fill in:
   - **Company**: Acme Plumbing
   - **Contact**: Sara's name, email, and phone (prefilled if you
     scanned the card)
   - **Notes**: "Met Sara at chamber mixer 4/30. 8 new Transit vans,
     plumber upfit + wrap. Sounded ready to move."
4. Click **Create Customer** — or **Create + Start Estimate** if you
   want to start quoting on the spot. Either way the customer is also
   created in NetSuite automatically.
5. The record page opens, with Sara already saved under **Contacts**
   (add more people there with **+ Add**).
6. (Optional) Click **Mark Hot** if she's high priority — that raises
   this customer on your dashboard.

You've now got Acme Plumbing tracked. The **Sales Pipeline** widget on
your home dashboard counts them in your open lead count.

---

## Step 2 — You qualify the lead

You give Sara a call to learn more. She tells you:
- 8 vans, all 2024 Ford Transit 250 mid-roof
- Plumber package: ladder rack, 3-drawer cabinet, partition, interior
  LED lights
- Wrap: full color, logo on hood and both sides, phone + license #
  along the lower body, "Acme Plumbing" on the rear doors

**What to do:**

1. Open the Acme Plumbing prospect at `/admin/prospects`.
2. Click the **+ Add** button under **Opportunities**.
3. Pick stage **Quoted** (or **Lead** for now if you haven't quoted).
4. Add a note describing what they need.
5. Save.

This isn't strictly required but it gives the pipeline a way to track
deal value as you move through stages.

---

## Step 3 — You build the upfit estimate

Go to the **Estimates** tab in the bottom nav (or `/estimates`).

1. Click the big **+** to start a **New Estimate**.
2. **Estimate Title**: "Acme Plumbing — 8 Transit upfit + wrap"
3. **Customer**: Type "Acme" — if Acme is already in your customer list
   (synced from NetSuite), pick them. If they're new, click **+ Create
   New Customer**, fill in name + billing address, and save. They'll
   sync to NetSuite later.
4. **Line items** — click **+ Add Line Item** for each thing you're
   selling. For Acme that's:
   - Ladder rack — qty 8
   - 3-drawer cabinet — qty 8
   - Partition kit — qty 8
   - Interior LED kit — qty 8
   - Labor (upfit) — qty 8
   - Wrap design fee — qty 1
   - Wrap install — qty 8
   - Wrap material — qty 8
   For each, search the catalog by part number or name. If something
   isn't in the catalog yet (custom labor, a specialty bracket), pick
   **Custom Line** and type the description and price.
5. **Install instructions** — scroll down. You'll see fields pre-filled
   from Acme's customer profile if you've set defaults. Add anything
   specific to this batch: "Wraps need to clear the new logo legal
   review before printing — Sara will provide PDF Mon."
6. Click **Save Draft**.

**Why custom lines are different**: catalog items get pushed into
NetSuite cleanly. Custom lines (anything not in your catalog) all roll
up under one item in NetSuite called **FS-CUSTOM** with the
description carrying the actual content. Your admin needs to have
created that FS-CUSTOM item in NetSuite — if not, the push to NetSuite
later will fail. Ask if you're not sure.

**Pro tip**: You don't have to build everything in one estimate. Some
shops build the upfit portion as one estimate and the graphics as a
second. It works either way. The advantage of one estimate: customer
sees one approval link. Advantage of two: graphics can move through
production while upfit parts are still being ordered.

---

## Step 4 — You send the estimate to the customer

1. Open the saved estimate.
2. Click **Send to Customer for Approval**.
3. Pick a delivery channel:
   - **Email** (default — works today)
   - **SMS** (only if your shop has SMS turned on)
   - You can pick both.
4. Confirm.

Sara gets an email with a button to view the estimate. She doesn't
need a login. She clicks the button, sees the estimate on a clean
public page, reviews it, checks the **I authorize this work** box,
and clicks **Accept & Authorize Work**.

You get an email saying she accepted.

If she clicks **Request Changes** instead, she types what she wants
adjusted, and you get an email with her note. You revise the estimate
and click **Send to Customer for Approval** again — that resends a
fresh link.

The link is good for 30 days. If she sits on it for over a month, the
link expires and you'll need to resend.

---

## Step 5 — You convert the estimate to a Sales Order

Sara's accepted. Now we need a Sales Order in NetSuite so accounting
has a record.

1. Open the (now accepted) estimate.
2. Click **Convert to Sales Order in NetSuite**.
3. Confirm.

This pushes everything to NetSuite. Catalog items map to their real
NetSuite items; custom lines route through FS-CUSTOM. The install
instructions you typed in Step 3 go into the Sales Order memo — that
way the shop floor sees them later when the trucks arrive.

If the push fails with an "unmapped lines" error, your admin needs to
create the FS-CUSTOM item in NetSuite. Tell them.

You'll see the new SO number on the estimate page.

---

## Step 6 — Graphics work starts in parallel

Even before Acme's vans arrive at the shop, your graphics team can
start designing. Whoever's running graphics goes to **Graphics** in
the bottom nav (or `/graphics`).

If a graphics job hasn't already been auto-created from the estimate,
they create one:

1. Click **+ New Graphics Job**.
2. Pick the customer (Acme Plumbing) and the vehicles.
3. Pick the job type: **Production** (full production: design → proof
   → print → install).
4. Save.

The job appears in the queue. The designer uploads working files (the
mockups they're iterating on) under **Proofs / Working Files** on the
job page. They can upload as many as they want.

When they have a final mockup ready for Sara to approve:

1. Open the graphics job.
2. Click **Send proof for customer approval**.
3. The file picker appears — pick the **one** file Sara should see
   (don't dump every working file on her).
4. Pick channel: email / SMS / both.
5. Click **Send to customer**.

Sara gets an email with a magic link to a public page that shows the
single proof file. She approves or requests revision. If she
approves, the file is locked into your records as the official proof.
If she requests revision, the designer iterates and sends a new proof.

This loop continues until Sara approves. Then graphics flips the job
to **In Production** and starts printing/cutting.

---

## Step 7 — The vans arrive at the shop

Two weeks later, Acme delivers all 8 vans on a flatbed. The shop tech
(or whoever's at the door) does the check-in.

For each van:

1. Open BMG Fleet on a phone or tablet. Tap **Check In** in the bottom
   nav (or `/fleet`).
2. **VIN** — scan the VIN barcode (windshield or door jamb), or type
   the last 8 characters and the system finds the rest. Tap **Decode
   VIN**.
3. The next screen pre-fills the customer (Acme Plumbing) and the
   install instructions from the SO memo. Review and adjust if needed.
4. Take check-in photos: walk-around (4 sides), dash with mileage, any
   pre-existing damage. Tap **Add Photo** for each.
5. Tap **Save Check-in**.
6. After save, tap **Check in another for customer** to keep Acme
   loaded for the next van. Repeat for vans 2–8.

Each van now shows up on the shop's **In-Shop** page at `/tracking` as
**Received**.

---

## Step 8 — Installers do the upfit work

Whoever's installing opens BMG Fleet on their phone. They go to the
shop's queue or scan the VIN of the van they're starting on. The app
opens the **pick-list** for that van — that's a single page with
everything they need:

- Install instructions (Sara's notes from the estimate, in a blue box
  at the top)
- The graphics proof Sara approved (so they can sanity-check the
  layout)
- The QC checklist (every required step for this type of upfit)
- Photo timeline (check-in photos for reference)
- Buttons to add their own progress photos and a final completion
  photo
- A **Mark Complete** button at the bottom

As they work, they tap items off the QC checklist:
- ☑ Ladder rack mounted, torqued
- ☑ Cabinet bolted to floor anchors
- ☑ Partition installed
- ☑ Interior lights wired and tested
- ☑ Customer logo placement verified against proof

Required items have a red asterisk — those have to be checked before
**Mark Complete** is allowed.

When the upfit is done, they:
1. Take a final completion photo (whole van, doors closed, looking
   clean).
2. Type a quick **Completion Notes** entry: "Lights tested, all
   drawers slide smooth, partition flush. Ready for graphics."
3. Tap **Mark Complete**.

If anything's missing — no completion photo, a required QC item not
checked — the app refuses and tells them what's missing. Once
everything's green, the van flips to **Complete**.

This is the **upfit completion ceremony**. It auto-fires:
- A notification to the shop team
- An email/SMS to Sara saying upfit is done

---

## Step 9 — Graphics get installed

Now graphics needs to apply the wrap. Two paths depending on how your
shop runs:

**If graphics gets installed in your shop**: the graphics team comes
to the upfit bay and applies the wrap. When done, they go back to the
graphics job at `/graphics` and flip it to **Installed**.

**If the wrap was already produced and shipped to a wrap shop
elsewhere**: the graphics team marks the job **Shipped** when it
leaves your shop. The wrap installer at the destination handles the
application separately.

Either way, the graphics job has its own status it walks through. The
in-shop tracking page (`/tracking`) shows both lanes for each van —
the upfit lane and the graphics install lane. **The van isn't fully
done until both lanes are green.**

This is enforced. If you try to ship a van whose graphics install lane
is still incomplete, the system blocks you. Admins can force-override
in a pinch (and it's audited), but normally everyone waits for both.

---

## Step 10 — Both lanes green: the van is shipped

When upfit is done **and** graphics is done, the van is ready to go
back to Acme.

1. Whoever's coordinating delivery opens `/tracking`, expands the
   van's row.
2. They confirm both lanes are green.
3. They coordinate pickup with Sara — usually a phone call or a
   message via the **Message Customer** button on the row (sends
   directly into your inbox, replies route back to whoever's
   assigned).
4. When Sara picks up the van (or when your driver delivers it),
   that's it. The van is back in service.

Repeat steps 7–10 for each of the 8 vans. They don't all have to be
in lockstep — typically a couple are in upfit while another couple
are getting graphics applied.

---

## Step 11 — You invoice Acme

The Sales Order in NetSuite is the financial record. Once all 8 vans
are complete, your admin (or whoever runs accounting) creates the
invoice in NetSuite against the SO.

If part of the work was graphics-only (e.g., Acme has a separate
order for replacement decals on existing vans), there's a faster
path: when graphics flips a job to **Shipped**, certain people
(typically the owner + accounting) get a bell notification with a
**Create Invoice** action. Clicking it opens a window to invoice the
graphics work directly without going through a Sales Order. That's
useful for one-off jobs but not the main flow for combined upfit +
graphics work like Acme.

---

## Who does what — quick reference

| Step | Who | Page |
| --- | --- | --- |
| 1. Add prospect | Sales | `/admin/prospects` |
| 2. Qualify lead | Sales | `/admin/prospects` |
| 3. Build estimate | Sales | `/estimates` |
| 4. Send for approval | Sales | `/estimates` |
| 5. Convert to SO | Sales | `/estimates` |
| 6. Graphics design + proof | Graphics | `/graphics` |
| 7. Check in arrived vehicles | Shop tech | `/fleet` |
| 8. Upfit work + complete | Installer | pick-list (`/vehicles/[VIN]/pick-list`) |
| 9. Graphics install | Graphics | `/graphics` |
| 10. Confirm both lanes done | Admin / coordinator | `/tracking` |
| 11. Invoice | Admin / accounting | NetSuite (or `/graphics` for direct) |

---

## What can go wrong (and how to recover)

**Sara never opens the estimate email.**
Open the estimate and click **Resend approval link**. Try SMS too if
you have it. Or just call her — sometimes an email gets buried.

**Sara approves but you can't push to NetSuite — "unmapped lines".**
You have a custom line item and the **FS-CUSTOM** placeholder item
doesn't exist in NetSuite. Your admin needs to create it once.

**Sara wants to add 2 more vans after she's already approved.**
Open the estimate, add the line items, save, click **Send to Customer
for Approval** again. She gets a fresh link and re-approves.

**The graphics proof comes back rejected with "logo too small on the
hood."** Designer revises the file, uploads the new version, picks
the new file with **Send proof**, sends a fresh approval link. Sara
approves the new version.

**A van arrives and the VIN doesn't match what's on the SO.**
Check in the van anyway with the actual VIN. The pick-list will pull
install context from the customer's defaults if the SO doesn't
match. Make a note in the check-in form.

**Installer hits Mark Complete and gets blocked because of a missing
QC item.** Either complete the item or, if it genuinely doesn't apply
(e.g., the van didn't get the partition because the customer waived
it), an admin can use **Force Complete (Admin)** on the pick-list.
That records who forced it and why.

**Shop calls saying graphics aren't ready when installer is.** Check
the graphics job at `/graphics`. If it's still in **Proofing** or
**In Production**, graphics isn't ready yet — message the customer
through the inbox to update them on timing.

**Sara wants a copy of the signed estimate.** Right now that's a
manual ask — your admin can pull the signed PDF from your records
and email it to her. (The signed copy is stored automatically every
time a customer accepts; you just don't have a self-serve download
button yet.)

---

## How long the whole thing takes (rough)

A clean Acme-Plumbing-style job (8 vans, upfit + wrap) typically
runs:

- Day 0: prospect entered
- Day 1–3: estimate built and sent
- Day 3–7: customer approves (often slower if their accounting has
  to sign off)
- Day 7: SO pushed, graphics design starts
- Day 7–14: graphics proof loop with customer
- Day 14: vans arrive at shop, check-in
- Day 14–21: upfit + graphics install across all 8 vans
- Day 21: vans back to Acme
- Day 22: invoice goes out

Real timelines vary wildly based on parts availability, customer
responsiveness, and how busy the shop is. The app doesn't try to
enforce a schedule — it just makes sure nothing slips through the
cracks.
