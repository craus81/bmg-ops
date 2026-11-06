# Shop tech / Field tech

Each section is one task. Read the one you need.

---

## Check in a vehicle that just arrived

1. Tap **Check In** in the bottom nav.
2. Type the VIN (full 17 characters or last 8) and tap **Decode VIN**.
   - The form pre-fills the customer and install instructions if the
     vehicle is on a Sales Order.
3. Take check-in photos: walk-around (4 sides), dash with mileage,
   any pre-existing damage.
4. Review the install instructions. Add anything specific to this
   vehicle.
5. Tap **Save Check-In**.

---

## Check in another vehicle for the same customer

After saving a check-in, tap **Check in another for customer**. The
form keeps the customer loaded so you only have to enter the new VIN.

---

## Clone a recent check-in

If a similar vehicle came in:

1. On the check-in home, scroll to **Recent Check-Ins**.
2. Tap **Clone** on the row you want to copy.
3. Type the new VIN, save.

---

## Look up a vehicle by partial VIN

1. Tap **Scan** in the bottom nav.
2. Type the last 8 characters into the search bar.
3. Matching scans and check-ins show up.

---

## Scan a VIN

1. **Scan** → **Scan VIN**.
2. Point at the VIN barcode.
3. Tap **Confirm**.

Tap **Enter Manually** if decoding fails.

---

## Scan several parts on each vehicle (kit + unit-number decal)

When every truck in a run gets the same kit, but some trucks also get a
part of their own (like a unit-number decal whose part number changes
truck to truck):

1. On **Scan**, pick the customer, then search and tap the kit. You can
   tap more than one part here. Every part you tick is saved on every
   vehicle. Tap **Continue with N parts →**, then pick the location.
2. Scan or type the VIN and the **Unit #**.
3. Under **Extra parts for this vehicle**, type or search the extra part
   number (for example `06S646`) and press Enter or tap **Add**. Add more
   if that truck needs them. Typing `06S646/06S647` adds both. A number
   that isn't in the parts list can still be added as typed.
4. Tap **Log & Scan Next** (or **Log**). FleetSuite saves one line for each
   shift part and one line for each extra part. All of them have the same
   VIN, unit #, stock #, location and crew.
5. The extra parts **stay** for the next truck. Tap **×** on a part to
   remove it, or **Clear** to remove them all, before logging the next
   vehicle.

Each extra line pays the crew that part's own rate from Install Pay Rates.
A part with no rate yet goes to the admin needs-pricing list. Each line
also matches its own PO line. The Verizon RFID part can't be an extra
part. It has to be scanned on its own.

---

## Pull a vehicle into a bay (job timer)

1. On **Home**, tap **Pull In**.
2. Scan the VIN barcode. No good barcode? Tap **Photo of the VIN plate**
   and take one clear photo — the VIN is read for you. You can also type
   the last 6 of the VIN.
3. The vehicle's pick list opens, the job timer starts, and the vehicle
   moves to **In Progress**.
4. Tick anyone else working on it and tap **Add**. They join the timer
   and come off whatever vehicle they were on.

A vehicle that isn't checked in yet goes to check-in first, then
**Pull In & Start Timer**.

**Pausing.** Switching to another task? Tap **⏸ Pause** on the timer —
that takes just you off. **Pause everyone** stops it for the whole crew.
**▶ Resume** (or **▶ Join** while a crewmate's clock runs) starts you
again.

**The clock only counts shop hours:** weekdays 7:00 AM – 3:30 PM, less
11:30 AM – 12:00 PM lunch. Outside those hours it shows *paused* and picks back
up at 7:00 AM on its own. Marking the vehicle **Stuck (Parts)** pauses
it for everyone (tap **▶ Resume** when the parts arrive). It stops for
good when the completion procedure is finished.

---

## Scan a part number arriving at the shop

1. **Scan** → **Scan Part**.
2. Point at the SKU barcode.
3. The part is matched to an open PO and the expected quantity is
   decremented.

---

## See what's in the shop right now

1. Tap **In-Shop** in the bottom nav.
2. Each row is a vehicle currently at the shop.
3. Tap a row to expand and see context, photos, and the QC checklist.

---

## See today's schedule

1. Tap **Schedule** in the bottom nav.
2. The week view shows scheduled installs and deliveries.
3. Tap a slot to see the assigned vehicle and installer.

---

## Clock in / out

1. Tap **Time** in the bottom nav.
2. Tap **Clock In** at start of day.
3. Tap **Start Break** / **End Break** as needed.
4. Tap **Clock Out** at end of day.

---

## Message a coworker

1. Tap **Messages** in the bottom nav.
2. Pick a coworker or thread.
3. Type and send.

This is for crew chat. Customer messages go through the inbox (run by
admin / sales).

---

## Message the customer about a vehicle

1. Open the vehicle in **In-Shop**.
2. Tap **💬 Message Customer**.
3. Type and send.

Replies go to whoever's assigned (usually admin / sales).

---

## Start graphics or upfit on a job

On the In-Shop card, the slim progress bar shows where the job is. Tap it to get the status buttons, then tap the graphics or **Upfit In Progress** button when you start. The job's bar moves to **Install** for everyone.
