import type { SupabaseClient } from '@supabase/supabase-js';
import { readSwitch, switchIsOn } from '@/lib/books/switches';
import { fetchAllRows } from '@/lib/fetch-all';
import { patchEntityRecord, updateCustomer, type CustomerUpdateFields } from '@/lib/netsuite';

/**
 * FleetSuite's record wins (migration 480, docs/books.md "FleetSuite's record
 * wins"; owner decisions, thread "Replacing NetSuite with FleetSuite":
 * FleetSuite is the master for customers, vendors and items from the first
 * quarter of 2027, 2026-10-09, which ends the 2026-09-21 rule that NetSuite's
 * record is the master; the team works only in FleetSuite from January 1,
 * 2027, 2026-10-31).
 *
 * The books switch fleetsuite_records (src/lib/books/switches.ts), off until a
 * super admin turns it on in Books → Switches. While it's off, the NetSuite
 * syncs copy a change made in NetSuite over FleetSuite's record, as they
 * always have. Once it's on, a customer FleetSuite has keeps its name, email,
 * phone and billing address, in the CRM record (prospects) and the customer
 * list (customers) alike, and a vendor its name, email and phone
 * (netsuite_vendors). NetSuite's fills one FleetSuite has blank. Where
 * NetSuite has something else, it's listed on Books → Changed in NetSuite
 * (record_differences): a super admin keeps FleetSuite's, which sends it on to
 * NetSuite, or takes NetSuite's. A customer or vendor FleetSuite hasn't got
 * comes in as now, and what only NetSuite knows (spend, a vendor's terms and
 * whether it's inactive) keeps coming.
 */

export type RecordKind = 'customer' | 'vendor';

/** An address's lines, as NetSuite keeps them and the CRM record stores them. */
export interface AddressLines {
  addr1: string;
  addr2: string;
  city: string;
  state: string;
  zip: string;
}

/** A field's value: text, or an address's lines; null when there's none. */
export type FieldValue = string | AddressLines | null;

export type CustomerField = 'name' | 'email' | 'phone' | 'address';
export type VendorField = 'name' | 'email' | 'phone';
export type RecordField = CustomerField | VendorField;

export type CustomerFacts = Record<CustomerField, FieldValue>;
export type VendorFacts = Record<VendorField, FieldValue>;

/** The fields of each kind FleetSuite's record keeps, in the order the list shows them. */
export const FIELDS: { customer: readonly CustomerField[]; vendor: readonly VendorField[] } = {
  customer: ['name', 'email', 'phone', 'address'],
  vendor: ['name', 'email', 'phone'],
};

export const FIELD_NAMES: Readonly<Record<RecordField, string>> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  address: 'Billing address',
};

export const KIND_NAMES: Readonly<Record<RecordKind, string>> = { customer: 'Customer', vendor: 'Vendor' };

const isKind = (v: unknown): v is RecordKind => v === 'customer' || v === 'vendor';
const isField = (kind: RecordKind, v: unknown): v is RecordField => (FIELDS[kind] as readonly string[]).includes(String(v));

/** Whether FleetSuite's record wins: off when the switch is off or can't be read. */
export const recordsWin = (service: SupabaseClient): Promise<boolean> => switchIsOn(service, 'fleetsuite_records');

/**
 * Whether FleetSuite's record wins, for a sync about to write FleetSuite's records. A switch that can't be read throws
 * instead of counting as off, which would write NetSuite's over FleetSuite's and list nothing.
 */
export async function recordsWinForSync(service: SupabaseClient): Promise<boolean> {
  try {
    return await readSwitch(service, 'fleetsuite_records');
  } catch (err: any) {
    throw new Error(`Couldn't tell whether FleetSuite's record wins: ${err?.message || err}`);
  }
}

// ── The same value, written two ways ───────────────────────────────────────

const ADDRESS_LINES = ['addr1', 'addr2', 'city', 'state', 'zip'] as const;
const words = (s: string) => s.trim().replace(/\s+/g, ' ');

