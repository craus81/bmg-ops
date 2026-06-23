# Proof Sync Script — Synology NAS Setup

## What it does
Scans the proof folder on your NAS every 15-30 minutes, uploads new/changed PDFs to Supabase Storage, and indexes them in BMG Ops so proofs surface automatically when a vehicle checks in.

## Setup

### 1. Install Python dependency
SSH into your Synology or open the Terminal in DSM:
```bash
pip3 install requests
```
If `pip3` isn't available, install Python 3 from Package Center first.

### 2. Configure
```bash
cp .env.sync.example .env.sync
nano .env.sync
```
Fill in:
- `SUPABASE_SERVICE_KEY` — your Supabase **service role** key (Dashboard → Settings → API)
- `PROOF_FOLDER` — absolute path to the proof root folder (e.g., `/volume1/proofs`)

### 3. Test manually
```bash
python3 /path/to/sync_proofs.py
```
Check `sync.log` in the same folder for output.

### 4. Schedule in Synology Task Scheduler
1. Open DSM → Control Panel → Task Scheduler
2. Create → Scheduled Task → User-defined Script
3. Schedule: every 15 or 30 minutes
4. Command: `python3 /volume1/scripts/proof-sync/sync_proofs.py`
5. Run as: root (or a user with read access to the proof folder)

## Folder structure
The script expects this layout:
```
/proofs/
  CustomerName/
    VehicleType/
      proof.pdf          ← synced, matched to customer + vehicle type
    proof.pdf            ← synced, vehicle type unknown
    X/                   ← archived, ignored entirely
    VehicleType/X/       ← archived, ignored entirely
```

Files that can't be cleanly parsed are flagged as "needs review" in the `graphics_proofs` table for manual follow-up.

## Files
- `sync_proofs.py` — main sync script
- `.env.sync` — your config (not committed to git)
- `.sync_state.json` — auto-generated, tracks what's been synced
- `sync.log` — log output from each run
