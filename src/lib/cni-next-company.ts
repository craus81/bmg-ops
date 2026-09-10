import type { SupabaseClient } from '@supabase/supabase-js';
import { rankForJob } from './cni-match-inputs';
import { nextBestCompany } from './invite-matching';

/**
 * The top-ranked company for a job that has NOT already been invited — the
 * name the SLA alert puts in front of a coordinator instead of "try someone
 * else". Ranked through the same loader the invite picker uses, so the alert
 * and the picker can never disagree about who is next.
 *
 * Returns null rather than throwing: a suggestion is a nicety on an alert
 * that has to go out either way, and a ranking failure must not swallow the
 * "nobody is coming" message it rides on.
 */
export async function suggestNextCompany(
  service: SupabaseClient,
  jobId: string,
  alreadyInvited: string[],
): Promise<{ companyId: string; companyName: string } | null> {
  try {
    const ranked = await rankForJob(service, jobId);
    if (!ranked) return null;
    const next = nextBestCompany(ranked.matches, alreadyInvited);
    return next ? { companyId: next.companyId, companyName: next.companyName } : null;
  } catch {
    return null;
  }
}