export function isBlank(v: FieldValue | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  return ADDRESS_LINES.every((k) => !String(v[k] ?? '').trim());
}

/**
 * A value as both systems may write the same one: words spaced alike, an email in any case, a phone by its digits
 * (with or without the country's 1), an address's lines in any case. A name's case counts.
 */
function comparable(field: RecordField, v: FieldValue | undefined): string {
  if (isBlank(v)) return '';
  if (typeof v !== 'string') return ADDRESS_LINES.map((k) => words(String(v![k] ?? '')).toLowerCase()).join('\n');
  const s = words(v);
  if (field === 'email') return s.toLowerCase();
  if (field === 'phone') {
    const digits = s.replace(/\D/g, '');
    if (!digits) return s.toLowerCase();
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  }
  return s;
}

export const sameValue = (field: RecordField, a: FieldValue | undefined, b: FieldValue | undefined): boolean =>
  comparable(field, a) === comparable(field, b);

/** A value as the list shows it. */
export function shownValue(v: FieldValue | undefined): string {
  if (isBlank(v)) return '(none)';
  if (typeof v === 'string') return words(v);
  return ADDRESS_LINES.map((k) => words(String(v![k] ?? ''))).filter(Boolean).join(', ');
}

// ── What a sync writes ─────────────────────────────────────────────────────

/** What a sync saw of one field of a record, as note_record_differences takes it. */
export interface Seen {
  kind: RecordKind;
  netsuite_id: string;
  name: string | null;
  field: RecordField;
  fleetsuite: FieldValue;
  netsuite: FieldValue;
  differs: boolean;
}

/**
 * The fields of a record FleetSuite has, as a sync writes them once FleetSuite's record wins: FleetSuite's, or
 * NetSuite's where FleetSuite's is blank. And what it saw of each: one FleetSuite has that NetSuite has something
 * else for differs.
 */
export function keepFleetsuite<F extends RecordField>(
  kind: RecordKind,
  netsuiteId: string,
  name: string | null,
  fields: readonly F[],
  fleetsuite: Record<F, FieldValue>,
  netsuite: Record<F, FieldValue>,
): { values: Record<F, FieldValue>; seen: Seen[] } {
  const values = {} as Record<F, FieldValue>;
  const seen: Seen[] = [];
  for (const field of fields) {
    const mine = isBlank(fleetsuite[field]) ? null : fleetsuite[field];
    const theirs = isBlank(netsuite[field]) ? null : netsuite[field];
    values[field] = mine ?? theirs;
    seen.push({ kind, netsuite_id: netsuiteId, name, field, fleetsuite: mine, netsuite: theirs, differs: mine !== null && !sameValue(field, mine, theirs) });
  }
  return { values, seen };
}

/** No address at all. */
export const NO_ADDRESS: AddressLines = { addr1: '', addr2: '', city: '', state: '', zip: '' };

/** The one line the customer list (customers) keeps an address as. */
export function addressLine(v: FieldValue): string | null {
  if (v === null || typeof v === 'string') return v && v.trim() ? v : null;
  return ADDRESS_LINES.map((k) => v[k]).filter(Boolean).join(', ') || null;
}

/** The CRM record's (prospects) address columns for an address. */
export function prospectAddress(v: FieldValue): { address: string | null; address2: string | null; city: string | null; state: string | null; zip: string | null } {
  const a = v !== null && typeof v !== 'string' ? v : NO_ADDRESS;
  return { address: a.addr1 || null, address2: a.addr2 || null, city: a.city || null, state: a.state || null, zip: a.zip || null };
}

