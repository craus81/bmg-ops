import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { BOOKS_GL_SYNC, type GlCopyResult } from '@/lib/books/netsuite-gl';
import { BOOKS_INVOICE_POSTING, type InvoicePostingResult } from '@/lib/books/invoice-posting';
import { BOOKS_OPEN_ITEMS_SYNC, copyNetSuiteOpenItems, type OpenItemsCopyResult } from '@/lib/books/netsuite-open-items';
import { chicagoDate } from '@/lib/books/own-invoices';
import { buildAgings, type OpenDocumentsData } from '@/lib/books/agings';
import { isParty, isPartyKind, partyBalances, type PartyBalancesData, type PartyKind } from '@/lib/books/party-balances';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/admin/books/agings?company=BMG&kind=customer — who owes BMG
 * (kind=customer, the default) or whom BMG owes (kind=vendor) in one
 * company's books, by how late, FleetSuite's next to NetSuite's (migration
 * 458, src/lib/books/agings.ts), aged to today in Central time, with how the
 * last copies of NetSuite's open documents and general ledger and the last
 * posting run went. With party=<id> (`none` for the lines FleetSuite can't
 * name), that customer's or vendor's aging with its open documents; without
 * it, every one's, their documents left out. Amounts are whole cents: what a
 * customer owes, what a vendor is owed.
 *
 * POST /api/admin/books/agings — Copy now: copies what NetSuite has open
 * (src/lib/books/netsuite-open-items.ts), as the cron does every two hours.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "AR and AP agings"); copying now (POST) isn't the CPA's.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const askedKind = params.get('kind');
  const kind: PartyKind = isPartyKind(askedKind) ? askedKind : 'customer';
  const askedParty = params.get('party');
  const party = askedParty === 'none' ? '' : askedParty;
  if (party !== null && !isParty(kind, party)) {
    return NextResponse.json({ error: 'Pick a customer or vendor on AR and AP agings' }, { status: 400 });
  }

  const service = createServiceClient();
  const [companies, openCopy, copy, posting] = await Promise.all([
    service.from('gl_companies').select('code, name').order('code'),
    service.from('sync_state').select('last_result, last_synced_at, updated_at').eq('sync_type', BOOKS_OPEN_ITEMS_SYNC).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
  ]);
  const error = companies.error || openCopy.error || copy.error || posting.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codes = (companies.data || []).map((c) => c.code as string);
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const [balances, open] = await Promise.all([
    service.rpc('gl_party_balances', { p_company: company, p_kind: kind }),
    service.rpc('gl_party_open_documents', { p_company: company, p_kind: kind }),
  ]);
  const rpcError = balances.error || open.error;
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });
  const agings = buildAgings(partyBalances(balances.data as PartyBalancesData, kind), open.data as OpenDocumentsData, kind, chicagoDate());

  const opened = (openCopy.data?.last_result ?? null) as OpenItemsCopyResult | null;
  const copied = (copy.data?.last_result ?? null) as GlCopyResult | null;
  const run = (posting.data?.last_result ?? null) as InvoicePostingResult | null;
  const shared = {
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    kind,
    today: agings.today,
    linked: agings.linked,
    netsuiteDocuments: agings.netsuiteDocuments,
    // When the copy last took what NetSuite has open, and how the last try went.
    lastOpenCopy: openCopy.data ? {
      at: openCopy.data.last_synced_at ?? null,
      tried: openCopy.data.updated_at,
      error: opened?.error ?? null,
      kept: !!opened?.kept,
      notes: opened?.notes ?? [],
    } : null,
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
    lastPosting: posting.data ? { at: posting.data.updated_at, error: run?.error ?? null, partial: !!run?.partial } : null,
  };

  if (party !== null) {
    return NextResponse.json({ ...shared, party: agings.parties.find((p) => p.party === party) ?? null });
  }
  return NextResponse.json({
    ...shared,
    parties: agings.parties.map(({ documents, ...p }) => ({ ...p, documentCount: documents.length })),
    totals: agings.totals,
    differing: agings.differing,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;
  const result = await copyNetSuiteOpenItems(createServiceClient());
  if (result.error) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ read: result.read, copied: result.copied, kept: !!result.kept, notes: result.notes ?? [] });
}
