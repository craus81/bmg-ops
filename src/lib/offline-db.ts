/**
 * IndexedDB helper for offline FleetSuite data.
 * Stores: parts catalog cache + queued offline scans.
 */

const DB_NAME = 'fleetsuite-offline';
const DB_VERSION = 1;

export interface OfflineScan {
  id: string; // client-generated UUID
  vin: string;
  vehicle_year: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_trim: string;
  body_class: string;
  drive_type: string;
  fuel_type: string;
  gvwr: string;
  part_number: string | null;
  part_display_name: string | null;
  scanned_at: string; // ISO timestamp
  synced: boolean;
}

export interface CachedPart {
  id: string;
  netsuite_id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  catalog: 'upfit' | 'graphics';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('scans')) {
        db.createObjectStore('scans', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('parts')) {
        const store = db.createObjectStore('parts', { keyPath: 'id' });
        store.createIndex('item_number', 'item_number', { unique: false });
        store.createIndex('catalog', 'catalog', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Scans ────────────────────────────────────────────

export async function saveOfflineScan(scan: OfflineScan): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scans', 'readwrite');
    tx.objectStore('scans').put(scan);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingScans(): Promise<OfflineScan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scans', 'readonly');
    const req = tx.objectStore('scans').getAll();
    req.onsuccess = () => {
      const all = req.result as OfflineScan[];
      resolve(all.filter(s => !s.synced));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllOfflineScans(): Promise<OfflineScan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scans', 'readonly');
    const req = tx.objectStore('scans').getAll();
    req.onsuccess = () => resolve(req.result as OfflineScan[]);
    req.onerror = () => reject(req.error);
  });
}

export async function markScanSynced(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scans', 'readwrite');
    const store = tx.objectStore('scans');
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) {
        req.result.synced = true;
        store.put(req.result);
      }
      tx.oncomplete = () => resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSyncedScans(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scans', 'readwrite');
    const store = tx.objectStore('scans');
    const req = store.getAll();
    req.onsuccess = () => {
      const all = req.result as OfflineScan[];
      for (const scan of all) {
        if (scan.synced) store.delete(scan.id);
      }
      tx.oncomplete = () => resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Parts Cache ──────────────────────────────────────

export async function cacheParts(parts: CachedPart[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('parts', 'readwrite');
    const store = tx.objectStore('parts');
    store.clear(); // Replace entire cache
    for (const part of parts) {
      store.put(part);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedParts(catalog?: 'upfit' | 'graphics'): Promise<CachedPart[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('parts', 'readonly');
    const store = tx.objectStore('parts');
    if (catalog) {
      const idx = store.index('catalog');
      const req = idx.getAll(catalog);
      req.onsuccess = () => resolve(req.result as CachedPart[]);
      req.onerror = () => reject(req.error);
    } else {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as CachedPart[]);
      req.onerror = () => reject(req.error);
    }
  });
}

export async function getPartsLastCached(): Promise<string | null> {
  try {
    return localStorage.getItem('fleetsuite-parts-cached-at');
  } catch {
    return null;
  }
}

export async function setPartsLastCached(): Promise<void> {
  try {
    localStorage.setItem('fleetsuite-parts-cached-at', new Date().toISOString());
  } catch {}
}
