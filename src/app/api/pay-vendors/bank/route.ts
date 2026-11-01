import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { getSuperAdminIds, notifyMany } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { deepLinks } from '@/lib/deep-links';
import {
  NOTE_MAX, TRIES, callBackProblems, entryProblems, mismatchText, noteProblem, numbersOf, readBackDiffers, type BankStatus,
} from '@/lib/vendor-bank';
import { bankKey, confirmSeal, confirmSealHolds, lockNumbers, openNumbers, openedProblem, type BankKey } from '@/lib/vendor-bank-lock';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/** Nothing here is kept by a browser or anything between. */
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/** How long a phone changed in FleetSuite is called out on the call-back. */
const PHONE_CHANGED_DAYS = 90;

const COLUMNS = 'id, vendor_netsuite_id, vendor_name, routing_number, account_last4, account_type, name_on_account, source, account_locked, '
  + 'status, tries, entered_by, entered_at, confirmed_by, confirmed_at, called_phone, spoke_with, confirm_seal, ended_by, ended_at, ended_why';

/** A set of numbers entered for a vendor, as vendor_bank_accounts keeps it (migration 490). */
interface BankRow {
  id: string;
  vendor_netsuite_id: string;
  vendor_name: string | null;
  routing_number: string;
  account_last4: string;
  account_type: string;
  name_on_account: string;
  source: string;
  account_locked: string | null;
  status: BankStatus;
  tries: number;
  entered_by: string | null;
  entered_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  called_phone: string | null;
  spoke_with: string | null;
  confirm_seal: string | null;
  ended_by: string | null;
  ended_at: string | null;
  ended_why: string | null;
}

const messageOf = (err: unknown) => String((err as any)?.message || err);
const vendorOf = (r: Pick<BankRow, 'vendor_name' | 'vendor_netsuite_id'>) => r.vendor_name || `Vendor ${r.vendor_netsuite_id}`;
/** A note as a sentence in an alert. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Where a set is, or why nothing was done to it, as the page says it. */
const WHERE: Readonly<Record<string, string>> = {
  pending: "They're waiting for a call-back.",
  confirmed: "They're confirmed already.",
  replaced: 'Newer numbers confirmed on a call-back replaced them.',
  refused: 'They were refused.',
  removed: 'They were removed.',
  gone: 'FleetSuite has no such bank numbers: reload.',
  same_person: 'Someone other than whoever entered them confirms them on a call-back.',
};
const whereItIs = (state: string) => WHERE[state] ?? `They're ${state}.`;

async function readRow(id: string): Promise<BankRow | null> {
  const { data, error } = await service.from('vendor_bank_accounts').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as BankRow | null) ?? null;
}

async function readNames(ids: Array<string | null>): Promise<(id: string | null) => string | null> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  const { data, error } = people.length ? await service.from('profiles').select('id, full_name').in('id', people) : { data: [], error: null };
  if (error) throw new Error(error.message);
  const names = new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
  return (id) => (id ? names.get(id) || 'Someone' : null);
}

interface VendorRow {
  netsuite_id: string;
  company_name: string | null;
  entity_id: string | null;
  phone: string | null;
  is_inactive: boolean | null;
}

const vendorName = (v: VendorRow) => v.company_name || v.entity_id || `Vendor ${v.netsuite_id}`;

/** Vendors in the copy of NetSuite's vendor list with every word typed in their name, active ones first. */
async function findVendors(typed: string) {
  const words = typed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let q = service.from('netsuite_vendors').select('netsuite_id, company_name, entity_id, phone, is_inactive');
  if (words.length > 0) {
    const like = `%${words.slice(0, 6).join('%')}%`;
    q = q.or(`company_name.ilike.${like},entity_id.ilike.${like}`);
  }
  const { data, error } = await q.order('is_inactive', { ascending: true }).order('company_name', { ascending: true }).order('netsuite_id').limit(15);
  if (error) throw new Error(`couldn't search the copy of NetSuite's vendors (${error.message})`);
  return ((data ?? []) as VendorRow[]).map((v) => ({ id: v.netsuite_id, name: vendorName(v), phone: v.phone || null, active: !v.is_inactive }));
}

