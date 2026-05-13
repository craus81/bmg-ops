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

export const storage = {
  from(bucket: string) {
    return {
      // Upload a file directly to R2 via a presigned PUT URL.
      // Avoids the Vercel ~4.5MB API body limit.
      async upload(path: string, file: File | Blob, options?: { contentType?: string; upsert?: boolean }) {
        try {
          const contentType =
            options?.contentType ||
            (file instanceof File ? file.type : '') ||
            'application/octet-stream';

          const presignRes = await fetch('/api/storage/presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
            body: JSON.stringify({ bucket, path, contentType }),
          });
          const presign = await presignRes.json();
          if (!presign.success) {
            return { data: null, error: { message: presign.error || 'Failed to get upload URL' } };
          }

          const putRes = await fetch(presign.url, {
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body: file,
          });
          if (!putRes.ok) {
            const text = await putRes.text().catch(() => '');
            return { data: null, error: { message: `Upload failed (${putRes.status}): ${text.slice(0, 200)}` } };
          }

          return { data: { key: presign.key, publicUrl: presign.publicUrl }, error: null };
        } catch (err: any) {
          return { data: null, error: { message: err.message || 'Network error' } };
        }
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
