'use client';

/**
 * Uploads into a Client Files folder (src/lib/client-files-upload.ts): one
 * file at a time, each in pieces through /api/client-files/upload, with a
 * line saying how far along it is, what was saved, or what went wrong.
 */

import { useCallback, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { formatBytes } from '@/lib/client-files';
import { MAX_UPLOAD_BYTES, uploadPieces } from '@/lib/client-files-upload';

export interface UploadStatus {
  /** "Uploading 2 of 3: van.jpg (45%)" while busy. */
  busy: string | null;
  done: string | null;
  error: string | null;
}

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

async function uploadOne(file: File, folderId: string, sub: string, onPart: (fraction: number) => void): Promise<string> {
  let session = '';
  for (const [from, to] of uploadPieces(file.size)) {
    const p = new URLSearchParams({ step: 'piece', offset: String(from) });
    if (session) p.set('session', session);
    const res = await apiFetch(`/api/client-files/upload?${p.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.slice(from, to),
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error || `Upload failed (HTTP ${res.status})`);
    session = json.session;
    onPart(file.size ? to / file.size : 1);
  }
  const res = await apiFetch('/api/client-files/upload?step=finish', {
    method: 'POST',
    body: JSON.stringify({ session, size: file.size, folderId, sub, name: file.name }),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.error || `Upload failed (HTTP ${res.status})`);
  return json.savedAs || file.name;
}

export function useClientFileUploads(onUploaded: () => void) {
  const [status, setStatus] = useState<UploadStatus>({ busy: null, done: null, error: null });

  const upload = useCallback(async (files: File[], folderId: string, sub: string, folderLabel: string) => {
    const list = files.filter(f => f.size <= MAX_UPLOAD_BYTES);
    const tooBig = files.filter(f => f.size > MAX_UPLOAD_BYTES);
    if (list.length === 0) {
      setStatus({ busy: null, done: null, error: tooBig.length ? `${tooBig[0].name} is bigger than ${formatBytes(MAX_UPLOAD_BYTES)}. Put it in Dropbox from a computer.` : 'Nothing to upload.' });
      return;
    }
    const saved: string[] = [];
    const renamed: string[] = [];
    let error: string | null = null;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const label = list.length > 1 ? `Uploading ${i + 1} of ${list.length}: ${f.name}` : `Uploading ${f.name}`;
      setStatus({ busy: label, done: null, error: null });
      try {
        const name = await uploadOne(f, folderId, sub, frac => {
          if (f.size > 1024 * 1024) setStatus({ busy: `${label} (${Math.round(frac * 100)}%)`, done: null, error: null });
        });
        saved.push(name);
        if (name !== f.name) renamed.push(`${f.name} was saved as ${name}, since that name was taken`);
      } catch (e: any) {
        error = `${f.name} did not upload: ${e?.message || 'Upload failed'}`;
        break;
      }
    }
    if (tooBig.length && !error) error = `${tooBig.map(f => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} bigger than ${formatBytes(MAX_UPLOAD_BYTES)} and did not upload.`;
    const done = saved.length
      ? `Uploaded ${saved.length === 1 ? saved[0] : `${saved.length} files`} to ${folderLabel}.${renamed.length ? ` ${renamed.join('. ')}.` : ''}`
      : null;
    setStatus({ busy: null, done, error });
    if (saved.length) onUploaded();
  }, [onUploaded]);

  const clear = useCallback(() => setStatus({ busy: null, done: null, error: null }), []);
  return { status, upload, clear };
}

/** The files in a drag from Files, Finder or Photos (not text or a link). */
export const dragHasFiles = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