async function readVendors(ids: string[]): Promise<Map<string, VendorRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service.from('netsuite_vendors').select('netsuite_id, company_name, entity_id, phone, is_inactive').in('netsuite_id', ids);
  if (error) throw new Error(`couldn't read the copy of NetSuite's vendors (${error.message})`);
  return new Map(((data ?? []) as VendorRow[]).map((v) => [v.netsuite_id, v]));
}

/** When each of these vendors' phone was last changed in FleetSuite (Vendor Details), in the last 90 days. */
async function readPhoneChanges(ids: string[]): Promise<Map<string, { at: string; by: string | null }>> {
  if (ids.length === 0) return new Map();
  const since = new Date(Date.now() - PHONE_CHANGED_DAYS * 86_400_000).toISOString();
  const { data, error } = await service.from('detail_changes').select('netsuite_id, patch, created_by, created_at')
    .eq('record_type', 'vendor').eq('status', 'changed').in('netsuite_id', ids).gte('created_at', since)
    .order('created_at', { ascending: false }).order('id').limit(500);
  if (error) throw new Error(`couldn't read the changes made to vendors (${error.message})`);
  const rows = ((data ?? []) as Array<{ netsuite_id: string; patch: Record<string, unknown> | null; created_by: string | null; created_at: string }>)
    .filter((r) => r.patch && 'phone' in r.patch);
  const nameOf = await readNames(rows.map((r) => r.created_by));
  const changes = new Map<string, { at: string; by: string | null }>();
  for (const r of rows) if (!changes.has(r.netsuite_id)) changes.set(r.netsuite_id, { at: r.created_at, by: nameOf(r.created_by) });
  return changes;
}

/** Why a set waiting or confirmed can't be trusted as it stands, or null when it can. */
function liveProblem(r: BankRow, key: BankKey | null): string | null {
  if (!key || !r.account_locked) return null;
  const opened = openNumbers(key, r.account_locked, r.vendor_netsuite_id, r.id);
  if ('problem' in opened) return openedProblem(opened.problem);
  const n = opened.numbers;
  if (n.routing !== r.routing_number || !n.account.endsWith(r.account_last4) || n.type !== r.account_type) {
    return "What these show isn't what's locked, so they were changed outside FleetSuite: enter them again.";
  }
  if (r.status === 'confirmed' && !confirmSealHolds(key, r.confirm_seal, r.vendor_netsuite_id, r.id)) {
    return "FleetSuite didn't confirm these, so they were changed outside it: enter them again and confirm them on a call-back.";
  }
  return null;
}

