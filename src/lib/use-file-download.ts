'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { fileNameFromDisposition, saveFile } from '@/lib/native-files';

interface Fetched {
  url: string;
  blob: Blob;
  name: string;
}

/**
 * A button that downloads a file a route makes (Books' Excel downloads) or
 * links to (a backup of the books, kept in BMG's file storage): fetch it
 * with the session, then hand it over with saveFile, a download on
 * a computer and the share sheet in the iPhone app. Safari opens the share
 * sheet only straight after a tap, and a file that took a while to make
 * arrives too late for it, so then the file waits and `ready` asks for one
 * more tap, as Completion Photos does. Errors go to `onError`, in the
 * page's own words around the route's.
 */
export function useFileDownload(onError: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Fetched | null>(null);

  const hand = useCallback(async (file: Fetched) => {
    try {
      await saveFile(file.blob, file.name);
      setWaiting(null);
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') throw e;
      setWaiting(file);
    }
  }, []);

  const download = useCallback(async (url: string, fallbackName: string) => {
    try {
      // The file already made for this tap's button, waiting for a fresh tap.
      if (waiting?.url === url) {
        await hand(waiting);
        return;
      }
      setBusy(true);
      const res = await apiFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `The download failed (${res.status})`);
      }
      // A file kept in BMG's file storage (a backup of the books) comes as
      // { url, fileName }: a short-lived link, fetched without the session
      // so R2's CORS rule applies, and the file never passes through the route.
      if ((res.headers.get('content-type') || '').includes('application/json')) {
        const stored = await res.json().catch(() => ({}));
        if (!stored?.url) throw new Error(stored?.error || "The download didn't say where the file is");
        const file = await fetch(stored.url, { credentials: 'omit' });
        if (!file.ok) throw new Error(`The download failed (${file.status})`);
        await hand({ url, blob: await file.blob(), name: stored.fileName || fallbackName });
        return;
      }
      const blob = await res.blob();
      await hand({ url, blob, name: fileNameFromDisposition(res.headers.get('content-disposition')) || fallbackName });
    } catch (e: any) {
      onError(e?.message || "The file couldn't be made");
    } finally {
      setBusy(false);
    }
  }, [waiting, hand, onError]);

  /** Whether the file for `url` is made and waiting for a tap to save it. */
  const ready = (url: string) => waiting?.url === url;

  return { busy, ready, download };
}
