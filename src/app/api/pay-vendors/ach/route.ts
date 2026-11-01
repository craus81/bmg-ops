import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { getSuperAdminIds, notifyMany } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { deepLinks } from '@/lib/deep-links';
import { switchIsOn } from '@/lib/books/switches';
import { companyNamed, readBankAccounts, readBankCompanies } from '@/lib/books/bank-accounts';
import { accountName, keptBills } from '@/lib/pay-vendors';
import {
  MODIFIERS, WHY_MAX, achFileName, buildAchFile, chicagoClock, dayText, effectiveDate, setupOf, setupProblems, type AchFile, type AchPayee,
  type SetupTyped,
} from '@/lib/ach-file';
import { accountProblem, digitsOf, isAccountType, noteProblem, routingProblem, type BankNumbers } from '@/lib/vendor-bank';
import {
  bankKey, keptSetProblem, lockFile, lockOffset, openFile, openNumbers, openOffset, openedProblem, type BankKey, type KeptSet,
} from '@/lib/vendor-bank-lock';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const OFF = 'Paying vendors is switched off until it moves into FleetSuite during 2027.';

/** Nothing here is kept by a browser or anything between. */
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/** How often a file is made again with the next letter when another took its letter the same moment. */
const MODIFIER_TRIES = 3;

/** How a bank account's ACH file starts, as vendor_ach_setups keeps it (migration 491). */
interface SetupRow {
  bank_account_netsuite_id: string;
  company: string;
  destination: string;
  destination_name: string;
  origin: string;
  origin_name: string;
  odfi: string;
  company_name: string;
  company_id: string;
  entry_description: string;
  sec_code: string;
  addenda: boolean;
  balanced: boolean;
  line_ending: string;
  offset_routing: string | null;
  offset_last4: string | null;
  offset_type: string | null;
  offset_locked: string | null;
  updated_by: string | null;
  updated_at: string;
}

const SETUP_COLUMNS = 'bank_account_netsuite_id, company, destination, destination_name, origin, origin_name, odfi, company_name, company_id, '
  + 'entry_description, sec_code, addenda, balanced, line_ending, offset_routing, offset_last4, offset_type, offset_locked, updated_by, updated_at';

/** A payment run, as much of it as its ACH file needs. */
interface RunRow {
  id: string;
  company: string;
  bank_account_netsuite_id: string | null;
  bank_account_name: string | null;
  pay_date: string;
  memo: string | null;
  status: string;
}

/** One vendor's payment in an approved run. */
interface PaymentRow {
  id: string;
  position: number;
  vendor_netsuite_id: string;
  vendor_name: string | null;
  method: string;
  bills: unknown;
  total_cents: number | string;
  status: string;
  netsuite_payment_id: string | null;
  netsuite_number: string | null;
}

type FileStatus = 'made' | 'sent' | 'set_aside';

/** An ACH file made from a run, as vendor_ach_files keeps it, its locked copy left out. */
interface FileRow {
  id: string;
  company: string;
  bank_account_netsuite_id: string;
  run_id: string;
  destination: string;
  origin: string;
  created_on: string;
  created_time: string;
  modifier: string;
  effective_date: string;
  entry_count: number;
  total_cents: number | string;
  file_name: string;
  status: FileStatus;
  made_by: string | null;
  made_at: string;
  downloads: number;
  downloaded_by: string | null;
  downloaded_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
  set_aside_by: string | null;
  set_aside_at: string | null;
  set_aside_why: string | null;
}

const FILE_COLUMNS = 'id, company, bank_account_netsuite_id, run_id, destination, origin, created_on, created_time, modifier, effective_date, '
  + 'entry_count, total_cents, file_name, status, made_by, made_at, downloads, downloaded_by, downloaded_at, sent_by, sent_at, set_aside_by, '
  + 'set_aside_at, set_aside_why';

/** A payment in a file and the vendor's numbers it pays to, as shown. */
interface FilePaymentRow {
  file_id: string;
  payment_id: string;
  position: number;
  vendor_netsuite_id: string;
  vendor_name: string | null;
  bank_account_id: string;
  account_last4: string;
  account_type: string;
  cents: number | string;
  live: boolean;
}

/** A set of a vendor's numbers (migration 490), as much as the file needs. */
type SetRow = KeptSet & { vendor_name: string | null; name_on_account: string };

const SET_COLUMNS = 'id, vendor_netsuite_id, vendor_name, routing_number, account_last4, account_type, name_on_account, status, account_locked, confirm_seal';

