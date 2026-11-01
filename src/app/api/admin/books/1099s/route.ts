import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { buildYear1099, type Year1099Data } from '@/lib/books/1099s';
import { checkReport, compare1099, type Report1099 } from '@/lib/books/1099-report';
import { logAudit } from '@/lib/audit';
import { BOOKS_ACCOUNTS_SYNC, type BooksAccountsSyncResult } from '@/lib/books/netsuite-accounts';
import { BOOKS_LISTS_SYNC, type BooksListsSyncResult } from '@/lib/books/netsuite-lists';
import { BOOKS_GL_SYNC, COPY_FROM } from '@/lib/books/netsuite-gl';
import { BOOKS_BILL_PAYMENTS_SYNC } from '@/lib/books/netsuite-bill-payments';
import { BOOKS_SPENDING_SYNC } from '@/lib/books/netsuite-spending';
import { chicagoDate } from '@/lib/books/own-invoices';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/admin/books/1099s?company=BMG&year=2025 — the 1099 dry run (part
 * 50, migration 481, src/lib/books/1099s.ts): what each vendor marked to get
 * a 1099 was paid in one company's year on the accounts that count toward
 * one, by category, worked out from FleetSuite's copy of NetSuite, with what
 * was left out or can't be split, and how the copies it reads last went. The
 * year is any from the copy's first (2025) to this one in Central time, last
 * year when it's left out. Amounts are whole cents. Nothing is filed or sent.
 *
 * With them, NetSuite's 1099 report for the year when one was uploaded
 * (part 51, migration 482, src/lib/books/1099-report.ts): who uploaded which
 * file when, and the report held against FleetSuite's totals vendor by
 * vendor and box by box, worked out afresh each time.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "1099s").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const years = offeredYears();
  const askedYear = params.get('year');
  const year = askedYear === null ? Math.max(years[years.length - 1], years[0] - 1) : /^\d{4}$/.test(askedYear) ? Number(askedYear) : NaN;
  if (!years.includes(year)) return pickAYear(years);

  const service = createServiceClient();
  const read = (syncType: string) =>
    service.from('sync_state').select('last_synced_at, last_result, updated_at').eq('sync_type', syncType).maybeSingle();
  const [companies, accounts, lists, ledger, billPayments, spending] = await Promise.all([
    service.from('gl_companies').select('id, code, name').order('code'),
    read(BOOKS_ACCOUNTS_SYNC), read(BOOKS_LISTS_SYNC), read(BOOKS_GL_SYNC), read(BOOKS_BILL_PAYMENTS_SYNC), read(BOOKS_SPENDING_SYNC),
  ]);
  const error = companies.error || accounts.error || lists.error || ledger.error || billPayments.error || spending.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codes = (companies.data || []).map((c) => c.code as string);
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });
  const companyId = (companies.data || []).find((c) => c.code === company)?.id;

  const [res, saved] = await Promise.all([
    service.rpc('gl_1099_year', { p_company: company, p_year: year }),
    service.from('gl_netsuite_1099_reports')
      .select('file_name, title_lines, amount_columns, left_out, vendors, skipped, uploaded_by, uploaded_at')
      .eq('company_id', companyId).eq('year', year).maybeSingle(),
  ]);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  if (saved.error) return NextResponse.json({ error: saved.error.message }, { status: 500 });
  const result = buildYear1099(res.data as Year1099Data);
  const row = saved.data as ReportRow | null;
  const report = row ? fromRow(row) : null;
  // Who uploaded it, by name; the name is a nicety, so a failed read just leaves it out.
  const who = row?.uploaded_by
    ? await service.from('profiles').select('full_name').eq('id', row.uploaded_by).maybeSingle()
    : null;

  // How each copy the year is read from last went: when it last finished, and why the last try failed.
  type SyncRow = { last_synced_at?: string | null; last_result?: unknown; updated_at?: string } | null;
  const copy = (row: SyncRow) => (row ? {
    at: row.last_synced_at ?? null,
    tried: row.updated_at ?? null,
    error: ((row.last_result ?? null) as { error?: string } | null)?.error ?? null,
  } : null);
  const chart = (accounts.data?.last_result ?? null) as BooksAccountsSyncResult | null;
  const listed = (lists.data?.last_result ?? null) as BooksListsSyncResult | null;
  const vendors = listed?.lists?.vendor;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    year,
    years,
    ...result,
    report: row && report ? {
      fileName: row.file_name,
      title: report.title,
      columns: report.columns,
      leftOut: report.leftOut,
      skipped: report.skipped,
      vendors: report.vendors.length,
      uploadedBy: (who?.data as { full_name?: string | null } | null)?.full_name ?? null,
      uploadedAt: row.uploaded_at,
    } : null,
    comparison: report ? compare1099(result, report) : null,
    copies: {
      chart: copy(accounts.data as SyncRow),
      // Whether the last copy of the chart could read which accounts count toward a 1099, and how many NetSuite has.
      accounts1099: chart ? (chart.accounts1099 ?? null) : null,
      lists: copy(lists.data as SyncRow),
      // The vendors list's own trouble: NetSuite wouldn't give it, or not the 1099 flags or legal names.
      vendors: vendors ? { error: vendors.error ?? null, missing: vendors.missing ?? [] } : null,
      ledger: copy(ledger.data as SyncRow),
      billPayments: copy(billPayments.data as SyncRow),
      spending: copy(spending.data as SyncRow),
    },
  });
}

