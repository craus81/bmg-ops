// Client-side storage helpers that call our R2 API routes
// Drop-in replacement for supabase.storage.from('bucket').upload() / .getPublicUrl()

const R2_PUBLIC_URL = process.env.NEXT_PUBLIC_R2_PUBLIC_URL || '';

export const storage = {
  from(bucket: string) {
    return {
      // Upload a file — returns { error } on failure, null on success
      async upload(path: string, file: File | Blob, options?: { contentType?: string; upsert?: boolean }) {
        try {
          const formData = new FormData();
          formData.append('file', file instanceof File ? file : new File([file], 'upload', { type: options?.contentType }));
          formData.append('bucket', bucket);
          formData.append('path', path);

          const res = await fetch('/api/storage', {
            method: 'POST',
            body: formData,
          });

          const data = await res.json();
          if (!data.success) {
            return { data: null, error: { message: data.error || 'Upload failed' } };
          }

          return { data: { key: data.key, publicUrl: data.publicUrl }, error: null };
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