const messageOf = (err: unknown) => String((err as any)?.message || err);
const isUuid = (s: string | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const dayOf = (v: string) => String(v).slice(0, 10);
const vendorOf = (r: { vendor_name: string | null; vendor_netsuite_id: string }) => r.vendor_name || `Vendor ${r.vendor_netsuite_id}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A note as a sentence in an alert. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Where a file is, when nothing was done to it, as the page says it. */
const FILE_WHERE: Readonly<Record<string, string>> = {
  made: "It's made and waiting to be uploaded to First Bank.",
  sent: "It's marked sent to First Bank.",
  sent_already: "It's marked sent to First Bank already.",
  set_aside: "It's set aside.",
  set_aside_already: "It's set aside already.",
  gone: 'FleetSuite has no such ACH file: reload.',
};
const fileWhere = (state: string) => FILE_WHERE[state] ?? `It's ${state}.`;

/** Why a payment didn't go in the file, from vendor_ach_file_save. */
const PAYMENT_WHY: Readonly<Record<string, (vendor: string) => string>> = {
  not_ach: (v) => `${v}'s payment isn't one of this run's ACH payments any more: reload.`,
  not_made: (v) => `${v}'s bill payment isn't made in NetSuite yet.`,
  cents: (v) => `${v}'s payment isn't what it was when the page read it: reload.`,
  in_file: (v) => `${v}'s payment is in another ACH file already: reload.`,
  bank: (v) => `${v}'s bank numbers changed since the page read them: reload.`,
};

async function readNames(ids: Array<string | null>): Promise<(id: string | null) => string | null> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  const { data, error } = people.length ? await service.from('profiles').select('id, full_name').in('id', people) : { data: [], error: null };
  if (error) throw new Error(error.message);
  const names = new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
  return (id) => (id ? names.get(id) || 'Someone' : null);
}

async function readRun(id: string): Promise<RunRow | null> {
  const { data, error } = await service.from('vendor_payment_runs')
    .select('id, company, bank_account_netsuite_id, bank_account_name, pay_date, memo, status').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RunRow | null) ?? null;
}

/** A run's payments, in the run's order. */
async function readPayments(runId: string): Promise<PaymentRow[]> {
  const { data, error } = await service.from('vendor_payment_run_payments')
    .select('id, position, vendor_netsuite_id, vendor_name, method, bills, total_cents, status, netsuite_payment_id, netsuite_number')
    .eq('run_id', runId).order('position').order('id').limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PaymentRow[];
}

async function readSetups(accountIds: string[]): Promise<Map<string, SetupRow>> {
  const ids = [...new Set(accountIds)];
  const { data, error } = ids.length > 0
    ? await service.from('vendor_ach_setups').select(SETUP_COLUMNS).in('bank_account_netsuite_id', ids)
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as unknown as SetupRow[]).map((r) => [r.bank_account_netsuite_id, r]));
}

/** The files made from a run, oldest first. */
async function readFiles(runId: string): Promise<FileRow[]> {
  const { data, error } = await service.from('vendor_ach_files').select(FILE_COLUMNS).eq('run_id', runId)
    .order('made_at').order('id').limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FileRow[];
}

async function readFile(id: string): Promise<FileRow | null> {
  const { data, error } = await service.from('vendor_ach_files').select(FILE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as FileRow | null) ?? null;
}

/** The payments in these files, each file's in its order. */
async function readFilePayments(fileIds: string[]): Promise<FilePaymentRow[]> {
  if (fileIds.length === 0) return [];
  const { data, error } = await service.from('vendor_ach_file_payments')
    .select('file_id, payment_id, position, vendor_netsuite_id, vendor_name, bank_account_id, account_last4, account_type, cents, live')
    .in('file_id', fileIds).order('file_id').order('position').limit(10_000);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FilePaymentRow[];
}

/** Each of these vendors' numbers confirmed on a call-back, by vendor: a vendor has one set confirmed at most. */
async function readConfirmed(vendorIds: string[]): Promise<Map<string, SetRow>> {
  const ids = [...new Set(vendorIds)];
  if (ids.length === 0) return new Map();
  const { data, error } = await service.from('vendor_bank_accounts').select(SET_COLUMNS).in('vendor_netsuite_id', ids).eq('status', 'confirmed')
    .order('vendor_netsuite_id').order('id').limit(1000);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as unknown as SetRow[]).map((r) => [r.vendor_netsuite_id, r]));
}

/** Where each of these sets of numbers is now, by set. */
async function readSetStatus(ids: string[]): Promise<Map<string, string>> {
  const sets = [...new Set(ids)];
  if (sets.length === 0) return new Map();
  const { data, error } = await service.from('vendor_bank_accounts').select('id, status').in('id', sets).limit(sets.length);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]));
}

/** How a setup is typed, from how it's kept. */
const typedOf = (r: SetupRow): SetupTyped => ({
  destination: r.destination, destinationName: r.destination_name, origin: r.origin, originName: r.origin_name, odfi: r.odfi,
  companyName: r.company_name, companyId: r.company_id, entryDescription: r.entry_description, secCode: r.sec_code, addenda: r.addenda,
  balanced: r.balanced, lineEnding: r.line_ending,
});

