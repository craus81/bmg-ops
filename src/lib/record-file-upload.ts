// Client side of the per-record file routes (/api/estimates/[id]/files,
// /api/customers/files, /api/prospects/files): presign → direct PUT to R2 →
// record. Mirrors storage.from().upload(): when the direct PUT fails at the
// network level (a CORS-blocked bucket, WebKit's File-streaming flakes, a
// File the OS can no longer read), small files go through the route's own
// 'upload' action instead, and every failure says which step broke and why
// rather than a bare "Network error".

import { SERVER_UPLOAD_LIMIT, xhrPut } from './storage';

export type RecordFileUploadResult = { file?: any; error?: string };

// A route that crashed or timed out answers with HTML/text, not JSON — that
// is a server error, not a network one.
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return { error: `FleetSuite's server returned an error (HTTP ${res.status})` };
  }
}

/**
 * Upload `file` through one of the per-record file routes and save its
 * record. `fields` identify the record (e.g. { prospectId }) and ride on
 * every call; `recordFields` only on the final record call (e.g. category).
 */
export async function uploadRecordFile(
  endpoint: string,
  fields: Record<string, string>,
  file: File,
  recordFields: Record<string, string> = {},
): Promise<RecordFileUploadResult> {
  const contentType = file.type || 'application/octet-stream';
  const meta = { ...fields, fileName: file.name, contentType, size: file.size };
  const postJson = async (payload: Record<string, unknown>) => {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return readJson(res);
  };

  let presign: any;
  try {
    presign = await postJson({ action: 'presign', ...meta });
  } catch {
    return { error: "Couldn't reach FleetSuite to start the upload. Check your connection and try again." };
  }
  if (!presign.success) return { error: presign.error || 'Could not start the upload' };

  let path: string = presign.path;
  let put: { ok: boolean; status: number; text: string } | null = null;
  try {
    put = await xhrPut(presign.uploadUrl, file, contentType);
  } catch {
    // Same triage as storage.from().upload(): read the file to separate
    // "unreadable here" from "blocked on the way to storage".
    let buf: ArrayBuffer;
    try {
      buf = await file.arrayBuffer();
    } catch {
      return { error: `Couldn't read "${file.name}" from this device. If it's stored in iCloud, Dropbox or OneDrive, open it once so it downloads, then try again.` };
    }
    if (buf.byteLength <= SERVER_UPLOAD_LIMIT) {
      try {
        const fd = new FormData();
        fd.append('action', 'upload');
        for (const [k, v] of Object.entries(meta)) fd.append(k, String(v));
        fd.append('file', new File([buf], file.name, { type: contentType }));
        const up = await readJson(await fetch(endpoint, { method: 'POST', body: fd }));
        if (!up.success || !up.path) return { error: up.error || 'The upload through FleetSuite failed' };
        path = up.path;
      } catch {
        return { error: "Storage blocked the direct upload, and FleetSuite couldn't be reached for the fallback. Check your connection and try again." };
      }
    } else {
      // Too big for the route — retry the direct PUT with the in-memory body.
      try {
        put = await xhrPut(presign.uploadUrl, buf, contentType);
      } catch {
        const mb = (buf.byteLength / (1024 * 1024)).toFixed(1);
        return { error: `Storage blocked the direct upload, and at ${mb}MB the file is too large for the fallback. Try again on a different network or browser.` };
      }
    }
  }
  if (put && !put.ok) return { error: `Storage refused the upload (HTTP ${put.status})` };

  let rec: any;
  try {
    rec = await postJson({ action: 'record', ...meta, ...recordFields, path });
  } catch {
    return { error: "The file uploaded, but FleetSuite couldn't be reached to save it. Check your connection and try again." };
  }
  if (!rec.success || !rec.file) return { error: rec.error || 'Failed to save the file record' };
  return { file: rec.file };
}
