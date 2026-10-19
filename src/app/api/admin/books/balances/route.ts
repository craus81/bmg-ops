import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { BOOKS_GL_SYNC, type GlCopyResult } from '@/lib/books/netsuite-gl';
import { BOOKS_INVOICE_POSTING, type InvoicePostingResult } from '@/lib/books/invoice-posting';
import { BOOKS_DAILY_CHECK, type DailyCheckResult } from '@/lib/books/daily-check';
import type { GlTotals } from '@/lib/books/differences';
import {
  copyHoldsAccounts, isPartyKind, PARTY_KINDS, partyBalances, type PartyBalancesData, type PartyKind,
} from '@/lib/books/party-balances';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/balances?company=BMG&kind=customer — every
 * customer's (kind=customer, the default) or vendor's (kind=vendor) balance
 * in one company's books, FleetSuite's next to NetSuite's (migration 406,
 * src/lib/books/party-balances.ts), with how many of the other kind's
 * differ, whether the copy of NetSuite's ledger holds all of the accounts
 * yet, and how the last posting run, copy and daily check went. Amounts are
 * whole cents: what a customer owes, what a vendor is owed.
 *
 * Super admin only, as the rest of the books (docs/books.md "Customer and
 * vendor balances").
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, posting, copy, check] = await Promise.all([
    service.from('gl_companies').select('code, name').order('code'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_DAILY_CHECK).maybeSingle(),
  ]);
  const error = companies.error || posting.error || copy.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codes = (companies.data || []).map((c) => c.code as string);
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });
  const askedKind = params.get('kind');
  const kind: PartyKind = isPartyKind(askedKind) ? askedKind : 'customer';
  const other = PARTY_KINDS.find((k) => k !== kind)!;

  const [mine, theirs, totals] = await Promise.all([
    service.rpc('gl_party_balances', { p_company: company, p_kind: kind }),
    service.rpc('gl_party_balances', { p_company: company, p_kind: other }),
    service.rpc('gl_netsuite_totals', { p_company: company }),
  ]);
  const rpcError = mine.error || theirs.error || totals.error;
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });
  const data = mine.data as PartyBalancesData;
  const balances = partyBalances(data, kind);
  const otherBalances = partyBalances(theirs.data as PartyBalancesData, other);

  const run = (posting.data?.last_result ?? null) as InvoicePostingResult | null;
  const copied = (copy.data?.last_result ?? null) as GlCopyResult | null;
  const checked = (check.data?.last_result ?? null) as DailyCheckResult | null;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    ...balances,
    other: { kind: other, parties: otherBalances.parties.length, differing: otherBalances.differing },
    // Null until a copy has read NetSuite's own totals.
    copyHolds: copyHoldsAccounts(totals.data as GlTotals | null, (data?.accounts ?? []).map((a) => a.netsuite_account_id)),
    lastPosting: posting.data ? { at: posting.data.updated_at, error: run?.error ?? null, partial: !!run?.partial } : null,
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
    lastCheck: check.data ? { at: check.data.updated_at, error: checked?.error ?? null } : null,
  });
}