/**
 * POST /api/admin/books/1099s — keeps NetSuite's 1099 report for one
 * company's year, to hold against FleetSuite's totals (part 51, migration
 * 482): { company, year, report } with the report as the 1099s page read it
 * from the file on the device it was picked on (src/lib/books/1099-report.ts),
 * each vendor's names and amounts only, replacing the one before; or
 * { company, year, remove: true } takes it off. A report with nine digits in
 * a row in a name or heading, a tax ID maybe, is refused, so a vendor's tax
 * ID is never kept. Audited without amounts. Nothing is sent to NetSuite.
 *
 * Super admins and the bookkeeper; the CPA only reads (docs/books.md "Who can
 * open the books").
 */
export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Send the company, the year and the report' }, { status: 400 });
  const years = offeredYears();
  if (typeof body.year !== 'number' || !years.includes(body.year)) return pickAYear(years);
  const year = body.year;

  const service = createServiceClient();
  const companies = await service.from('gl_companies').select('code').order('code');
  if (companies.error) return NextResponse.json({ error: companies.error.message }, { status: 500 });
  const company = typeof body.company === 'string' ? body.company : '';
  if (!(companies.data || []).some((c) => c.code === company)) {
    return NextResponse.json({ error: `No company ${company || '(none)'}` }, { status: 400 });
  }
  const recordId = `${company} ${year}`;

  if (body.remove === true) {
    const res = await service.rpc('gl_netsuite_1099_report_remove', { p_company: company, p_year: year });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    const removed = !!(res.data as { removed?: boolean } | null)?.removed;
    if (removed) {
      await logAudit(service, { actorId: auth.user.id, table: 'gl_netsuite_1099_reports', recordId, action: 'remove', detail: { company, year } });
    }
    return NextResponse.json({ removed });
  }

  const checked = checkReport(body.report);
  if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  const r = checked.report;
  const res = await service.rpc('gl_netsuite_1099_report_save', {
    p: {
      company,
      year,
      file_name: r.fileName,
      title: r.title,
      left_out: r.leftOut,
      columns: r.columns,
      vendors: r.vendors,
      skipped: { totals: r.skipped.totals, no_name: r.skipped.noName, combined: r.skipped.combined },
      uploaded_by: auth.user.id,
    },
  });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const replaced = !!(res.data as { replaced?: boolean } | null)?.replaced;
  await logAudit(service, {
    actorId: auth.user.id,
    table: 'gl_netsuite_1099_reports',
    recordId,
    action: replaced ? 'replace' : 'upload',
    detail: { company, year, file_name: r.fileName, vendors: r.vendors.length, columns: r.columns.map((c) => c.header) },
  });
  return NextResponse.json({ saved: true, vendors: r.vendors.length, replaced });
}

/** The years offered: the copy's first (2025) to this one in Central time, the latest first. */
function offeredYears(): number[] {
  const thisYear = Number(chicagoDate().slice(0, 4));
  const firstYear = Number(COPY_FROM.slice(0, 4));
  const years: number[] = [];
  for (let y = thisYear; y >= firstYear; y--) years.push(y);
  return years;
}

const pickAYear = (years: number[]) =>
  NextResponse.json({ error: `Pick a year from ${years[years.length - 1]} to ${years[0]}` }, { status: 400 });

/** A kept report as the database has it (migration 482). */
interface ReportRow {
  file_name: string;
  title_lines: string[];
  amount_columns: Report1099['columns'];
  left_out: string[];
  vendors: Report1099['vendors'];
  skipped: { totals?: number; no_name?: number; combined?: number };
  uploaded_by: string | null;
  uploaded_at: string;
}

function fromRow(row: ReportRow): Report1099 {
  return {
    title: row.title_lines ?? [],
    columns: row.amount_columns ?? [],
    leftOut: row.left_out ?? [],
    vendors: row.vendors ?? [],
    skipped: { totals: row.skipped?.totals ?? 0, noName: row.skipped?.no_name ?? 0, combined: row.skipped?.combined ?? 0 },
  };
}