/**
 * GET /api/pay-vendors/bank — the bank numbers kept for vendors (the numbers themselves never: the four digits an
 * account ends with), whether VENDOR_BANK_KEY is there to lock them, each set waiting for a call-back with the phone on
 * file and when it was last changed in FleetSuite, and the last 50 sets replaced, refused or removed.
 * GET ?find=<typed> — vendors from the copy of NetSuite's vendor list by name, active ones first.
 * Super admins only, switched on or off.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const params = req.nextUrl.searchParams;

  try {
    if (params.has('find')) return NextResponse.json({ vendors: await findVendors(params.get('find') || '') }, NO_STORE);

    const read = bankKey();
    const key = 'key' in read ? read.key : null;
    const [live, past] = await Promise.all([
      service.from('vendor_bank_accounts').select(COLUMNS).in('status', ['pending', 'confirmed'])
        .order('vendor_name', { ascending: true }).order('id').limit(1000),
      service.from('vendor_bank_accounts').select(COLUMNS).in('status', ['replaced', 'refused', 'removed'])
        .order('ended_at', { ascending: false }).order('id').limit(50),
    ]);
    if (live.error || past.error) throw new Error((live.error ?? past.error)!.message);
    const rows = (live.data ?? []) as unknown as BankRow[];
    const ended = (past.data ?? []) as unknown as BankRow[];
    const waiting = [...new Set(rows.filter((r) => r.status === 'pending').map((r) => r.vendor_netsuite_id))];
    const [vendors, phoneChanges, nameOf] = await Promise.all([
      readVendors(waiting),
      readPhoneChanges(waiting),
      readNames([...rows, ...ended].flatMap((r) => [r.entered_by, r.confirmed_by, r.ended_by])),
    ]);

    const view = (r: BankRow) => ({
      id: r.id,
      vendorId: r.vendor_netsuite_id,
      vendorName: vendorOf(r),
      routing: r.routing_number,
      last4: r.account_last4,
      type: r.account_type,
      nameOnAccount: r.name_on_account,
      source: r.source,
      status: r.status,
      tries: r.tries,
      enteredBy: nameOf(r.entered_by),
      enteredById: r.entered_by,
      enteredAt: r.entered_at,
      confirmedBy: nameOf(r.confirmed_by),
      confirmedAt: r.confirmed_at,
      calledPhone: r.called_phone,
      spokeWith: r.spoke_with,
      endedBy: nameOf(r.ended_by),
      endedAt: r.ended_at,
      endedWhy: r.ended_why,
      problem: liveProblem(r, key),
      phone: r.status === 'pending' ? vendors.get(r.vendor_netsuite_id)?.phone || null : null,
      phoneChanged: r.status === 'pending' ? phoneChanges.get(r.vendor_netsuite_id) ?? null : null,
    });
    return NextResponse.json({
      keyProblem: key ? null : (read as { problem: string }).problem,
      me: auth.user.id,
      accounts: rows.map(view),
      past: ended.map(view),
    }, NO_STORE);
  } catch (err) {
    return NextResponse.json({ error: `Couldn't open the vendor bank numbers (${messageOf(err)}).` }, { status: 500 });
  }
}

const rowId = z.string().uuid();
const text = (max: number) => z.string().max(max);
const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('enter'),
    // Made by the page when the form opens: the same form pressed twice is one entry.
    id: rowId,
    vendorId: z.string().regex(/^\d{1,20}$/),
    routing: text(60),
    account: text(60),
    accountAgain: text(60),
    type: text(20),
    name: text(200),
    source: text(2000),
  }),
  z.object({
    action: z.literal('confirm'),
    id: rowId,
    phone: text(200),
    spokeWith: text(1000),
    routing: text(60),
    account: text(60),
    type: text(20),
  }),
  // A set waiting refused, or one confirmed removed, with why.
  z.object({ action: z.enum(['refuse', 'remove']), id: rowId, reason: text(2000) }),
]);
type Body = z.infer<typeof Body>;

/** Tells every super admin and everyone copied on new alerts, never whoever did it. */
async function tell(actorId: string, alert: { type: string; title: string; body: string; url: string }) {
  try {
    const [admins, watchers] = await Promise.all([getSuperAdminIds(actorId), newAlertWatcherIds(service)]);
    const to = [...new Set([...admins, ...watchers])].filter((p) => !!p && p !== actorId);
    if (to.length > 0) await notifyMany(to, { ...alert, channels: ['in_app', 'push', 'email'] });
  } catch (err) {
    console.error(`[vendor-bank] alert ${alert.type} not sent: ${messageOf(err)}`);
  }
}

/** What an audit keeps of a set: never more of the account number than the four digits it ends with. */
const auditOf = (r: Pick<BankRow, 'vendor_netsuite_id' | 'vendor_name' | 'routing_number' | 'account_last4' | 'account_type'>) => ({
  vendor_id: r.vendor_netsuite_id, vendor: vendorOf(r), routing: r.routing_number, account_ending: r.account_last4, type: r.account_type,
});

