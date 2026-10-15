/**
 * "Rep reviews first" proofs (migration 378).
 *
 * Whoever enters a graphics job picks where its proof goes: straight to the
 * customer (the artist sends the approval link, as before), or to a BMG rep
 * first. In the rep flow the artist sends the proof to the rep; the rep then
 *   * sends it to the customer through the normal approval email,
 *   * records that the customer approved it verbally (a note is required,
 *     and that counts as the customer's approval: production can print), or
 *   * sends it back to the artist with what to change.
 *
 * State helpers live in ./proof-rep-review-state (client-safe); the server
 * actions here take a service-role client.
 */

import { roundForSend, roundLabel, openProofRound, closeProofRound } from './proof-rounds';
import { notify, notifyMany } from './notify';
import { deepLinks } from './deep-links';
import { fetchEmailAttachments } from './email-attachments';

import { isRepRoute, reviewingRepId, isWithRep, type ProofRoute } from './proof-rep-review-state';
export * from './proof-rep-review-state';

// ── Server actions ─────────────────────────────────────────────────────

type Db = { from: (table: string) => any };

export interface ActionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const JOB_COLUMNS = 'id, job_number, title, customer, status, created_by, assigned_to, proof_route, proof_rep_id, rep_review_status, rep_review_proof_file_id, rep_review_requested_by, customer_approved, sent_for_approval_by';

async function loadJob(service: Db, jobId: string) {
  const { data } = await service.from('graphics_jobs').select(JOB_COLUMNS).eq('id', jobId).maybeSingle();
  return data as any;
}

async function nameOf(service: Db, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data } = await service.from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
  return data?.full_name || data?.email || null;
}

function jobLabel(job: any): string {
  return job.title || (job.job_number ? `Job #${job.job_number}` : 'Graphics job');
}

function firstName(name: string | null): string {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

async function historyNote(service: Db, job: any, note: string, by: string | null) {
  try {
    await service.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: job.status,
      to_status: job.status,
      note,
      changed_by: by,
    });
  } catch (err) {
    console.error('rep review history note failed:', err);
  }
}

/** Change where the job's proofs go, and who the rep is. */
export async function setProofRoute(
  service: Db,
  jobId: string,
  opts: { route: ProofRoute; repId: string | null; actorId: string },
): Promise<ActionResult> {
  const job = await loadJob(service, jobId);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (opts.repId) {
    const { data: rep } = await service.from('profiles').select('id').eq('id', opts.repId).maybeSingle();
    if (!rep) return { ok: false, status: 400, error: 'That rep was not found.' };
  }
  const patch: Record<string, unknown> = {
    proof_route: opts.route,
    proof_rep_id: opts.repId,
    updated_at: new Date().toISOString(),
  };
  const { error } = await service.from('graphics_jobs').update(patch).eq('id', jobId);
  if (error) return { ok: false, status: 500, error: error.message };
  const repName = opts.route === 'rep' ? await nameOf(service, opts.repId || job.created_by) : null;
  await historyNote(
    service, job,
    opts.route === 'rep' ? `Proof set to go to ${repName || 'the rep'} first` : 'Proof set to go straight to the customer',
    opts.actorId,
  );
  return { ok: true };
}

/** The artist sends the proof to the rep. Nothing reaches the customer. */
export async function sendProofToRep(
  service: Db,
  jobId: string,
  opts: { actorId: string; proofFileId: string; note?: string | null },
): Promise<ActionResult & { repName?: string | null }> {
  const job = await loadJob(service, jobId);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.customer_approved) return { ok: false, status: 409, error: 'The customer already approved this proof.' };
  if (!isRepRoute(job)) return { ok: false, status: 409, error: 'This job sends proofs straight to the customer.' };
  const repId = reviewingRepId(job);
  if (!repId) return { ok: false, status: 400, error: 'Pick a rep for this job first.' };

  const { data: file } = await service
    .from('graphics_job_files')
    .select('id, file_name, file_size, file_type, storage_path')
    .eq('id', opts.proofFileId)
    .eq('job_id', job.id)
    .maybeSingle();
  if (!file) return { ok: false, status: 400, error: 'Selected proof file does not belong to this job.' };

  const now = new Date().toISOString();
  const note = opts.note?.trim() || null;
  const { error } = await service.from('graphics_jobs').update({
    rep_review_status: 'pending',
    rep_review_proof_file_id: file.id,
    rep_review_requested_at: now,
    rep_review_requested_by: opts.actorId,
    rep_review_note: note,
    rep_review_decided_at: null,
    rep_review_decided_by: null,
    rep_review_reason: null,
    updated_at: now,
  }).eq('id', job.id);
  if (error) return { ok: false, status: 500, error: error.message };

  const [repName, senderName, round] = await Promise.all([
    nameOf(service, repId),
    nameOf(service, opts.actorId),
    roundForSend(service, job.id, { reminder: false }),
  ]);
  const label = jobLabel(job);
  const rev = round ? roundLabel(round) : 'Proof';
  await historyNote(service, job, `${rev} sent to ${repName || 'the rep'} for review${note ? `: ${note}` : ''}`, opts.actorId);

  // The proof itself rides along when it fits an email, so the rep can look
  // without opening the app; the button opens the job either way.
  let emailAttachments: { filename: string; content: Buffer; contentType?: string }[] | undefined;
  if (file.file_size == null || file.file_size <= 10 * 1024 * 1024) {
    const fetched = await fetchEmailAttachments('graphics-proofs', [file], 10 * 1024 * 1024);
    if (fetched.ok) emailAttachments = fetched.attachments;
  }

  if (repId !== opts.actorId) {
    const lines = [
      `Hi ${firstName(repName)}, ${senderName || 'the art team'} sent you the ${rev.toLowerCase()} for ${job.customer || 'the customer'}: ${label}.`,
      note ? `Their note: "${note}"` : '',
      'Nothing has gone to the customer yet. From the job you can send it to the customer, record that the customer approved it verbally, or send it back with changes.',
    ].filter(Boolean);
    await notify({
      userId: repId,
      type: 'proof_rep_review_requested',
      title: `Proof ready for your review (${rev}): ${label}`,
      body: lines.join('\n\n'),
      url: deepLinks.graphicsJob(job.id),
      emailCtaNote: emailAttachments ? `The proof is attached (${file.file_name}).` : undefined,
      emailAttachments,
    });
  }
  return { ok: true, repName };
}

