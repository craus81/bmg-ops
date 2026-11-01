import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '../supabase-service';
import { NO_ANSWER_MS, reasonOf, recordUrl, scrub, thrownAnswer, whoSent } from '../netsuite-sends';
import { switchIsOn } from './switches';

/**
 * FleetSuite's own numbers (Books part 67, migration 497, docs/books.md "Own
 * numbers"; the plan has every sales order and PO start in FleetSuite with its
 * own number, and FleetSuite's numbers copied to NetSuite, from the second
 * quarter of 2027). Built switched off.
 *
 * Once Books → Switches has FleetSuite's own numbers on, each sales order, PO,
 * invoice and credit memo FleetSuite makes in NetSuite (src/lib/netsuite.ts,
 * and a drop ship PO NetSuite makes for FleetSuite's sales order) gets the
 * next number of its kind before it's sent, and NetSuite gets it as the
 * document's number. NetSuite keeps it only when Allow Override is ticked for
 * that kind (Setup → Company → Auto-Generated Numbers), so the number NetSuite
 * kept is read back and kept beside FleetSuite's, and the daily check tells
 * the super admins when NetSuite kept its own. Every number taken is kept with
 * what became of it, and none is given twice, so each gap has its reason.
 * While it's off, or when its switch can't be read, NetSuite numbers them as
 * it does today. A number that can't be taken while it's on sends nothing.
 *
 * Bills already carry FleetSuite's number: the Reference No. FleetSuite sends
 * with each one (the vendor's invoice number) is the bill's number in NetSuite.
 */

export type OwnNumberType = 'sales_order' | 'purchase_order' | 'invoice' | 'credit_memo';

export const OWN_NUMBER_TYPES: readonly OwnNumberType[] = ['sales_order', 'purchase_order', 'invoice', 'credit_memo'];

export const isOwnNumberType = (v: unknown): v is OwnNumberType => typeof v === 'string' && (OWN_NUMBER_TYPES as string[]).includes(v);

/**
 * Each kind in words: one of it, with its article, the list's heading, NetSuite's name under Auto-Generated Numbers,
 * and NetSuite's record.
 */
export const OWN_NUMBER_KINDS: Readonly<Record<OwnNumberType, { one: string; a: string; many: string; netsuite: string; record: string }>> = {
  sales_order: { one: 'sales order', a: 'a sales order', many: 'Sales orders', netsuite: 'Sales Order', record: 'salesOrder' },
  purchase_order: { one: 'PO', a: 'a PO', many: 'POs', netsuite: 'Purchase Order', record: 'purchaseOrder' },
  invoice: { one: 'invoice', a: 'an invoice', many: 'Invoices', netsuite: 'Invoice', record: 'invoice' },
  credit_memo: { one: 'credit memo', a: 'a credit memo', many: 'Credit memos', netsuite: 'Credit Memo', record: 'creditMemo' },
};

// ── Taking a number for a send ─────────────────────────────────────────────

/** What became of a number. */
export type NumberEnd =
  | { status: 'made'; netsuiteId: string | null; netsuiteNumber: string | null }
  | { status: 'refused' | 'unsure'; note: string };

/** Where numbers are taken and kept. */
export interface NumberKeeper {
  /** The next number of the kind while FleetSuite's own numbers is on, null while it's off; throws when it can't take one. */
  reserve(type: OwnNumberType): Promise<{ id: string; number: string } | null>;
  /** Keeps what became of it; throws when it can't. */
  settle(id: string, end: NumberEnd): Promise<void>;
}

let service: SupabaseClient | null = null;
const db = () => (service ??= createServiceClient());

