import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { QC_MAX_UPLOAD_BYTES, isQcImageType, isUuid } from '@/lib/qc-fixes';
import { qcPhotoSignedUrl, saveQcPhoto } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createServiceClient();

/**
 * GET /api/qc-fixes/photo?id=… — one QC fix photo for staff (redirect to a
 * signed R2 URL). `download=1` saves it under its name.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { data: photo } = await supabase.from('qc_fix_photos').select('storage_path, file_name').eq('id', id).maybeSingle();
  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = await qcPhotoSignedUrl(photo, req.nextUrl.searchParams.get('download') === '1');
  if (req.nextUrl.searchParams.get('format') === 'json') return NextResponse.json({ url });
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/qc-fixes/photo — BMG's photo of a repair, added from the fixed
 * email's compose screen (multipart `file` + `reportId`). Kind 'fix'.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'No photo received' }, { status: 400 }); }
  const file = form.get('file');
  const reportId = String(form.get('reportId') || '');
  if (!(file instanceof Blob)) return NextResponse.json({ error: 'No photo received' }, { status: 400 });
  if (!isQcImageType(file.type)) return NextResponse.json({ error: 'Only photos can be added (JPEG, PNG, HEIC).' }, { status: 400 });
  if (file.size > QC_MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'That photo is too large.' }, { status: 413 });
  if (!isUuid(reportId)) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  const { data: report } = await supabase.from('qc_fix_reports').select('id, customer_id').eq('id', reportId).maybeSingle();
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });

  const saved = await saveQcPhoto(supabase, {
    customerId: report.customer_id,
    reportId: report.id,
    kind: 'fix',
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    fileName: (file as File).name || 'fix.jpg',
    uploadedBy: auth.user.id,
  });
  if ('error' in saved) return NextResponse.json({ error: saved.error }, { status: 500 });
  return NextResponse.json({ id: saved.id, sizeBytes: file.size, name: (file as File).name || 'fix.jpg' });
}

/** DELETE /api/qc-fixes/photo?id=… — remove a fix photo BMG added (customer photos stay). */
export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { error } = await supabase.from('qc_fix_photos').delete().eq('id', id).eq('kind', 'fix');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
