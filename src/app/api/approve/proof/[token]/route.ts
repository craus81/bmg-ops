import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  validateExpiry, captureMetadata, checkRateLimit, uploadSignedDocument,
  getRequestIp, AGREEMENT_TEXT,
} from '@/lib/magic-link-approval';
import { notifyMany } from '@/lib/notify';
import { r2Get, r2PublicUrl, r2Upload } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const ApprovalSchema = z.object({
  action: z.enum(['accept', 'reject']),
  reason: z.string().trim().max(1000).optional(),
  agreementText: z.string().max(2000).optional(),
  timeOnPageSeconds: z.number().int().nonnegative().max(86_400).optional().nullable(),
  deliveryChannel: z.enum(['sms_link', 'email_link']).optional().nullable(),
  deliveryTarget: z.string().max(254).optional().nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function loadJobByToken(token: string) {
  const { data: job, error } = await supabase
    .from('graphics_jobs')
    .select('*')
    .eq('approval_token', token)
    .maybeSingle();
  if (error || !job) return { job: null };

  // If the sender chose a specific proof file at send-time, the customer
  // sees only that one. Older jobs sent before the picker landed have no
  // approval_proof_file_id and fall back to the full file list.
  let filesQuery = supabase
    .from('graphics_job_files')
    .select('id, file_name, file_type, storage_path, uploaded_at')
    .eq('job_id', job.id);
  if (job.approval_proof_file_id) {
    filesQuery = filesQuery.eq('id', job.approval_proof_file_id);
  } else {
    filesQuery = filesQuery.order('uploaded_at', { ascending: false });
  }
  const { data: files } = await filesQuery;
  return { job, files: files || [] };
}

function isPdf(file: { file_name: string; file_type?: string | null }): boolean {
  return (file.file_type || '').toLowerCase().includes('pdf')
    || (file.file_name || '').toLowerCase().endsWith('.pdf');
}

function publicJob(j: any) {
  return {
    id: j.id,
    job_number: j.job_number,
    title: j.title,
    part_number: j.part_number,
    customer: j.customer,
    quantity: j.quantity,
    notes: j.notes,
    proof_url: j.proof_url,
    status: j.status,
    customer_approved_at: j.customer_approved_at,
    customer_rejected_at: j.customer_rejected_at,
  };
}

/**
 * GET /api/approve/proof/[token]
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'approve_proof_get')) {
    return NextResponse.json({ error: 'Too many attempts', status: 'error' }, { status: 429 });
  }

  const { job, files } = await loadJobByToken(params.token);
  if (!job) return NextResponse.json({ status: 'invalid', error: 'not_found' }, { status: 404 });

  const expiry = validateExpiry(job.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ status: 'expired' }, { status: 410 });

  if (job.customer_approved) {
    return NextResponse.json({ status: 'already_approved', job: publicJob(job) });
  }
  if (job.customer_rejected_at) {
    return NextResponse.json({ status: 'already_rejected', job: publicJob(job) });
  }

  // Files live in R2 under the graphics-proofs prefix (see src/lib/storage.ts).
  // R2 public URLs are directly fetchable, no signing needed.
  const fileEntries = (files || []).map((f: any) => ({
    id: f.id,
    file_name: f.file_name,
    url: r2PublicUrl('graphics-proofs', f.storage_path),
    is_pdf: isPdf(f),
  }));

  return NextResponse.json({ status: 'ready', job: publicJob(job), files: fileEntries });
}

/**
 * POST /api/approve/proof/[token]
 * Body: { action: 'accept'|'reject', timeOnPageSeconds?, deliveryChannel?,
 *         deliveryTarget?, reason?, agreementText? }
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'approve_proof_post')) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  const parsed = await validateBody(req, ApprovalSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const action = body.action;

  const { job, files } = await loadJobByToken(params.token);
  if (!job) return NextResponse.json({ error: 'Invalid token' }, { status: 404 });
  const expiry = validateExpiry(job.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ error: 'Expired' }, { status: 410 });
  if (job.customer_approved) return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  if (job.customer_rejected_at) return NextResponse.json({ error: 'Already rejected' }, { status: 409 });

  const metadata = captureMetadata(req, body);

  if (action === 'reject') {
    const reason = (body.reason || '').trim();
    if (!reason) return NextResponse.json({ error: 'reason required' }, { status: 400 });

    await supabase
      .from('graphics_jobs')
      .update({
        customer_rejected_at: new Date().toISOString(),
        customer_rejection_reason: reason,
        customer_approved_ip: metadata.ip,
        customer_approved_user_agent: metadata.userAgent,
        customer_approved_via: metadata.deliveryChannel,
        customer_approved_delivery_target: metadata.deliveryTarget,
        customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
        status: 'revision',
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    await supabase.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: job.status,
      to_status: 'revision',
      note: `Customer requested changes: ${reason}`,
    });

    await notifyGraphicsTeam(job, 'revision', reason);
    return NextResponse.json({ status: 'submitted_rejected' });
  }

  // Accept — clone the current proof files to an immutable location,
  // then record an HTML audit snapshot alongside.
  const signedProofPaths: string[] = [];
  for (const f of files || []) {
    try {
      const fetched = await r2Get('graphics-proofs', f.storage_path);
      if (!fetched.success || !fetched.body) {
        console.error('proof file fetch failed:', f.storage_path, fetched.error);
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of fetched.body as any) {
        chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      const destPath = `proofs/${job.id}/${Date.now()}-${f.file_name}`;
      const uploaded = await r2Upload(
        'signed-documents',
        destPath,
        buffer,
        f.file_type || 'application/octet-stream',
      );
      if (uploaded.success) signedProofPaths.push(uploaded.key);
      else console.error('proof file archive upload failed:', destPath, uploaded.error);
    } catch (err) {
      console.error('proof file clone failed:', err);
    }
  }

  const snapshotHtml = renderProofHtml(job, files || [], metadata, body.agreementText || AGREEMENT_TEXT, signedProofPaths);
  let signedPath: string | null = null;
  let signedHash: string | null = null;
  try {
    const uploaded = await uploadSignedDocument(
      `proofs/${job.id}/signed`,
      snapshotHtml,
      'text/html; charset=utf-8'
    );
    signedPath = uploaded.path;
    signedHash = uploaded.hash;
  } catch (err: any) {
    console.error('Signed HTML upload failed:', err);
  }

  const approvedAt = new Date().toISOString();
  await supabase
    .from('graphics_jobs')
    .update({
      customer_approved: true,
      customer_approved_at: approvedAt,
      customer_approved_ip: metadata.ip,
      customer_approved_user_agent: metadata.userAgent,
      customer_approved_via: metadata.deliveryChannel,
      customer_approved_delivery_target: metadata.deliveryTarget,
      customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
      signed_document_storage_path: signedPath,
      signed_document_hash: signedHash,
      signed_proof_storage_paths: signedProofPaths.length > 0 ? signedProofPaths : null,
      updated_at: approvedAt,
    })
    .eq('id', job.id);

  await supabase.from('graphics_status_history').insert({
    job_id: job.id,
    from_status: job.status,
    to_status: job.status,
    note: 'Customer approved proof via magic link',
  });

  await notifyGraphicsTeam(job, 'approved');
  return NextResponse.json({ status: 'submitted_accepted' });
}

async function notifyGraphicsTeam(job: any, verdict: 'approved' | 'revision', reason?: string) {
  const targetIds = new Set<string>();
  if (job.created_by) targetIds.add(job.created_by);
  if (job.assigned_to) targetIds.add(job.assigned_to);
  if (job.sent_for_approval_by) targetIds.add(job.sent_for_approval_by);

  const { data: prod } = await supabase
    .from('profiles')
    .select('id')
    .in('role', ['admin', 'graphics_production', 'production'])
    .eq('status', 'approved');
  for (const p of prod || []) targetIds.add(p.id);

  if (targetIds.size === 0) return;

  const title = verdict === 'approved'
    ? `Proof approved: ${job.title || `Job #${job.job_number}`}`
    : `Proof revision requested: ${job.title || `Job #${job.job_number}`}`;
  const body = verdict === 'approved'
    ? `${job.customer || 'Customer'} approved the proof. You can move to production.`
    : `${job.customer || 'Customer'} requested changes: ${reason || '(no reason)'}`;

  await notifyMany(Array.from(targetIds), {
    type: verdict === 'approved' ? 'proof_approved' : 'proof_revision_requested',
    title,
    body,
    url: '/graphics',
  });
}

function esc(s: any): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderProofHtml(job: any, files: any[], meta: any, agreement: string, signedPaths: string[]): string {
  const approvedAt = new Date().toISOString();
  const fileRows = files.map((f, i) => {
    const archivedPath = signedPaths[i] || '';
    return `<li>
      <div><strong>${esc(f.file_name)}</strong></div>
      <div class="sub">original: ${esc(f.storage_path)}</div>
      ${archivedPath ? `<div class="sub">archived: ${esc(archivedPath)}</div>` : '<div class="sub">archival failed — original may be re-used</div>'}
    </li>`;
  }).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Proof approval — ${esc(job.job_number)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; color:#0f172a; background:#f1f5f9; padding:24px; }
.card { max-width: 720px; margin: 0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:24px; }
h1 { font-size:22px; margin:0 0 4px; }
.meta { color:#64748b; font-size:12px; }
ul { font-size:13px; list-style:none; padding:0; }
ul li { border-top:1px solid #e2e8f0; padding:10px 0; }
.sub { font-size:11px; color:#475569; }
.signed { margin-top:20px; padding:14px; border:1px solid #16a34a; background:#dcfce7; border-radius:10px; font-size:12px; }
.audit div { margin-bottom:2px; }
.note { margin-top:12px; padding:10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; font-size:13px; white-space:pre-wrap; }
</style></head><body>
<div class="card">
  <h1>${esc(job.title || `Proof — Job #${job.job_number}`)}</h1>
  <div class="meta">${esc(job.customer || 'customer')}${job.part_number ? ` · ${esc(job.part_number)}` : ''}${job.quantity ? ` · Qty ${esc(job.quantity)}` : ''}</div>

  <h3 style="margin-top:18px; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#64748b;">Proof files (as-signed)</h3>
  <ul>${fileRows || '<li class="sub">No attached files — only job notes were available at approval time.</li>'}</ul>

  ${job.notes ? `<div class="note">${esc(job.notes)}</div>` : ''}

  <div class="signed">
    <strong>APPROVED</strong>
    <div class="audit" style="margin-top:8px;">
      <div><em>${esc(agreement)}</em></div>
      <div>Approved at: ${esc(approvedAt)}</div>
      <div>IP: ${esc(meta.ip)}</div>
      <div>User agent: ${esc(meta.userAgent)}</div>
      ${meta.deliveryChannel ? `<div>Delivered via: ${esc(meta.deliveryChannel)}${meta.deliveryTarget ? ' to ' + esc(meta.deliveryTarget) : ''}</div>` : ''}
      ${typeof meta.timeOnPageSeconds === 'number' ? `<div>Time on page: ${meta.timeOnPageSeconds}s</div>` : ''}
    </div>
  </div>
</div>
</body></html>`;
}