const OFFSET_NEEDED = "A balanced file needs BMG's account the payments come from: type it under How First Bank takes the file.";

/** BMG's account for a balanced file's offsetting debit, opened with this key, or why it can't be used. */
function offsetOf(r: SetupRow, key: BankKey): { numbers: BankNumbers } | { problem: string } {
  if (!r.offset_locked) return { problem: OFFSET_NEEDED };
  const opened = openOffset(key, r.offset_locked, r.bank_account_netsuite_id);
  if ('problem' in opened) return { problem: `BMG's account for the offsetting debit: ${openedProblem(opened.problem)}` };
  const n = opened.numbers;
  if (n.routing !== r.offset_routing || !n.account.endsWith(r.offset_last4 ?? '') || n.type !== r.offset_type) {
    return { problem: "BMG's account for the offsetting debit isn't what's locked, so it was changed outside FleetSuite: type it again." };
  }
  return { numbers: n };
}

/** A setup as the page shows it: BMG's account only as its routing number, last four digits and type. */
function setupView(r: SetupRow, key: BankKey | null, nameOf: (id: string | null) => string | null) {
  const offset = r.balanced && key ? offsetOf(r, key) : null;
  return {
    ...typedOf(r),
    offset: r.balanced && r.offset_routing && r.offset_last4 && r.offset_type
      ? { routing: r.offset_routing, last4: r.offset_last4, type: r.offset_type }
      : null,
    offsetProblem: offset && 'problem' in offset ? offset.problem : null,
    problems: setupProblems(typedOf(r)),
    updatedBy: nameOf(r.updated_by),
    updatedAt: r.updated_at,
  };
}

