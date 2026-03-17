#!/usr/bin/env python3
"""
BMG Ops — Proof File Sync Script
Runs on Synology NAS via Task Scheduler every 15-30 minutes.

Scans the proof folder, uploads new/updated PDFs to Supabase Storage,
and indexes them in the graphics_proofs table.

Folder structure expected:
  /proofs/CustomerName/VehicleType/proof.pdf   → clean match
  /proofs/CustomerName/proof.pdf               → single vehicle assumed
  /proofs/CustomerName/X/                      → archived, ignored
  /proofs/CustomerName/VehicleType/X/          → archived, ignored

Files that can't be cleanly parsed are flagged as 'needs_review'.

Setup:
  1. pip install requests   (or: pip3 install requests)
  2. Copy .env.sync to the same folder as this script and fill in values
  3. Add to Synology Task Scheduler: python3 /path/to/sync_proofs.py
"""

import os
import sys
import json
import hashlib
import time
import logging
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' module not found. Install with: pip3 install requests")
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
ENV_FILE = SCRIPT_DIR / ".env.sync"
STATE_FILE = SCRIPT_DIR / ".sync_state.json"
LOG_FILE = SCRIPT_DIR / "sync.log"

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("proof-sync")


def load_env():
    """Load config from .env.sync file."""
    config = {}
    if not ENV_FILE.exists():
        log.error(f"Config file not found: {ENV_FILE}")
        log.error("Copy .env.sync.example to .env.sync and fill in values")
        sys.exit(1)

    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                config[key.strip()] = value.strip().strip('"').strip("'")

    required = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "PROOF_FOLDER"]
    for key in required:
        if key not in config:
            log.error(f"Missing required config: {key}")
            sys.exit(1)

    return config


def load_state():
    """Load sync state (tracks what's already been synced)."""
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"synced_files": {}}


