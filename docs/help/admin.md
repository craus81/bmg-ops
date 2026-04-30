# Admin

Each section is one task. Read the one you need.

---

## Approve a new user

When someone new signs up, they show up as **Pending**.

1. Go to **Admin → Users**.
2. Find them in the **Pending** section at the top.
3. Tap **Approve**.
4. Pick the role(s) they should have.
5. Tap **Save**.

They can sign in immediately.

---

## Change someone's role

1. **Admin → Users**.
2. Tap the user's row.
3. Check or uncheck the roles in the **Roles** section.
4. Tap **Save**.

---

## Lock someone out

1. **Admin → Users** → tap the user.
2. Tap **Set Status → Denied**.
3. Save.

Set them back to **Approved** to restore.

---

## Give someone access to one extra feature

When someone needs access to a single feature their role doesn't
normally have:

1. **Admin → Users** → tap the user.
2. Scroll to **Feature Overrides**.
3. Toggle the feature **Granted** or **Denied**.
4. Save.

---

## Edit the QC checklist for installs

1. Go to **Admin → Install Checklists**.
2. Pick a template (Upfit, Graphics, or Mixed) — or tap **+ New
   Template**.
3. Add or edit checklist items.
4. Mark items **Required** if they must be checked off before an
   installer can mark a vehicle complete.
5. Tap **Save**.

Changes only apply to **new** jobs. Vehicles already in progress keep
their original checklist.

---

## See every vehicle in the shop right now

1. Go to **In-Shop** in the bottom nav.
2. Each row is a vehicle currently at the shop.
3. Expand a row to see install context, photos, the QC checklist, and
   completion notes.

---

## Mark a vehicle complete on someone's behalf

1. **In-Shop** → expand the vehicle's row.
2. Tap **Run Completion Process**.
3. Step through the modal: confirm checklist, add a completion photo,
   write notes.
4. Tap **Mark Complete**.

---

## Force a vehicle complete (when the system is blocking)

If the gate is wrong (customer waived something, etc.):

1. Open the vehicle's pick-list (`/vehicles/[VIN]/pick-list`).
2. Tap **Force Complete (Admin)**.
3. Type a reason.
4. Confirm.

This is recorded in the audit trail.

---

## Read and reply to customer messages

1. Go to **Admin → Inbox**.
2. Filter tabs: **Unassigned**, **Mine**, **All**, **Archived**, **Unknown**.
3. Tap a thread to open it.
4. Tap **Assign to me** if you're taking it.
5. Type a reply, pick **Email** or **SMS**, tap **Send**.
6. Tap **Archive** when the conversation is done.

---

## Send a customer a message from anywhere

Most pages with a vehicle, estimate, or job have a **💬 Message
Customer** button. Tap it. The thread opens already scoped to the
right context.

---

## Run a NetSuite report

1. Go to **Admin → Reports**.
2. Pick a report (Sales by Customer, etc.).
3. Set date range and filters.
4. Tap **Run**.
5. Tap **Export CSV** if you need the data offline.

---

## Upload a reference document for the AI to use

1. Go to **Admin → Knowledge**.
2. Tap **Upload File**.
3. Drag in the file (PDF, Word, Excel, image).
4. Pick a category and add tags.
5. Tap **Save**.

The AI assistant indexes it within minutes.

---

## Re-sync the help library from the repo

If someone updated the help docs in the repo:

1. Go to **Admin → Knowledge**.
2. Tap **Sync Help Library from Repo (docs/help)**.
3. Confirm.

Everything in the **help** category gets refreshed.

---

## Bulk-upload a list of VINs

1. Go to **Admin → Bulk Upload**.
2. Drag in the CSV (must have a `VIN` column).
3. Review the preview — failed rows show inline errors.
4. Tap **Submit**.

---

## See who's clocked in right now

Add the **Time Clock** widget to your home dashboard, or go to
**Admin → Reports → Time Clock**.

---

## Add or edit a customer

1. From any new estimate, tap **+ Create New Customer** or open an
   existing customer's row.
2. Edit name, billing, ship-to, primary contact.
3. Tap **Save**.

---

## Set up a customer's default install context

1. From any estimate, pick the customer.
2. Tap the **pencil icon** next to the customer name.
3. Fill in delivery instructions, default site contact, notes for ops.
4. Tap **Save**.

These pre-fill on every new estimate and check-in for this customer.
