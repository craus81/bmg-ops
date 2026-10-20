'use client';

/**
 * Purchasing → Jobs tab (2026-10-20, retiring the Upfit tab): every open
 * sold job that isn't in the shop yet, sorted by what it's waiting on.
 * Short jobs first (open the job to order the short parts), then jobs with
 * parts on order and their ETA, then "Ready to schedule": all parts in, so
 * call the customer.
 *
 * Verdicts come from the readiness board's synced data (the same numbers
 * as the customer page's Jobs card); the job page has the live view.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { apiFetch } from '@/lib/api-client';
import { fetchAllRows } from '@/lib/fetch-all';
import { deepLinks } from '@/lib/deep-links';
import { jobStanding, type JobStanding } from '@/lib/job-standing';
import type { BoardReadiness } from '@/lib/parts-readiness';

interface JobRow {
  id: string;
  project_name: string | null;
  customer_name: string | null;
  netsuite_so_number: string | null;
  status: string | null;
}

/** Hand-set states that mean the job is past (or not yet at) parts. */
const NOT_WAITING = ['completed', 'cancelled', 'opportunity', 'estimate', 'in_progress', 'scheduled_pickup'];

const GROUPS: { key: JobStanding['key']; title: string; hint: string; color: string }[] = [
  { key: 'short', title: 'Short', hint: 'Open the job and tap Order on the short parts.', color: '#ef4444' },
  { key: 'on_order', title: 'On order', hint: 'Every short part is on a vendor PO.', color: '#f59e0b' },
  { key: 'parts_in', title: 'Ready to schedule', hint: 'All parts are in. Call the customer to book it.', color: '#22c55e' },
];

export default function PurchasingJobsTab() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [readiness, setReadiness] = useState<Record<string, BoardReadiness>>({});
  const [error, setError] = useState<string | null>(null);
  const [verdictsLoaded, setVerdictsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error: err } = await fetchAllRows<JobRow>((from, to) => supabase
        .from('upfit_projects')
        .select('id, project_name, customer_name, netsuite_so_number, status')
        .not('netsuite_so_id', 'is', null)
        .not('status', 'in', `(${NOT_WAITING.join(',')})`)
        .order('updated_at', { ascending: false })
        .order('id')
        .range(from, to));
      if (cancelled) return;
      if (err) { setError(`Could not load jobs: ${err.message}`); setJobs([]); return; }
      setJobs(data);
      const merged: Record<string, BoardReadiness> = {};
      for (let i = 0; i < data.length; i += 100) {
        try {
          const res = await apiFetch('/api/upfit-projects/readiness-board', {
            method: 'POST',
            body: JSON.stringify({ ids: data.slice(i, i + 100).map(j => j.id) }),
          });
          const d = res.ok ? await res.json() : null;
          Object.assign(merged, d?.readiness || {});
        } catch { /* a missing chunk leaves those jobs out; the job page is live */ }
      }
      if (!cancelled) { setReadiness(merged); setVerdictsLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!jobs) return <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading jobs…</div>;

  const byGroup = new Map<string, { job: JobRow; standing: JobStanding }[]>();
  for (const job of jobs) {
    let standing = jobStanding(job, readiness[job.id]);
    // No verdict once the board has answered: nothing stocked on the SO
    // (labor, custom lines), so nothing to wait on.
    if (standing.key === 'sold' && verdictsLoaded) standing = { ...standing, key: 'parts_in', detail: 'No stocked parts on the SO' };
    const list = byGroup.get(standing.key) || [];
    list.push({ job, standing });
    byGroup.set(standing.key, list);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
        Sold jobs that aren’t in the shop yet, by what they’re waiting on. Parts counts are from the last NetSuite sync; open a job for the live picture.
      </div>
      {error && <div style={{ fontSize: '12px', color: 'var(--error)', fontWeight: 600 }}>{error}</div>}
      {GROUPS.map(g => {
        const rows = byGroup.get(g.key) || [];
        return (
          <section key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: 0, color: g.color }}>{g.title}</h2>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>{rows.length}</span>
              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{g.hint}</span>
            </div>
            {rows.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>None right now.</div>}
            {rows.map(({ job, standing }) => (
              <button
                key={job.id}
                type="button"
                onClick={() => router.push(deepLinks.upfitProject(job.id))}
                title="Open this job"
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left',
                  padding: '9px 12px', borderRadius: '10px', border: '1px solid var(--border)',
                  background: 'var(--card)', color: 'var(--text-primary)', cursor: 'pointer', font: 'inherit',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, overflowWrap: 'anywhere' }}>
                    {job.netsuite_so_number ? `SO ${job.netsuite_so_number} · ` : ''}{job.customer_name || job.project_name || 'Job'}
                  </span>
                  <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                    {[job.customer_name ? job.project_name : null, standing.detail].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 800, color: g.color }}>
                  {g.key === 'short' ? 'Order parts →' : 'Open →'}
                </span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}
