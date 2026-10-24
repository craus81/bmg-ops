import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { transactionUrl } from '@/lib/netsuite';
import { BOOKS_COMPANIES, type BooksCompany } from '@/lib/books/journal';
import { BOOKS_BILLS_SYNC } from '@/lib/books/netsuite-bills';
import { BOOKS_SPENDING_SYNC } from '@/lib/books/netsuite-spending';
import {
  accountNamer, BOOKS_MISTAKE_CHECKS, LOOK_FROM, mistakeView, runMistakeChecks, USUAL_FROM,
  type MistakeDocType, type MistakeView,
} from '@/lib/books/mistake-checks';

export const dynamic = 'force-dynamic';
// "Look now" runs the same look as the cron, with the same budget.
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 2000;

/** NetSuite's page for each kind of document. */
const PAGES: Record<MistakeDocType, Parameters<typeof transactionUrl>[0]> = {
  VendBill: 'vendbill', VendCred: 'vendcred', Check: 'check', CardChrg: 'cardchrg', CardRfnd: 'cardrfnd',
};

/** A refusal from the database, as the page shows it: "gl: it's already cleared" → "It's already cleared." */
const plain = (message: string) => {
  const text = message.replace(/^gl: /, '');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;
};

interface SyncState { at: string; error: string | null }

const syncStateOf = (row: { last_result: unknown; updated_at: string | null } | null): SyncState | null => {
  if (!row?.updated_at) return null;
  const result = (row.last_result ?? {}) as { error?: unknown };
  return { at: row.updated_at, error: typeof result.error === 'string' ? result.error : null };
};

/**
 * GET /api/admin/books/mistake-checks — every likely mistake the nightly
 * look has kept (migration 431, src/lib/books/mistake-checks.ts), open and
 * cleared, each company's open count, and when the look and the copies it
 * looked through last ran, for Books → Mistake checks.
 *
 * POST — { action: 'clear', id, how: 'fixed' | 'fine', note?, learn? },
 * { action: 'reopen', id } or { action: 'look' }: a super admin clears one,
 * opens one again, or has the check look now rather than wait for the night.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const read = (syncType: string) => service.from('sync_state').select('last_result, updated_at').eq('sync_type', syncType).maybeSingle();
  const [companies, rows, accounts, look, bills, spending] = await Promise.all([
    service.from('gl_companies').select('id, code, name').order('code'),
    fetchAllRows<Record<string, any>>((from, to) => service
      .from('gl_mistake_checks')
      .select('id, key, kind, company_id, party_netsuite_id, party_name, doc_date, amount, strength, why, docs, learn, state, '
        + 'cleared_how, cleared_by, cleared_at, cleared_note, gone_why, learned, back_at, found_at')
      .order('id', { ascending: true })
      .range(from, to)),
    fetchAllRows<{ netsuite_account_id: string | null; number: string | null; name: string }>((from, to) => service
      .from('gl_accounts')
      .select('netsuite_account_id, number, name')
      .order('id', { ascending: true })
      .range(from, to)),
    read(BOOKS_MISTAKE_CHECKS),
    read(BOOKS_BILLS_SYNC),
    read(BOOKS_SPENDING_SYNC),
  ]);
  const error = companies.error || rows.error || accounts.error || look.error || bills.error || spending.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const known = (companies.data ?? []).filter((c: { code: string }) => (BOOKS_COMPANIES as readonly string[]).includes(c.code));
  const codes = new Map(known.map((c: { id: string; code: string }) => [c.id, c.code as BooksCompany]));
  const clearers = [...new Set(rows.data.map((r) => r.cleared_by).filter((id): id is string => typeof id === 'string'))];
  const profiles = clearers.length ? await service.from('profiles').select('id, full_name').in('id', clearers) : { data: [], error: null };
  if (profiles.error) return NextResponse.json({ error: profiles.error.message }, { status: 500 });
  const names = new Map((profiles.data ?? []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name ?? 'a super admin']));

  const link = (type: MistakeDocType, netsuiteId: string) => {
    try {
      return transactionUrl(PAGES[type], netsuiteId);
    } catch {
      // Without NetSuite's account in the environment there's no address to give.
      return null;
    }
  };
  const items = rows.data
    .map((r) => mistakeView(r, { companyCode: (id) => codes.get(id) ?? null, accountName: accountNamer(accounts.data), names, link }))
    .filter((v): v is MistakeView => v !== null);

  return NextResponse.json({
    companies: known.map((c: { code: string; name: string }) => ({
      code: c.code, name: c.name, open: items.filter((i) => i.company === c.code && i.state === 'open').length,
    })),
    items,
    lookFrom: LOOK_FROM,
    usualFrom: USUAL_FROM,
    lastLook: syncStateOf(look.data),
    lastBills: syncStateOf(bills.data),
    lastSpending: syncStateOf(spending.data),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const service = createServiceClient();

  if (body?.action === 'look') {
    const result = await runMistakeChecks(service);
    if (result.error) return NextResponse.json({ error: `The look didn't finish: ${result.error}` }, { status: 500 });
    return NextResponse.json({ look: 'ok', found: result.found, added: result.added, back: result.back, gone: result.gone });
  }

  const id = typeof body?.id === 'string' ? body.id : '';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'That mistake isn\'t on the list.' }, { status: 400 });

  if (body?.action === 'clear') {
    if (body.how !== 'fixed' && body.how !== 'fine') return NextResponse.json({ error: 'Clear it as fixed in NetSuite or fine as it is.' }, { status: 400 });
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > NOTE_MAX) return NextResponse.json({ error: `The note is too long: keep it under ${NOTE_MAX.toLocaleString('en-US')} characters.` }, { status: 400 });
    const { data, error } = await service.rpc('gl_mistake_check_clear', {
      p: { id, how: body.how, note, learn: body.how === 'fine' && body.learn === true, by: auth.user.id },
    });
    if (error) return NextResponse.json({ error: plain(error.message) }, { status: 409 });
    return NextResponse.json({ cleared: data });
  }

  if (body?.action === 'reopen') {
    const { data, error } = await service.rpc('gl_mistake_check_reopen', { p: { id } });
    if (error) return NextResponse.json({ error: plain(error.message) }, { status: 409 });
    return NextResponse.json({ reopened: data });
  }

  return NextResponse.json({ error: 'Clear it, open it again, or look now.' }, { status: 400 });
}
