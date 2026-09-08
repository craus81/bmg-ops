/**
 * Proof revision rounds (R6-10).
 *
 * Proof approval state lived as single columns on graphics_jobs, one
 * approval at a time. The second time a customer rejected a proof, the
 * first rejection's reason was overwritten — and with it the only record
 * of what the designer had been asked to fix. "How many rounds did this
 * job take, and what did they want changed each time?" had no answer.
 *
 * A round is one proof sent to a customer: what it addresses, which file
 * went, and how it ended.
 */

export type RoundOutcome = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface ProofRound {
  id?: string;
  round_number: number;
  addressing?: string | null;
  proof_file_id?: string | null;
  sent_at?: string | null;
  outcome: RoundOutcome;
  decided_at?: string | null;
  rejection_reason?: string | null;
}

/** "First proof" / "Revision 2" — round 1 is not a revision. */
export function roundLabel(roundNumber: number): string {
  if (roundNumber <= 1) return 'First proof';
  return `Revision ${roundNumber - 1}`;
}

/** The number the next send should take. */
export function nextRoundNumber(rounds: ProofRound[]): number {
  if (rounds.length === 0) return 1;
  return Math.max(...rounds.map(r => Number(r.round_number) || 0)) + 1;
}

/**
 * What a new round is addressing: the most recent REJECTION's reason.
 * Null on a first proof, and null when the previous round was abandoned
 * rather than rejected — a superseded round asked for nothing.
 */
export function addressingFor(rounds: ProofRound[]): string | null {
  const rejected = rounds
    .filter(r => r.outcome === 'rejected' && (r.rejection_reason || '').trim())
    .sort((a, b) => b.round_number - a.round_number);
  return rejected.length > 0 ? (rejected[0].rejection_reason || '').trim() : null;
}

export interface RoundSummary {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  superseded: number;
  /** Highest round number reached. */
  current: number;
  /** True once a customer has rejected at least once. */
  hasRevisions: boolean;
  /** What the open round is addressing, if any. */
  addressing: string | null;
}

export function summarizeRounds(rounds: ProofRound[]): RoundSummary {
  const by = (o: RoundOutcome) => rounds.filter(r => r.outcome === o).length;
  const open = rounds.find(r => r.outcome === 'pending');
  return {
    total: rounds.length,
    approved: by('approved'),
    rejected: by('rejected'),
    pending: by('pending'),
    superseded: by('superseded'),
    current: rounds.length === 0 ? 0 : Math.max(...rounds.map(r => Number(r.round_number) || 0)),
    hasRevisions: by('rejected') > 0,
    addressing: (open?.addressing || '').trim() || null,
  };
}

/** Board chip: "R3" once a job is past its first proof, nothing before. */
export function roundChip(summary: RoundSummary): { text: string; tone: 'none' | 'warn' | 'bad' } | null {
  if (summary.current <= 1) return null;
  return {
    text: `R${summary.current}`,
    // Three or more rounds is where a job stops being normal.
    tone: summary.current >= 4 ? 'bad' : summary.current >= 3 ? 'warn' : 'none',
  };
}

// ── Per-customer rollup ───────────────────────────────────────────────

export interface JobRoundCount {
  customerName: string | null;
  /** Rounds this job actually went through. */
  rounds: number;
  /** False while the job is still waiting on a customer. */
  settled: boolean;
}

export interface CustomerRevisionStat {
  customer: string;
  jobs: number;
  totalRounds: number;
  avgRounds: number;
  /** Jobs that needed more than one proof. */
  revisedJobs: number;
  worstJobRounds: number;
}

/**
 * Average rounds per customer, over SETTLED jobs only.
 *
 * A job still waiting on its first answer has taken one round so far and
 * might take four. Counting it as 1 drags every average toward 1 and
 * makes a customer look better the more work of theirs is currently
 * stuck — precisely backwards. Unsettled jobs are excluded and counted
 * separately so the exclusion is visible rather than silent.
 */
