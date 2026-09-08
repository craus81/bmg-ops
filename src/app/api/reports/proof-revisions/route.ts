import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { customerRevisionStats, type JobRoundCount } from '@/lib/proof-rounds';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/proof-revisions (R6-10) — how many proof rounds each
 * customer's work takes, worst first.
 *
 * Settled jobs only. A job still waiting on its first answer has taken
 * one round SO FAR and might take four; counting it would make a customer
 * look better the more of their work is currently stuck. The count of
 * what was excluded is returned so the omission is visible.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const rounds = await fetchAllRows<any>((from, to) => supabase
      .from('graphics_proof_rounds')
      .select('job_id, round_number, outcome')
      .order('job_id')
      .order('round_number')
      .range(from, to));
    if (rounds.error) throw new Error(`Could not read proof rounds: ${rounds.error.message}`);
    if (rounds.data.length === 0) {
      return NextResponse.json({
        success: true, rows: [], excludedInFlight: 0, jobs: 0,
        note: 'No proofs have been sent since revision rounds started being recorded.',
      });
    }

    const jobIds = [...new Set(rounds.data.map(r => r.job_id as string))];
    const jobs = new Map<string, any>();
    for (let i = 0; i < jobIds.length; i += 200) {
      const { data, error } = await supabase
        .from('graphics_jobs')
        .select('id, customer, job_number')
        .in('id', jobIds.slice(i, i + 200));
      if (error) throw new Error(`Could not read graphics jobs: ${error.message}`);
      for (const j of data || []) jobs.set(j.id, j);
    }

    const byJob = new Map<string, { rounds: number; settled: boolean }>();
    for (const r of rounds.data) {
      const cur = byJob.get(r.job_id) || { rounds: 0, settled: false };
      cur.rounds = Math.max(cur.rounds, Number(r.round_number) || 0);
      // Approved ends a job; a rejection with no follow-up send is also a
      // finished conversation. Only an OPEN round means still waiting.
      if (r.outcome === 'approved') cur.settled = true;
      byJob.set(r.job_id, cur);
    }
    for (const [jobId, v] of byJob) {
      if (!v.settled) {
        const jobRounds = rounds.data.filter(r => r.job_id === jobId);
        v.settled = !jobRounds.some(r => r.outcome === 'pending');
      }
    }

    const counts: JobRoundCount[] = [...byJob.entries()].map(([jobId, v]) => ({
      customerName: jobs.get(jobId)?.customer || null,
      rounds: v.rounds,
      settled: v.settled,
    }));

    const { rows, excludedInFlight } = customerRevisionStats(counts);
    return NextResponse.json({ success: true, rows, excludedInFlight, jobs: counts.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not build the revision report' }, { status: 500 });
  }
}