/** The rep sends the proof back to the artist with what to change. */
export async function sendProofBackToArtist(
  service: Db,
  jobId: string,
  opts: { actorId: string; reason: string },
): Promise<ActionResult> {
  const job = await loadJob(service, jobId);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (!isWithRep(job)) return { ok: false, status: 409, error: 'No proof is waiting on the rep.' };
  const reason = opts.reason.trim();
  if (!reason) return { ok: false, status: 400, error: 'Say what needs to change.' };

  const now = new Date().toISOString();
  const { error } = await service.from('graphics_jobs').update({
    rep_review_status: 'changes_requested',
    rep_review_decided_at: now,
    rep_review_decided_by: opts.actorId,
    rep_review_reason: reason,
    status: job.status === 'revision' ? job.status : 'revision',
    updated_at: now,
  }).eq('id', job.id);
  if (error) return { ok: false, status: 500, error: error.message };

  const repName = await nameOf(service, opts.actorId);
  try {
    await service.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: job.status,
      to_status: 'revision',
      note: `${repName || 'The rep'} sent the proof back: ${reason}`,
      changed_by: opts.actorId,
    });
  } catch (err) {
    console.error('rep send-back history failed:', err);
  }

  const targets = [job.rep_review_requested_by, job.assigned_to]
    .filter((id: string | null): id is string => !!id && id !== opts.actorId);
  if (targets.length > 0) {
    await notifyMany([...new Set(targets)], {
      type: 'proof_rep_review_update',
      title: `Proof sent back: ${jobLabel(job)}`,
      body: `${repName || 'The rep'} wants changes before it goes to ${job.customer || 'the customer'}: ${reason}`,
      url: deepLinks.graphicsJob(job.id),
    });
  }
  return { ok: true };
}

/**
 * The rep records that the customer approved the proof verbally. Counts as
 * the customer's approval (production can print); the note says how.
 */
export async function recordVerbalApproval(
  service: Db,
  jobId: string,
  opts: { actorId: string; note: string },
): Promise<ActionResult> {
  const job = await loadJob(service, jobId);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.customer_approved) return { ok: false, status: 409, error: 'Already approved' };
  const note = opts.note.trim();
  if (!note) return { ok: false, status: 400, error: 'Say how the customer approved it.' };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    customer_approved: true,
    customer_approved_at: now,
    customer_approved_by: opts.actorId,
    approval_verbal_note: note,
    customer_rejected_at: null,
    customer_rejection_reason: null,
    updated_at: now,
  };
  if (isRepRoute(job)) {
    patch.rep_review_status = 'approved_verbally';
    patch.rep_review_decided_at = now;
    patch.rep_review_decided_by = opts.actorId;
  }
  const { error } = await service.from('graphics_jobs').update(patch).eq('id', job.id);
  if (error) return { ok: false, status: 500, error: error.message };

  // The approval history counts rounds: a proof the customer never got by
  // email still gets its round, so it reads "First proof — approved".
  const { data: open } = await service
    .from('graphics_proof_rounds')
    .select('id')
    .eq('job_id', job.id)
    .eq('outcome', 'pending')
    .maybeSingle();
  if (!open) {
    await openProofRound(service, job.id, { proofFileId: job.rep_review_proof_file_id || null, sentBy: opts.actorId });
  }
  await closeProofRound(service, job.id, 'approved');

  const repName = await nameOf(service, opts.actorId);
  await historyNote(service, job, `${repName || 'Staff'} recorded the customer's verbal approval: ${note}`, opts.actorId);

  // Same audience as an approval through the link.
  const targetIds = new Set<string>();
  for (const id of [job.created_by, job.assigned_to, job.sent_for_approval_by, job.rep_review_requested_by]) {
    if (id) targetIds.add(id);
  }
  const { data: prod } = await service
    .from('profiles')
    .select('id')
    .in('role', ['admin', 'super_admin', 'graphics_production', 'production'])
    .eq('status', 'approved');
  for (const p of prod || []) targetIds.add(p.id);
  targetIds.delete(opts.actorId);
  if (targetIds.size > 0) {
    await notifyMany(Array.from(targetIds), {
      type: 'proof_approved',
      title: `Proof approved: ${jobLabel(job)}`,
      body: `${job.customer || 'The customer'} approved the proof verbally (recorded by ${repName || 'staff'}): ${note}. You can move to production.`,
      url: deepLinks.graphicsJob(job.id),
    });
  }
  return { ok: true };
}
