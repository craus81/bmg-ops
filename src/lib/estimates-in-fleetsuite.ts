import type { SupabaseClient } from '@supabase/supabase-js';
import { switchIsOn } from '@/lib/books/switches';

/**
 * Estimates in FleetSuite only (migration 479, docs/books.md "Estimates in
 * FleetSuite only"; owner decisions 2026-10-31, thread "Replacing NetSuite
 * with FleetSuite": from January 2027 estimates stop going to NetSuite).
 *
 * The books switch estimates_in_fleetsuite (src/lib/books/switches.ts), off
 * until a super admin turns it on in Books → Switches. While it's off,
 * estimates push to NetSuite as they do now. Once it's on, nobody pushes or
 * syncs an estimate to NetSuite: /api/estimates/push and the wrap quote's
 * old NetSuite quote (/api/wrap-quote/netsuite) refuse, and the estimate's
 * Push button goes. NetSuite still gets each job's sales order when it's
 * made. An estimate pushed before keeps its NetSuite copy, which deleting
 * the estimate still deletes and converting it to a sales order still closes.
 */

/** Why a push or sync of an estimate was refused. */
export const ESTIMATES_STAY_REFUSAL =
  "Estimates stay in FleetSuite now, so nothing was sent to NetSuite. NetSuite gets the job's sales order when it's made.";

/** Why the wrap quote's old NetSuite quote was refused. */
export const WRAP_QUOTE_STAYS_REFUSAL =
  "Estimates stay in FleetSuite now, so no NetSuite quote was made. Open the quote's estimate instead.";

/** On an estimate, where Push to NetSuite as Estimate was. */
export const ESTIMATES_STAY_LINE = "Estimates stay in FleetSuite. NetSuite gets the sales order when it's made.";

/** On an estimate pushed before, where "Edit below & sync changes" was. */
export const PUSHED_BEFORE_LINE = "NetSuite's copy closes with the sales order";

/** Told to FleetSuite AI, which otherwise sends people to push a new estimate. */
export const ESTIMATES_STAY_PROMPT =
  "IMPORTANT: Estimates stay in FleetSuite now. Never tell anyone to push an estimate to NetSuite; NetSuite gets the job's sales order when the estimate is converted to one.";

/** What FleetSuite AI's prompt gets added once estimates stay in FleetSuite, and nothing while they push. */
export async function estimatesPromptNote(service: SupabaseClient): Promise<string> {
  return (await switchIsOn(service, 'estimates_in_fleetsuite')) ? `\n\n${ESTIMATES_STAY_PROMPT}` : '';
}
