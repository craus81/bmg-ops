import type { SupabaseClient } from '@supabase/supabase-js';
import { NO_ANSWER_MS, describeSend, recordUrl, type SendAction, type SendOutcome } from '@/lib/netsuite-sends';

/**
 * Books → NetSuite feed (docs/books.md "NetSuite feed"): every send FleetSuite
 * made to NetSuite (netsuite_sends, migration 477, kept by
 * src/lib/netsuite-sends.ts) and what NetSuite answered, newest first, and the
 * ones FleetSuite can't be sure about (an answer that didn't say, or none at
 * all) until someone has looked for them in NetSuite. NetSuite may have
 * made those anyway, so they're looked for before anyone tries again. Open to
 * whoever opens the books.
 */

/** How a send stands: NetSuite took it or refused it, FleetSuite isn't sure, it never heard back, or it's on its way. */
export type FeedOutcome = SendOutcome | 'no_answer' | 'sending';

/** A row of netsuite_sends as the feed reads it. */
export interface SendRecord {
  id: string;
  started_at: string;
  finished_at: string | null;
  action: SendAction;
  record_type: string;
  record_id: string | null;
  made_type: string | null;
  made_id: string | null;
  doc_ref: string | null;
  outcome: SendOutcome | null;
  http_status: number | null;
  error: string | null;
  user_id: string | null;
  looked_at: string | null;
  looked_by: string | null;
  looked_note: string | null;
}

export const SEND_COLUMNS = 'id, started_at, finished_at, action, record_type, record_id, made_type, made_id, doc_ref, outcome, '
  + 'http_status, error, user_id, looked_at, looked_by, looked_note';

/** A send as the feed shows it. */
export interface FeedSend {
  id: string;
  at: string;
  answeredAt: string | null;
  what: string;
  outcome: FeedOutcome;
  status: number | null;
  error: string | null;
  docRef: string | null;
  /** NetSuite's internal ID of what it made, or of the record changed or made from. */
  netsuiteId: string | null;
  link: string | null;
  who: string | null;
  looked: { at: string; by: string | null; note: string | null } | null;
}

/** The days the summary counts. */
export const SUMMARY_DAYS = 7;
/** Sends a page of the feed shows. */
export const FEED_PAGE = 50;
/** The most sends to look at the feed lists. */
const TO_LOOK_LIMIT = 100;

/** How a send stands at `now`. One without an answer more than NO_ANSWER_MS on never heard back, as the reads below count it. */
export function feedOutcome(row: Pick<SendRecord, 'outcome' | 'started_at'>, now: Date): FeedOutcome {
  if (row.outcome) return row.outcome;
  return now.getTime() - Date.parse(row.started_at) > NO_ANSWER_MS ? 'no_answer' : 'sending';
}

/** FleetSuite can't be sure NetSuite did it: its answer didn't say, or it never came. */
export const isUnsure = (outcome: FeedOutcome) => outcome === 'unsure' || outcome === 'no_answer';

const cutoffOf = (now: Date) => new Date(now.getTime() - NO_ANSWER_MS).toISOString();
/** PostgREST's filter for the sends FleetSuite can't be sure about at `now`. */
const unsureFilter = (now: Date) => `outcome.eq.unsure,and(outcome.is.null,started_at.lt.${cutoffOf(now)})`;

/** The kinds of record the feed can be narrowed to. */
export const FEED_KINDS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'salesOrder', name: 'Sales orders' },
  { key: 'invoice', name: 'Invoices' },
  { key: 'estimate', name: 'Estimates' },
  { key: 'itemFulfillment', name: 'Fulfillments' },
  { key: 'creditMemo', name: 'Credit memos' },
  { key: 'purchaseOrder', name: 'Purchase orders' },
  { key: 'itemReceipt', name: 'Item receipts' },
  { key: 'vendorBill', name: 'Bills' },
  { key: 'vendorCredit', name: 'Vendor credits' },
  { key: 'journalEntry', name: 'Journal entries' },
  { key: 'inventoryAdjustment', name: 'Inventory adjustments' },
  { key: 'inventoryTransfer', name: 'Inventory transfers' },
  { key: 'customerPayment', name: 'Customer payments' },
  { key: 'customerDeposit', name: 'Customer deposits' },
  { key: 'deposit', name: 'Bank deposits' },
  { key: 'vendorPayment', name: 'Bill payments' },
  { key: 'customer', name: 'Customers' },
  { key: 'vendor', name: 'Vendors' },
  { key: 'contact', name: 'Contacts' },
  { key: 'note', name: 'Notes' },
  { key: 'item', name: 'Items' },
  { key: 'other', name: 'Other' },
];
export type FeedFilter = 'all' | 'took' | 'refused' | 'unsure';