/**
 * GET /api/pay-vendors/ach?company=<BMG|1084> — the company's bank accounts (the first company when none is named)
 * and how each one's ACH file for First Bank starts. GET ?run=<id> — an approved run's ACH payments, each with the
 * vendor's numbers confirmed on a call-back (the routing number, the four digits the account ends with, checking or
 * savings), the files made from it, and the day First Bank pays a file made now. GET ?download=<file> — a file made,
 * to upload to First Bank, while each vendor's numbers in it are still the ones confirmed: the one answer that holds
 * whole account numbers. Super admins only; a file is downloaded only while paying vendors is switched on.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const params = req.nextUrl.searchParams;

  try {
    const on = await switchIsOn(service, 'vendor_payments');
    const read = bankKey();
    const key = 'key' in read ? read.key : null;
    const keyProblem = key ? null : (read as { problem: string }).problem;

    const download = params.get('download');
    if (download !== null) return await downloadFile(download, auth.user.id, on, key, keyProblem);

    const runId = params.get('run');
    if (runId !== null) {
      const run = isUuid(runId) ? await readRun(runId) : null;
      if (!run) return NextResponse.json({ error: "There's no such payment run." }, { status: 404 });
      if ((run.status !== 'approved' && run.status !== 'done') || !run.bank_account_netsuite_id) {
        return NextResponse.json({ error: "Its ACH file is made once it's approved." }, { status: 409 });
      }
      const accountId = run.bank_account_netsuite_id;
      const [payments, files, setups] = await Promise.all([readPayments(run.id), readFiles(run.id), readSetups([accountId])]);
      const ach = payments.filter((p) => p.method === 'ach');
      const inFiles = await readFilePayments(files.map((f) => f.id));
      const [confirmed, setStatus, nameOf] = await Promise.all([
        readConfirmed(ach.map((p) => p.vendor_netsuite_id)),
        readSetStatus(inFiles.map((fp) => fp.bank_account_id)),
        readNames([...files.flatMap((f) => [f.made_by, f.downloaded_by, f.sent_by, f.set_aside_by]), setups.get(accountId)?.updated_by ?? null]),
      ]);
      const setup = setups.get(accountId) ?? null;
      const liveFile = new Map(inFiles.filter((fp) => fp.live).map((fp) => [fp.payment_id, fp.file_id]));
      const today = chicagoClock().day;
      const pays = effectiveDate(dayOf(run.pay_date), today);

      return NextResponse.json({
        run: { id: run.id, company: run.company, accountId, accountName: run.bank_account_name, status: run.status, payDate: dayOf(run.pay_date) },
        setup: setup ? setupView(setup, key, nameOf) : null,
        keyProblem,
        pays: { day: pays, text: dayText(pays) },
        payments: ach.map((p) => {
          const set = confirmed.get(p.vendor_netsuite_id) ?? null;
          const fileId = liveFile.get(p.id) ?? null;
          const problem = set ? keptSetProblem(set, key) : null;
          let why: string | null = null;
          if (p.status === 'dropped') why = 'Dropped from the run.';
          else if (p.status !== 'made') why = 'Goes in a file once its bill payment is made in NetSuite.';
          else if (!fileId && !set) why = `No bank numbers are confirmed on a call-back for ${vendorOf(p)}: enter them under Vendor bank numbers.`;
          else if (!fileId && problem) why = problem;
          return {
            paymentId: p.id,
            position: p.position,
            vendorId: p.vendor_netsuite_id,
            vendorName: vendorOf(p),
            totalCents: Number(p.total_cents),
            paymentStatus: p.status,
            number: p.netsuite_number,
            bank: set ? { last4: set.account_last4, type: set.account_type, routing: set.routing_number, nameOnAccount: set.name_on_account } : null,
            fileId,
            why,
          };
        }),
        files: files.map((f) => {
          const mine = inFiles.filter((fp) => fp.file_id === f.id);
          const changed = f.status === 'made' ? mine.find((fp) => setStatus.get(fp.bank_account_id) !== 'confirmed') : undefined;
          return {
            id: f.id,
            fileName: f.file_name,
            status: f.status,
            modifier: f.modifier,
            pays: { day: dayOf(f.effective_date), text: dayText(dayOf(f.effective_date)) },
            entryCount: f.entry_count,
            totalCents: Number(f.total_cents),
            madeBy: nameOf(f.made_by),
            madeAt: f.made_at,
            downloads: f.downloads,
            downloadedBy: nameOf(f.downloaded_by),
            downloadedAt: f.downloaded_at,
            sentBy: nameOf(f.sent_by),
            sentAt: f.sent_at,
            setAsideBy: nameOf(f.set_aside_by),
            setAsideAt: f.set_aside_at,
            setAsideWhy: f.set_aside_why,
            payments: mine.map((fp) => ({ vendorName: vendorOf(fp), cents: Number(fp.cents), last4: fp.account_last4, type: fp.account_type })),
            // Waiting to be uploaded on or after the day it pays: First Bank needs a day still to come.
            late: f.status === 'made' && dayOf(f.effective_date) <= today,
            problem: changed
              ? `${vendorOf(changed)}'s bank numbers were replaced or removed since it was made: set it aside, and make a new one if they're still to be paid by ACH.`
              : null,
          };
        }),
        switchedOn: on,
      }, NO_STORE);
    }

    const companies = await readBankCompanies(service);
    const company = companyNamed(companies, (params.get('company') || '').trim() || null);
    if (!company) return NextResponse.json({ error: 'Books has no company by that name with a NetSuite subsidiary.' }, { status: 404 });
    const accounts = await readBankAccounts(service, company);
    const setups = await readSetups(accounts.map((a) => a.netsuiteId));
    const nameOf = await readNames([...setups.values()].map((s) => s.updated_by));
    return NextResponse.json({
      company: company.code,
      accounts: accounts.map((a) => {
        const s = setups.get(a.netsuiteId);
        return { netsuiteId: a.netsuiteId, name: accountName(a), setup: s ? setupView(s, key, nameOf) : null };
      }),
      keyProblem,
      switchedOn: on,
    }, NO_STORE);
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

/** A file made, opened to upload to First Bank, counted as downloaded while its vendors' numbers are the ones confirmed. */
async function downloadFile(id: string, me: string, on: boolean, key: BankKey | null, keyProblem: string | null) {
  if (!on) return NextResponse.json({ error: `${OFF} No ACH file is downloaded.`, switchedOff: true }, { status: 403 });
  if (!key) return NextResponse.json({ error: keyProblem }, { status: 503 });
  const file = isUuid(id) ? await readFile(id) : null;
  if (!file) return NextResponse.json({ error: fileWhere('gone') }, { status: 404 });
  if (file.status !== 'made') return NextResponse.json({ error: `${fileWhere(file.status)} Only a file waiting to be uploaded is downloaded.` }, { status: 409 });
  const { data: kept, error: keptError } = await service.from('vendor_ach_files').select('file_locked').eq('id', file.id).maybeSingle();
  if (keptError) throw new Error(keptError.message);
  const opened = openFile(key, (kept as { file_locked: string | null } | null)?.file_locked ?? '', file.id);
  if ('problem' in opened) {
    return NextResponse.json({
      error: opened.problem === 'other_key'
        ? 'This file was locked with another key than VENDOR_BANK_KEY holds now: put that key back, or set it aside and make a new one.'
        : "This file doesn't open as it was locked, so it was changed outside FleetSuite: set it aside and make a new one.",
    }, { status: 409 });
  }

  const { data, error } = await service.rpc('vendor_ach_file_downloaded', { p: { id: file.id, by: me } });
  if (error) return NextResponse.json({ error: `Couldn't open the file (${error.message}).` }, { status: 500 });
  const result = data as { state: string; downloads?: number; vendor_name?: string };
  if (result.state === 'bank') {
    return NextResponse.json({
      error: `${result.vendor_name || 'A vendor'}'s bank numbers were replaced or removed since this file was made, so it isn't downloaded: set it aside, `
        + "and make a new one if they're still to be paid by ACH.",
    }, { status: 409 });
  }
  if (result.state !== 'downloaded') return NextResponse.json({ error: fileWhere(result.state) }, { status: result.state === 'gone' ? 404 : 409 });

  await logAudit(service, {
    actorId: me, table: 'vendor_ach_files', recordId: file.id, action: 'download', detail: { file_name: file.file_name, downloads: result.downloads },
  });
  return new NextResponse(opened.text, {
    headers: {
      'Content-Type': 'text/plain; charset=us-ascii',
      'Content-Disposition': `attachment; filename="${file.file_name}"`,
      'Cache-Control': 'no-store',
    },
  });
}

