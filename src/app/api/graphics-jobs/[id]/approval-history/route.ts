import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { deepLinks } from '@/lib/deep-links';
import {
  buildApprovalHistory,
  dropDuplicateThreadCopies,
  type HistoryMessage,
  type MessageStatus,
  type RoundRow,
} from '@/lib/approval-history';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** Customer-facing email kinds that carry a graphics job's context_url.
 *  Staff alerts (mentions, assignments) carry it too and are left out. */
const CUSTOMER_EMAIL_KINDS = ['proof_approval', 'pickup_notice'];

/**
 * GET /api/graphics-jobs/[id]/approval-history
 *
 * Every proof round for the job with the emails, texts and customer replies
 * that went with it — the expanded view of the job's Customer Approval
 * card. Grouping lives in src/lib/approval-history.ts.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const jobId = (params.id || '').trim();
  if (!jobId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: job, error } = await supabase
    .from('graphics_jobs')
    .select('id, customer_approved, customer_rejected_at, customer_approved_via, customer_approved_delivery_target, customer_approved_time_on_page_seconds, signed_document_storage_path')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });

  const contextUrl = deepLinks.graphicsJob(jobId);
  const [roundsRes, emailsRes, textsRes, threadsRes] = await Promise.all([
    supabase
      .from('graphics_proof_rounds')
      .select('round_number, addressing, proof_file_id, sent_at, sent_by, outcome, decided_at, rejection_reason, created_at')
      .eq('job_id', jobId)
      .order('round_number'),
    supabase
      .from('email_log')
      .select('id, kind, recipients, copy_recipients, subject, sent_by, delivery_status, delivery_detail, created_at')
      .eq('context_url', contextUrl)
      .in('kind', CUSTOMER_EMAIL_KINDS)
      .order('created_at')
      .limit(500),
    supabase
      .from('sms_log')
      .select('id, kind, to_phone, body, sent_by, status, error, created_at')
      .eq('context_url', contextUrl)
      .order('created_at')
      .limit(500),
    supabase
      .from('customer_threads')
      .select('id, external_contacts(name, phone, email)')
      .eq('context_entity_type', 'graphics_job')
      .eq('context_entity_id', jobId),
  ]);
  // sms_log is new (migration 347); an unmigrated database just has no texts.
  if (roundsRes.error) return NextResponse.json({ error: roundsRes.error.message }, { status: 500 });
  if (emailsRes.error) return NextResponse.json({ error: emailsRes.error.message }, { status: 500 });

  const threads = (threadsRes.data || []) as any[];
  const threadContact: Record<string, string> = {};
  for (const t of threads) {
    const c = Array.isArray(t.external_contacts) ? t.external_contacts[0] : t.external_contacts;
    threadContact[t.id] = c?.name || c?.phone || c?.email || 'Customer';
  }
  const { data: threadMsgs } = threads.length > 0
    ? await supabase
        .from('customer_messages')
        .select('id, thread_id, direction, channel, body, sent_by, sent_at, delivery_status')
        .in('thread_id', threads.map(t => t.id))
        .order('sent_at')
        .limit(500)
    : { data: [] as any[] };

  const rounds = (roundsRes.data || []) as RoundRow[];
  const emails = (emailsRes.data || []) as any[];
  const texts = (textsRes.data || []) as any[];

  const nameIds = new Set<string>();
  for (const r of rounds) if (r.sent_by) nameIds.add(r.sent_by);
  for (const e of [...emails, ...texts, ...(threadMsgs || [])]) if (e.sent_by) nameIds.add(e.sent_by);
  const fileIds = [...new Set(rounds.map(r => r.proof_file_id).filter(Boolean))] as string[];

  const [{ data: profs }, { data: files }] = await Promise.all([
    nameIds.size > 0
      ? supabase.from('profiles').select('id, full_name').in('id', [...nameIds])
      : Promise.resolve({ data: [] as any[] }),
    fileIds.length > 0
      ? supabase.from('graphics_job_files').select('id, file_name').in('id', fileIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const names: Record<string, string> = Object.fromEntries((profs || []).map((p: any) => [p.id, p.full_name || '']));
  const fileNames: Record<string, string> = Object.fromEntries((files || []).map((f: any) => [f.id, f.file_name]));
  const nameOf = (id: string | null) => (id ? names[id] || null : null);

  const logged: HistoryMessage[] = [
    ...emails.map((e): HistoryMessage => ({
      id: e.id,
      source: 'email_log',
      channel: 'email',
      direction: 'out',
      at: e.created_at,
      kind: e.kind,
      subject: e.subject || null,
      body: null,
      who: [...(e.recipients || []), ...(e.copy_recipients || [])].join(', '),
      sentByName: nameOf(e.sent_by),
      status: (e.delivery_status || 'sent') as MessageStatus,
      detail: e.delivery_detail || null,
      reminder: /\bReminder:/i.test(e.subject || ''),
    })),
    ...texts.map((t): HistoryMessage => ({
      id: t.id,
      source: 'sms_log',
      channel: 'text',
      direction: 'out',
      at: t.created_at,
      kind: t.kind,
      subject: null,
      body: t.body || null,
      who: t.to_phone,
      sentByName: nameOf(t.sent_by),
      status: (t.status || 'sent') as MessageStatus,
      detail: t.error || null,
      reminder: false,
    })),
  ];

  const thread: HistoryMessage[] = (threadMsgs || []).map((m: any): HistoryMessage => ({
    id: m.id,
    source: 'thread',
    channel: m.channel === 'email' ? 'email' : 'text',
    direction: m.direction === 'inbound' ? 'in' : 'out',
    at: m.sent_at,
    kind: null,
    subject: null,
    body: m.body || null,
    who: threadContact[m.thread_id] || 'Customer',
    sentByName: nameOf(m.sent_by),
    status: (m.delivery_status || null) as MessageStatus | null,
    detail: null,
    reminder: false,
  }));

  const decided = job.customer_approved || job.customer_rejected_at;
  const history = buildApprovalHistory(
    rounds,
    [...logged, ...dropDuplicateThreadCopies(logged, thread)],
    names,
    fileNames,
    decided
      ? {
          via: job.customer_approved_via || null,
          target: job.customer_approved_delivery_target || null,
          timeOnPageSeconds: job.customer_approved_time_on_page_seconds ?? null,
          signedDocument: !!job.signed_document_storage_path,
        }
      : null,
  );

  return NextResponse.json(history);
}
