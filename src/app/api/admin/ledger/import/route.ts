import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { ledgerPdfsEnabled } from '@/lib/ledger/pdf-gate';
import { maskRealm } from '@/lib/quickbooks/config';
import { isQboTokenError, NO_QBO_TOKEN, QBO_NOT_CONNECTED, readConnection } from '@/lib/quickbooks/tokens';
import {
  DEFAULT_BUDGET_MS,
  GATE_FREE_PHASES,
  MAX_BUDGET_MS,
  cancelRun,
  claimLease,
  confirmCutover,
  markReportViewed,
  notifyImportFailed,
  probeR2,
  runImportChunk,
  startDryRun,
  startImport,
} from '@/lib/quickbooks/importer';
import { ALL_PHASES, type Phase } from '@/lib/quickbooks/dry-run';

export const dynamic = 'force-dynamic';
// The proven ceiling. The importer's own deadline stops it well inside this;
// maxDuration is the platform's backstop, not the budget.
export const maxDuration = 300;

/**
 * POST /api/admin/ledger/import — the one door into the importer.
 *
 * DRIVEN FROM OUTSIDE. The deployed app is unreachable from a session
 * container, so the bulk pull is looped by scripts/import-quickbooks.mjs (or
 * the ledger-import GitHub Action) with `Authorization: Bearer $CRON_SECRET`
 * — hence the cron-kind dual-auth block below, verbatim from the
 * netsuite-sync route. The admin page drives the SAME route with a session
 * for small runs.
 *
 * A stopped-early chunk answers 200 with `partial: true`, never `error`: the
 * driver's loop is supposed to call again, and a 500 would make it stop.
 * `status: 'failed'` inside a 200 is the shape for a run that really did
 * fail — it carries the cause and the resume command, and the cursor is
 * intact so `--mode resume` re-fetches the same page.
 */

const phaseEnum = z.enum(ALL_PHASES as [Phase, ...Phase[]]);
const budget = z.number().int().min(1_000).max(MAX_BUDGET_MS).optional();

const bodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('dry_run'),
    reportsFrom: z.string().regex(/^\d{4}$/).optional(),
    budgetMs: budget,
    runId: z.string().uuid().optional(),
  }),
  z.object({ mode: z.literal('report_viewed'), runId: z.string().uuid() }),
  z.object({
    mode: z.literal('confirm_cutover'),
    dryRunId: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    budgetMs: budget,
  }),
  z.object({
    mode: z.literal('import'),
    dryRunId: z.string().uuid().optional(),
    phases: z.array(phaseEnum).optional(),
    budgetMs: budget,
  }),
  z.object({ mode: z.literal('resume'), runId: z.string().uuid(), budgetMs: budget }),
  z.object({ mode: z.literal('status'), runId: z.string().uuid().optional() }),
  z.object({ mode: z.literal('cancel'), runId: z.string().uuid() }),
  z.object({ mode: z.literal('probe_r2') }),
]);

