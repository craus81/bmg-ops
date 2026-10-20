'use client';

/**
 * The vehicle's job on its In-Shop card (2026-10-20, retiring the Upfit
 * tab): which sold job the vehicle belongs to, a link to the job page, and
 * the job's open tasks with a tick box, so techs never need the job page to
 * finish a task. Job tasks on Home open this card once a vehicle is checked
 * in (deepLinks.jobTask).
 *
 * A job belongs to the vehicle when the check-in handoff linked it
 * (upfit_projects.fleet_checkin_id, migration 085) or when it is the job for
 * one of the vehicle's sales orders.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

interface Job { id: string; project_name: string | null; netsuite_so_number: string | null }
interface Task { id: string; project_id: string; title: string; due_date: string | null; assignee: { full_name: string } | null }

export default function VehicleJobPanel({ vehicleId, salesOrderIds }: {
  vehicleId: string;
  /** NetSuite SO internal ids linked to this vehicle. */
  salesOrderIds: string[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const soKey = salesOrderIds.join(',');

  const load = useCallback(async () => {
    const supabase = createClient();
    const ors = [`fleet_checkin_id.eq.${vehicleId}`];
    const sos = soKey ? soKey.split(',').filter(id => /^\d+$/.test(id)) : [];
    if (sos.length > 0) ors.push(`netsuite_so_id.in.(${sos.join(',')})`);
    const { data: jobRows } = await supabase
      .from('upfit_projects')
      .select('id, project_name, netsuite_so_number')
      .or(ors.join(','))
      .neq('status', 'cancelled')
      .limit(10);
    const list = (jobRows || []) as Job[];
    setJobs(list);
    if (list.length === 0) { setTasks([]); return; }
    const { data: taskRows } = await supabase
      .from('upfit_project_tasks')
      .select('id, project_id, title, due_date, assignee:assigned_to(full_name)')
      .in('project_id', list.map(j => j.id))
      .is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(50);
    setTasks((taskRows || []) as unknown as Task[]);
  }, [vehicleId, soKey]);

  useEffect(() => { load(); }, [load]);

  const complete = async (task: Task) => {
    setBusy(task.id);
    setError(null);
    try {
      const res = await apiFetch('/api/upfit-projects/tasks', {
        method: 'PATCH',
        body: JSON.stringify({ id: task.id, completed: true }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error || 'Could not mark the task done. Try again.');
        return;
      }
      setTasks(prev => prev.filter(t => t.id !== task.id));
    } finally {
      setBusy(null);
    }
  };

  if (jobs.length === 0) return null;

  return (
    <div style={{ marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Job</div>
      {jobs.map(job => (
        <button
          key={job.id}
          type="button"
          onClick={() => router.push(deepLinks.upfitProject(job.id))}
          title="Open the job: parts, POs, graphics, notes and files"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
            padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(96,165,250,0.35)',
            background: 'rgba(96,165,250,0.08)', color: '#60a5fa', fontSize: '12px', fontWeight: 700,
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {job.project_name || 'Job'}{job.netsuite_so_number ? ` · SO ${job.netsuite_so_number}` : ''}
          </span>
          <span style={{ flexShrink: 0 }}>Open job →</span>
        </button>
      ))}
      {tasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
          {tasks.map(task => (
            <label key={task.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: busy ? 'wait' : 'pointer' }}>
              <input
                type="checkbox"
                checked={false}
                disabled={busy === task.id}
                onChange={() => complete(task)}
                style={{ marginTop: '2px' }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{task.title}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {[task.assignee?.full_name, task.due_date && `due ${new Date(`${task.due_date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`].filter(Boolean).map(s => ` · ${s}`).join('')}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <div style={{ fontSize: '12px', color: 'var(--error)', fontWeight: 600 }}>{error}</div>}
    </div>
  );
}