interface ProspectRow {
  netsuite_id: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

const PROSPECT_COLUMNS = 'netsuite_id, company_name, email, phone, address, address2, city, state, zip';

/** A customer's facts as FleetSuite's CRM record has them. */
export function prospectFacts(row: ProspectRow): CustomerFacts {
  return {
    name: row.company_name,
    email: row.email,
    phone: row.phone,
    address: { addr1: row.address ?? '', addr2: row.address2 ?? '', city: row.city ?? '', state: row.state ?? '', zip: row.zip ?? '' },
  };
}

/** NetSuite ids read at once. */
const READ_CHUNK = 200;

/**
 * FleetSuite's CRM records of these NetSuite customers, by NetSuite's id. A read that fails throws: a sync that can't
 * see FleetSuite's record mustn't write over it.
 */
export async function readCustomerRecords(service: SupabaseClient, netsuiteIds: string[]): Promise<Map<string, CustomerFacts>> {
  const ids = [...new Set(netsuiteIds.filter((id) => /^[0-9]+$/.test(id)))];
  const out = new Map<string, CustomerFacts>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await service.from('prospects').select(PROSPECT_COLUMNS).in('netsuite_id', ids.slice(i, i + READ_CHUNK));
    if (error) throw new Error(`Couldn't read FleetSuite's customers: ${error.message}`);
    for (const row of (data ?? []) as ProspectRow[]) if (row.netsuite_id) out.set(String(row.netsuite_id), prospectFacts(row));
  }
  return out;
}

/**
 * A customer's name, email, phone and billing address as a customer sync writes them: NetSuite's, or once FleetSuite's
 * record wins for a customer FleetSuite has, FleetSuite's, with NetSuite's filling a blank, and what NetSuite has
 * instead. Without `withAddress` the address is left out: the sync didn't read it.
 */
export function customerToWrite(
  netsuiteId: string,
  netsuite: CustomerFacts,
  fleetsuite: CustomerFacts | undefined,
  withAddress: boolean,
): { facts: CustomerFacts; seen: Seen[] } {
  if (!fleetsuite) return { facts: netsuite, seen: [] };
  const fields = FIELDS.customer.filter((f) => withAddress || f !== 'address');
  const name = typeof fleetsuite.name === 'string' ? fleetsuite.name : null;
  const { values, seen } = keepFleetsuite('customer', netsuiteId, name, fields, fleetsuite, netsuite);
  return { facts: { ...netsuite, ...values }, seen };
}

interface VendorRow {
  netsuite_id: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
}

/** FleetSuite's copy of NetSuite's vendors, by NetSuite's id. A read that fails throws, as readCustomerRecords. */
export async function readVendorRecords(service: SupabaseClient): Promise<Map<string, VendorFacts>> {
  const { data, error } = await fetchAllRows<VendorRow>((from, to) =>
    service.from('netsuite_vendors').select('netsuite_id, company_name, email, phone').order('netsuite_id').range(from, to));
  if (error) throw new Error(`Couldn't read FleetSuite's vendors: ${error.message}`);
  return new Map(data.map((r) => [String(r.netsuite_id), { name: r.company_name, email: r.email, phone: r.phone }]));
}

// ── Noting it ──────────────────────────────────────────────────────────────

/** Fields sent to note_record_differences at once. */
const NOTE_CHUNK = 500;

const fieldKey = (netsuiteId: string, field: string) => `${netsuiteId}:${field}`;

/** The fields of one kind of record that have a difference open. */
async function openFields(service: SupabaseClient, kind: RecordKind): Promise<Set<string>> {
  const { data, error } = await fetchAllRows<{ netsuite_id: string; field: string }>((from, to) =>
    service.from('record_differences').select('netsuite_id, field').eq('kind', kind).eq('status', 'open').order('id').range(from, to));
  if (error) throw new Error(`Couldn't read what NetSuite has instead: ${error.message}`);
  return new Set(data.map((r) => fieldKey(r.netsuite_id, r.field)));
}

/**
 * Notes what a sync saw of one kind of record: a field that differs is listed, and one that doesn't closes the
 * difference open for it, if there is one. Throws when it can't be noted, so a sync can leave its records to be read
 * again rather than lose what NetSuite has instead.
 */