const text = (max: number) => z.string().max(max);
const Body = z.discriminatedUnion('action', [
  // How a bank account's file starts, typed or read from NetSuite's last file, and BMG's account for a balanced one.
  z.object({
    action: z.literal('setup'),
    company: z.string().min(1).max(12),
    accountId: z.string().regex(/^\d{1,20}$/),
    destination: text(40),
    destinationName: text(100),
    origin: text(40),
    originName: text(100),
    odfi: text(40),
    companyName: text(100),
    companyId: text(40),
    entryDescription: text(100),
    secCode: text(10),
    addenda: z.boolean(),
    balanced: z.boolean(),
    lineEnding: text(10),
    // BMG's account the payments come from, typed from BMG's own records; left out keeps the one kept.
    offset: z.object({ routing: text(60), account: text(60), accountAgain: text(60), type: text(20) }).nullable().optional(),
  }),
  z.object({
    action: z.literal('make'),
    // Made by the page when the run opens: the same press twice is one file.
    id: z.string().uuid(),
    runId: z.string().uuid(),
    paymentIds: z.array(z.string().uuid()).min(1).max(50),
  }),
  z.object({ action: z.literal('sent'), fileId: z.string().uuid() }),
  z.object({ action: z.literal('set_aside'), fileId: z.string().uuid(), reason: text(2000) }),
]);
type Body = z.infer<typeof Body>;

/** Tells every super admin and everyone copied on new alerts, never whoever did it. */
async function tell(actorId: string, alert: { type: string; title: string; body: string; url: string }) {
  try {
    const [admins, watchers] = await Promise.all([getSuperAdminIds(actorId), newAlertWatcherIds(service)]);
    const to = [...new Set([...admins, ...watchers])].filter((p) => !!p && p !== actorId);
    if (to.length > 0) await notifyMany(to, { ...alert, channels: ['in_app', 'push', 'email'] });
  } catch (err) {
    console.error(`[ach-file] alert ${alert.type} not sent: ${messageOf(err)}`);
  }
}

