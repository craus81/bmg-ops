# Customer guide

The **customer** role is for fleet customers who log in to see their
own jobs and approve estimates / proofs. The header brands as
**Fleet GO** and the customer dashboard is the only page you see.

Default features (`ROLE_DEFAULT_FEATURES.customer`): home only.

Most customer interactions don't require login at all — magic-link
approvals work without an account. This guide covers both flows.

## How do I see all my active jobs?

If you have a customer account:

1. Sign in with your work email and the magic link.
2. The dashboard at `/customer/dashboard` shows every active job for
   your company:
   - Vehicles currently in the shop (with current status).
   - Graphics jobs in production or awaiting approval.
   - Recent invoices.

If you don't have a customer account, ping your BMG sales rep — they
can create one for your team.

## How do I approve an estimate? (no login needed)

When BMG sends an estimate for approval, you'll get an email (and SMS,
if your phone is on file and SMS is enabled) with a magic link.

1. Click the magic link in the email.
2. The estimate opens in your browser. No login required.
3. Review the line items, total, and install instructions.
4. Check the **I authorize this work** checkbox.
5. Click **Accept & Authorize Work**.

That's it. The link captures your IP, browser, and how long you spent
on the page for the audit trail. An immutable HTML snapshot of the
estimate is stored as a signed PDF-like record. BMG gets notified
immediately and starts production.

If something needs to change, click **Request Changes** instead and
write what you'd like adjusted. BMG will revise and resend.

## How do I approve a graphics proof? (no login needed)

When the proof is ready, you get an email with a magic link.

1. Click the link.
2. The proof opens with the file embedded inline (or a download button
   for PDFs).
3. Review carefully — colors, logo placement, text spelling, vehicle
   coverage.
4. Check the **I approve this proof** checkbox.
5. Click **Approve Proof**.

If something's wrong, click **Request Revision** and write what's off.
BMG will revise and send a new proof.

Once approved, the proof file is locked into BMG's records and
production runs from that file.

## My approval link expired. What now?

Magic links last 30 days. If yours has expired:

1. Reply to the email it came from, or call BMG.
2. They'll resend a fresh link.
3. Click the new link.

The old link no longer works once a new one is issued, but if it's
still within 30 days you can also try the old link first.

## I clicked the link but it says "stale" or won't load.

A few things to try:

1. Make sure you're using the most recent email if BMG sent multiple
   reminders.
2. Check your spam folder for newer emails.
3. Forward the link to your computer browser if the mobile email app
   is mishandling it.
4. If still stuck, reply to the email — BMG will resend.

## Can I see all the proofs / estimates BMG has sent me?

Currently, no — there's no portal that lists every approval link sent
to you. You have to keep the emails.

If you want a single dashboard, BMG can create a customer account for
you (above). That dashboard shows your active jobs but not the full
history of approval links.

## How do I message BMG about a job?

Two options:

1. **Reply to any BMG email**. The reply goes into BMG's unified inbox
   tagged to the right job.
2. **Text BMG's main number**. Same — your text goes into the inbox
   and the right person gets paged.

If your phone number is already in BMG's system, your text auto-routes
to the right thread. If not, BMG creates an "unknown contact" thread
and matches you up later.

## What does each job status mean?

For graphics jobs:
- **new** — Job created, no proof yet.
- **proof_pending** — Proof sent to you for approval.
- **approved** — You approved; BMG hasn't started production yet.
- **revision** — You requested changes; BMG is revising.
- **in_production** — BMG is cutting / printing your graphics.
- **ready_to_pickup** — Done, waiting for you to pick up.
- **shipped** — Shipped to your install location.
- **installed** — Installed on the vehicle.

For vehicles in the shop:
- **received** — Vehicle has arrived and been checked in.
- **in_progress** — Work is happening.
- **complete** — Done, ready for you.

## I want to add another vehicle to a quote. What do I do?

Reply to the original quote email or text BMG. They'll add it to the
estimate and resend for approval.

## How do I download an approved proof or signed estimate?

After you approve, BMG retains an immutable signed copy. To get it
yourself, ask BMG — they'll send the PDF.

The signed copies live in a private storage bucket and aren't directly
downloadable from the customer dashboard. (This may change in a future
release; for now it's a manual ask.)

## What if I'm not sure I'm the right person to approve?

If the email got forwarded to you and you don't have authority to
authorize work / approve graphics:

1. **Don't click Accept**. The audit trail records you as the
   approver.
2. Forward to whoever does have authority. The link still works for
   them.
3. Optional: reply to BMG and let them know who you forwarded to so
   they have a paper trail too.