/** The keeper FleetSuite uses outside the tests: own_numbers' switch, own_number_reserve and own_number_settle. */
export const tableKeeper: NumberKeeper = {
  async reserve(type) {
    if (!(await switchIsOn(db(), 'own_numbers'))) return null;
    const { data, error } = await db().rpc('own_number_reserve', { p_type: type, p_by: await whoSent() });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { reserved_id?: unknown; reserved_number?: unknown } | null;
    if (typeof row?.reserved_id !== 'string' || typeof row.reserved_number !== 'string') throw new Error('no number came back');
    return { id: row.reserved_id, number: row.reserved_number };
  },
  async settle(id, end) {
    const { error } = await db().rpc('own_number_settle', {
      p_id: id,
      p_status: end.status,
      p_netsuite_id: end.status === 'made' ? end.netsuiteId : null,
      p_netsuite_number: end.status === 'made' ? end.netsuiteNumber : null,
      p_note: end.status === 'made' ? null : end.note,
    });
    if (error) throw new Error(error.message);
  },
};

let chosenKeeper: NumberKeeper | null | undefined;

/** For tests: take numbers from this keeper, or none with null; undefined goes back to own_numbers. */
export function setNumberKeeper(keeper: NumberKeeper | null | undefined): void {
  chosenKeeper = keeper;
}

function currentKeeper(): NumberKeeper | null {
  if (chosenKeeper !== undefined) return chosenKeeper;
  // None under the test runner unless a test asks: the tests that mock fetch see only NetSuite's requests.
  return process.env.VITEST ? null : tableKeeper;
}

/** One send's number, and how it says what became of it. Saying it never throws, and only the first saying counts. */
export interface OwnNumber {
  ok: true;
  /** FleetSuite's number, sent as the document's tranId; null while own numbers are off, and NetSuite numbers it. */
  number: string | null;
  /** NetSuite made it: its internal ID and the number it kept, when FleetSuite read them back. */
  made(netsuiteId: string | null | undefined, netsuiteNumber: string | null | undefined): Promise<void>;
  /** NetSuite refused it, so nothing has the number. */
  refused(reason: string): Promise<void>;
  /** FleetSuite can't tell whether NetSuite made it. */
  unsure(reason: string): Promise<void>;
  /** NetSuite answered with an error: one it gives for what was sent (4xx) refused it, any other leaves FleetSuite unsure. */
  failed(status: number, text: string | null): Promise<void>;
  /** The send never heard back. */
  lost(err: unknown): Promise<void>;
}

/** Why a number couldn't be taken: nothing is sent. */
export interface NoOwnNumber {
  ok: false;
  error: string;
}

const nothing = async () => {};
const OFF: OwnNumber = { ok: true, number: null, made: nothing, refused: nothing, unsure: nothing, failed: nothing, lost: nothing };

const kept = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The number for a document of `type` FleetSuite is about to send to NetSuite: FleetSuite's own while it's switched
 * on, or none, and NetSuite numbers it. Taken just before the send, so a document refused before it goes takes none.
 */
export async function ownNumberFor(type: OwnNumberType): Promise<OwnNumber | NoOwnNumber> {
  const keeper = currentKeeper();
  if (!keeper) return OFF;
  let reserved: { id: string; number: string } | null;
  try {
    reserved = await keeper.reserve(type);
  } catch (err) {
    console.error(`[own-numbers] couldn't take a ${type} number:`, (err as Error)?.message || err);
    return {
      ok: false,
      error: `FleetSuite couldn't give this ${OWN_NUMBER_KINDS[type].one} its number, so nothing was sent to NetSuite. Try again in a moment.`,
    };
  }
  if (!reserved) return OFF;
  const { id, number } = reserved;

  let said = false;
  const end = async (e: NumberEnd) => {
    if (said) return;
    said = true;
    try {
      await keeper.settle(id, e);
    } catch (err) {
      // The document's fate doesn't hang on it: the number stays as on its way, which Books → Own numbers shows.
      console.warn(`[own-numbers] couldn't keep what became of ${number}:`, (err as Error)?.message || err);
    }
  };
  const refused = (reason: string) => end({ status: 'refused', note: scrub(reason) || 'NetSuite refused it.' });
  const unsure = (reason: string) => end({ status: 'unsure', note: scrub(reason) || "FleetSuite couldn't tell whether NetSuite made it." });
  return {
    ok: true,
    number,
    made: (netsuiteId, netsuiteNumber) => end({ status: 'made', netsuiteId: kept(netsuiteId), netsuiteNumber: kept(netsuiteNumber) }),
    refused,
    unsure,
    failed: (status, text) => (status >= 400 && status < 500
      ? refused(reasonOf(text) || `NetSuite refused it (${status}).`)
      : unsure(reasonOf(text) || `NetSuite answered ${status}, which doesn't say whether it made it.`)),
    lost: (err) => unsure(thrownAnswer(err).error ?? ''),
  };
}

