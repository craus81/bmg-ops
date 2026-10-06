import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFinancials } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { parsePaychexPayroll, summarizePeriods } from '@/lib/paychex-payroll';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PostSchema = z.object({
  fileName: z.string().max(300).optional(),
  /** The CSV's text, read in the browser. A year of biweekly payroll is ~50 KB. */
  csv: z.string().min(1).max(4_000_000),
  /** true = parse and report what WOULD change; nothing is written. */
  preview: z.boolean().optional(),
});

/**
 * POST /api/reports/paychex-payroll/import
 *
 * Upload Paychex Flex's "Payroll Labor Cost" CSV (src/lib/paychex-payroll.ts
 * reads it by column position and refuses the whole file on any bad row).
 * Preview first: per pay period, how many checks and dollars the file holds
 * and how many existing rows it would replace. Saving replaces every pay
 * period the file carries in one transaction (replace_payroll_periods,
 * migration 340), so re-uploading a period never doubles it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { csv, fileName, preview } = parsed.data;

  const { rows, errors } = parsePaychexPayroll(csv);
  if (errors.length > 0) {
    return NextResponse.json({ error: 'The file was not imported — fix the report and upload again.', errors: errors.slice(0, 25), errorCount: errors.length }, { status: 400 });
  }

  const service = createServiceClient();
  const periods = summarizePeriods(rows);

  // Existing rows per period this file would replace.
  const minStart = periods.reduce((m, p) => (p.period_start < m ? p.period_start : m), periods[0].period_start);
  const { data: existing, error: exErr } = await fetchAllRows<{ period_start: string; period_end: string }>((f, t) => service
    .from('payroll_checks')
    .select('period_start, period_end')
    .gte('period_start', minStart)
    .order('id')
    .range(f, t));
  if (exErr) return NextResponse.json({ error: 'Failed to read existing payroll: ' + exErr.message }, { status: 500 });
  const existingByPeriod = new Map<string, number>();
  for (const r of existing) {
    const k = `${r.period_start}|${r.period_end}`;
    existingByPeriod.set(k, (existingByPeriod.get(k) || 0) + 1);
  }
  const periodsOut = periods.map(p => ({ ...p, replaces: existingByPeriod.get(`${p.period_start}|${p.period_end}`) || 0 }));

  if (preview) {
    return NextResponse.json({
      preview: true,
      rows: rows.length,
      employees: new Set(rows.map(r => r.paychex_employee_id)).size,
      periods: periodsOut,
    });
  }

  const { data: result, error } = await service.rpc('replace_payroll_periods', {
    p_import: { file_name: fileName || null, uploaded_by: auth.user.id },
    p_rows: rows,
  });
  if (error) return NextResponse.json({ error: 'Import failed: ' + error.message }, { status: 500 });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'payroll_imports',
    recordId: (result as any)?.import_id || 'unknown',
    action: 'paychex_payroll_imported',
    detail: {
      fileName: fileName || null,
      rows: rows.length,
      periods: periods.length,
      firstPeriodStart: periods[0].period_start,
      lastPeriodEnd: periods[periods.length - 1].period_end,
      replaced: (result as any)?.replaced ?? null,
    },
  });

  return NextResponse.json({ imported: true, ...(result as any), periods: periodsOut });
}
