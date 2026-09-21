# Install completion ceremony

What happens at the end of a vehicle's time in the shop. Same flow
whether you're an installer wrapping up or an admin finalizing on
behalf of someone.

---

## Where you do it

Two places, same modal:

- **Installer** — Pick-list → **Mark Complete**.
- **Admin** — In-Shop tab → expand row → **Run Completion Process**.

---

## What the modal asks for

Step by step:

1. **Confirm the QC checklist.** Required items must be checked.
2. **Add at least one completion photo.** Tap **Add Photo**, snap or
   pick.
3. **Type completion notes.** What got done, anything to flag.
4. **Review and tap Mark Complete.**

---

## What the system blocks

You can't mark complete unless:

- At least one completion photo is uploaded.
- Every required QC task is checked.
- The graphics-install lane is also done (if there is a linked
  graphics job).

If anything's missing, the app shows you exactly what. Admins can
override — see below.

---

## What happens when it succeeds

- The vehicle flips to **Complete**.
- The shop team is notified.
- You and the admins get a "tell the customer it's ready" prompt.
  Nothing goes to the customer until someone taps **Email Customer**.
- The vehicle's record locks in the completion photos, notes, and
  who marked it complete.

---

## Admin override

When the gate is wrong — the installer left without photographing it,
the customer waived something, the job is sitting in a stuck status
nobody cleared:

1. Open the completion modal the normal way (In-Shop tab → **Run
   Completion Process**, or the pick-list's **Mark Complete**).
2. Type a completion note saying why you're overriding.
3. Tap **Complete anyway…**. The app lists exactly what's unmet.
4. Tap **Admin override · mark complete anyway**.

Only admins see steps 3 and 4 — for everyone else the button stays
disabled and reads what's still needed. The override is recorded in
the audit trail with the specific gates it bypassed, and the weekly
exceptions digest picks it up.

---

## Editing the QC checklist

Go to **Admin → Install Checklists**. Edit the templates. Changes
apply to **new** jobs only — existing in-progress jobs keep their
original checklist.
