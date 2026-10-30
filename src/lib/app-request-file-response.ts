import { NextResponse } from 'next/server';
import { r2Get } from './r2';
import { REQUEST_FILES_PREFIX } from './app-requests';

const SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Stream one request screenshot back, private and never cached by a shared cache. */
export async function requestFileResponse(row: { storage_path: string; file_name: string | null; content_type: string | null }) {
  const got = await r2Get(REQUEST_FILES_PREFIX, row.storage_path);
  if (!got.success || !got.body) return NextResponse.json({ error: "The screenshot isn't in storage." }, { status: 404 });
  const type = row.content_type && SAFE_TYPES.has(row.content_type) ? row.content_type : 'application/octet-stream';
  const name = (row.file_name || 'screenshot').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new NextResponse(got.body as unknown as BodyInit, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      ...(got.contentLength ? { 'Content-Length': String(got.contentLength) } : {}),
    },
  });
}