export function customerRevisionStats(
  jobs: JobRoundCount[],
): { rows: CustomerRevisionStat[]; excludedInFlight: number } {
  const settled = jobs.filter(j => j.settled);
  const byCustomer = new Map<string, JobRoundCount[]>();
  for (const job of settled) {
    const key = (job.customerName || '').trim() || 'No customer';
    const bucket = byCustomer.get(key) || [];
    bucket.push(job);
    byCustomer.set(key, bucket);
  }

  const rows: CustomerRevisionStat[] = [];
  for (const [customer, list] of byCustomer) {
    const totalRounds = list.reduce((n, j) => n + j.rounds, 0);
    rows.push({
      customer,
      jobs: list.length,
      totalRounds,
      avgRounds: Math.round((totalRounds / list.length) * 100) / 100,
      revisedJobs: list.filter(j => j.rounds > 1).length,
      worstJobRounds: Math.max(...list.map(j => j.rounds)),
    });
  }

  // Worst first — the point of the report is who to talk to.
  rows.sort((a, b) => b.avgRounds - a.avgRounds || b.jobs - a.jobs);
  return { rows, excludedInFlight: jobs.length - settled.length };
}

// ── Server-side round bookkeeping ─────────────────────────────────────

type Db = { from: (table: string) => any };

/**
 * Open a round for a proof send.
 *
 * Called on a FRESH send only — a reminder re-mints the token for the
 * same proof and the same ask, so it belongs to the round already open
 * rather than starting a new one.
 *
 * Any round still pending is marked superseded rather than deleted: the
 * customer was shown it, so it happened, even though nobody answered.
 *
 * Never throws into the caller. Losing the history row costs the round
 * count; failing the send would cost the customer their proof.
 */
export async function openProofRound(
  service: Db,
  jobId: string,
  opts: { proofFileId?: string | null; sentBy?: string | null },
): Promise<{ roundNumber: number; addressing: string | null } | null> {
  try {
    const { data: existing } = await service
      .from('graphics_proof_rounds')
      .select('id, round_number, outcome, rejection_reason')
      .eq('job_id', jobId)
      .order('round_number');
    const rounds = (existing || []) as ProofRound[];

    const stillOpen = rounds.filter(r => r.outcome === 'pending');
    if (stillOpen.length > 0) {
      await service
        .from('graphics_proof_rounds')
        .update({ outcome: 'superseded' })
        .eq('job_id', jobId)
        .eq('outcome', 'pending');
    }

    const roundNumber = nextRoundNumber(rounds);
    const addressing = addressingFor(rounds);
    const { error } = await service.from('graphics_proof_rounds').insert({
      job_id: jobId,
      round_number: roundNumber,
      addressing,
      proof_file_id: opts.proofFileId || null,
      sent_at: new Date().toISOString(),
      sent_by: opts.sentBy || null,
      outcome: 'pending',
    });
    if (error) {
      console.error('openProofRound insert failed:', error.message);
      return null;
    }
    return { roundNumber, addressing };
  } catch (err) {
    console.error('openProofRound failed:', err);
    return null;
  }
}

/**
 * Close the open round with the customer's answer. Best-effort for the
 * same reason: the decision itself is already recorded on graphics_jobs.
 */
export async function closeProofRound(
  service: Db,
  jobId: string,
  outcome: 'approved' | 'rejected',
  rejectionReason?: string | null,
): Promise<void> {
  try {
    const patch: Record<string, unknown> = {
      outcome,
      decided_at: new Date().toISOString(),
    };
    // The CHECK constraint requires a reason on a rejection; a customer
    // who rejected without typing one still gets an honest placeholder
    // rather than the write failing.
    if (outcome === 'rejected') {
      patch.rejection_reason = (rejectionReason || '').trim() || 'No reason given.';
    }
    await service
      .from('graphics_proof_rounds')
      .update(patch)
      .eq('job_id', jobId)
      .eq('outcome', 'pending');
  } catch (err) {
    console.error('closeProofRound failed:', err);
  }
}
