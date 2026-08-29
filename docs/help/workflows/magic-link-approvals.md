# Customer approvals (magic links)

How customers approve estimates and proofs without logging in.

---

## Sending an estimate for approval (sales)

1. Open the estimate.
2. Tap **Send to Customer for Approval**.
3. Pick **Email**, **SMS**, or both.
4. Confirm.

The customer gets a link. Valid for 30 days.

**Estimate + proof in one send.** If the estimate has a linked graphics
job with files on it, the compose screen shows an **Include graphic
proofs** picker (the job's newest proof is pre-checked). Checked files
appear in the email, on the approval page, and in the attached PDF —
and when the customer accepts, the proof is **approved for production
at the same time**. No separate proof send, no price surprise after
the design is loved.

---

## Sending a proof for approval (graphics)

1. Open the graphics job.
2. Tap **Send proof for customer approval**.
3. Pick **one** file.
4. Pick a channel.
5. Tap **Send to customer**.

---

## What the customer sees

A clean public page with the estimate or proof. They tap **Accept &
Authorize Work** or **Approve Proof** — or **Request Changes** /
**Request Revision** if something's wrong.

No login. No account.

---

## After they accept

- **Estimate**: flips to **Accepted**. You can now convert it to a
  Sales Order. If the send included graphic proofs, the linked
  graphics jobs are marked customer-approved too — production can run.
- **Proof**: graphics job flips to **Approved**. Production can run.

You're notified either way.

---

## After they reject

- **Estimate**: their reason shows on the estimate. Edit and tap
  **Send to Customer for Approval** again to resend.
- **Proof**: the graphics job flips to **Revision** with their
  comment attached. Designer revises and sends a new proof.

---

## Resending a link

1. Open the estimate or graphics job.
2. Tap **Resend approval link**.
3. Pick a channel.
4. Confirm.

---

## Common issues

- **Link rendered as `http:///approve/…`** — Your `NEXT_PUBLIC_APP_URL`
  environment variable isn't set. Tell your admin to fix in Vercel.
- **"Rate limit exceeded."** — Customer hit reload too many times.
  They wait an hour and try again.
- **Customer says they approved but the job is still pending.** —
  Check if their link expired (over 30 days). Resend.
