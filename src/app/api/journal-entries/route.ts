import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createJournalEntry, findJournalEntry } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { readAccounts, readCompanies } from '@/lib/books/snap-a-bill';
import { saveOwnTypedEntry } from '@/lib/books/own-journal-entries';
import { logAudit } from '@/lib/audit';
import { getSuperAdminIds, notifyMany } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { deepLinks } from '@/lib/deep-links';
import {
  JOURNAL_LINE_ACCOUNT_TYPES, MAX_LINES, MAX_LINE_CENTS, MEMO_MAX, REASON_MAX, formatCents, isDay, keptLines, linesToKeep,
  netsuiteTypedEntry, typedExternalId, workOutTypedEntry,
  type JournalAccount, type JournalCompany, type KeptLine, type TypedStatus, type WorkedTypedEntry,
} from '@/lib/typed-journal-entries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Journal entries are switched off until ${SWITCH_ON_DATE_TEXT}.`;

/** How long an approval can say it's being made before FleetSuite asks NetSuite what became of it. */
const STALE_MS = 5 * 60 * 1000;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

interface Gate {
  auth: Auth;
  on: boolean;
  /** Super admins approve, and send entries back. */
  superAdmin: boolean;
  error?: NextResponse;
}

/**
 * Anyone with Payments once journal entries are switched on (Books → Switches); until then only super admins, who
 * can type and save entries to see what they'd make, and none is asked for approval or sent.
 */