/**
 * POST /api/pay-vendors/ach — super admins only:
 *   { action: 'setup', company, accountId, …how the file starts, offset? } — how a bank account's file for First Bank
 *     starts, and BMG's account for the offsetting debit when First Bank wants the file balanced, kept locked;
 *   { action: 'make', id, runId, paymentIds } — the file for a run's ACH payments made in NetSuite, each paid to its
 *     vendor's numbers confirmed on a call-back, kept locked until it's uploaded;
 *   { action: 'sent', fileId } — a file uploaded to First Bank: its locked copy goes;
 *   { action: 'set_aside', fileId, reason } — a file First Bank refused, or that was never sent, with why: its
 *     payments can go in a new file.
 * Making a file is refused while paying vendors is switched off.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Body);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  try {
    if (body.action === 'setup') return await saveSetup(body, auth.user.id);
    if (body.action === 'make') {
      if (!(await switchIsOn(service, 'vendor_payments'))) {
        return NextResponse.json({ error: `${OFF} No ACH file was made.`, switchedOff: true }, { status: 403 });
      }
      return await makeFile(body, auth.user.id);
    }
    if (body.action === 'sent') return await markSent(body, auth.user.id);
    return await setAside(body, auth.user.id);
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

async function saveSetup(body: Extract<Body, { action: 'setup' }>, me: string) {
  const companies = await readBankCompanies(service);
  const company = companyNamed(companies, body.company);
  if (!company) return NextResponse.json({ error: 'Books has no company by that name with a NetSuite subsidiary.' }, { status: 404 });
  const account = (await readBankAccounts(service, company)).find((a) => a.netsuiteId === body.accountId);
  if (!account) return NextResponse.json({ error: `That isn't one of ${company.name}'s bank accounts in Books.` }, { status: 400 });

  const typed: SetupTyped = {
    destination: body.destination, destinationName: body.destinationName, origin: body.origin, originName: body.originName, odfi: body.odfi,
    companyName: body.companyName, companyId: body.companyId, entryDescription: body.entryDescription, secCode: body.secCode,
    addenda: body.addenda, balanced: body.balanced, lineEnding: body.lineEnding,
  };
  const problems = setupProblems(typed);
  if (problems.length > 0) return NextResponse.json({ error: problems[0], problems }, { status: 400 });
  const s = setupOf(typed);

  let offset: { offset_routing: string | null; offset_last4: string | null; offset_type: string | null; offset_locked: string | null } = {
    offset_routing: null, offset_last4: null, offset_type: null, offset_locked: null,
  };
  if (s.balanced) {
    const read = bankKey();
    if (!('key' in read)) return NextResponse.json({ error: read.problem }, { status: 503 });
    if (body.offset) {
      const o = body.offset;
      const wrong = [
        routingProblem(o.routing), accountProblem(o.account),
        digitsOf(o.account) !== digitsOf(o.accountAgain) ? "The account number typed again isn't the same." : null,
        isAccountType(o.type) ? null : 'Pick checking or savings.',
      ].filter((p): p is string => !!p);
      if (wrong.length > 0) return NextResponse.json({ error: `BMG's account for the offsetting debit: ${wrong[0]}`, problems: wrong }, { status: 400 });
      const numbers: BankNumbers = { routing: digitsOf(o.routing) ?? '', account: digitsOf(o.account) ?? '', type: o.type as BankNumbers['type'] };
      offset = {
        offset_routing: numbers.routing, offset_last4: numbers.account.slice(-4), offset_type: numbers.type,
        offset_locked: lockOffset(read.key, numbers, body.accountId),
      };
    } else {
      const kept = (await readSetups([body.accountId])).get(body.accountId);
      const opened = kept?.balanced ? offsetOf(kept, read.key) : { problem: OFFSET_NEEDED };
      if ('problem' in opened) return NextResponse.json({ error: opened.problem }, { status: 400 });
      offset = { offset_routing: kept!.offset_routing, offset_last4: kept!.offset_last4, offset_type: kept!.offset_type, offset_locked: kept!.offset_locked };
    }
  }

  const row = {
    bank_account_netsuite_id: body.accountId, company: company.code, destination: s.destination, destination_name: s.destinationName,
    origin: s.origin, origin_name: s.originName, odfi: s.odfi, company_name: s.companyName, company_id: s.companyId,
    entry_description: s.entryDescription, sec_code: s.secCode, addenda: s.addenda, balanced: s.balanced, line_ending: s.lineEnding,
    ...offset, updated_by: me, updated_at: new Date().toISOString(),
  };
  const { error } = await service.from('vendor_ach_setups').upsert(row, { onConflict: 'bank_account_netsuite_id' });
  if (error) return NextResponse.json({ error: `It wasn't saved (${error.message}).` }, { status: 500 });

  const { offset_locked: _locked, updated_by: _by, updated_at: _at, ...shown } = row;
  await logAudit(service, { actorId: me, table: 'vendor_ach_setups', recordId: body.accountId, action: 'ach_setup', detail: shown });
  const read = bankKey();
  const nameOf = await readNames([me]);
  return NextResponse.json({ success: true, setup: setupView(row, 'key' in read ? read.key : null, nameOf) });
}

/** The letters and digits taken by files made today for the bank from BMG. */
async function modifiersTaken(destination: string, origin: string, day: string): Promise<Set<string>> {
  const { data, error } = await service.from('vendor_ach_files').select('modifier')
    .eq('destination', destination).eq('origin', origin).eq('created_on', day).limit(100);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ modifier: string }>).map((r) => r.modifier));
}

