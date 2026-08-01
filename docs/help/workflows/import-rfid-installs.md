# Import a spreadsheet of RFID installs

Bulk-load a CNI installer's RFID work from a spreadsheet — VIN plus the
three device IDs off each unit's label (**SN**, **IMEI**, **CCID**) —
and credit it to the installer's company in one pass. Each row becomes an
install record in the **Scan Log**, ready for reporting and invoicing,
exactly as if it had been scanned live.

Use this when an installer emails or hands you a list instead of scanning
in the app.

---

## What the device IDs mean

A Verizon RFID install (part **06CS901033**) captures three numbers off
the unit's label, on top of the vehicle VIN:

- **SN** — the unit's serial number.
- **IMEI** — the 15-digit cellular IMEI.
- **CCID** — the SIM card's ICCID (labeled "CCID", ~18–22 digits).

For the RFID part these are **required and validated** on every row. For a
non-RFID part number, only the VIN is checked.

---

## Where you do it

**More** menu → **Import Installs** (admin only), or go straight to
`/admin/import-installs`.

---

## Step 1 — Prepare the spreadsheet

One row per vehicle, saved as **.xlsx** or **.csv** (`.tsv` and plain
text work too — legacy `.xls` doesn't; re-save it as `.xlsx` first). A
header row is recommended. Column names are flexible — these all work
(case/spacing/punctuation ignored):

| Field | Required | Accepted headers |
|---|---|---|
| VIN | yes | `VIN` |
| SN | yes (RFID) | `SN`, `Serial`, `Serial Number`, `Serial No` |
| IMEI | yes (RFID) | `IMEI` |
| CCID | yes (RFID) | `CCID`, `ICCID`, `SIM`, `SIM ID`, `SIM Number` |
| Year | no | `Year`, `Model Year`, `Yr` |
| Make | no | `Make` |
| Model | no | `Model` |
| Unit # | no | `Unit`, `Unit Number`, `Unit No` |

**No header row?** The importer falls back to reading columns in this
exact order: **VIN, SN, IMEI, CCID, Year, Make, Model, Unit**. It will
warn you it guessed — check the preview before importing.

**A title above the headers is fine.** The importer looks for the header
row within the first few rows, so a sheet that starts with something like
"RFID installs — July" still parses correctly.

---

## Step 2 — Fill in the top form

- **Credit to company \*** — the CNI company that did the work. This is
  stamped on every imported install.
- **Part number \*** — defaults to the Verizon RFID part `06CS901033`.
  Leave it for RFID jobs; change it for a different part.
- **Part description** — defaults to "Verizon RFID Install".
- **Billable customer** — who gets invoiced for this work (optional but
  recommended so the installs are ready to bill).
- **Location** — optional.

---

## Step 3 — Upload the file (or paste)

Drop the spreadsheet file onto the upload box — or click it and pick the
file. It's read and parsed on the spot; no copy-paste needed.

- **Multi-sheet workbooks:** the first sheet with real install data is
  used (a leading "Instructions"/"Notes" sheet is skipped), and the
  status line tells you which sheet it read.
- **Prefer to paste?** The old way still works: copy the cells (including
  the header row) from Excel/Sheets into the paste box and tap **Parse**.
  Tab-separated and comma-separated both work.

Either way you'll get a count: how many rows, how many are **valid**, and
how many **need fixing**.

---

## Step 4 — Review the preview

The preview table shows every row with a **Status** column:

- **ok** — ready to import.
- **fix: …** — lists exactly what's wrong (e.g. `fix: IMEI, CCID`).
  These rows are highlighted and **will not** be imported until fixed.

> **CCID column tip:** keep the CCID column formatted as **text** in
> Excel. If it's numeric, Excel itself rounds off digits past the 15th —
> the file arrives already wrong, and no importer can get them back.

What gets flagged on an RFID import:

- **VIN** — not 11–17 characters / not a valid VIN shape.
- **SN** — fewer than 4 characters.
- **IMEI** — not exactly 15 digits.
- **CCID** — not 18–22 digits.

Fix the data in your spreadsheet and upload it again — the preview
refreshes with the corrected file.

---

## Step 5 — Import

Tap **Import N installs**. You'll confirm, then it loads in batches with
a progress bar. When it finishes you'll see how many were
**imported** and how many were **skipped/failed**, with the reason for
each failure.

---

## Duplicates are skipped automatically

The importer reuses the same guard as live scanning, so re-running a list
is safe:

- Same **VIN + part number** already in the system → skipped.
- Same **IMEI** already logged → skipped.

Skipped rows show up in the failed list with the reason — they don't
create a second record.

---

## What happens after import

Each imported row becomes a **Scan Log** entry credited to the company
you chose, carrying the VIN, the device IDs, and the billable customer.
From there it flows down the normal path — it shows in reporting and is
ready to match a PO and invoice, just like a scanned vehicle.

---

## Tips

- **Year/Make/Model are optional.** Leave them blank if you don't have
  them; only a full 17-character VIN can auto-decode them anyway.
- **Last-8 VINs are fine for billing** but won't auto-fill vehicle
  details — fill Year/Make/Model in yourself if you need them.
- **One company per import.** If a spreadsheet covers more than one
  installer, split it and run each separately.
- **Re-running is safe** — duplicates are skipped, so you can re-import a
  corrected list without doubling anything up.