function connectionRefusal(e: unknown): NextResponse | null {
  const message = e instanceof Error ? e.message : String(e);
  if (message === NO_QBO_TOKEN || message === QBO_NOT_CONNECTED) {
    return NextResponse.json({ error: 'QuickBooks not connected', needsAuth: true }, { status: 401 });
  }
  if (isQboTokenError(e)) {
    return NextResponse.json({ error: message, partial: true, retryAfterMs: 5_000 }, { status: 200 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  // Allow Vercel Cron / the driver script with the shared secret; anyone else
  // needs an admin session. Fails closed if CRON_SECRET is not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  let userId: string | null = null;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
    userId = auth.user.id;
  }

  const parsed = await validateBody(req, bodySchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const service = createServiceClient();

  try {
    // ── probe_r2: allowed while the PDF gate is still shut ────────────────
    if (body.mode === 'probe_r2') {
      return NextResponse.json(await probeR2(service));
    }

    if (body.mode === 'report_viewed') {
      // A runId that is not a COMPLETED dry run is the caller's mistake —
      // 400 with the reason, exactly like confirm_cutover's unknown_dry_run.
      const marked = await markReportViewed(service, body.runId, userId);
      return NextResponse.json(
        marked.ok ? { ok: true, runId: body.runId } : { error: marked.error },
        { status: marked.ok ? 200 : 400 },
      );
    }

    if (body.mode === 'cancel') {
      await cancelRun(service, body.runId, userId);
      return NextResponse.json({ ok: true, runId: body.runId, status: 'cancelled' });
    }

    if (body.mode === 'status') {
      return NextResponse.json(await loadStatus(service, body.runId));
    }

    if (body.mode === 'confirm_cutover') {
      const budgetMs = Math.min(body.budgetMs ?? DEFAULT_BUDGET_MS, MAX_BUDGET_MS);
      const result = await confirmCutover(service, {
        dryRunId: body.dryRunId,
        date: body.date,
        // NULL on the cron-secret path: such a run has no session user, and
        // app_settings.ledger.cutover.confirmedBy is `string | null`.
        userId,
        deadline: Date.now() + budgetMs,
      });
      // A dryRunId that names no dry run is the caller's mistake, not a
      // server fault — 400, exactly like `unknown_customer` on attach.
      return NextResponse.json(result, { status: result.ok ? 200 : 400 });
    }

    // ── The chunked modes ─────────────────────────────────────────────────
    let runId: string;
    const budgetMs = Math.min(
      ('budgetMs' in body && body.budgetMs) || DEFAULT_BUDGET_MS,
      MAX_BUDGET_MS,
    );

    if (body.mode === 'dry_run') {
      if (body.runId) {
        // `mode: 'dry_run'` with a runId CONTINUES a dry run — it must not
        // silently continue an import instead. runImportChunk keys off the
        // STORED mode, so an unchecked id here would write ledger rows for a
        // caller who asked for a dry run, and answer `mode: 'import'`.
        const { data: existing } = await service
          .from('ledger_import_runs')
          .select('id, mode, status')
          .eq('id', body.runId)
          .maybeSingle();
        if (!existing || existing.mode !== 'dry_run') {
          return NextResponse.json({ error: 'unknown_dry_run — no dry run has that id' }, { status: 400 });
        }
        if (existing.status !== 'running') {
          return NextResponse.json(
            { error: `That dry run is ${existing.status}, not running — start a new one.` },
            { status: 400 },
          );
        }
      }
      runId = body.runId ?? (await startDryRun(service, {
        startedBy: userId,
        reportsFrom: body.reportsFrom ?? null,
        budgetMs,
      }));
    } else if (body.mode === 'import') {
      const phases = body.phases && body.phases.length > 0 ? body.phases : ALL_PHASES;
      const onlyR2Phases = phases.every(p => p === 'pdfs' || p === 'attachments_fetch');
      if (onlyR2Phases) {
        // A distinct gate from the 412 below: this run has NOTHING to do
        // while the R2 flip is unverified. A full run just skips those
        // phases with an event instead.
        const gate = await ledgerPdfsEnabled(service);
        if (!gate.enabled) {
          return NextResponse.json(
            {
              error: 'PDF storage is off until the R2 privacy flip is confirmed — docs/r2-private-flip.md',
              needsFlip: true,
            },
            { status: 403 },
          );
        }
      }
      const started = await startImport(service, {
        startedBy: userId,
        dryRunId: body.dryRunId ?? null,
        phases: body.phases,
        budgetMs,
      });
      if (!started.ok) {
        return NextResponse.json(
          {
            error: started.error,
            needsDryRun: true,
            gateFreePhases: GATE_FREE_PHASES,
          },
          { status: 412 },
        );
      }
      runId = started.runId;
    } else {
      runId = body.runId;
    }

    const lease = await claimLease(service, runId, budgetMs);
    if (!lease.ok) {
      return NextResponse.json(
        { error: 'another driver holds this run', runId, retryAfterMs: lease.retryAfterMs },
        { status: 409 },
      );
    }

    const result = await runImportChunk(service, runId, { deadline: Date.now() + budgetMs });
    if (result.status === 'failed' && result.error) {
      await notifyImportFailed(service, runId, result.error);
    }
    return NextResponse.json(result);
  } catch (e: any) {
    const refusal = connectionRefusal(e);
    if (refusal) return refusal;
    if (String(e?.message) === 'run_not_found') {
      return NextResponse.json({ error: 'No such import run' }, { status: 404 });
    }
    console.error('[ledger] import route failed:', e?.message || e);
    return NextResponse.json({ error: String(e?.message || e).slice(0, 500) }, { status: 500 });
  }
}

/**
 * GET ?runId= — the same status payload, for scripts and admins that would
 * rather not POST. Same guard as the POST above.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }
  try {
    const runId = req.nextUrl.searchParams.get('runId') || undefined;
    return NextResponse.json(await loadStatus(createServiceClient(), runId));
  } catch (e: any) {
    const refusal = connectionRefusal(e);
    if (refusal) return refusal;
    return NextResponse.json({ error: String(e?.message || e).slice(0, 500) }, { status: 500 });
  }
}

async function loadStatus(service: ReturnType<typeof createServiceClient>, runId?: string) {
  let connection: Record<string, unknown> | null = null;
  try {
    const conn = await readConnection(service);
    connection = {
      // Masked here as everywhere: the full realm id never leaves tokens.ts.
      realmMasked: maskRealm(conn.realmId),
      environment: conn.environment,
      companyName: conn.companyName,
      accessExpiresAt: conn.accessExpiresAt,
      refreshExpiresAt: conn.refreshExpiresAt,
      capabilities: conn.capabilities,
    };
  } catch {
    connection = null;
  }

  const columns =
    'id, source, mode, status, realm_id, started_at, finished_at, phase, cursor, config, counts, api_calls, error, report_viewed_at, dry_run_id, invocations';
  if (runId) {
    const { data } = await service.from('ledger_import_runs').select(`${columns}, report`).eq('id', runId).maybeSingle();
    return { connection, run: data ?? null };
  }
  const { data } = await service
    .from('ledger_import_runs')
    .select(columns)
    .eq('source', 'quickbooks')
    .order('started_at', { ascending: false })
    .limit(10);
  return { connection, runs: data ?? [] };
}
