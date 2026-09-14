import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/admin/ledger/runs — THE progress feed the ledger page polls.
 *
 * Read-tier (`finance`/`executive`, admins auto-pass) rather than admin: a
 * finance viewer watching an import is not driving it, and the run row
 * carries no secret — `realm_id` is stored already masked and no token value
 * ever touches this table.
 *
 * Two shapes: the last 20 runs with an events summary each, or `?runId=` for
 * one run's full row plus its last 10 error messages.
 */

const OUTCOMES = ['error', 'skipped', 'dropped_field', 'voided', 'deleted', 'unsupported', 'unmatched', 'ambiguous'] as const;

/**
 * The columns the LIST serves. Named, never `*`: a column added to
 * ledger_import_runs later must be a deliberate decision to show the
 * finance/executive read tier, not an automatic disclosure.
 */
const LIST_COLUMNS =
  'id, source, mode, status, realm_id, started_at, finished_at, phase, counts, api_calls, error, report_viewed_at, invocations, dry_run_id';

/** The single-run feed: the list plus the progress detail the page polls. */
const RUN_COLUMNS =
  `${LIST_COLUMNS}, cursor, config, report, report_viewed_by, lease_until, last_invocation_at`;

async function eventSummary(
  service: ReturnType<typeof createServiceClient>,
  runId: string,
): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  await Promise.all(
    OUTCOMES.map(async outcome => {
      // Head count, never a row select: the events table is unbounded and a
      // row select would cap at 1000 and under-report.
      const { count } = await service
        .from('ledger_import_events')
        .select('id', { count: 'exact', head: true })
        .eq('run_id', runId)
        .eq('outcome', outcome);
      if (count) summary[outcome] = count;
    }),
  );
  return summary;
}

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['finance', 'executive']);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const runId = req.nextUrl.searchParams.get('runId');

  try {
    if (runId) {
      const { data: run, error } = await service
        .from('ledger_import_runs')
        .select(RUN_COLUMNS)
        .eq('id', runId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!run) return NextResponse.json({ error: 'No such run' }, { status: 404 });

      const { data: errors } = await service
        .from('ledger_import_events')
        .select('entity_type, external_id, message, created_at')
        .eq('run_id', runId)
        .eq('outcome', 'error')
        .order('created_at', { ascending: false })
        .limit(10);

      return NextResponse.json({
        run,
        events: await eventSummary(service, runId),
        lastErrors: (errors || []).map(e => `${e.entity_type}${e.external_id ? ` ${e.external_id}` : ''}: ${e.message}`),
      });
    }

    const { data: runs, error } = await service
      .from('ledger_import_runs')
      .select(LIST_COLUMNS)
      .order('started_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);

    const withEvents = await Promise.all(
      (runs || []).map(async run => ({ ...run, events: await eventSummary(service, String(run.id)) })),
    );
    return NextResponse.json({ runs: withEvents });
  } catch (e: any) {
    // PGRST205/42P01: the ledger schema is not deployed on this environment
    // yet — a real answer, not a 500.
    const message = String(e?.message || e);
    if (/PGRST205|42P01|does not exist/i.test(message)) {
      return NextResponse.json({ error: 'Ledger schema not deployed yet' }, { status: 503 });
    }
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 500 });
  }
}