/**
 * Whether the number NetSuite kept is FleetSuite's: the same but for case, or with a PO's customer after a dash
 * (src/lib/po-number.ts). The same rule as own_numbers.kept_own (migration 497).
 */
export function keptOurs(ours: string, netsuite: string | null | undefined): boolean {
  const theirs = String(netsuite ?? '').trim().toUpperCase();
  const mine = ours.toUpperCase();
  return theirs === mine || theirs.startsWith(`${mine}-`);
}

// ── Books → Own numbers ────────────────────────────────────────────────────

export interface SeriesRow {
  doc_type: OwnNumberType;
  prefix: string;
  next_seq: number | string;
  changed_by: string | null;
  changed_at: string | null;
}

export interface NumberRow {
  id: string;
  doc_type: OwnNumberType;
  number: string;
  reserved_at: string;
  reserved_by: string | null;
  status: 'reserved' | 'made' | 'refused' | 'unsure';
  settled_at: string | null;
  netsuite_id: string | null;
  netsuite_number: string | null;
  note: string | null;
  kept_own: boolean | null;
}

export const NUMBER_COLUMNS = 'id, doc_type, number, reserved_at, reserved_by, status, settled_at, netsuite_id, netsuite_number, note, kept_own';

/** How a number stands, as Books → Own numbers shows it. */
export type Standing = 'made' | 'kept_own' | 'refused' | 'unsure' | 'sending' | 'no_answer';

/** What became of a number, in words: what the page shows beside it. */
export function standingOf(row: NumberRow, now: Date): { standing: Standing; text: string } {
  const kind = OWN_NUMBER_KINDS[row.doc_type] ?? OWN_NUMBER_KINDS.invoice;
  if (row.status === 'made') {
    if (row.netsuite_number && !keptOurs(row.number, row.netsuite_number)) {
      return {
        standing: 'kept_own',
        text: `NetSuite made it but kept its own number, ${row.netsuite_number}. Tick Allow Override for ${kind.netsuite} in NetSuite.`,
      };
    }
    return { standing: 'made', text: row.netsuite_number ? 'Made in NetSuite.' : "Made in NetSuite, which didn't say what number it kept." };
  }
  if (row.status === 'refused') return { standing: 'refused', text: `NetSuite refused it, so nothing has this number: ${row.note ?? 'no reason given.'}` };
  if (row.status === 'unsure') {
    return { standing: 'unsure', text: `Not sure NetSuite made it: ${row.note ?? 'no answer.'} Look for ${row.number} in NetSuite.` };
  }
  return now.getTime() - Date.parse(row.reserved_at) > NO_ANSWER_MS
    ? { standing: 'no_answer', text: `FleetSuite never heard back from NetSuite. Look for ${row.number} in NetSuite.` }
    : { standing: 'sending', text: 'On its way to NetSuite.' };
}

/** The largest next number a kind can have. */
export const MAX_NEXT = 999_999_999;

/** A super admin's change to a kind's letters and next number, checked: the letters upper-cased. */
export function seriesChange(prefix: unknown, next: unknown): { prefix: string; next: number } | { error: string } {
  const letters = typeof prefix === 'string' ? prefix.trim().toUpperCase() : '';
  if (!/^[A-Z]{1,6}$/.test(letters)) return { error: 'The letters are one to six letters, A to Z, like INV.' };
  const n = typeof next === 'number' ? next : typeof next === 'string' && /^\s*\d+\s*$/.test(next) ? Number(next) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_NEXT) return { error: `The next number is a whole number from 1 to ${MAX_NEXT.toLocaleString('en-US')}.` };
  return { prefix: letters, next: n };
}

