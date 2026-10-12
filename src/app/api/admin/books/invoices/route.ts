import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { COPY_FROM, monthOfDate, monthsBetween } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { INVOICE_RULE } from '@/lib/books/invoice-rule';
import { checkMonth, type ChartAccount, type InvoiceMonthData, type LineFactsRead, type TaxAccountCount } from '@/lib/books/invoice-check';
import { readLineFacts } from '@/lib/books/invoice-line-facts';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { compactSuiteqlError } from '@/lib/sales-order-sync';

export const dynamic = 'force-dynamic';
// It asks NetSuite about the month's invoice lines.
export const maxDuration = 60;

/**
 * GET /api/admin/books/invoices?company=BMG&month=2026-09 — one company's
 * NetSuite invoices dated in a month, each with the entry FleetSuite's
 * invoice rule works out for it next to the GL lines NetSuite posted
 * (migration 364), and why any differ. With `summary=1` only the counts come
 * back, for checking every month in turn.
 *
 * What the copy of the invoices' lines doesn't keep (which lines are cost of
 * goods, a discount or markup set at the top, each line's own amount,
 * quantity and rate) is asked of NetSuite each time
 * (src/lib/books/invoice-line-facts.ts); when it can't be, the check goes
 * without and says so.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md). It only reads; nothing is posted.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, accounts, lists] = await Promise.all([
    service.from('gl_companies').select('id, code, name').order('code'),
    fetchAllRows<Omit<ChartAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('netsuite_account_id, number, name, account_type, company_id, active, is_summary')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_LISTS_SYNC).maybeSingle(),
  ]);
  const error = companies.error || accounts.error || lists.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codeOf = new Map((companies.data || []).map((c) => [c.id as string, c.code as string]));
  const codes = [...codeOf.values()];
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  // Every month from January 2025, defaulting to last month.
  const today = new Date().toISOString().slice(0, 10);
  const months = monthsBetween(COPY_FROM, monthOfDate(today)!);
  const lastCalendar = new Date();
  lastCalendar.setUTCDate(1);
  lastCalendar.setUTCMonth(lastCalendar.getUTCMonth() - 1);
  const previous = monthOfDate(lastCalendar.toISOString().slice(0, 10))!;
  const askedMonth = params.get('month');
  const month = askedMonth && /^\d{4}-\d{2}$/.test(askedMonth) && months.includes(`${askedMonth}-01`)
    ? `${askedMonth}-01`
    : months.includes(previous) ? previous : months[0];

  const res = await service.rpc('gl_invoice_month', { p_company: company, p_month: month });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const data = (res.data ?? {}) as Partial<InvoiceMonthData>;

  const invoices = data.invoices ?? [];
  let facts: LineFactsRead | { error: string } | null = null;
  if (invoices.length) {
    try {
      facts = await readLineFacts((q) => suiteqlQueryAll(q, 1000, { retries: 1 }), invoices.map((i) => i.netsuite_id));
    } catch (err) {
      facts = { error: compactSuiteqlError(err) };
    }
  }

  const lastLists = (lists.data?.last_result ?? null) as { taxAccounts?: TaxAccountCount[] } | null;
  const check = checkMonth(
    { invoices, items: data.items ?? [] },
    {
      company,
      chart: accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null })),
      taxAccounts: Array.isArray(lastLists?.taxAccounts) ? lastLists.taxAccounts : null,
      facts,
    },
  );

  if (params.get('summary') === '1') return NextResponse.json({ company, month, summary: check.summary });
  return NextResponse.json({
    rule: INVOICE_RULE,
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    month,
    months,
    listsCopiedAt: lists.data?.updated_at ?? null,
    ...check,
  });
}