async function makeFile(body: Extract<Body, { action: 'make' }>, me: string) {
  const read = bankKey();
  if (!('key' in read)) return NextResponse.json({ error: read.problem }, { status: 503 });
  const key = read.key;
  const run = await readRun(body.runId);
  if (!run) return NextResponse.json({ error: "There's no such payment run." }, { status: 404 });
  if ((run.status !== 'approved' && run.status !== 'done') || !run.bank_account_netsuite_id) {
    return NextResponse.json({ error: "Its ACH file is made once it's approved. Nothing was made." }, { status: 409 });
  }
  // A press sent twice: the first one made it.
  if (await readFile(body.id)) return NextResponse.json({ success: true, id: body.id, made: false });
  const accountId = run.bank_account_netsuite_id;
  const [payments, setups] = await Promise.all([readPayments(run.id), readSetups([accountId])]);
  const setup = setups.get(accountId);
  if (!setup) {
    return NextResponse.json({
      error: `Set up how First Bank takes the ACH file from ${run.bank_account_name || 'this bank account'} first, under ACH file for First Bank. Nothing was made.`,
    }, { status: 409 });
  }
  const setupWrong = setupProblems(typedOf(setup));
  if (setupWrong.length > 0) return NextResponse.json({ error: `How First Bank takes the file: ${setupWrong[0]} Nothing was made.` }, { status: 409 });
  let offset: BankNumbers | null = null;
  if (setup.balanced) {
    const opened = offsetOf(setup, key);
    if ('problem' in opened) return NextResponse.json({ error: `${opened.problem} Nothing was made.` }, { status: 409 });
    offset = opened.numbers;
  }

  const wanted = new Set(body.paymentIds);
  const picked = payments.filter((p) => wanted.has(p.id));
  if (picked.length !== wanted.size || picked.some((p) => p.method !== 'ach' || p.status !== 'made' || !p.netsuite_payment_id)) {
    return NextResponse.json({ error: "Only this run's ACH payments made in NetSuite go in its ACH file. Nothing was made." }, { status: 400 });
  }
  const inFiles = await readFilePayments((await readFiles(run.id)).map((f) => f.id));
  const already = picked.filter((p) => inFiles.some((fp) => fp.payment_id === p.id && fp.live));
  if (already.length > 0) {
    return NextResponse.json({
      error: `${already.map(vendorOf).join(', ')} ${already.length === 1 ? 'is' : 'are'} in an ACH file already: reload. Nothing was made.`,
    }, { status: 409 });
  }

  // Each vendor's numbers confirmed on a call-back now, opened: what the file pays to.
  const confirmed = await readConfirmed(picked.map((p) => p.vendor_netsuite_id));
  const problems: string[] = [];
  const rows: Array<{ p: PaymentRow; set: SetRow; numbers: BankNumbers }> = [];
  for (const p of picked) {
    const set = confirmed.get(p.vendor_netsuite_id);
    if (!set) { problems.push(`${vendorOf(p)}: no bank numbers are confirmed on a call-back.`); continue; }
    const problem = keptSetProblem(set, key);
    const opened = set.account_locked ? openNumbers(key, set.account_locked, set.vendor_netsuite_id, set.id) : null;
    if (problem || !opened || 'problem' in opened) { problems.push(`${vendorOf(p)}: ${problem || openedProblem(opened && 'problem' in opened ? opened.problem : 'broken')}`); continue; }
    rows.push({ p, set, numbers: opened.numbers });
  }
  if (problems.length > 0) return NextResponse.json({ error: `${problems[0]} Nothing was made.`, problems }, { status: 409 });

  const payees: AchPayee[] = rows.map(({ p, set, numbers }) => ({
    ...numbers,
    cents: Number(p.total_cents),
    name: set.name_on_account,
    reference: p.netsuite_number || p.netsuite_payment_id || '',
    bills: keptBills(p.bills).map((b) => ({ number: b.number, cents: b.cents })),
  }));
  const shape = setupOf(typedOf(setup));
  const clock = chicagoClock();
  const pays = effectiveDate(dayOf(run.pay_date), clock.day);
  const taken = await modifiersTaken(setup.destination, setup.origin, clock.day);

  for (let attempt = 0; attempt < MODIFIER_TRIES; attempt += 1) {
    const modifier = [...MODIFIERS].find((m) => !taken.has(m));
    if (!modifier) {
      return NextResponse.json({ error: `${MODIFIERS.length} ACH files were made for First Bank today already, as many as a day takes: make this one tomorrow. Nothing was made.` }, { status: 409 });
    }
    let built: AchFile;
    try {
      built = buildAchFile({ setup: shape, offset, createdDay: clock.day, createdTime: clock.time, modifier, effectiveDate: pays, payees });
    } catch (err) {
      return NextResponse.json({ error: `${messageOf(err)} Nothing was made.` }, { status: 409 });
    }
    const fileName = achFileName(run.company, clock.day, modifier);
    const { data, error } = await service.rpc('vendor_ach_file_save', {
      p: {
        id: body.id, company: run.company, bank_account_netsuite_id: accountId, run_id: run.id, destination: setup.destination, origin: setup.origin,
        created_on: clock.day, created_time: clock.time, modifier, effective_date: pays, entry_count: built.entryCount, total_cents: built.totalCents,
        entry_hash: built.entryHash, file_name: fileName, file_locked: lockFile(key, built.text, body.id), by: me,
        payments: rows.map(({ p, set }) => ({
          payment_id: p.id, vendor_netsuite_id: p.vendor_netsuite_id, vendor_name: p.vendor_name, bank_account_id: set.id, routing_number: set.routing_number,
          account_last4: set.account_last4, account_type: set.account_type, name_on_account: set.name_on_account, cents: Number(p.total_cents),
        })),
      },
    });
    if (error) return NextResponse.json({ error: `Couldn't keep the file (${error.message}). Nothing was made.` }, { status: 500 });
    const result = data as { state: string; payment_id?: string; why?: string };
    if (result.state === 'modifier_taken') { taken.add(modifier); continue; }
    if (result.state === 'made_already') return NextResponse.json({ success: true, id: body.id, made: false });
    if (result.state === 'run') return NextResponse.json({ error: "The run isn't approved or paid from this bank account any more: reload. Nothing was made." }, { status: 409 });
    if (result.state === 'payment') {
      const p = picked.find((x) => x.id === result.payment_id);
      const why = PAYMENT_WHY[result.why ?? ''] ?? ((v: string) => `${v}'s payment can't go in the file: reload.`);
      return NextResponse.json({ error: `${why(p ? vendorOf(p) : 'A vendor')} Nothing was made.` }, { status: 409 });
    }
    if (result.state !== 'made') return NextResponse.json({ error: `The file wasn't kept (${result.state}): reload. Nothing was made.` }, { status: 500 });

    await logAudit(service, {
      actorId: me, table: 'vendor_ach_files', recordId: body.id, action: 'make',
      detail: {
        run_id: run.id, file_name: fileName, effective_date: pays, entries: built.entryCount,
        vendors: rows.map(({ p, set }) => ({ vendor_id: p.vendor_netsuite_id, vendor: vendorOf(p), routing: set.routing_number, account_ending: set.account_last4, type: set.account_type })),
      },
    });
    const nameOf = await readNames([me]);
    await tell(me, {
      type: 'books_ach_file_made',
      title: `ACH file made: ${fileName}`,
      body: `${nameOf(me)} made the ACH file ${fileName} from the payment run from ${run.bank_account_name || 'its bank account'} dated `
        + `${dayText(dayOf(run.pay_date))}, paying ${plural(rows.length, 'vendor')} by ACH. Once it's uploaded, First Bank pays it on ${dayText(pays)}.`,
      url: deepLinks.payVendors(run.id),
    });
    return NextResponse.json({ success: true, id: body.id, made: true, fileName, pays: { day: pays, text: dayText(pays) } });
  }
  return NextResponse.json({ error: 'Other files took the next letters for today the same moment: press again. Nothing was made.' }, { status: 409 });
}