export async function noteDifferences(service: SupabaseClient, kind: RecordKind, seen: Seen[]): Promise<{ opened: number; closed: number }> {
  const mine = seen.filter((s) => s.kind === kind);
  if (!mine.length) return { opened: 0, closed: 0 };
  const open = await openFields(service, kind);
  const list = mine.filter((s) => s.differs || open.has(fieldKey(s.netsuite_id, s.field)));
  let opened = 0;
  let closed = 0;
  for (let i = 0; i < list.length; i += NOTE_CHUNK) {
    const { data, error } = await service.rpc('note_record_differences', { p: list.slice(i, i + NOTE_CHUNK) });
    if (error) throw new Error(`Couldn't note what NetSuite has instead: ${error.message}`);
    const r = (data ?? {}) as { opened?: number; closed?: number };
    opened += Number(r.opened) || 0;
    closed += Number(r.closed) || 0;
  }
  return { opened, closed };
}

// ── The list ───────────────────────────────────────────────────────────────

export type DifferenceStatus = 'open' | 'kept' | 'taken' | 'same';

export interface DifferenceRow {
  id: string;
  kind: RecordKind;
  netsuite_id: string;
  name: string | null;
  field: RecordField;
  fleetsuite_value: FieldValue;
  netsuite_value: FieldValue;
  status: DifferenceStatus;
  first_seen_at: string;
  last_seen_at: string;
  sent_to_netsuite: boolean | null;
  closed_at: string | null;
  closed_by: string | null;
}

export const DIFFERENCE_COLUMNS =
  'id, kind, netsuite_id, name, field, fleetsuite_value, netsuite_value, status, first_seen_at, last_seen_at, sent_to_netsuite, closed_at, closed_by';

/** The most of either list read at once. */
export const LIST_LIMIT = 200;

/** The differences open now, newest first, and the last ones closed. */
export async function readDifferences(service: SupabaseClient): Promise<{ open: DifferenceRow[]; closed: DifferenceRow[]; more: boolean }> {
  const [open, closed] = await Promise.all([
    service.from('record_differences').select(DIFFERENCE_COLUMNS).eq('status', 'open')
      .order('last_seen_at', { ascending: false }).order('id', { ascending: false }).limit(LIST_LIMIT + 1),
    service.from('record_differences').select(DIFFERENCE_COLUMNS).neq('status', 'open')
      .order('closed_at', { ascending: false }).order('id', { ascending: false }).limit(25),
  ]);
  const failed = open.error ?? closed.error;
  if (failed) throw new Error(`Couldn't read what NetSuite has instead: ${failed.message}`);
  const openRows = (open.data ?? []) as DifferenceRow[];
  return { open: openRows.slice(0, LIST_LIMIT), closed: (closed.data ?? []) as DifferenceRow[], more: openRows.length > LIST_LIMIT };
}

/** One difference as Books → Changed in NetSuite shows it. */
export interface Change {
  id: string;
  kind: RecordKind;
  kindName: string;
  netsuiteId: string;
  name: string;
  field: RecordField;
  fieldName: string;
  fleetsuite: string;
  netsuite: string;
  status: DifferenceStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  closedBy: string | null;
  sent: boolean | null;
  link: string | null;
}

/** A difference as the page shows it, with who closed it by name and a link to the record in NetSuite. */
export function changeOf(row: DifferenceRow, names: Map<string, string>, link: (kind: RecordKind, id: string) => string | null): Change {
  return {
    id: row.id,
    kind: row.kind,
    kindName: KIND_NAMES[row.kind] ?? row.kind,
    netsuiteId: row.netsuite_id,
    name: row.name ?? `NetSuite ID ${row.netsuite_id}`,
    field: row.field,
    fieldName: FIELD_NAMES[row.field] ?? row.field,
    fleetsuite: shownValue(row.fleetsuite_value),
    netsuite: shownValue(row.netsuite_value),
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by ? names.get(row.closed_by) ?? null : null,
    sent: row.sent_to_netsuite,
    link: link(row.kind, row.netsuite_id),
  };
}

// ── Keeping FleetSuite's, or taking NetSuite's ─────────────────────────────