/** 'YYYY-MM-DD' in Chicago. */
/** The kind that already has these letters, when another one does: two kinds with the same letters would read alike. */
export function lettersTakenBy(rows: SeriesRow[], type: OwnNumberType, prefix: string): string | null {
  const other = rows.find((r) => r.doc_type !== type && r.prefix.toUpperCase() === prefix.toUpperCase());
  return other ? OWN_NUMBER_KINDS[other.doc_type].many : null;
}

const centralDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);

/** How far back Books → Own numbers looks for sales orders and POs made in NetSuite while it's off. */
export const OUTSIDE_DAYS_OFF = 30;

/**
 * The day sales orders and POs made in NetSuite are listed from: the day FleetSuite's own numbers went on, or while
 * it's off, OUTSIDE_DAYS_OFF days back, to show who still makes them there.
 */
export function outsideSince(state: { on: boolean; changedAt: string | null }, now: Date): string {
  if (state.on) return centralDay(state.changedAt && !Number.isNaN(Date.parse(state.changedAt)) ? new Date(state.changedAt) : now);
  return centralDay(new Date(now.getTime() - OUTSIDE_DAYS_OFF * 86_400_000));
}

/** A sales order or PO made in NetSuite instead of FleetSuite (own_numbers_made_outside, migration 497). */
export interface OutsideRow {
  netsuite_id: string;
  doc_type: 'sales_order' | 'purchase_order';
  tranid: string | null;
  trandate: string;
  party: string | null;
  created_by_name: string | null;
  told_at?: string | null;
}

/** Whether FleetSuite's own numbers is on, and since when. */
export async function readOwnNumbersSwitch(service: SupabaseClient): Promise<{ on: boolean; changedAt: string | null }> {
  const { data, error } = await service.from('books_switches').select('is_on, changed_at').eq('piece', 'own_numbers').maybeSingle();
  if (error) throw new Error(`Couldn't read the switch: ${error.message}`);
  const row = data as { is_on?: boolean | null; changed_at?: string | null } | null;
  return { on: row?.is_on === true, changedAt: row?.changed_at ?? null };
}

/** Each kind's letters and next number, in OWN_NUMBER_TYPES order. */
export async function readSeries(service: SupabaseClient): Promise<SeriesRow[]> {
  const { data, error } = await service.from('own_number_series').select('doc_type, prefix, next_seq, changed_by, changed_at');
  if (error) throw new Error(`Couldn't read the numbers: ${error.message}`);
  const rows = new Map(((data ?? []) as SeriesRow[]).map((r) => [r.doc_type, r]));
  return OWN_NUMBER_TYPES.flatMap((t) => (rows.has(t) ? [rows.get(t)!] : []));
}

/** Numbers a page of Books → Own numbers shows. */
export const NUMBERS_PAGE = 100;