/**
 * POST /api/pay-vendors/bank — super admins only:
 *   { action: 'enter', id, vendorId, routing, account, accountAgain, type, name, source } — a vendor's numbers, locked,
 *     waiting for a call-back;
 *   { action: 'confirm', id, phone, spokeWith, routing, account, type } — what the vendor read out on a call-back, by a
 *     super admin who didn't enter them: confirmed when it matches what was entered, a try when it doesn't, and refused
 *     on the third;
 *   { action: 'refuse' | 'remove', id, reason } — a set waiting refused, or one confirmed removed, with why.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Body);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  try {
    if (body.action === 'enter') return await enter(body, auth.user.id);
    if (body.action === 'confirm') return await confirm(body, auth.user.id);
    return await end(body, auth.user.id);
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

async function enter(body: Extract<Body, { action: 'enter' }>, me: string) {
  const read = bankKey();
  if (!('key' in read)) return NextResponse.json({ error: read.problem }, { status: 503 });
  const problems = entryProblems(body);
  if (problems.length > 0) return NextResponse.json({ error: problems[0], problems }, { status: 400 });
  const vendor = (await readVendors([body.vendorId])).get(body.vendorId);
  if (!vendor) return NextResponse.json({ error: `FleetSuite's copy of NetSuite's vendors has no vendor ${body.vendorId}.` }, { status: 404 });

  const numbers = numbersOf(body);
  const row = {
    id: body.id, vendor_netsuite_id: body.vendorId, vendor_name: vendorName(vendor), routing_number: numbers.routing,
    account_last4: numbers.account.slice(-4), account_type: numbers.type, name_on_account: body.name.trim(), source: body.source.trim(),
  };
  const { data, error } = await service.rpc('vendor_bank_enter', {
    p: { ...row, account_locked: lockNumbers(read.key, numbers, body.vendorId, body.id), by: me },
  });
  if (error) return NextResponse.json({ error: `Couldn't keep them (${error.message}).` }, { status: 500 });
  const result = data as { state: string; fresh?: boolean };
  if (result.state === 'waiting') {
    return NextResponse.json({ error: `${row.vendor_name} has bank numbers waiting for a call-back already: confirm or refuse those first.` }, { status: 409 });
  }
  if (result.state === 'taken') return NextResponse.json({ error: 'That form was used for another vendor: close it and enter them again.' }, { status: 409 });

  if (result.fresh) {
    await logAudit(service, { actorId: me, table: 'vendor_bank_accounts', recordId: body.id, action: 'enter', detail: auditOf(row) });
    const nameOf = await readNames([me]);
    await tell(me, {
      type: 'books_vendor_bank_waiting',
      title: `Bank numbers entered for ${row.vendor_name}`,
      body: `${nameOf(me)} entered new bank numbers for ${row.vendor_name} (${row.source}). Before anything is paid to them, another super admin `
        + `calls ${row.vendor_name} on a number BMG already had and confirms them.`,
      url: deepLinks.vendorBank(body.vendorId),
    });
  }
  return NextResponse.json({ success: true });
}

async function confirm(body: Extract<Body, { action: 'confirm' }>, me: string) {
  const read = bankKey();
  if (!('key' in read)) return NextResponse.json({ error: read.problem }, { status: 503 });
  const row = await readRow(body.id);
  if (!row) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (row.status !== 'pending') return NextResponse.json({ error: whereItIs(row.status) }, { status: 409 });
  if (row.entered_by === me) return NextResponse.json({ error: whereItIs('same_person') }, { status: 403 });
  // A call-back typed wrong isn't one that didn't match.
  const problems = callBackProblems(body);
  if (problems.length > 0) return NextResponse.json({ error: problems[0], problems }, { status: 400 });
  const opened = openNumbers(read.key, row.account_locked ?? '', row.vendor_netsuite_id, row.id);
  if ('problem' in opened) return NextResponse.json({ error: openedProblem(opened.problem) }, { status: 409 });
  // What the page shows has to be what's locked: a set changed outside FleetSuite isn't confirmed.
  const wrong = liveProblem(row, read.key);
  if (wrong) return NextResponse.json({ error: wrong }, { status: 409 });

  const vendor = vendorOf(row);
  const nameOf = await readNames([me, row.entered_by]);
  const differs = readBackDiffers(opened.numbers, body);
  if (differs.length > 0) {
    const { data, error } = await service.rpc('vendor_bank_mismatch', { p: { id: row.id, by: me } });
    if (error) return NextResponse.json({ error: `Couldn't count the call-back (${error.message}).` }, { status: 500 });
    const result = data as { state: string; tries?: number };
    if (result.state === 'tried') {
      await logAudit(service, {
        actorId: me, table: 'vendor_bank_accounts', recordId: row.id, action: 'call_back_mismatch', detail: { ...auditOf(row), differs, tries: result.tries },
      });
      return NextResponse.json({ error: mismatchText(differs, TRIES - (result.tries ?? TRIES)), tries: result.tries }, { status: 409 });
    }
    if (result.state === 'refused') {
      await logAudit(service, {
        actorId: me, table: 'vendor_bank_accounts', recordId: row.id, action: 'refuse', detail: { ...auditOf(row), differs, why: 'three call-backs' },
      });
      await tell(me, {
        type: 'books_vendor_bank_decided',
        title: `Bank numbers refused for ${vendor}`,
        body: `The numbers read on three call-backs to ${vendor} didn't match the ones ${nameOf(row.entered_by) || 'someone'} entered, so they're refused `
          + `and nothing will be paid to them. If ${vendor} didn't send new numbers, someone may be trying to have BMG pay them instead.`,
        url: deepLinks.vendorBank(row.vendor_netsuite_id),
      });
      return NextResponse.json({
        error: `That's three call-backs that didn't match, so these numbers are refused and nothing will be paid to them. Enter them again from ${vendor}'s form.`,
        refused: true,
      }, { status: 409 });
    }
    return NextResponse.json({ error: whereItIs(result.state) }, { status: result.state === 'same_person' ? 403 : 409 });
  }

  const { data, error } = await service.rpc('vendor_bank_confirm', {
    p: {
      id: row.id, by: me, called_phone: body.phone.trim(), spoke_with: body.spokeWith.trim(),
      confirm_seal: confirmSeal(read.key, row.vendor_netsuite_id, row.id),
    },
  });
  if (error) return NextResponse.json({ error: `Couldn't confirm them (${error.message}).` }, { status: 500 });
  const result = data as { state: string; replaced?: string | null };
  if (result.state !== 'confirmed' || !('replaced' in result)) {
    return NextResponse.json({ error: whereItIs(result.state) }, { status: result.state === 'same_person' ? 403 : 409 });
  }

  await logAudit(service, {
    actorId: me, table: 'vendor_bank_accounts', recordId: row.id, action: 'confirm',
    detail: { ...auditOf(row), called: body.phone.trim(), spoke_with: body.spokeWith.trim(), replaced: result.replaced ?? null },
  });
  await tell(me, {
    type: 'books_vendor_bank_decided',
    title: `Bank numbers confirmed for ${vendor}`,
    body: `${nameOf(me)} called ${vendor} on ${body.phone.trim()}, and ${body.spokeWith.trim()} read out the bank numbers `
      + `${nameOf(row.entered_by) || 'someone'} entered.${result.replaced ? ' They replace the ones confirmed before.' : ''}`,
    url: deepLinks.vendorBank(row.vendor_netsuite_id),
  });
  return NextResponse.json({ success: true, replaced: result.replaced ?? null });
}

async function end(body: Extract<Body, { action: 'refuse' | 'remove' }>, me: string) {
  const row = await readRow(body.id);
  if (!row) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  const from: BankStatus = body.action === 'refuse' ? 'pending' : 'confirmed';
  if (row.status !== from) return NextResponse.json({ error: whereItIs(row.status) }, { status: 409 });
  // With the key, the account itself is kept out of why too.
  const read = bankKey();
  const opened = 'key' in read && row.account_locked ? openNumbers(read.key, row.account_locked, row.vendor_netsuite_id, row.id) : null;
  const problem = noteProblem('why', body.reason, NOTE_MAX, opened && 'numbers' in opened ? opened.numbers.account : null);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const to = body.action === 'refuse' ? 'refused' : 'removed';
  const why = body.reason.trim();
  const { data, error } = await service.rpc('vendor_bank_end', { p: { id: row.id, by: me, status: to, why } });
  if (error) return NextResponse.json({ error: `Couldn't ${body.action} them (${error.message}).` }, { status: 500 });
  const result = data as { state: string };
  if (result.state !== to) return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });

  await logAudit(service, { actorId: me, table: 'vendor_bank_accounts', recordId: row.id, action: body.action, detail: { ...auditOf(row), why } });
  const vendor = vendorOf(row);
  const nameOf = await readNames([me, row.entered_by]);
  await tell(me, {
    type: 'books_vendor_bank_decided',
    ...(to === 'refused'
      ? {
        title: `Bank numbers refused for ${vendor}`,
        body: `${nameOf(me)} refused the bank numbers ${row.entered_by === me ? 'they' : nameOf(row.entered_by) || 'someone'} entered for ${vendor}: ${sentence(why)} `
          + 'Nothing will be paid to them.',
      }
      : {
        title: `Bank numbers removed for ${vendor}`,
        body: `${nameOf(me)} removed ${vendor}'s confirmed bank numbers: ${sentence(why)} Nothing is paid to ${vendor} by ACH until new ones are entered and confirmed.`,
      }),
    url: deepLinks.vendorBank(row.vendor_netsuite_id),
  });
  return NextResponse.json({ success: true });
}
