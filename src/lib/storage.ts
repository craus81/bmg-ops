// Client-side storage helpers that call our R2 API routes
// Drop-in replacement for supabase.storage.from('bucket').upload() / .getPublicUrl()

import { createClient } from './supabase-browser';

const R2_PUBLIC_URL = process.env.NEXT_PUBLIC_R2_PUBLIC_URL || '';

// Pull the current Supabase access token and attach it as a Bearer header
// so requireAuth() on our API routes accepts the request even when the
// cookie-based path fails (e.g. cookie too large, blocked third-party
// cookies in some browsers, post-deploy stale cookies).
async function authHeader(): Promise<Record<string, string>> {
  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

// Stay safely under Vercel's ~4.5MB request body cap when falling back to
// the same-origin /api/storage upload route.
const SERVER_UPLOAD_LIMIT = 4 * 1024 * 1024;

// PUT via XHR instead of fetch: fetch has no request-body progress events,
// so a 200MB .psd upload looks frozen until it finishes. Rejects with a
// TypeError on network failure, matching fetch, so callers' fallback logic
// treats both transports the same.
function xhrPut(
  url: string,
  body: File | Blob | ArrayBuffer,
  contentType: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.responseText || '' });
    xhr.onerror = () => reject(new TypeError('Load failed'));
    xhr.ontimeout = () => reject(new TypeError('Load failed'));
    xhr.send(body);
  });
}

export const storage = {
  from(bucket: string) {
    return {
      // Upload a file directly to R2 via a presigned PUT URL.
      // Avoids the Vercel ~4.5MB API body limit. Pass onProgress to get
      // upload progress for the direct PUT (bytes sent, total bytes).
      async upload(path: string, file: File | Blob, options?: { contentType?: string; upsert?: boolean; onProgress?: (loaded: number, total: number) => void }) {
        const contentType =
          options?.contentType ||
          (file instanceof File ? file.type : '') ||
          'application/octet-stream';
        const fileName = file instanceof File ? file.name : path.split('/').pop() || 'file';

        // Same-origin fallback through our API route — immune to the CORS /
        // WebKit failure modes of the direct-to-R2 PUT, but capped by the
        // serverless body limit, so only used for small-enough files.
        const serverUpload = async (body: Blob) => {
          try {
            const fd = new FormData();
            fd.append('bucket', bucket);
            fd.append('path', path);
            fd.append('file', new File([body], fileName, { type: contentType }));
            const res = await fetch('/api/storage', {
              method: 'POST',
              headers: await authHeader(),
              body: fd,
            });
            const data = await res.json();
            if (!data.success) {
              return { data: null, error: { message: data.error || `Upload failed (${res.status})` } };
            }
            return { data: { key: data.key, publicUrl: data.publicUrl }, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message || 'Network error' } };
          }
        };

        let presign: any;
        try {
          const presignRes = await fetch('/api/storage/presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
            body: JSON.stringify({ bucket, path, contentType }),
          });
          presign = await presignRes.json();
        } catch (err: any) {
          return { data: null, error: { message: err.message || 'Network error' } };
        }
        if (!presign.success) {
          return { data: null, error: { message: presign.error || 'Failed to get upload URL' } };
        }

        let putRes: { ok: boolean; status: number; text: string };
        try {
          putRes = await xhrPut(presign.url, file, contentType, options?.onProgress);
        } catch {
          // WebKit reports every failed cross-origin PUT as a bare TypeError
          // ("Load failed") — a CORS-blocked origin, a dropped connection,
          // and a File the OS can no longer stream (e.g. an iCloud item not
          // downloaded locally) all look identical. Read the file into
          // memory to separate the unreadable-file case, then route small
          // files through our own API instead.
          let buf: ArrayBuffer;
          try {
            buf = await file.arrayBuffer();
          } catch {
            return {
              data: null,
              error: { message: `Couldn't read "${fileName}" from this device. If it's stored in iCloud/OneDrive/Google Drive, open it once so it downloads, then try again.` },
            };
          }
          if (buf.byteLength <= SERVER_UPLOAD_LIMIT) {
            return serverUpload(new Blob([buf], { type: contentType }));
          }
          // Too big for the server route — retry the direct PUT with the
          // in-memory body, which sidesteps WebKit's File-streaming flakes.
          try {
            putRes = await xhrPut(presign.url, buf, contentType, options?.onProgress);
          } catch (err2: any) {
            const mb = (buf.byteLength / (1024 * 1024)).toFixed(1);
            return {
              data: null,
              error: { message: `Direct upload was blocked by the network or browser (${err2?.message || 'Load failed'}), and at ${mb}MB the file is too large for the fallback route. Try again on a different network or browser.` },
            };
          }
        }

        if (!putRes.ok) {
          return { data: null, error: { message: `Upload failed (${putRes.status}): ${putRes.text.slice(0, 200)}` } };
        }

        return { data: { key: presign.key, publicUrl: presign.publicUrl }, error: null };
      },

      // Get a public URL for a file
      getPublicUrl(path: string) {
        const publicUrl = R2_PUBLIC_URL
          ? `${R2_PUBLIC_URL}/${bucket}/${path}`
          : `/api/storage?bucket=${bucket}&path=${path}`;
        return { data: { publicUrl } };
      },

      // Create a signed URL (for R2, we just return the public URL since the bucket is public)
      async createSignedUrl(path: string, _expiresIn: number) {
        const publicUrl = R2_PUBLIC_URL
          ? `${R2_PUBLIC_URL}/${bucket}/${path}`
          : `/api/storage?bucket=${bucket}&path=${path}`;
        return { data: { signedUrl: publicUrl }, error: null };
      },

      // Delete file(s)
      async remove(paths: string[]) {
        const errors: string[] = [];
        for (const path of paths) {
          try {
            const res = await fetch('/api/storage', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
              body: JSON.stringify({ bucket, path }),
            });
            const data = await res.json();
            if (!data.success) errors.push(data.error);
          } catch (err: any) {
            errors.push(err.message);
          }
        }
        return { error: errors.length > 0 ? { message: errors.join('; ') } : null };
      },
    };
  },
};
