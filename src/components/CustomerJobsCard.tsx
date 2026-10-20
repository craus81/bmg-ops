'use client';

/**
 * Jobs card on the customer page (Craig, 2026-10-20, retiring the Upfit
 * tab): this customer's sold jobs — one per sales order — with what each is
 * waiting on. Open jobs first, most urgent first; finished jobs from the
 * last 90 days after. Tapping a job opens its page.
 *
 * Standing comes from src/lib/job-standing.ts over the readiness board's
 * synced verdicts, the same numbers the Upfit list chips use.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { apiFetch } from '@/lib/api-client';
import CollapsibleCard from '@/components/CollapsibleCard';
import { deepLinks } from '@/lib/deep-links';
import { jobStanding, compareJobStanding, type JobStanding } from '@/lib/job-standing';
import type { BoardReadiness } from '@/lib/parts-readiness';

interface JobRow {
  id: string;
  project_name: string | null;
  status: string | null;
  netsuite_so_number: string | null;
  estimate_number: string | null;
  updated_at: string | null;
}

const FINISHED_DAYS = 90;

const TONE: Record<JobStanding['tone'], string> = {
  bad: '#ef4444', warn: '#f59e0b', good: '#22c55e', info: '#60a5fa', muted: '#94a3b8',
};

export default function CustomerJobsCard({ page, customerNetsuiteId, prospectId }: {
  page: string;
  customerNetsuiteId: string | null;
  prospectId: string | null;
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [readiness, setReadiness] = useState<Record<string, BoardReadiness>>({});

  useEffect(() => {
    let cancelled = false;
    const ors = [
      customerNetsuiteId ? `customer_netsuite_id.eq.${customerNetsuiteId}` : null,
      prospectId ? `prospect_id.eq.${prospectId}` : null,
    ].filter(Boolean);
    if (ors.length === 0) { setJobs([]); return; }
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('upfit_projects')
        .select('id, project_name, status, netsuite_so_number, estimate_number, updated_at')
        .or(ors.join(','))
        .order('updated_at', { ascending: false })
        .limit(200);
      if (cancelled) return;
      const cutoff = Date.now() - FINISHED_DAYS * 86400000;
      const rows = ((data || []) as JobRow[]).filter(j =>
        j.status !== 'cancelled'
        && (j.status !== 'completed' || (j.updated_at && new Date(j.updated_at).getTime() >= cutoff)));
      setJobs(rows);

      const openIds = rows.filter(j => j.status !== 'completed').map(j => j.id).slice(0, 100);
      if (openIds.length === 0) return;
      try {
        const res = await apiFetch('/api/upfit-projects/readiness-board', {
          method: 'POST',
          body: JSON.stringify({ ids: openIds }),
        });
        const d = res.ok ? await res.json() : null;
        if (!cancelled && d?.readiness) setReadiness(d.readiness);
      } catch { /* the chips fall back to Sold; the job page has the live view */ }
    })();
    return () => { cancelled = true; };
  }, [customerNetsuiteId, prospectId]);

  if (!jobs || jobs.length === 0) return null;

  const rows = jobs
    .map(j => ({ job: j, standing: jobStanding(j, readiness[j.id]) }))
    .sort((a, b) => compareJobStanding(a.standing, b.standing));
  const openCount = rows.filter(r => r.standing.key !== 'done').length;

  return (
    <CollapsibleCard page={page} id="jobs" title="Jobs"
      note={<span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>{openCount} open</span>}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map(({ job, standing }, i) => {
          const color = TONE[standing.tone];
          const ref = job.netsuite_so_number ? `SO ${job.netsuite_so_number}` : job.estimate_number || null;
          return (
            <button
              key={job.id}
              type="button"
              onClick={() => router.push(deepLinks.upfitProject(job.id))}
              title="Open this job"
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                padding: '8px 0', cursor: 'pointer', color: 'var(--text-primary)', font: 'inherit',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, overflowWrap: 'anywhere' }}>
                  {job.project_name || 'Job'}
                </span>
                <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                  {[ref, standing.detail].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span style={{ flexShrink: 0, fontSize: '10.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '6px', background: `${color}1f`, color }}>
                {standing.label}
              </span>
            </button>
          );
        })}
      </div>
    </CollapsibleCard>
  );
}