export type Act = 'keep' | 'take';

export type ActResult =
  | { ok: true; status: 'kept' | 'taken' | 'same'; row: DifferenceRow }
  | { ok: false; status: number; error: string };

const refused = (status: number, error: string): ActResult => ({ ok: false, status, error });

/** What a customer's field sends NetSuite, as the Customer Record's Edit panel does (updateCustomer). */
function customerUpdate(field: CustomerField, v: FieldValue): CustomerUpdateFields {
  if (field === 'address') {
    const a = prospectAddress(v);
    return { address: a.address ?? '', address2: a.address2 ?? '', city: a.city ?? '', state: a.state ?? '', zip: a.zip ?? '' };
  }
  const text = typeof v === 'string' ? v.trim() : '';
  return field === 'name' ? { companyName: text } : field === 'email' ? { email: text } : { phone: text };
}

const VENDOR_BODY: Record<VendorField, string> = { name: 'companyName', email: 'email', phone: 'phone' };

/** FleetSuite's record of the customer or vendor now, or null when it hasn't got it. */
async function readFleetsuite(service: SupabaseClient, kind: RecordKind, netsuiteId: string): Promise<Record<string, FieldValue> | null> {
  if (kind === 'customer') {
    const { data, error } = await service.from('prospects').select(PROSPECT_COLUMNS).eq('netsuite_id', netsuiteId).maybeSingle();
    if (error) throw new Error(`Couldn't read FleetSuite's customer: ${error.message}`);
    return data ? prospectFacts(data as ProspectRow) : null;
  }
  const { data, error } = await service.from('netsuite_vendors').select('netsuite_id, company_name, email, phone').eq('netsuite_id', netsuiteId).maybeSingle();
  if (error) throw new Error(`Couldn't read FleetSuite's vendor: ${error.message}`);
  const row = data as VendorRow | null;
  return row ? { name: row.company_name, email: row.email, phone: row.phone } : null;
}

/**
 * Writes NetSuite's value of a field into FleetSuite's record: a customer's CRM record, and its line on the customer
 * list as the Customer Record's Edit panel keeps it in step (/api/prospects), at best, since the syncs go by the CRM
 * record.
 */
async function writeFleetsuite(service: SupabaseClient, kind: RecordKind, netsuiteId: string, field: RecordField, v: FieldValue): Promise<void> {
  const text = typeof v === 'string' && v.trim() ? v.trim() : null;
  if (kind === 'vendor') {
    const column = field === 'name' ? 'company_name' : field;
    const { error } = await service.from('netsuite_vendors').update({ [column]: text }).eq('netsuite_id', netsuiteId);
    if (error) throw new Error(`Couldn't change FleetSuite's vendor: ${error.message}`);
    return;
  }
  const prospect = field === 'address' ? prospectAddress(v) : { [field === 'name' ? 'company_name' : field]: text };
  const listed = field === 'address' ? { address: addressLine(v) } : { [field === 'name' ? 'company_name' : field]: text };
  const crm = await service.from('prospects').update(prospect).eq('netsuite_id', netsuiteId);
  if (crm.error) throw new Error(`Couldn't change FleetSuite's customer: ${crm.error.message}`);
  const list = await service.from('customers').update(listed).eq('netsuite_id', netsuiteId);
  if (list.error) console.error(`[fleetsuite records] the customer list's ${netsuiteId} wasn't changed: ${list.error.message}`);
}

/** Opens a difference again after what was pressed didn't go through. One the sync opened meanwhile stands instead. */
async function reopen(service: SupabaseClient, id: string, from: 'kept' | 'taken'): Promise<void> {
  const { error } = await service.from('record_differences')
    .update({ status: 'open', closed_at: null, closed_by: null, sent_to_netsuite: null }).eq('id', id).eq('status', from);
  if (error) console.error(`[fleetsuite records] ${id} couldn't be opened again: ${error.message}`);
}