/** The numbers FleetSuite took, newest first, of one kind or all. */
export async function readNumbers(service: SupabaseClient, type: OwnNumberType | null): Promise<NumberRow[]> {
  let query = service.from('own_numbers').select(NUMBER_COLUMNS);
  if (type) query = query.eq('doc_type', type);
  const { data, error } = await query
    .order('reserved_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(NUMBERS_PAGE);
  if (error) throw new Error(`Couldn't read the numbers taken: ${error.message}`);
  return (data ?? []) as NumberRow[];
}

/** Sales orders and POs Books → Own numbers shows made in NetSuite. */
export const OUTSIDE_PAGE = 200;

/** The sales orders and POs made in NetSuite instead of FleetSuite from `since`, newest first. */
export async function readOutside(service: SupabaseClient, since: string): Promise<OutsideRow[]> {
  const { data, error } = await service.rpc('own_numbers_made_outside', { p_since: since, p_limit: OUTSIDE_PAGE });
  if (error) throw new Error(`Couldn't read what was made in NetSuite: ${error.message}`);
  return (data ?? []) as OutsideRow[];
}

/** A kind's letters and next number as Books → Own numbers shows them. */
export function seriesView(row: SeriesRow, names: Map<string, string>) {
  const next = Number(row.next_seq);
  return {
    type: row.doc_type,
    many: OWN_NUMBER_KINDS[row.doc_type].many,
    prefix: row.prefix,
    next,
    nextNumber: `${row.prefix}${next}`,
    changedAt: row.changed_at,
    changedBy: row.changed_by ? names.get(row.changed_by) ?? 'Someone' : null,
  };
}

/** A number FleetSuite took as Books → Own numbers shows it: what became of it, who took it, and NetSuite's page. */
export function numberView(row: NumberRow, now: Date, names: Map<string, string>) {
  const { standing, text } = standingOf(row, now);
  return {
    id: row.id,
    type: row.doc_type,
    one: OWN_NUMBER_KINDS[row.doc_type]?.one ?? row.doc_type,
    number: row.number,
    at: row.reserved_at,
    by: row.reserved_by ? names.get(row.reserved_by) ?? null : null,
    standing,
    text,
    netsuiteNumber: row.netsuite_number,
    link: recordUrl(OWN_NUMBER_KINDS[row.doc_type]?.record ?? null, row.netsuite_id),
  };
}

/** A sales order or PO made in NetSuite instead, as Books → Own numbers shows it. */
export function outsideView(row: OutsideRow) {
  return {
    netsuiteId: row.netsuite_id,
    type: row.doc_type,
    one: OWN_NUMBER_KINDS[row.doc_type].one,
    number: row.tranid,
    date: String(row.trandate).slice(0, 10),
    party: row.party,
    by: row.created_by_name,
    told: !!row.told_at,
    link: recordUrl(OWN_NUMBER_KINDS[row.doc_type].record, row.netsuite_id),
  };
}

export type SeriesView = ReturnType<typeof seriesView>;
export type NumberView = ReturnType<typeof numberView>;
export type OutsideView = ReturnType<typeof outsideView>;

// ── The daily check ────────────────────────────────────────────────────────

/** Something about FleetSuite's own numbers the daily check tells the super admins about. */
export type NumberAlertItem =
  | { kind: 'kept'; id: string; type: OwnNumberType; number: string; netsuiteNumber: string }
  | { kind: 'outside'; netsuiteId: string; type: 'sales_order' | 'purchase_order'; tranid: string | null; date: string; party: string | null; by: string | null };

/** The most of each one look tells about; any more are told about at the next. */
const NUMBERS_AT_A_LOOK = 200;

/**
 * What the daily check tells about while FleetSuite's own numbers is on, oldest first: numbers NetSuite didn't keep,
 * and sales orders and POs made in NetSuite instead since it went on, each once. Nothing while it's off.
 */
export async function lookAtOwnNumbers(service: SupabaseClient, now: Date): Promise<NumberAlertItem[]> {
  const state = await readOwnNumbersSwitch(service);
  if (!state.on) return [];
  const { data, error } = await service.rpc('own_numbers_to_tell', { p_since: outsideSince(state, now), p_limit: NUMBERS_AT_A_LOOK });
  if (error) throw new Error(`couldn't read the numbers to tell about (${error.message})`);
  const told = (data ?? {}) as {
    kept?: Array<{ id: string; doc_type: OwnNumberType; number: string; netsuite_number: string }>;
    outside?: Array<Omit<OutsideRow, 'told_at'>>;
  };
  return [
    ...(told.kept ?? []).map((k): NumberAlertItem => ({
      kind: 'kept', id: k.id, type: k.doc_type, number: k.number, netsuiteNumber: k.netsuite_number,
    })),
    ...(told.outside ?? []).map((o): NumberAlertItem => ({
      kind: 'outside', netsuiteId: o.netsuite_id, type: o.doc_type, tranid: o.tranid, date: String(o.trandate).slice(0, 10),
      party: o.party, by: o.created_by_name,
    })),
  ];
}

/** Marks what the daily check told about, so no later look tells about it again. */
export async function markOwnNumbersTold(service: SupabaseClient, items: NumberAlertItem[]): Promise<void> {
  const { error } = await service.rpc('own_numbers_mark_told', {
    p_number_ids: items.flatMap((i) => (i.kind === 'kept' ? [i.id] : [])),
    p_outside_ids: items.flatMap((i) => (i.kind === 'outside' ? [i.netsuiteId] : [])),
  });
  if (error) throw new Error(`couldn't mark the numbers told about (${error.message})`);
}
