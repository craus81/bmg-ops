import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { r2PresignPut, r2Delete, r2Get } from '@/lib/r2';

export const dynamic = 'force-dynamic';

/**
 * Files attached to a CUSTOMER record (customer_files + R2 under the
 * 'customer-files' prefix). Unlike prospect files, these are PRIVATE — a
 * resale/exemption certificate carries an EIN — so no public URL is ever
 * stored or handed out. Uploads go browser → R2 via presigned PUT (to dodge
 * Vercel's ~4.5MB API body limit); downloads STREAM back through this
 * staff-gated route, so the R2 object is never linked directly.
 *
 *   POST { action: 'presign', customerId, fileName, contentType, size }
 *     → { uploadUrl, path }              (browser PUTs the file to uploadUrl)
 *   POST { action: 'record', customerId, path, fileName, contentType, size, category? }
 *     → { success, file }                (saves metadata after the PUT succeeds)
 *   GET  ?customerId=<uuid>[&category=]  → { success, files }
 *   GET  ?download=<fileId>              → streams the file (attachment)
 *   DELETE ?id=<uuid>                    → { success }  (removes R2 object + row)
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_BYTES = 25 * 1024 * 1024;
const R2_PREFIX = 'customer-files';

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const customerId = String(body?.customerId || '');
  if (!UUID_RE.test(customerId)) return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  const fileName = safeFileName(String(body?.fileName || ''));
  const contentType = String(body?.contentType || 'application/octet-stream').slice(0, 100);
  const size = Number(body?.size) || 0;
  if (size <= 0 || size > MAX_BYTES) return NextResponse.json({ error: 'File must be under 25MB' }, { status: 400 });

  const supabase = service();
  const { data: customer } = await supabase.from('customers').select('id').eq('id', customerId).maybeSingle();
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  if (body.action === 'presign') {
    const path = `${customerId}/${Date.now()}-${fileName}`;
    const { url } = await r2PresignPut(R2_PREFIX, path, contentType);
    return NextResponse.json({ success: true, uploadUrl: url, path });
  }

  if (body.action === 'record') {
    const path = String(body?.path || '');
    // Only accept paths this route could have presigned for this customer —
    // otherwise a crafted `path` could alias someone else's object.
    if (!path.startsWith(`${customerId}/`) || path.includes('..')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    const category = ['tax_exempt_cert', 'general'].includes(String(body?.category))
      ? String(body.category) : 'general';
    const { data, error } = await supabase.from('customer_files').insert({
      customer_id: customerId,
      category,
      file_name: fileName,
      content_type: contentType,
      size_bytes: size,
      storage_path: path,
      uploaded_by: auth.user?.id || null,
    }).select('id, category, file_name, content_type, size_bytes, created_at').single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Failed to save file record' }, { status: 500 });
    return NextResponse.json({ success: true, file: data });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const supabase = service();

  // ── Private download: stream the object, never expose the R2 URL ──
  const downloadId = req.nextUrl.searchParams.get('download') || '';
  if (downloadId) {
    if (!UUID_RE.test(downloadId)) return NextResponse.json({ error: 'download id required' }, { status: 400 });
    const { data: file } = await supabase.from('customer_files')
      .select('file_name, content_type, storage_path')
      .eq('id', downloadId)
      .maybeSingle();
    if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    const got = await r2Get(R2_PREFIX, file.storage_path);
    if (!got.success || !got.body) return NextResponse.json({ error: got.error || 'Could not read file' }, { status: 502 });
    return new NextResponse(got.body as any, {
      headers: {
        'Content-Type': file.content_type || got.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${file.file_name.replace(/"/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  // ── List a customer's files (metadata only, no URL) ──
  const customerId = req.nextUrl.searchParams.get('customerId') || '';
  if (!UUID_RE.test(customerId)) return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  const category = req.nextUrl.searchParams.get('category') || '';

  let query = supabase.from('customer_files')
    .select('id, category, file_name, content_type, size_bytes, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, files: data || [] });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = service();
  const { data: file } = await supabase.from('customer_files').select('id, storage_path').eq('id', id).maybeSingle();
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });

  await r2Delete(R2_PREFIX, file.storage_path);
  const { error } = await supabase.from('customer_files').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
