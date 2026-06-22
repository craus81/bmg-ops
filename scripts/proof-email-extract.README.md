# Email Graphics-Proof Extractor

`scripts/extract-email-proofs.mjs` pulls graphics proofs — the PDF and
photo-based artwork/mockup files vendors send for sign-off — out of the Gmail
inbox and saves them to a local folder.

## How it authenticates
It reuses the **same Gmail connection the app already uses**: the OAuth refresh
token stored in Supabase `google_tokens` (see `src/lib/google.ts`). As long as
Gmail is connected in BMG Ops (the PO auto-import connection), no extra setup is
needed. It reads these from `.env.local` / `.env`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`

## Usage
```bash
node scripts/extract-email-proofs.mjs --dry-run          # preview, download nothing
node scripts/extract-email-proofs.mjs                    # pull to ./proofs-export
node scripts/extract-email-proofs.mjs --after 2026/01/01 --out ~/proofs
node scripts/extract-email-proofs.mjs --query 'from:wrapmate.com has:attachment'
```

Options: `--query`, `--after`, `--before`, `--out`, `--max`, `--min-bytes`,
`--dry-run` (see the header comment in the script for details).

## What counts as a proof
- **Always kept:** `pdf`, `ai`, `eps`, `psd`, `tif/tiff`, `svg`.
- **Kept if larger than `--min-bytes`** (default 25 KB, to skip signature
  logos / tracking pixels): `jpg/jpeg`, `png`, `gif`, `bmp`, `webp`, `heic`.

## Default search
Tuned to BMG's graphics vendors and proof language, overridable via env without
editing code:

- `PROOF_SUBJECT_KEYWORDS` (default: `proof,proofs,artwork,mockup,rendering,decal,wrap`)
- `PROOF_SENDERS` (default: `nextdoor-graphics.com,wrapmate.com,4over.com`)

The full Gmail query can be replaced outright with `--query`.

## Output
- One subfolder per email: `<date>__<sender>__<msgid8>/`
- Files prefixed with an 8-char content hash so same-named attachments never
  clobber each other.
- `manifest.csv` at the output root (date, from, subject, filename, size, path,
  message id).
- `.proof-export-state.json` tracks what's already been pulled, so re-running is
  incremental.
