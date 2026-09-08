/**
 * Completion photos captured while offline (R6-10).
 *
 * The scan queue itself lives in localStorage, which is right for a few
 * KB of JSON. Photos cannot: a single phone photo is 2–5 MB and the whole
 * localStorage quota is about 5 MB, so one picture fills it and every
 * subsequent write — including the SCAN QUEUE ITSELF — starts throwing.
 * Queuing photos there would trade a nice-to-have for the thing the field
 * app exists to do. So photos go to IndexedDB, which is quota-managed in
 * hundreds of MB and stores Blobs without base64 inflation.
 *
 * A queued photo is keyed by the offline scan's LOCAL id. On reconnect
 * the scan is posted first, the server's real scan_log id comes back, and
 * the photos are uploaded against it — scan, then photos, in that order,
 * because a photo has nothing to hang off until the scan row exists.
 */

const DB_NAME = 'bmg-offline-photos';
const DB_VERSION = 1;
const STORE = 'photos';

export interface QueuedPhoto {
  id: string;
  /** The offline scan's local id — the join back to the queued scan. */
  localScanId: string;
  blob: Blob;
  contentType: string;
  capturedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so photos can’t be queued offline.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('localScanId', 'localScanId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the offline photo store'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  }));
}

export async function queuePhoto(localScanId: string, file: Blob): Promise<void> {
  const photo: QueuedPhoto = {
    id: crypto.randomUUID(),
    localScanId,
    blob: file,
    contentType: (file as File).type || 'image/jpeg',
    capturedAt: new Date().toISOString(),
  };
  await tx('readwrite', store => store.add(photo));
}

export async function photosForScan(localScanId: string): Promise<QueuedPhoto[]> {
  const all = await tx<QueuedPhoto[]>('readonly', store => store.getAll() as IDBRequest<QueuedPhoto[]>);
  return all.filter(p => p.localScanId === localScanId);
}

export async function allQueuedPhotos(): Promise<QueuedPhoto[]> {
  return tx<QueuedPhoto[]>('readonly', store => store.getAll() as IDBRequest<QueuedPhoto[]>);
}

export async function deletePhoto(id: string): Promise<void> {
  await tx('readwrite', store => store.delete(id) as unknown as IDBRequest<undefined>);
}

export async function deletePhotosForScan(localScanId: string): Promise<void> {
  const photos = await photosForScan(localScanId);
  for (const p of photos) await deletePhoto(p.id);
}

// ── Pure helpers ──────────────────────────────────────────────────────

/** How many photos are waiting, per queued scan. */
export function countByScan(photos: Pick<QueuedPhoto, 'localScanId'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of photos) out[p.localScanId] = (out[p.localScanId] || 0) + 1;
  return out;
}

/** "3 photos waiting" — the chip on a queued scan. Null when there are none. */
export function waitingNote(count: number): string | null {
  if (!count || count <= 0) return null;
  return `${count} photo${count !== 1 ? 's' : ''} waiting`;
}

/**
 * Photos a scan can no longer be matched to.
 *
 * If a queued scan is synced but its photo upload fails, the photos are
 * left in the store rather than dropped — but once the scan itself is
 * gone from the queue, nothing knows which scan_log they belong to. They
 * are reported so the person can be told, never silently deleted: a photo
 * of a finished install is somebody's evidence.
 */
export function orphanedPhotos(
  photos: Pick<QueuedPhoto, 'id' | 'localScanId'>[],
  queuedScanIds: string[],
): string[] {
  const live = new Set(queuedScanIds);
  return photos.filter(p => !live.has(p.localScanId)).map(p => p.id);
}
