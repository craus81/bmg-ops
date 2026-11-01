import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { BOOKS_INVOICE_POSTING, type InvoicePostingResult } from '@/lib/books/invoice-posting';
import { isParty, isPartyKind, partyDetail, type PartyDocumentsData } from '@/lib/books/party-balances';

export const dynamic = 'force-dynamic';

/** The most documents the page lists at once. */
const SHOWN = 1000;

/**
 * GET /api/admin/books/balances/party?company=BMG&kind=customer&party=<id>&only=differs
 * — one customer's or vendor's balance in one company's books and every
 * document behind it, FleetSuite's journal next to the copy of NetSuite's
 * general ledger (migration 406), those that differ first, then the newest,
 * only those that differ with only=differs. `party` is a customer's
 * FleetSuite id or a vendor's NetSuite id, or `none` for the lines FleetSuite
 * can't name. Amounts are whole cents as the balance reads: what a customer
 * owes, what a vendor is owed.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "Customer and vendor balances").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const kind = params.get('kind');
  const asked = params.get('party') ?? '';
  const party = asked === 'none' ? '' : asked;
  if (!isPartyKind(kind) || !asked || !isParty(kind, party)) {
    return NextResponse.json({ error: 'Pick a customer or vendor on Customer and vendor balances' }, { status: 400 });
  }

  const service = createServiceClient();
  const [companies, posting] = await Promise.all([
    service.from('gl_companies').select('code, name').order('code'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
  ]);
  const error = companies.error || posting.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const codes = (companies.data || []).map((c) => c.code as string);
  const askedCompany = params.get('company');
  const company = askedCompany && codes.includes(askedCompany) ? askedCompany : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const differs = params.get('only') === 'differs';
  const res = await service.rpc('gl_party_documents', {
    p_company: company, p_kind: kind, p_party: party, p_differs: differs, p_limit: SHOWN,
  });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const detail = partyDetail(res.data as PartyDocumentsData, kind);
  const run = (posting.data?.last_result ?? null) as InvoicePostingResult | null;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    ...detail,
    only: differs ? 'differs' : 'all',
    lastPosting: posting.data ? { at: posting.data.updated_at, error: run?.error ?? null, partial: !!run?.partial } : null,
  });
}
