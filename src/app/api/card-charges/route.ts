import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { createJournalEntry, findJournalEntry } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { readAccounts, readCompanies } from '@/lib/books/snap-a-bill';
import { saveOwnCardEntry } from '@/lib/books/own-journal-entries';
import { logAudit } from '@/lib/audit';
import {
  CARD_ACCOUNT_TYPES, FIRST_SEND_MONTH, MAX_CHARGES_PER_ENTRY, MAX_CODED_AT_ONCE, MEMO_MAX, formatCents, importRows, keptCharge,
  monthName, netsuiteJournalEntry, readChaseDownload, sendExternalId, workOutCardEntry,
  type CardAccount, type CardCompany, type KeptChargeRow, type WorkedCardEntry,
} from '@/lib/card-charges';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Card charges are switched off until ${SWITCH_ON_DATE_TEXT}.`;

/** How long a send can say it's being made before FleetSuite asks NetSuite what became of it. */
const STALE_MS = 5 * 60 * 1000;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

/**
 * Anyone with Payments once card charges are switched on (Books → Switches); until then only super admins, who can
 * add and code charges to see what a send would make, and nothing is sent.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'vendor_payments');
  if (auth.error) return { auth, on: false, error: auth.error };
  const on = await switchIsOn(service, 'card_charges');
  if (!on && !getProfileRoles(auth.profile).includes('super_admin')) {
    return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  }
  return { auth, on };
}

interface Chart {
  companies: CardCompany[];
  /** The accounts a charge can go to. */
  accounts: Map<string, CardAccount>;
  /** The card accounts. */
  cards: Map<string, CardAccount>;
}

async function readChart(): Promise<Chart> {
  const rows = await readCompanies(service);
  const [lines, cardRows] = await Promise.all([readAccounts(service, rows), readAccounts(service, rows, CARD_ACCOUNT_TYPES)]);
  const keep = (all: typeof lines) => {
    const out = new Map<string, CardAccount>();
    for (const a of all.values()) {
      if (a.companies.length > 0) out.set(a.id, { id: a.id, number: a.number, name: a.name, type: a.type, companies: a.companies });
    }
    return out;
  };
  return {
    companies: rows.map((c) => ({ code: c.code, name: c.name, subsidiaryId: c.subsidiaryId })),
    accounts: keep(lines),
    cards: keep(cardRows),
  };
}

const byNumber = (a: CardAccount, b: CardAccount) => (a.number || a.name).localeCompare(b.number || b.name, 'en', { numeric: true });

const CHARGE_COLUMNS = 'id, charge_date, post_date, description, merchant_key, category, chase_type, cents, card, account_netsuite_id, memo, remembered';

interface SendRow {
  id: string;
  month: string;
  tran_date: string | null;
  charge_count: number | null;
  net_cents: number | string | null;
  total_cents: number | string | null;
  claimed_at: string | null;
  netsuite_journal_id: string | null;
  netsuite_number: string | null;
  error: string | null;
  created_at: string;
}

const numberOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * GET /api/card-charges?status=1 — whether card charges are on, and whether this person can use them.
 * GET /api/card-charges?company=<code>&card=<NetSuite account id> — the companies, card accounts and accounts, and
 * for the card (the one picked, else the one last added to): its charges not sent yet, its sends and its files.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'vendor_payments');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'card_charges');
    return NextResponse.json({ on, canUse: on || getProfileRoles(auth.profile).includes('super_admin') });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    const chart = await readChart();
    const company = chart.companies.find((c) => c.code === params.get('company'))
      ?? chart.companies.find((c) => c.code === 'BMG') ?? chart.companies[0];
    const cards = [...chart.cards.values()].filter((a) => !!company && a.companies.includes(company.code)).sort(byNumber);
    let cardId = params.get('card') || '';
    if (!cards.some((c) => c.id === cardId)) {
      const { data: last } = await service.from('card_charge_imports').select('card_account_netsuite_id')
        .eq('company', company?.code ?? '').order('created_at', { ascending: false }).limit(1).maybeSingle();
      const lastCard = (last as { card_account_netsuite_id?: string } | null)?.card_account_netsuite_id;
      cardId = cards.some((c) => c.id === lastCard) ? lastCard! : cards[0]?.id ?? '';
    }

    let charges: KeptChargeRow[] = [];
    let sends: SendRow[] = [];
    let imports: Array<Record<string, any>> = [];
    if (cardId && company) {
      const [chargeRes, sendRes, importRes] = await Promise.all([
        fetchAllRows<KeptChargeRow>((from, to) => service.from('card_charges').select(CHARGE_COLUMNS)
          .eq('card_account_netsuite_id', cardId).eq('company', company.code).is('send_id', null)
          .order('charge_date', { ascending: true }).order('id', { ascending: true }).range(from, to)),
        service.from('card_charge_sends')
          .select('id, month, tran_date, charge_count, net_cents, total_cents, claimed_at, netsuite_journal_id, netsuite_number, error, created_at')
          .eq('card_account_netsuite_id', cardId).eq('company', company.code).order('created_at', { ascending: false }).limit(12),
        service.from('card_charge_imports').select('id, file_name, charges, added, already, remembered, payments, created_at')
          .eq('card_account_netsuite_id', cardId).eq('company', company.code).order('created_at', { ascending: false }).limit(10),
      ]);
      if (chargeRes.error) throw new Error(chargeRes.error.message);
      if (sendRes.error) throw new Error(sendRes.error.message);
      if (importRes.error) throw new Error(importRes.error.message);
      charges = chargeRes.data;
      sends = (sendRes.data ?? []) as SendRow[];
      imports = importRes.data ?? [];
    }
    // How many of each file's charges aren't sent: the ones Undo would take back off.
    const unsentByImport = new Map<string, number>();
    if (imports.length > 0) {
      const held = await fetchAllRows<{ import_id: string }>((from, to) => service.from('card_charges').select('import_id')
        .in('import_id', imports.map((i) => i.id)).is('send_id', null).order('id', { ascending: true }).range(from, to));
      if (held.error) throw new Error(held.error.message);
      for (const r of held.data) unsentByImport.set(r.import_id, (unsentByImport.get(r.import_id) ?? 0) + 1);
    }

    return NextResponse.json({
      companies: chart.companies,
      company: company?.code ?? null,
      cardAccounts: cards,
      accounts: [...chart.accounts.values()].filter((a) => !!company && a.companies.includes(company.code)).sort(byNumber),
      cardId: cardId || null,
      charges: charges.map((r) => ({
        ...keptCharge(r), postDate: r.post_date, merchantKey: r.merchant_key, category: r.category, type: r.chase_type,
        remembered: r.remembered,
      })),
      sends: sends.map((s) => ({
        id: s.id,
        month: String(s.month).slice(0, 7),
        date: s.tran_date,
        count: s.charge_count,
        netCents: numberOrNull(s.net_cents),
        totalCents: numberOrNull(s.total_cents),
        state: s.netsuite_journal_id ? 'made' : s.claimed_at ? 'making' : 'refused',
        journalId: s.netsuite_journal_id,
        number: s.netsuite_number,
        error: s.netsuite_journal_id ? null : s.error,
        at: s.created_at,
      })),
      imports: imports.map((i) => ({
        id: i.id, fileName: i.file_name, charges: i.charges, added: i.added, already: i.already, remembered: i.remembered,
        payments: i.payments, unsent: unsentByImport.get(i.id) ?? 0, at: i.created_at,
      })),
      firstSendMonth: FIRST_SEND_MONTH,
      maxPerEntry: MAX_CHARGES_PER_ENTRY,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can add and code charges to see what a send would make; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/);
const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('import'),
    // Made by the page when a file is picked: the same file sent twice in one go is one import.
    importId: z.string().uuid(),
    company: z.string().min(1).max(12),
    cardId: netsuiteId,
    fileName: z.string().max(300).optional(),
    // The CSV's text, read in the browser. A year of a busy card is well under a megabyte.
    csv: z.string().min(1).max(3_000_000),
  }),
  z.object({
    action: z.literal('code'),
    company: z.string().min(1).max(12),
    cardId: netsuiteId,
    changes: z.array(z.object({
      id: z.string().uuid(),
      accountId: netsuiteId.nullable(),
      memo: z.string().max(MEMO_MAX).optional(),
    })).min(1).max(MAX_CODED_AT_ONCE),
  }),
  z.object({
    action: z.literal('undo'),
    importId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('send'),
    // Made by the page for each month's Send: pressed twice, or tried again, it's one journal entry.
    sendId: z.string().uuid(),
    company: z.string().min(1).max(12),
    cardId: netsuiteId,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    // What the page showed, so nothing changed under it.
    expectedCount: z.number().int().min(1).max(MAX_CHARGES_PER_ENTRY).optional(),
    expectedTotalCents: z.number().int().optional(),
  }),
]);

/** The company and card a request names, when the card is a card account that company can use. */
function companyAndCard(chart: Chart, companyCode: string, cardId: string) {
  const company = chart.companies.find((c) => c.code === companyCode);
  const card = chart.cards.get(cardId);
  if (!company) return { error: NextResponse.json({ error: `There's no company ${companyCode} in Books.` }, { status: 400 }) };
  if (!card || !card.companies.includes(company.code)) {
    return { error: NextResponse.json({ error: `That isn't a card account ${company.name} can use.` }, { status: 400 }) };
  }
  return { company, card };
}

