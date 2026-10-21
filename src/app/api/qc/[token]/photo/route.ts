import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { QC_MAX_UPLOAD_BYTES, isQcImageType } from '@/lib/qc-fixes';
import { resolveQcCustomer, saveQcPhoto } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createServiceClient();

/**
 * POST /api/qc/[token]/photo — one photo for a QC fix report, as
 * multipart `file` + `kind` (vin | issue). The browser shrinks photos
 * first, so each fits under Vercel's body cap. Stored unclaimed; the
 * report submit (POST /api/qc/[token]) claims it by id.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!await checkRateLimit(getRequestIp(req), 'qc_link_photo', 200)) {
    return NextResponse.json({ error: 'Too many uploads from here. Try again in a little while.' }, { status: 429 });
  }
  const customer = await resolveQcCustomer(supabase, params.token);
  if (!customer) return NextResponse.json({ error: 'This link no longer works. Ask BMG for a new one.' }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'No photo received' }, { status: 400 }); }
  const file = form.get('file');
  const kind = form.get('kind');
  if (!(file instanceof Blob)) return NextResponse.json({ error: 'No photo received' }, { status: 400 });
  if (kind !== 'vin' && kind !== 'issue') return NextResponse.json({ error: 'Unknown photo kind' }, { status: 400 });
  if (!isQcImageType(file.type)) return NextResponse.json({ error: 'Only photos can be added (JPEG, PNG, HEIC).' }, { status: 400 });
  if (file.size > QC_MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'That photo is too large.' }, { status: 413 });

  const saved = await saveQcPhoto(supabase, {
    customerId: customer.id,
    reportId: null,
    kind,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    fileName: (file as File).name || 'photo.jpg',
  });
  if ('error' in saved) return NextResponse.json({ error: saved.error }, { status: 500 });
  return NextResponse.json({ id: saved.id });
}
