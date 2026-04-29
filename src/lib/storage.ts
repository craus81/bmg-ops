// Client-side storage helpers that call our R2 API routes
// Drop-in replacement for supabase.storage.from('bucket').upload() / .getPublicUrl()

const R2_PUBLIC_URL = process.env.NEXT_PUBLIC_R2_PUBLIC_URL || '';

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
            headers: { 'Content-Type': 'application/json' },
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
              headers: { 'Content-Type': 'application/json' },
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