/**
 * POST /api/card-charges — { action: 'import' } adds a Chase download's charges; 'code' codes charges and remembers
 * each merchant's account; 'undo' takes a file's charges back off (the ones not sent); 'send' makes a month's journal
 * entry in NetSuite from the charges as they're kept, and keeps Books' copy. Sending is refused while card charges are
 * switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.action === 'undo') {
    const { data, error } = await service.from('card_charges').delete()
      .eq('import_id', body.importId).is('send_id', null).select('id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const removed = (data ?? []).length;
    await logAudit(service, { actorId: auth.user.id, table: 'card_charge_imports', recordId: body.importId, action: 'undo', detail: { removed } });
    return NextResponse.json({ success: true, removed });
  }

  if (body.action === 'send' && !gate.on) {
    return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });
  }

  let chart: Chart;
  try {
    chart = await readChart();
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
  const picked = companyAndCard(chart, body.company, body.cardId);
  if (picked.error) return picked.error;
  const { company, card } = picked;

  if (body.action === 'import') {
    const download = readChaseDownload(body.csv);
    if (download.problems.length > 0) {
      return NextResponse.json({ error: download.problems[0], problems: download.problems.slice(0, 25) }, { status: 400 });
    }
    const { data, error } = await service.rpc('card_charges_import', {
      p: {
        import_id: body.importId, company: company.code, card_account_netsuite_id: card.id, file_name: body.fileName ?? null,
        payments: download.payments, imported_by: auth.user.id,
        rows: importRows(download.rows),
      },
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const result = data as { added: number; already: number; remembered: number; payments: number; again: boolean };
    if (!result.again) {
      await logAudit(service, {
        actorId: auth.user.id, table: 'card_charge_imports', recordId: body.importId, action: 'create',
        detail: { card: card.id, file: body.fileName ?? null, added: result.added, already: result.already, remembered: result.remembered },
      });
    }
    return NextResponse.json({ success: true, ...result, zero: download.zero });
  }

  if (body.action === 'code') {
    for (const c of body.changes) {
      if (!c.accountId) continue;
      const account = chart.accounts.get(c.accountId);
      if (c.accountId === card.id) return NextResponse.json({ error: "A charge can't go to the card's own account." }, { status: 400 });
      if (!account || !account.companies.includes(company.code)) {
        return NextResponse.json({ error: `A charge goes to an account ${company.name} can't use. Nothing was saved.` }, { status: 400 });
      }
    }
    const { data, error } = await service.rpc('card_charges_code', {
      p: {
        card_account_netsuite_id: card.id, by: auth.user.id,
        changes: body.changes.map((c) => ({ id: c.id, account_netsuite_id: c.accountId, memo: c.memo ?? '' })),
      },
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, ...(data as { coded: number; held: number }) });
  }

  return send(body, { auth, chart, company, card });
}

type SendBody = Extract<z.infer<typeof Schema>, { action: 'send' }>;

interface SendContext {
  auth: Auth;
  chart: Chart;
  company: CardCompany;
  card: CardAccount;
}

async function letGo(sendId: string, error: string) {
  await service.rpc('card_charges_let_go', { p: { send_id: sendId, error } });
}

async function send(body: SendBody, ctx: SendContext): Promise<NextResponse> {
  const { auth, chart, company, card } = ctx;
  const month = body.month;
  if (month < FIRST_SEND_MONTH) {
    return NextResponse.json({
      error: `${monthName(month)} is before ${monthName(FIRST_SEND_MONTH)}: its card charges are on the bookkeeper's journal entries in NetSuite already. Nothing was sent.`,
    }, { status: 400 });
  }

  const { data, error } = await service.rpc('card_charges_claim', {
    p: {
      send_id: body.sendId, company: company.code, card_account_netsuite_id: card.id, month: `${month}-01`,
      max: MAX_CHARGES_PER_ENTRY, created_by: auth.user.id,
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as {
    state: 'made' | 'making' | 'uncoded' | 'nothing' | 'claimed';
    netsuite_journal_id?: string; netsuite_number?: string | null; charge_count?: number; total_cents?: number;
    claimed_at?: string; uncoded?: number; charges?: KeptChargeRow[];
  };

  if (claim.state === 'made') {
    return NextResponse.json({
      success: true, already: true, journalId: claim.netsuite_journal_id, number: claim.netsuite_number ?? null,
      count: claim.charge_count ?? null, totalCents: claim.total_cents ?? null,
    });
  }
  if (claim.state === 'uncoded') {
    const n = claim.uncoded ?? 0;
    return NextResponse.json({
      error: `${n === 1 ? 'One charge' : `${n} charges`} in ${monthName(month)} ${n === 1 ? 'has' : 'have'} no account yet. Code ${n === 1 ? 'it' : 'them'}, then send. Nothing was sent.`,
    }, { status: 409 });
  }
  if (claim.state === 'nothing') {
    return NextResponse.json({ error: `${monthName(month)} has no charges to send.` }, { status: 409 });
  }

  const charges = (claim.charges ?? []).map(keptCharge);
  const worked = workOutCardEntry(charges, { company, cardAccount: card, accounts: chart.accounts });
  const externalId = sendExternalId(body.sendId);

  if (claim.state === 'making') {
    const age = Date.now() - Date.parse(claim.claimed_at ?? '');
    if (!(age > STALE_MS)) {
      return NextResponse.json({ error: `${monthName(month)}'s charges are being sent now. Don't press again: reload in a minute to see them.` }, { status: 409 });
    }
    // Being made for a while: NetSuite made it or never will. Ask it.
    let there: Awaited<ReturnType<typeof findJournalEntry>>;
    try {
      there = await findJournalEntry(externalId);
    } catch (err: any) {
      return NextResponse.json({ error: `Couldn't ask NetSuite what became of this send (${err?.message || err}). Try again.` }, { status: 502 });
    }
    if (there) return finish(body, ctx, worked, there.journalId, there.number || null, true);
    const why = "NetSuite has no journal entry from this send, so its charges are back to send again.";
    await letGo(body.sendId, why);
    return NextResponse.json({ error: why }, { status: 409 });
  }

  // Freshly claimed: check it's what the page showed, then make it.
  if (worked.problems.length > 0) {
    const why = worked.problems.join(' ');
    await letGo(body.sendId, why);
    return NextResponse.json({ error: `${why} Nothing was sent.` }, { status: 400 });
  }
  if (body.expectedCount === undefined || body.expectedTotalCents === undefined
    || worked.chargeCount !== body.expectedCount || worked.netCents !== body.expectedTotalCents) {
    const why = `${monthName(month)} now has ${worked.chargeCount} charges for ${formatCents(worked.netCents)}, not what the page showed.`;
    await letGo(body.sendId, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Reload and check them.` }, { status: 409 });
  }

  // NetSuite never takes two journal entries under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findJournalEntry(externalId);
    if (there) return finish(body, ctx, worked, there.journalId, there.number || null, true);
  } catch (err: any) {
    const why = `Couldn't check NetSuite for this send (${err?.message || err}).`;
    await letGo(body.sendId, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Try again.` }, { status: 502 });
  }

  const result = await createJournalEntry(netsuiteJournalEntry(worked, company.subsidiaryId!, body.sendId));
  if (!result.success || !result.journalId) {
    const why = result.error || "NetSuite didn't make the journal entry.";
    if (result.unsure) {
      // NetSuite may have made it: keep the charges held until it's asked again.
      await service.from('card_charge_sends').update({ error: why.slice(0, 2000), updated_at: new Date().toISOString() }).eq('id', body.sendId);
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so the charges stay held. Press Send again in a few minutes and FleetSuite will ask NetSuite.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(body.sendId, why);
    return NextResponse.json({ error: why }, { status: 502 });
  }

  let number: string | null = null;
  try {
    number = (await findJournalEntry(externalId))?.number || null;
  } catch {
    // The number is for showing; NetSuite's id is what's kept.
  }
  return finish(body, ctx, worked, result.journalId, number, false);
}

/** The journal entry is in NetSuite: keep its id on the send, keep Books' copy, and say so. */
async function finish(body: SendBody, ctx: SendContext, worked: WorkedCardEntry, journalId: string, number: string | null, already: boolean) {
  const { auth, company, card } = ctx;
  await service.from('card_charge_sends').update({
    netsuite_journal_id: journalId,
    netsuite_number: number,
    charge_count: worked.chargeCount,
    net_cents: worked.netCents,
    total_cents: worked.totalCents,
    tran_date: worked.date || null,
    error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', body.sendId);

  // Books' own copy of the journal entry (never fails the send).
  const books = await saveOwnCardEntry(service, {
    netsuiteId: journalId, netsuiteNumber: number, company: company.code, worked, madeFromId: body.sendId, madeBy: auth.user.id,
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'card_charge_sends',
    recordId: body.sendId,
    action: 'create',
    detail: {
      netsuite_journal_id: journalId, card: card.id, month: body.month, charges: worked.chargeCount,
      net: formatCents(worked.netCents), found_in_netsuite: already,
    },
  });

  return NextResponse.json({
    success: true,
    ...(already ? { already: true } : {}),
    journalId,
    number,
    count: worked.chargeCount,
    totalCents: worked.netCents,
    ...(books.saved || books.reason === 'already saved' ? {} : { warning: `Books didn't keep its copy (${books.reason}). The journal entry is in NetSuite.` }),
  });
}