def save_state(state):
    """Persist sync state."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def file_hash(filepath):
    """Quick hash: file size + modified time (fast, no full read)."""
    stat = os.stat(filepath)
    return f"{stat.st_size}_{int(stat.st_mtime)}"


def parse_proof_path(filepath, proof_root):
    """
    Parse a file path relative to the proof root into customer + vehicle type.

    Returns: (customer_name, vehicle_type, sync_status)
      - sync_status is 'synced' for clean parses, 'needs_review' for ambiguous
    """
    rel = os.path.relpath(filepath, proof_root)
    parts = Path(rel).parts

    if len(parts) < 2:
        # File sitting directly in proof root — can't determine customer
        return None, None, "needs_review"

    customer_name = parts[0]

    # Check for archive folders (X or x)
    for part in parts[1:]:
        if part.strip().upper() == "X":
            return customer_name, None, "archived"

    if len(parts) == 2:
        # CustomerName/file.pdf — no vehicle subfolder
        return customer_name, None, "synced"

    if len(parts) == 3:
        # CustomerName/VehicleType/file.pdf — clean match
        vehicle_type = parts[1]
        return customer_name, vehicle_type, "synced"

    if len(parts) > 3:
        # Deeply nested — flag for review
        vehicle_type = parts[1]
        return customer_name, vehicle_type, "needs_review"

    return customer_name, None, "needs_review"


def upload_to_supabase_storage(config, filepath, storage_path):
    """Upload a file to Supabase Storage."""
    url = f"{config['SUPABASE_URL']}/storage/v1/object/graphics-proofs/{storage_path}"
    headers = {
        "Authorization": f"Bearer {config['SUPABASE_SERVICE_KEY']}",
        "apikey": config["SUPABASE_SERVICE_KEY"],
        "Content-Type": "application/pdf",
        "x-upsert": "true",
    }

    with open(filepath, "rb") as f:
        resp = requests.post(url, headers=headers, data=f)

    if resp.status_code in (200, 201):
        return True
    else:
        log.error(f"Upload failed ({resp.status_code}): {resp.text[:200]}")
        return False


def upsert_proof_record(config, record):
    """Insert or update a graphics_proofs record via Supabase REST API."""
    url = f"{config['SUPABASE_URL']}/rest/v1/graphics_proofs"
    headers = {
        "Authorization": f"Bearer {config['SUPABASE_SERVICE_KEY']}",
        "apikey": config["SUPABASE_SERVICE_KEY"],
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }

    resp = requests.post(url, headers=headers, json=record)

    if resp.status_code in (200, 201):
        return True
    else:
        log.error(f"DB upsert failed ({resp.status_code}): {resp.text[:200]}")
        return False


def check_existing_by_nas_path(config, nas_path):
    """Check if a proof with this NAS path already exists."""
    url = f"{config['SUPABASE_URL']}/rest/v1/graphics_proofs"
    headers = {
        "Authorization": f"Bearer {config['SUPABASE_SERVICE_KEY']}",
        "apikey": config["SUPABASE_SERVICE_KEY"],
    }
    params = {
        "nas_path": f"eq.{nas_path}",
        "select": "id,nas_modified_at",
        "limit": "1",
    }

    resp = requests.get(url, headers=headers, params=params)
    if resp.status_code == 200:
        data = resp.json()
        return data[0] if data else None
    return None


def sync_proofs():
    """Main sync logic."""
    config = load_env()
    state = load_state()
    proof_root = config["PROOF_FOLDER"]

    if not os.path.isdir(proof_root):
        log.error(f"Proof folder not found: {proof_root}")
        sys.exit(1)

    storage_prefix = config.get("STORAGE_PREFIX", "nas-sync")
    synced_files = state.get("synced_files", {})

    stats = {"scanned": 0, "uploaded": 0, "skipped": 0, "errors": 0, "archived": 0, "flagged": 0}

    log.info(f"Starting proof sync from: {proof_root}")

    for root, dirs, files in os.walk(proof_root):
        for filename in files:
            filepath = os.path.join(root, filename)

            # Only sync PDFs
            if not filename.lower().endswith(".pdf"):
                continue

            # Skip hidden files and temp files
            if filename.startswith(".") or filename.startswith("~"):
                continue

            stats["scanned"] += 1
            current_hash = file_hash(filepath)
            nas_path = os.path.relpath(filepath, proof_root)

            # Check if already synced with same hash
            if nas_path in synced_files and synced_files[nas_path] == current_hash:
                stats["skipped"] += 1
                continue

            # Parse the path
            customer_name, vehicle_type, sync_status = parse_proof_path(filepath, proof_root)

            if sync_status == "archived":
                stats["archived"] += 1
                synced_files[nas_path] = current_hash
                continue

            log.info(f"Syncing: {nas_path} → customer={customer_name}, vehicle={vehicle_type}, status={sync_status}")

            # Build storage path: nas-sync/CustomerName/filename.pdf
            safe_customer = (customer_name or "unknown").replace("/", "_").replace("\\", "_")
            safe_vehicle = (vehicle_type or "general").replace("/", "_").replace("\\", "_")
            storage_path = f"{storage_prefix}/{safe_customer}/{safe_vehicle}/{filename}"

            # Upload to Supabase Storage
            if not upload_to_supabase_storage(config, filepath, storage_path):
                stats["errors"] += 1
                continue

            # Get file modified time
            file_stat = os.stat(filepath)
            modified_at = datetime.fromtimestamp(file_stat.st_mtime, tz=timezone.utc).isoformat()
            now = datetime.now(timezone.utc).isoformat()

            # Check if record exists
            existing = check_existing_by_nas_path(config, nas_path)

            if existing:
                # Update existing record
                update_url = f"{config['SUPABASE_URL']}/rest/v1/graphics_proofs?id=eq.{existing['id']}"
                headers = {
                    "Authorization": f"Bearer {config['SUPABASE_SERVICE_KEY']}",
                    "apikey": config["SUPABASE_SERVICE_KEY"],
                    "Content-Type": "application/json",
                }
                update_data = {
                    "storage_path": storage_path,
                    "file_size": file_stat.st_size,
                    "nas_modified_at": modified_at,
                    "last_synced_at": now,
                }
                resp = requests.patch(update_url, headers=headers, json=update_data)
                if resp.status_code not in (200, 204):
                    log.error(f"Update failed for {nas_path}: {resp.text[:200]}")
                    stats["errors"] += 1
                    continue
            else:
                # Insert new record
                record = {
                    "customer_name": customer_name or "Unknown",
                    "vehicle_type": vehicle_type,
                    "file_name": filename,
                    "storage_path": storage_path,
                    "file_size": file_stat.st_size,
                    "file_type": "application/pdf",
                    "nas_path": nas_path,
                    "nas_modified_at": modified_at,
                    "last_synced_at": now,
                    "sync_status": sync_status,
                }

                if not upsert_proof_record(config, record):
                    stats["errors"] += 1
                    continue

            synced_files[nas_path] = current_hash
            stats["uploaded"] += 1
            if sync_status == "needs_review":
                stats["flagged"] += 1

    # Save state
    state["synced_files"] = synced_files
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    log.info(
        f"Sync complete: {stats['scanned']} scanned, {stats['uploaded']} uploaded, "
        f"{stats['skipped']} skipped, {stats['archived']} archived, "
        f"{stats['flagged']} flagged for review, {stats['errors']} errors"
    )


if __name__ == "__main__":
    try:
        sync_proofs()
    except Exception as e:
        log.error(f"Sync failed with error: {e}", exc_info=True)
        sys.exit(1)
