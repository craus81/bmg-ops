import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The designer's art proof on a duplicated estimate (Craig, 2026-10-20,
 * "Show it; revisions take the job").
 *
 * A graphics job belongs to one estimate (graphics_jobs.estimate_id): it
 * drives production, and the customer approving that estimate approves the
 * job's proof. A plain Duplicate is usually a different job, so the job
 * stays with the original and the copy only SHOWS the art proof chosen on
 * it: estimates.copied_graphics_proofs (migration 419) lists the job and
 * file ids, and loadEstimateProofs puts them on the copy's PDF and approval
 * page. Approving the copy never approves the original's job (the approval
 * side checks jobCoversEstimate). A revision replaces the same job, so the
 * job itself moves to the revision, unless the original is already on a
 * Sales Order, where production follows the order and the revision only
 * shows the proof.
 */

export interface CopiedProof {
  job_id: string;
  file_ids: string[];
  /** The estimate the proof was copied from, for the note on the copy. */
  from_estimate: string | null;
}

/** Only well-formed entries with files survive; one per job. */
export function sanitizeCopiedProofs(raw: unknown): CopiedProof[] {
  if (!Array.isArray(raw)) return [];
  const out: CopiedProof[] = [];
  const seen = new Set<string>();
  for (const e of raw as any[]) {
    const jobId = typeof e?.job_id === 'string' ? e.job_id : null;
    const files = Array.isArray(e?.file_ids) ? e.file_ids.filter((f: unknown) => typeof f === 'string' && f) : [];
    if (!jobId || files.length === 0 || seen.has(jobId)) continue;
    seen.add(jobId);
    out.push({ job_id: jobId, file_ids: [...new Set(files as string[])], from_estimate: typeof e?.from_estimate === 'string' ? e.from_estimate : null });
  }
  return out;
}

/**
 * The art proofs a copy shows: what was chosen on each graphics job that
 * covers the source and does not move to the copy, then whatever the
 * source itself showed from an earlier copy. Jobs the copy will own
 * (`ownedByCopy`) are left out.
 */
export function proofsForCopy(
  jobs: Array<{ id: string; estimate_attach?: { file_ids?: unknown } | null }>,
  sourceCopied: unknown,
  sourceNumber: string | null,
  ownedByCopy: Set<string>,
): CopiedProof[] {
  const fromJobs = jobs
    .filter(j => !ownedByCopy.has(j.id))
    .map(j => ({ job_id: j.id, file_ids: j.estimate_attach?.file_ids, from_estimate: sourceNumber }));
  return sanitizeCopiedProofs([...fromJobs, ...sanitizeCopiedProofs(sourceCopied)])
    .filter(p => !ownedByCopy.has(p.job_id));
}

/**
 * Work out the copy's art proofs, and for a revision which jobs move to it.
 *
 * - `copyInGroup`: the copy stays in the source's fleet order, whose one
 *   job already covers it, so that job is neither shown nor moved.
 * - `revision` and `sourceOnSalesOrder`: a revision of an estimate not yet
 *   on a Sales Order takes over the source's own jobs.
 */
export async function planCopiedProofs(
  supabase: SupabaseClient,
  source: { id: string; estimate_number: string | null; fleet_group_id: string | null; copied_graphics_proofs?: unknown; netsuite_so_id?: string | null },
  opts: { copyInGroup: boolean; revision: boolean },
): Promise<{ copied: CopiedProof[]; moveJobIds: string[] }> {
  const groupId = !opts.copyInGroup ? source.fleet_group_id : null;
  const { data: jobs } = await supabase
    .from('graphics_jobs')
    .select('id, estimate_id, estimate_attach')
    .or(groupId ? `estimate_id.eq.${source.id},fleet_group_id.eq.${groupId}` : `estimate_id.eq.${source.id}`)
    .order('created_at', { ascending: true });
  const rows = (jobs || []) as Array<{ id: string; estimate_id: string | null; estimate_attach: any }>;
  const moveJobIds = opts.revision && !source.netsuite_so_id
    ? rows.filter(j => j.estimate_id === source.id).map(j => j.id)
    : [];
  const copied = proofsForCopy(rows, source.copied_graphics_proofs, source.estimate_number, new Set(moveJobIds));
  return { copied, moveJobIds };
}