async function markSent(body: Extract<Body, { action: 'sent' }>, me: string) {
  const file = await readFile(body.fileId);
  if (!file) return NextResponse.json({ error: fileWhere('gone') }, { status: 404 });
  const { data, error } = await service.rpc('vendor_ach_file_sent', { p: { id: file.id, by: me } });
  if (error) return NextResponse.json({ error: `It wasn't marked sent (${error.message}).` }, { status: 500 });
  const result = data as { state: string };
  if (result.state !== 'sent') return NextResponse.json({ error: fileWhere(result.state) }, { status: result.state === 'gone' ? 404 : 409 });
  await logAudit(service, { actorId: me, table: 'vendor_ach_files', recordId: file.id, action: 'sent', detail: { file_name: file.file_name } });
  return NextResponse.json({ success: true });
}

async function setAside(body: Extract<Body, { action: 'set_aside' }>, me: string) {
  const file = await readFile(body.fileId);
  if (!file) return NextResponse.json({ error: fileWhere('gone') }, { status: 404 });
  if (file.status === 'set_aside') return NextResponse.json({ error: fileWhere('set_aside_already') }, { status: 409 });
  const problem = noteProblem('why', body.reason, WHY_MAX);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const why = body.reason.trim();
  const { data, error } = await service.rpc('vendor_ach_file_set_aside', { p: { id: file.id, by: me, why } });
  if (error) return NextResponse.json({ error: `It wasn't set aside (${error.message}).` }, { status: 500 });
  const result = data as { state: string; was?: FileStatus };
  if (result.state !== 'set_aside') return NextResponse.json({ error: fileWhere(result.state) }, { status: result.state === 'gone' ? 404 : 409 });

  await logAudit(service, {
    actorId: me, table: 'vendor_ach_files', recordId: file.id, action: 'set_aside', detail: { file_name: file.file_name, was: result.was, why },
  });
  const nameOf = await readNames([me]);
  const sent = result.was === 'sent';
  await tell(me, {
    type: 'books_ach_file_set_aside',
    title: `ACH file set aside: ${file.file_name}`,
    body: `${nameOf(me)} set aside the ACH file ${file.file_name}${sent ? ', which was marked sent to First Bank' : ''}: ${sentence(why)} `
      + (sent
        ? "Its payments can go in a new file, so check with First Bank that it didn't pay this one, or they're paid twice."
        : 'Its payments can go in a new file.'),
    url: deepLinks.payVendors(file.run_id),
  });
  return NextResponse.json({ success: true, was: result.was });
}
