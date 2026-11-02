import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { loadInventoryValue } from '@/lib/books/inventory-value-data';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { centralDate } from '@/lib/books/mistake-checks';
import { monthOfDate } from '@/lib/books/netsuite-gl';
import { buildReport, type BuilderAsk } from '@/lib/books/report-builder';
import { loadSplit } from '@/lib/books/report-data';
import {
  bankRecNotes, builderNotes, cpaNotes, inventoryNotes, ledgerNotes, partyNotes, reportNotes, yearEndWorkbook,
} from '@/lib/books/report-workbook';
import { report } from '@/lib/books/reports';
import { rollForward } from '@/lib/books/roll-forward';
import { yearView } from '@/lib/books/year-end';
import { booksCompanies, pickYear, readBankRecs, readLedger, readPartyBalances, readYear } from '@/lib/books/year-end-data';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/year-end/download?company=BMG&year=2027 — the year
 * Year end shows for the same company, as one Excel file for the CPA: the
 * trial balance and balance sheet at December 31, the profit and loss for
 * the year and by month, the cash flow statement and how the year closes
 * into retained earnings, FleetSuite's books next to NetSuite's own totals
 * as Reports and Year end show them; the general ledger, every account's
 * documents in the year with each side's running balance; what each
 * customer owed and each vendor was owed at December 31, both sides, and
 * how they come to the trial balance; each bank account reconciled in
 * FleetSuite, its statement at December 31 held against the books and each
 * month of the year; the company's inventory value at December 31 when it
 * has stock; each fixed asset, other asset and long term liability
 * account's year; the CPA's adjustments dated in the year and made, line by
 * line; and a contents sheet with what's done before the year closes
 * (src/lib/books/report-workbook.ts's yearEndWorkbook, docs/books.md "Year
 * end"). While the year isn't over, through this month, and it says so.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  try {
    const today = centralDate(new Date());
    const picked = pickYear(await booksCompanies(service), params, today);
    if (!picked) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });
    const { company, year } = picked;
    const read = await readYear(service, company, year, today);
    const { loaded } = read;
    const january = `${year}-01-01`;
    // December, or this month while the year isn't over.
    const thisMonth = monthOfDate(today)!;
    const to = thisMonth < `${year}-12-01` ? thisMonth : `${year}-12-01`;
    const [split, stock, ledger, parties, banks] = await Promise.all([
      loadSplit(service, company.code),
      loadInventoryValue(service, new URLSearchParams({ month: to.slice(0, 7) })),
      readLedger(service, loaded, { from: january, to }),
      readPartyBalances(service, loaded, to),
      readBankRecs(service, { company: company.code, accounts: read.facts.banks.map((b) => b.account), year, to, thisMonth }),
    ]);
    if ('error' in split) throw new Error(split.error);
    if ('error' in stock) throw new Error(stock.error);

    const named = loaded.companies.find((c) => c.code === company.code);
    const books = { code: company.code, name: company.name, legal_name: named?.legal_name ?? null };
    const posts = (POSTING_COMPANIES as readonly string[]).includes(company.code);
    const runs = { lastPosting: loaded.lastPosting, lastCopy: loaded.lastCopy };
    const ask: BuilderAsk = { rows: 'account', months: 'picked', from: january, to, by: 'month', division: null, location: null };
    const built = buildReport(loaded.data, split.split, split.locationNames, ask);
    const value = stock.value.companies.find((c) => c.company === company.code) ?? null;

    const file = await yearEndWorkbook({
      company: books,
      year,
      to,
      liveFrom: company.books_live_from,
      view: yearView(read.facts, read.amounts),
      close: read.amounts,
      reports: {
        trial_balance: report(loaded.data, 'trial_balance', { to }),
        balance_sheet: report(loaded.data, 'balance_sheet', { to }),
        profit_and_loss: report(loaded.data, 'profit_and_loss', { from: january, to }),
        cash_flow: report(loaded.data, 'cash_flow', { from: january, to }),
      },
      reportNotes: reportNotes({ companyName: company.name, posts, checked: read.checked, ...runs }),
      byMonth: { ask, built, notes: builderNotes({ companyName: company.name, posts, copied: read.checked, ties: built.ties, ...runs }) },
      ledger: { accounts: ledger, notes: ledgerNotes({ ledger, checked: read.checked }) },
      parties: {
        customer: { balances: parties.customer, notes: partyNotes({ balances: parties.customer, checked: read.checked }) },
        vendor: { balances: parties.vendor, notes: partyNotes({ balances: parties.vendor, checked: read.checked }) },
      },
      banks: { accounts: banks, notes: bankRecNotes({ banks, lastPosting: loaded.lastPosting }) },
      inventory: value && {
        value,
        notes: inventoryNotes({ month: stock.month, through: stock.through, company: value, lastCopy: stock.lastCopy, lastPosting: stock.lastPosting }),
      },
      rollForward: rollForward(loaded.data, { from: january, to }),
      cpa: {
        adjustments: read.facts.adjustments,
        accountName: read.accountName,
        notes: cpaNotes({ year, waiting: read.facts.entries.filter((e) => e.journal === 'cpa_adjustments').length }),
      },
      now: new Date(),
    });
    return new NextResponse(file.bytes, {
      headers: {
        'Content-Type': file.type,
        'Content-Length': String(file.bytes.byteLength),
        'Content-Disposition': attachmentDisposition(file.name),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return failed(err);
  }
}
