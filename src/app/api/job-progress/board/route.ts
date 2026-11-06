import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { JOB_PROGRESS_ESTIMATE_COLUMNS, loadJobProgress } from '@/lib/job-progress-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Finished orders stay on the board this long. */
const KEEP_COMPLETE_DAYS = 7;
/** An approved estimate that never became a sales order drops off after this. */
const NO_SO_DAYS = 120;
/** Oldest approval the board looks at. */
const LOOKBACK_DAYS = 365;

/**
 * GET /api/job-progress/board — the Job stages board (Valarie's "pull up
 * everything that's in each stage"): every open approved order with the
 * step it's on, how long it's been there, and its rep.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const supabase = createServiceClient();
  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 86400000).toISOString();

  try {
    const ests: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('estimates')
        .select(JOB_PROGRESS_ESTIMATE_COLUMNS)
        .or('customer_approved.eq.true,status.eq.accepted')
        .gte('updated_at', since)
        .order('updated_at', { ascending: false })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      ests.push(...(data || []));
      if (!data || data.length < 1000 || ests.length >= 3000) break;
    }
    const progress = await loadJobProgress(supabase, ests);

    const repIds = [...new Set(ests.map(e => e.created_by).filter(Boolean))];
    const { data: people } = repIds.length
      ? await supabase.from('profiles').select('id, full_name').in('id', repIds)
      : { data: [] as any[] };
    const nameOf = new Map((people || []).map((p: any) => [p.id, p.full_name || null]));

    const rows = [];
    for (const r of progress.values()) {
      const e = r.estimate;
      const v = r.view;
      const approvedAt = e.customer_approved_at || e.updated_at;
      if (v.done) {
        const at = v.since ? Date.parse(v.since) : NaN;
        if (!Number.isFinite(at) || now - at > KEEP_COMPLETE_DAYS * 86400000) continue;
      } else {
        // A closed or cancelled sales order isn't open work.
        if (r.soClosed) continue;
        if (!e.netsuite_so_id && !r.soNumber && approvedAt && now - Date.parse(approvedAt) > NO_SO_DAYS * 86400000) continue;
      }
      const stage = v.stages.find(s => s.key === v.current)!;
      rows.push({
        estimateId: e.id,
        estimateNumber: e.estimate_number || null,
        title: e.title || null,
        customer: e.customer_name || null,
        soNumber: r.soNumber,
        stage: v.current,
        stageLabel: stage.label,
        detail: stage.detail,
        heldUp: v.heldUp,
        since: v.since || approvedAt || null,
        repId: e.created_by || null,
        rep: nameOf.get(e.created_by) || null,
      });
    }
    rows.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
    return NextResponse.json({ rows });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't load the job stages: ${e?.message || e}` }, { status: 500 });
  }
}
