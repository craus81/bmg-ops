import { NextRequest } from 'next/server';

// Server side of the per-record file routes' fallback upload. The browser
// normally PUTs straight to R2 (presign → record); when that PUT fails,
// src/lib/record-file-upload.ts sends small files here as multipart with
// action 'upload' and the same fields as a presign. JSON stays the shape of
// every other call.

// Vercel caps a function request body at ~4.5MB; the client only falls back
// at SERVER_UPLOAD_LIMIT (4MB) so this is just the backstop.
export const ROUTE_UPLOAD_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

/** The POST body as a plain object, plus the file when it came as multipart. Null = unreadable. */
export async function readRecordFileBody(req: NextRequest): Promise<{ body: any; file: File | null } | null> {
  const type = req.headers.get('content-type') || '';
  try {
    if (type.startsWith('multipart/form-data')) {
      const fd = await req.formData();
      const body: Record<string, string> = {};
      let file: File | null = null;
      fd.forEach((v, k) => {
        if (typeof v === 'string') body[k] = v;
        else if (k === 'file') file = v;
      });
      return { body, file };
    }
    return { body: await req.json(), file: null };
  } catch {
    return null;
  }
}