/** Why one of the list can't be acted on, or null when it's open. */
export function actRefusal(row: DifferenceRow | null): ActResult | null {
  if (!row) return refused(404, 'That difference isn\'t on the list.');
  if (!isKind(row.kind) || !isField(row.kind, row.field)) return refused(409, 'FleetSuite can\'t keep or take that one.');
  if (row.status === 'open') return null;
  const how = row.status === 'kept' ? "FleetSuite's was kept" : row.status === 'taken' ? "NetSuite's was taken" : 'the two are the same now';
  return refused(409, `That one is done: ${how}. Reload to see the list as it is.`);
}

/**
 * Keeps FleetSuite's value of a field, sending it on to NetSuite, or takes NetSuite's into FleetSuite's record. The
 * difference is taken first, so a second press does nothing, and opened again when NetSuite refuses or a write fails.
 */
export async function actOn(service: SupabaseClient, opts: { id: string; act: Act; by: string; now?: Date }): Promise<ActResult> {
  const { data, error } = await service.from('record_differences').select(DIFFERENCE_COLUMNS).eq('id', opts.id).maybeSingle();
  if (error) throw new Error(`Couldn't read the difference: ${error.message}`);
  const row = data as DifferenceRow | null;
  const why = actRefusal(row);
  if (why) return why;
  const { kind, netsuite_id: netsuiteId, field } = row!;
  const at = (opts.now ?? new Date()).toISOString();
  const what = `${KIND_NAMES[kind].toLowerCase()} ${row!.name ?? netsuiteId}`;

  const claim = async (status: 'kept' | 'taken' | 'same') => {
    const { data: claimed, error: claimError } = await service.from('record_differences')
      .update({
        status, closed_at: at, closed_by: status === 'same' ? null : opts.by, ...(status === 'kept' ? { sent_to_netsuite: true } : {}),
      })
      .eq('id', opts.id).eq('status', 'open').select('id');
    if (claimError) throw new Error(`Couldn't take the difference: ${claimError.message}`);
    return (claimed ?? []).length > 0;
  };
  const gone = refused(409, 'Someone dealt with that one just now. Reload to see the list as it is.');

  const record = await readFleetsuite(service, kind, netsuiteId);
  if (!record) return refused(409, `FleetSuite doesn't have the ${what} any more, so there's nothing to keep or take.`);

  if (opts.act === 'take') {
    if (!(await claim('taken'))) return gone;
    try {
      await writeFleetsuite(service, kind, netsuiteId, field, row!.netsuite_value);
    } catch (err: any) {
      await reopen(service, opts.id, 'taken');
      return refused(500, `${String(err?.message || err).replace(/[.\s]+$/, '')}. Nothing changed.`);
    }
    return { ok: true, status: 'taken', row: row! };
  }

  const value = record[field] ?? null;
  if (isBlank(value)) {
    return refused(409, `FleetSuite has no ${FIELD_NAMES[field].toLowerCase()} for the ${what} now, so there's nothing to send. Take NetSuite's instead.`);
  }
  if (sameValue(field, value, row!.netsuite_value)) return (await claim('same')) ? { ok: true, status: 'same', row: row! } : gone;

  if (!(await claim('kept'))) return gone;
  const sent = kind === 'customer'
    ? await updateCustomer(netsuiteId, customerUpdate(field as CustomerField, value))
    : await patchEntityRecord('vendor', netsuiteId, { [VENDOR_BODY[field as VendorField]]: typeof value === 'string' ? value.trim() : '' });
  if (!sent.success) {
    await reopen(service, opts.id, 'kept');
    const said = String(sent.error || "NetSuite didn't answer").replace(/[.\s]+$/, '');
    return refused(502, 'unsure' in sent && sent.unsure
      ? `${said}, so FleetSuite can't tell whether NetSuite took it. The next read of NetSuite shows it: if NetSuite has FleetSuite's then, this goes by itself.`
      : `NetSuite didn't take it: ${said}. Nothing changed.`);
  }
  return { ok: true, status: 'kept', row: row! };
}