/** What the feed shows of one send, with who sent it and who looked named. */
export function feedSend(row: SendRecord, now: Date, names: Map<string, string>): FeedSend {
  const made = !!row.made_id;
  return {
    id: row.id,
    at: row.started_at,
    answeredAt: row.finished_at,
    what: describeSend(row),
    outcome: feedOutcome(row, now),
    status: row.http_status,
    error: row.error,
    docRef: row.doc_ref,
    netsuiteId: made ? row.made_id : row.record_id,
    link: made ? recordUrl(row.made_type, row.made_id) : row.action === 'delete' ? null : recordUrl(row.record_type, row.record_id),
    who: row.user_id ? names.get(row.user_id) ?? null : null,
    looked: row.looked_at ? { at: row.looked_at, by: row.looked_by ? names.get(row.looked_by) ?? null : null, note: row.looked_note } : null,
  };
}

/** People's names by their IDs, for who sent and who looked. */
export async function readNames(service: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const { data, error } = await service.from('profiles').select('id, full_name').in('id', wanted);
  // A name is only a label: without them the feed still shows every send.
  if (error) return new Map();
  return new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).filter((p) => p.full_name).map((p) => [p.id, p.full_name!]));
}

async function counted(query: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw new Error(`Couldn't count the sends: ${error.message}`);
  return count ?? 0;
}

/** The last SUMMARY_DAYS days' sends: how many NetSuite took, refused, and left FleetSuite unsure about. */
export async function readSummary(service: SupabaseClient, now: Date): Promise<{ days: number; took: number; refused: number; unsure: number }> {
  const since = new Date(now.getTime() - SUMMARY_DAYS * 86_400_000).toISOString();
  const head = () => service.from('netsuite_sends').select('id', { count: 'exact', head: true }).gte('started_at', since);
  const [took, refused, unsure, unanswered] = await Promise.all([
    counted(head().eq('outcome', 'took')),
    counted(head().eq('outcome', 'refused')),
    counted(head().eq('outcome', 'unsure')),
    counted(head().is('outcome', null).lt('started_at', cutoffOf(now))),
  ]);
  return { days: SUMMARY_DAYS, took, refused, unsure: unsure + unanswered };
}

/** The sends FleetSuite can't be sure about that nobody has looked for yet, newest first. */
export async function readToLook(service: SupabaseClient, now: Date): Promise<SendRecord[]> {
  const { data, error } = await service.from('netsuite_sends').select(SEND_COLUMNS)
    .is('looked_at', null)
    .or(unsureFilter(now))
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(TO_LOOK_LIMIT);
  if (error) throw new Error(`Couldn't read the sends to look at: ${error.message}`);
  return (data ?? []) as unknown as SendRecord[];
}

/** One page of the feed, newest first, narrowed to an outcome and a kind of record, and whether there's more. */
export async function readSends(
  service: SupabaseClient,
  opts: { now: Date; filter: FeedFilter; kind: string | null; page: number },
): Promise<{ rows: SendRecord[]; more: boolean }> {
  let q = service.from('netsuite_sends').select(SEND_COLUMNS);
  if (opts.filter === 'took' || opts.filter === 'refused') q = q.eq('outcome', opts.filter);
  if (opts.filter === 'unsure') q = q.or(unsureFilter(opts.now));
  // Any kind of item, and what the item script was asked, are items.
  if (opts.kind === 'item') q = q.or('record_type.eq.item,record_type.eq.script,record_type.like.*Item');
  else if (opts.kind) q = q.eq('record_type', opts.kind);
  const from = opts.page * FEED_PAGE;
  const { data, error } = await q
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + FEED_PAGE);
  if (error) throw new Error(`Couldn't read the sends: ${error.message}`);
  const rows = (data ?? []) as unknown as SendRecord[];
  return { rows: rows.slice(0, FEED_PAGE), more: rows.length > FEED_PAGE };
}

/** Why a send can't be marked looked at, or null when it can. */
export function lookRefusal(row: Pick<SendRecord, 'outcome' | 'started_at' | 'looked_at'> | null, now: Date): { status: number; message: string } | null {
  if (!row) return { status: 404, message: "There's no such send." };
  const outcome = feedOutcome(row, now);
  if (outcome === 'sending') return { status: 409, message: "It's still on its way to NetSuite. Look again in a few minutes." };
  if (!isUnsure(outcome)) return { status: 409, message: `NetSuite ${outcome === 'took' ? 'took' : 'refused'} this one, so there's nothing to look for.` };
  if (row.looked_at) return { status: 409, message: 'Someone has already looked at this one.' };
  return null;
}

/** Notes that a super admin looked for a send in NetSuite, and what they found; false when someone just had. */
export async function markLooked(
  service: SupabaseClient,
  opts: { id: string; by: string; note: string | null; now: Date },
): Promise<boolean> {
  const { data, error } = await service.from('netsuite_sends')
    .update({ looked_at: opts.now.toISOString(), looked_by: opts.by, looked_note: opts.note })
    .eq('id', opts.id)
    .is('looked_at', null)
    .select('id');
  if (error) throw new Error(`Couldn't note it: ${error.message}`);
  return (data ?? []).length > 0;
}