async function access(req: NextRequest): Promise<Gate> {
  const auth = await requireFeature(req, 'vendor_payments');
  if (auth.error) return { auth, on: false, superAdmin: false, error: auth.error };
  const on = await switchIsOn(service, 'journal_entries');
  const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
  if (!on && !superAdmin) {
    return { auth, on, superAdmin, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  }
  return { auth, on, superAdmin };
}

interface Chart {
  companies: JournalCompany[];
  /** Every account in the chart, each with the companies a typed line can use it for (none for one it can't). */
  accounts: Map<string, JournalAccount>;
}

async function readChart(): Promise<Chart> {
  const rows = await readCompanies(service);
  const all = await readAccounts(service, rows, JOURNAL_LINE_ACCOUNT_TYPES);
  return {
    companies: rows.map((c) => ({ code: c.code, name: c.name, subsidiaryId: c.subsidiaryId })),
    accounts: new Map([...all.values()].map((a) => [a.id, { id: a.id, number: a.number, name: a.name, type: a.type, companies: a.companies }])),
  };
}

const byNumber = (a: JournalAccount, b: JournalAccount) => (a.number || a.name).localeCompare(b.number || b.name, 'en', { numeric: true });

const ENTRY_COLUMNS = 'id, company, tran_date, memo, lines, total_cents, status, created_by, created_at, updated_by, updated_at, '
  + 'asked_by, asked_at, returned_by, returned_at, returned_reason, approved_by, approved_at, netsuite_journal_id, netsuite_number, error';

interface EntryRow {
  id: string;
  company: string;
  tran_date: string;
  memo: string | null;
  lines: KeptLine[] | null;
  total_cents: number | string;
  status: TypedStatus;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  asked_by: string | null;
  asked_at: string | null;
  returned_by: string | null;
  returned_at: string | null;
  returned_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  netsuite_journal_id: string | null;
  netsuite_number: string | null;
  error: string | null;
}

/** The most entries the page lists that aren't made, and that are. */
const OPEN_LIMIT = 200;
const MADE_LIMIT = 25;

const isUuid = (s: string | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * GET /api/journal-entries?status=1 — whether journal entries are on, and whether this person can use and approve them.
 * GET /api/journal-entries[?id=<entry>] — the companies and the accounts a line can go to, the entries not made yet,
 * the last made, and the one asked for.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'vendor_payments');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'journal_entries');
    const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
    return NextResponse.json({ on, canUse: on || superAdmin, canApprove: on && superAdmin });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    const chart = await readChart();
    const id = params.get('id');
    const [openRes, madeRes, oneRes] = await Promise.all([
      service.from('typed_journal_entries').select(ENTRY_COLUMNS).neq('status', 'made')
        .order('updated_at', { ascending: false }).limit(OPEN_LIMIT),
      service.from('typed_journal_entries').select(ENTRY_COLUMNS).eq('status', 'made')
        .order('approved_at', { ascending: false }).limit(MADE_LIMIT),
      isUuid(id)
        ? service.from('typed_journal_entries').select(ENTRY_COLUMNS).eq('id', id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (openRes.error) throw new Error(openRes.error.message);
    if (madeRes.error) throw new Error(madeRes.error.message);
    if (oneRes.error) throw new Error(oneRes.error.message);
    const rows = new Map<string, EntryRow>();
    for (const r of [...(openRes.data ?? []), ...(madeRes.data ?? []), ...(oneRes.data ? [oneRes.data] : [])] as unknown as EntryRow[]) rows.set(r.id, r);

    const people = [...new Set([...rows.values()].flatMap((r) => [r.created_by, r.updated_by, r.asked_by, r.returned_by, r.approved_by])
      .filter((p): p is string => !!p))];
    const { data: profiles, error: profileError } = people.length
      ? await service.from('profiles').select('id, full_name').in('id', people)
      : { data: [], error: null };
    if (profileError) throw new Error(profileError.message);
    const names = new Map(((profiles ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
    const name = (p: string | null) => (p ? names.get(p) || 'Someone' : null);

    return NextResponse.json({
      companies: chart.companies,
      accounts: [...chart.accounts.values()].filter((a) => a.companies.length > 0).sort(byNumber),
      entries: [...rows.values()].map((r) => ({
        id: r.id,
        company: r.company,
        date: String(r.tran_date).slice(0, 10),
        memo: r.memo,
        lines: keptLines(r.lines),
        totalCents: Number(r.total_cents),
        status: r.status,
        createdBy: name(r.created_by),
        createdById: r.created_by,
        createdAt: r.created_at,
        updatedBy: name(r.updated_by),
        updatedAt: r.updated_at,
        askedBy: name(r.asked_by),
        askedById: r.asked_by,
        askedAt: r.asked_at,
        returnedBy: name(r.returned_by),
        returnedAt: r.returned_at,
        returnedReason: r.returned_reason,
        approvedBy: name(r.approved_by),
        approvedAt: r.approved_at,
        journalId: r.netsuite_journal_id,
        number: r.netsuite_number,
        error: r.error,
      })),
      me: gate.auth.user.id,
      superAdmin: gate.superAdmin,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can type and save entries to see what they'd make; none is asked for approval or sent to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/);
const cents = z.number().int().min(0).max(MAX_LINE_CENTS);
const stamp = z.string().min(1).max(60);
const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    // Made by the page when the entry is started: it's the journal entry's External ID in NetSuite.
    id: z.string().uuid(),
    company: z.string().min(1).max(12),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().max(MEMO_MAX).nullable().optional(),
    lines: z.array(z.object({
      accountId: netsuiteId.nullable(),
      debitCents: cents,
      creditCents: cents,
      memo: z.string().max(MEMO_MAX).nullable().optional(),
    })).max(MAX_LINES),
  }),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }),
  // updatedAt: the draft as the asker saw it.
  z.object({ action: z.literal('ask'), id: z.string().uuid(), updatedAt: stamp }),
  z.object({ action: z.literal('take_back'), id: z.string().uuid() }),
  z.object({ action: z.literal('send_back'), id: z.string().uuid(), reason: z.string().trim().min(1).max(REASON_MAX) }),
  // askedAt: the ask as the approver saw it.
  z.object({ action: z.literal('approve'), id: z.string().uuid(), askedAt: stamp }),
]);
type Body = z.infer<typeof Schema>;

const WHERE_IT_IS: Record<string, string> = {
  draft: "It's a draft now: it was taken back or sent back.",
  waiting: "It's asked for approval: take it back to change it.",
  sending: "It's being made in NetSuite.",
  made: "It's in NetSuite already.",
  gone: "There's no such journal entry: it was deleted.",
};
const whereItIs = (status: string) => WHERE_IT_IS[status] ?? `It's ${status}.`;

async function readEntry(id: string): Promise<EntryRow | null> {
  const { data, error } = await service.from('typed_journal_entries').select(ENTRY_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as EntryRow | null) ?? null;
}

/** What an entry is, for an alert: its company, date, memo and total. */
const describe = (r: Pick<EntryRow, 'company' | 'tran_date' | 'memo' | 'total_cents'>) =>
  `${r.company} journal entry dated ${String(r.tran_date).slice(0, 10)} for ${formatCents(Number(r.total_cents))}${r.memo ? `: ${r.memo}` : ''}`;

/**
 * An alert to these people and to anyone with "Copy me on new alerts" ticked, never to the one who did it. Never
 * throws: the entry has moved whatever happens here.
 */
async function tell(ids: Array<string | null | undefined>, actorId: string, alert: { type: string; title: string; body: string; url: string }) {
  try {
    const watchers = await newAlertWatcherIds(service);
    const to = [...new Set([...ids, ...watchers])].filter((p): p is string => !!p && p !== actorId);
    if (to.length > 0) await notifyMany(to, { ...alert, channels: ['in_app', 'push', 'email'] });
  } catch (err: any) {
    console.error(`[journal-entries] alert ${alert.type} not sent: ${err?.message || err}`);
  }
}

/**
 * POST /api/journal-entries — { action: 'save' } saves a draft, new or changed; 'delete' deletes a draft; 'ask' asks
 * for approval; 'take_back' takes an ask back to a draft; 'send_back' (super admins) sends an ask back with why;
 * 'approve' (super admins who didn't ask) makes the entry in NetSuite from its lines as they're kept, and keeps
 * Books' copy. Asking and approving are refused while journal entries are switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if ((body.action === 'ask' || body.action === 'approve') && !gate.on) {
    return NextResponse.json({
      error: `${OFF} ${body.action === 'ask' ? 'It was saved, and not asked for approval.' : 'Nothing was sent to NetSuite.'}`,
      switchedOff: true,
    }, { status: 403 });
  }
  if ((body.action === 'send_back' || body.action === 'approve') && !gate.superAdmin) {
    return NextResponse.json({ error: 'Only a super admin approves journal entries or sends them back.' }, { status: 403 });
  }

  try {
    switch (body.action) {
      case 'save': return await save(body, gate);
      case 'delete': return await remove(body, gate);
      case 'ask': return await ask(body, gate);
      case 'take_back': return await takeBack(body, gate);
      case 'send_back': return await sendBack(body, gate);
      case 'approve': return await approve(body, gate);
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

async function save(body: Extract<Body, { action: 'save' }>, { auth }: Gate) {
  const chart = await readChart();
  const company = chart.companies.find((c) => c.code === body.company);
  if (!company) return NextResponse.json({ error: `There's no company ${body.company} in Books.` }, { status: 400 });
  if (!isDay(body.date)) return NextResponse.json({ error: `${body.date} isn't a day on the calendar.` }, { status: 400 });

  const { data, error } = await service.rpc('typed_journal_entry_save', {
    p: {
      id: body.id, company: company.code, tran_date: body.date, memo: body.memo ?? '', by: auth.user.id,
      lines: linesToKeep(body.lines.map((l) => ({ ...l, memo: l.memo ?? null }))),
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { saved: boolean; status: string; updated_at?: string };
  if (!result.saved) return NextResponse.json({ error: `It wasn't saved. ${whereItIs(result.status)}`, status: result.status }, { status: 409 });
  return NextResponse.json({ success: true, updatedAt: result.updated_at });
}

async function remove(body: Extract<Body, { action: 'delete' }>, { auth, superAdmin }: Gate) {
  const row = await readEntry(body.id);
  if (!row) return NextResponse.json({ success: true, already: true });
  if (row.status !== 'draft') return NextResponse.json({ error: `Only a draft can be deleted. ${whereItIs(row.status)}` }, { status: 409 });
  if (!superAdmin && row.created_by !== auth.user.id) {
    return NextResponse.json({ error: 'Only whoever started a draft, or a super admin, can delete it.' }, { status: 403 });
  }
  const { data, error } = await service.from('typed_journal_entries').delete().eq('id', body.id).eq('status', 'draft').select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if ((data ?? []).length === 0) return NextResponse.json({ error: "It wasn't deleted: it was asked for approval just now." }, { status: 409 });
  await logAudit(service, {
    actorId: auth.user.id, table: 'typed_journal_entries', recordId: body.id, action: 'delete',
    detail: { company: row.company, date: row.tran_date, memo: row.memo, total: formatCents(Number(row.total_cents)) },
  });
  return NextResponse.json({ success: true });
}

async function ask(body: Extract<Body, { action: 'ask' }>, { auth }: Gate) {
  const row = await readEntry(body.id);
  if (!row) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (row.status !== 'draft') return NextResponse.json({ error: whereItIs(row.status) }, { status: 409 });

  // The same checks approving makes, on the lines as they're kept, before anyone's asked.
  const chart = await readChart();
  const worked = workOutTypedEntry(
    { date: String(row.tran_date).slice(0, 10), memo: row.memo, lines: keptLines(row.lines) },
    { company: chart.companies.find((c) => c.code === row.company), accounts: chart.accounts },
  );
  if (worked.problems.length > 0) {
    return NextResponse.json({ error: `${worked.problems[0]} It wasn't asked for approval.`, problems: worked.problems }, { status: 400 });
  }

  const { data, error } = await service.rpc('typed_journal_entry_ask', { p: { id: body.id, by: auth.user.id, updated_at: body.updatedAt } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string; asked_at?: string };
  if (result.state === 'changed') {
    return NextResponse.json({ error: 'It was changed since you opened it. Reload and check it, then ask again.' }, { status: 409 });
  }
  if (result.state !== 'asked') return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });

  await logAudit(service, {
    actorId: auth.user.id, table: 'typed_journal_entries', recordId: body.id, action: 'ask_approval',
    detail: { company: row.company, date: row.tran_date, memo: row.memo, total: formatCents(worked.debitCents), lines: worked.lines.length },
  });
  const approvers = await getSuperAdminIds(auth.user.id);
  await tell(approvers, auth.user.id, {
    type: 'books_journal_entry_waiting',
    title: 'A journal entry is waiting for approval',
    body: `${describe(row)}. Approve it to make it in NetSuite, or send it back.`,
    url: deepLinks.journalEntries(body.id),
  });
  return NextResponse.json({
    success: true,
    askedAt: result.asked_at,
    ...(approvers.length === 0 ? { warning: "No one else can approve it yet: it needs a super admin who didn't ask." } : {}),
  });
}

async function takeBack(body: Extract<Body, { action: 'take_back' }>, { auth, superAdmin }: Gate) {
  const row = await readEntry(body.id);
  if (!row) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (row.status !== 'waiting') return NextResponse.json({ error: whereItIs(row.status) }, { status: 409 });
  if (!superAdmin && row.asked_by !== auth.user.id && row.created_by !== auth.user.id) {
    return NextResponse.json({ error: 'Only whoever asked, or a super admin, can take it back.' }, { status: 403 });
  }
  const { data, error } = await service.rpc('typed_journal_entry_take_back', { p: { id: body.id, by: auth.user.id } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string };
  if (result.state !== 'taken_back') return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });
  await logAudit(service, { actorId: auth.user.id, table: 'typed_journal_entries', recordId: body.id, action: 'take_back' });
  return NextResponse.json({ success: true });
}

async function sendBack(body: Extract<Body, { action: 'send_back' }>, { auth }: Gate) {
  const row = await readEntry(body.id);
  if (!row) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  const { data, error } = await service.rpc('typed_journal_entry_send_back', { p: { id: body.id, by: auth.user.id, reason: body.reason } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string };
  if (result.state !== 'sent_back') return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });
  await logAudit(service, {
    actorId: auth.user.id, table: 'typed_journal_entries', recordId: body.id, action: 'send_back', detail: { reason: body.reason },
  });
  await tell([row.asked_by, row.created_by], auth.user.id, {
    type: 'books_journal_entry_decided',
    title: 'Your journal entry was sent back',
    body: `${describe(row)}, sent back to be fixed: ${body.reason}`,
    url: deepLinks.journalEntries(body.id),
  });
  return NextResponse.json({ success: true });
}

async function letGo(id: string, error: string) {
  await service.rpc('typed_journal_entry_let_go', { p: { id, error } });
}

async function approve(body: Extract<Body, { action: 'approve' }>, gate: Gate): Promise<NextResponse> {
  const { auth } = gate;
  const { data, error } = await service.rpc('typed_journal_entry_claim', { p: { id: body.id, approver: auth.user.id, asked_at: body.askedAt } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as {
    state: 'made' | 'making' | 'claimed' | 'changed' | 'yours' | 'draft' | 'gone';
    netsuite_journal_id?: string; netsuite_number?: string | null; entry?: EntryRow;
  };

  if (claim.state === 'made') {
    return NextResponse.json({ success: true, already: true, journalId: claim.netsuite_journal_id, number: claim.netsuite_number ?? null });
  }
  if (claim.state === 'gone') return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (claim.state === 'draft') return NextResponse.json({ error: `${whereItIs('draft')} Nothing was sent.` }, { status: 409 });
  if (claim.state === 'changed') {
    return NextResponse.json({ error: 'It was taken back or asked for again since you opened it. Reload and check it. Nothing was sent.' }, { status: 409 });
  }
  if (claim.state === 'yours') {
    return NextResponse.json({ error: "You asked for this one, so a super admin who didn't ask approves it. Nothing was sent." }, { status: 403 });
  }

  const entry = claim.entry!;
  const chart = await readChart();
  const company = chart.companies.find((c) => c.code === entry.company);
  const worked = workOutTypedEntry(
    { date: String(entry.tran_date).slice(0, 10), memo: entry.memo, lines: keptLines(entry.lines) },
    { company, accounts: chart.accounts },
  );
  const externalId = typedExternalId(entry.id);

  if (claim.state === 'making') {
    const age = Date.now() - Date.parse(entry.approved_at ?? '');
    if (!(age > STALE_MS)) {
      return NextResponse.json({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." }, { status: 409 });
    }
    // Being made for a while: NetSuite made it or never will. Ask it.
    let there: Awaited<ReturnType<typeof findJournalEntry>>;
    try {
      there = await findJournalEntry(externalId);
    } catch (err: any) {
      return NextResponse.json({ error: `Couldn't ask NetSuite what became of this approval (${err?.message || err}). Try again.` }, { status: 502 });
    }
    if (there) return finish(entry, worked, gate, there.journalId, there.number || null, true);
    const why = 'NetSuite has no journal entry from this approval, so it waits for approval again.';
    await letGo(entry.id, why);
    return NextResponse.json({ error: why }, { status: 409 });
  }

  // Freshly claimed: check it as it's kept, then make it.
  if (worked.problems.length > 0 || !company?.subsidiaryId) {
    const why = worked.problems.join(' ') || "Its company has no NetSuite subsidiary in Books.";
    await letGo(entry.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent.`, problems: worked.problems }, { status: 400 });
  }

  // NetSuite never takes two journal entries under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findJournalEntry(externalId);
    if (there) return finish(entry, worked, gate, there.journalId, there.number || null, true);
  } catch (err: any) {
    const why = `Couldn't check NetSuite for this entry (${err?.message || err}).`;
    await letGo(entry.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Try again.` }, { status: 502 });
  }

  const result = await createJournalEntry(netsuiteTypedEntry(worked, company.subsidiaryId, entry.id));
  if (!result.success || !result.journalId) {
    const why = result.error || "NetSuite didn't make the journal entry.";
    if (result.unsure) {
      // NetSuite may have made it: keep it held until it's asked again.
      await service.from('typed_journal_entries').update({ error: why.slice(0, 2000) }).eq('id', entry.id).eq('status', 'sending');
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so it stays approved. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(entry.id, why);
    return NextResponse.json({ error: why }, { status: 502 });
  }

  let number: string | null = null;
  try {
    number = (await findJournalEntry(externalId))?.number || null;
  } catch {
    // The number is for showing; NetSuite's id is what's kept.
  }
  return finish(entry, worked, gate, result.journalId, number, false);
}

/** The journal entry is in NetSuite: keep its id on the entry, keep Books' copy, and say so. */
async function finish(entry: EntryRow, worked: WorkedTypedEntry, { auth }: Gate, journalId: string, number: string | null, already: boolean) {
  const { error } = await service.rpc('typed_journal_entry_made', { p: { id: entry.id, netsuite_journal_id: journalId, netsuite_number: number } });
  if (error) console.error(`[journal-entries] entry ${entry.id} made as NetSuite journal entry ${journalId} but not kept: ${error.message}`);

  // Books' own copy of the journal entry (never fails the approval).
  const approver = entry.approved_by ?? auth.user.id;
  const books = await saveOwnTypedEntry(service, {
    netsuiteId: journalId, netsuiteNumber: number, company: entry.company, worked, madeFromId: entry.id, madeBy: approver,
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'typed_journal_entries',
    recordId: entry.id,
    action: 'approve',
    detail: {
      netsuite_journal_id: journalId, company: entry.company, date: worked.date, lines: worked.lines.length,
      total: formatCents(worked.debitCents), asked_by: entry.asked_by, found_in_netsuite: already,
    },
  });
  await tell([entry.asked_by, entry.created_by], auth.user.id, {
    type: 'books_journal_entry_decided',
    title: 'Your journal entry was approved',
    body: `${describe(entry)}, approved and made in NetSuite as ${number || `journal entry ${journalId}`}.`,
    url: deepLinks.journalEntries(entry.id),
  });

  return NextResponse.json({
    success: true,
    ...(already ? { already: true } : {}),
    journalId,
    number,
    totalCents: worked.debitCents,
    ...(books.saved || books.reason === 'already saved' ? {} : { warning: `Books didn't keep its copy (${books.reason}). The journal entry is in NetSuite.` }),
  });
}
