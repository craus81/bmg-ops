import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate } from '@/lib/books/netsuite-gl';
import { monthParam } from '@/lib/books/report-data';
import { salesReport, type SalesLine } from '@/lib/books/sales-report';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/sales?company=BMG&from=2025-09&to=2026-08
 * — one company's sales for the posting months from `from` through `to`, by
 * state, location and NetSuite class, with returns, discounts and
 * transportation apart (src/lib/books/sales-report.ts, migration 426), from
 * the copy of NetSuite's ledger. The end defaults to last month and the start
 * to the eleven months before it.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const [companies, copy] = await Promise.all([
    service.from('gl_companies').select('code, name, legal_name').order('code'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
  ]);
  const error = companies.error || copy.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const params = new URL(req.url).searchParams;
  const codes = (companies.data || []).map((c) => c.code as string);
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const months = monthsThrough(new Date());
  const through = months[months.length - 1];
  const last = months.length > 1 ? months[months.length - 2] : through;
  const to = monthParam(params.get('to'), through) ?? last;
  const askedFrom = monthParam(params.get('from'), through);
  const from = askedFrom && askedFrom <= to ? askedFrom : months[Math.max(0, months.indexOf(to) - 11)];

  const lines = await service.rpc('gl_sales_lines', { p_company: company, p_from: from, p_to: to });
  if (lines.error) return NextResponse.json({ error: lines.error.message }, { status: 500 });

  const copied = (copy.data?.last_result ?? null) as { error?: string } | null;
  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, legal_name: c.legal_name })),
    company,
    from,
    to,
    months,
    ...salesReport((lines.data ?? []) as SalesLine[]),
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
  });
}

/** Every month from the start of the copy through this one, as YYYY-MM-01. */
function monthsThrough(now: Date): string[] {
  const current = monthOfDate(now.toISOString().slice(0, 10))!;
  const out: string[] = [];
  for (let m = COPY_FROM; m <= current;) {
    out.push(m);
    const d = new Date(`${m}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    m = d.toISOString().slice(0, 10);
  }
  return out;
}
