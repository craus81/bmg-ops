# FleetSuite Inventory — How It Works

A practical guide to the parts process: from "we sold an upfit" to "the
vehicle is scheduled, the parts are on the shelf with its name on them,
and the vendor's bill is in NetSuite."

## The big picture

```
Sales order (NetSuite)
   └─► Upfit project (FleetSuite) — linked by SO number
          └─► Parts Readiness: needed vs available vs on order
                 ├─► Vendor POs sync from NetSuite (every 2 hours)
                 ├─► ETAs arrive from vendor emails (hourly scan)
                 └─► Reserve parts to the job (allocation)
                        └─► Verdict: READY → set drop-off date
                               └─► In-Shop arrival schedule → vehicle arrives → Check-In
                                      └─► Job completed → parts consumed
Invoice email from vendor ──► PDF captured ──► one-click NetSuite bill
```

## Where everything lives

| Screen | What it's for |
|---|---|
| **Upfit** (tab) | One project per job. Key dates, linked SO, Parts Readiness card, notes. |
| **More → Inventory** | Every part at a glance: on hand · allocated · free · on order. |
| **More → Parts Mail** | What the email scanner found: ETAs applied, invoices captured, review queue. |
| **In-Shop** (tab) | Arrival schedule + calendar up top, Check-In, and every vehicle in the shop. |
| **More → System Health** | Confirms the background syncs are alive. |

---

## Step 1 — Set up the project

1. On the **Upfit** tab, open (or create) the project.
2. In **Pull from NetSuite**, type the SO number (e.g. `SO12345`) and hit
   **Link**. This is what powers the parts math — no SO link, no
   readiness card.
3. Fill in **Key Dates** as you learn them. Whoever talks to the customer
   sets **Customer Drop-off** and **Needs It Back** — those two dates put
   the vehicle on the In-Shop arrival schedule automatically.

## Step 2 — Read the Parts Readiness card

The card lists every part on the SO with five numbers:

| Column | Meaning |
|---|---|
| **Need** | Quantity the sales order calls for. |
| **Res.** | Reserved for *this* job. Click the number to change it. |
| **Free** | Stock left after **every** job's reservations. |
| **On Order** | Still coming on open vendor POs (with PO #, vendor, ETA chips). |
| **Status** | The verdict for that part — see below. |

Part status, best to worst:

- 🟢 **Reserved** — held for this job. Nobody else can count these.
- 🟢 **Available** — enough free stock exists *right now*, but it isn't
  reserved yet. Another job could claim it first.
- 🔵 **On order** — not enough free stock, but open POs cover the gap.
  The chip shows the ETA when we have one.
- 🔴 **Short** — not in stock and not on order. Someone needs to buy it.

The banner at the top rolls those up into one verdict for the whole job:

- ✅ **All parts reserved — ready to schedule**
- ✅ **All parts available — reserve them so another job can't claim them**
- ⏳ **Waiting on parts already on order** (shows the latest ETA — the
  earliest realistic drop-off date)
- ❌ **N parts not in stock or on order — don't schedule yet**

Numbers refresh live when you open the project or hit **Refresh**.

## Step 3 — Reserve the parts

**When a job is real and its parts are available, reserve them.** That's
the whole discipline. Reservation is what stops two jobs from counting
the same shelf stock.

- **Reserve available** (card header) grabs everything free that the job
  still needs, in one click.
- Click any **Res.** number to set an exact quantity (0 releases it).
  FleetSuite caps you at what's genuinely free — you can't reserve
  phantom stock.
- **Release all** frees everything back to the pool (e.g. the job slips
  a month and another job needs the shelf).
- You never have to clean up: **completing** a project marks its parts
  consumed; **cancelling** releases them automatically.

## Step 4 — Parts on order and ETAs

- **Vendor POs sync from NetSuite every 2 hours** — every PO to every
  parts vendor (Ranger, Masterack, Legend, Meyer, Buyers, …), matched to
  jobs purely by **part number**, so it doesn't matter that POs aren't
  linked to SOs in NetSuite.
- **ETAs fill in automatically from email.** An hourly scan reads the
  watched mailboxes for order confirmations and ship notices, extracts
  the PO number + dates + tracking, and writes the ETA onto the PO — and
  onto any project that references that PO number.
- **Someone should glance at More → Parts Mail every day or two.** Emails
  the scanner couldn't match land in **Needs Review** — type the PO
  number and hit **Link & Apply**, or **Dismiss**. Admins can edit the
  watched-mailbox list and hit **Scan Now** there too.
- No email? Set **Parts ETA** by hand in the project's Key Dates.

## Step 5 — Schedule the vehicle

1. Wait for the verdict to reach ✅ (or ⏳ with an ETA you trust).
2. Agree on a date with the customer and set **Customer Drop-off** (and
   **Needs It Back**) on the project.
3. The vehicle appears in the **Arriving** section at the top of
   In-Shop — list and calendar views — automatically. Graphics-install jobs marked
   **O'Fallon Shop** show up the same way.
4. When it rolls in: **Arrived ✓** in the Arriving list, then run the
   normal **Check-In** (photos, condition, the works — every vehicle goes
   through it).

## Step 6 — Invoices become NetSuite bills

- When a vendor emails an invoice, the scanner saves the PDF and lists it
  under **Vendor Invoices** on the Parts Mail page with the extracted
  invoice #, date, and total.
- If it isn't linked to a PO yet, type the PO number → **Link PO**.
- **Create NetSuite Bill** (admin/finance only) turns the PO into a
  vendor bill — vendor, items, and amounts carry over from the PO, and
  the vendor's invoice number becomes the bill's Reference No. It always
  asks before posting; nothing financial is ever automatic.

## The Inventory page (More → Inventory)

One row per part that has stock, reservations, or an open PO:

- **On Hand** — physical count per NetSuite.
- **Avail** — on hand minus NetSuite-side commitments.
- **Allocated** — reserved to jobs in FleetSuite; green chips name the
  jobs (`3 → Anderson build`).
- **Free** — Avail minus Allocated. What a new job could actually take.
- **On Order** — blue chips show quantity, PO, vendor, and ETA.

Use the search box and the **Allocated** / **On Order** filters.

## Who does what

| Person | Habit |
|---|---|
| **Salesperson / whoever owns the customer** | Link the SO on the project; set drop-off + need-back dates. |
| **Whoever orders parts** | Watch for 🔴 Short parts; place the vendor PO in NetSuite as usual — it syncs in. |
| **Shop lead** | Reserve parts when a job is real; run the day from In-Shop's arrival schedule and readiness verdicts. |
| **Everyone** | Glance at Parts Mail's review queue every day or two. |
| **Finance / admin** | Create bills from captured invoices; keep an eye on System Health. |

## Gotchas

- **On-hand numbers come from NetSuite** (synced every 2 hours; the
  readiness card also checks live when opened). Until the QBO move,
  NetSuite is still the master for physical counts — FleetSuite is the
  master for *who the parts are for*.
- **"Available" already nets out NetSuite commitments.** If a NetSuite SO
  commits inventory *and* you reserve in FleetSuite, the math leans
  conservative — it will never tell two jobs they can both have the last
  unit, which is the failure mode that hurts.
- **Reserving is first-come.** "Available" on the card means available
  *right now* — if scheduling matters, reserve at the moment the job is
  confirmed, not the day before drop-off.
- **The email scan reads only the watched mailboxes** (edit the list on
  Parts Mail) and only acts on what it can match confidently — anything
  fuzzy waits in the review queue rather than guessing.
