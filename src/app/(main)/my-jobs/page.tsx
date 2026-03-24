'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import {
  VEHICLE_STATUS_LABELS,
  VEHICLE_STATUS_COLORS,
  GRAPHICS_STATUS_LABELS,
  GRAPHICS_STATUS_COLORS,
} from '@/lib/types';
import type { VehicleTrackingStatus, GraphicsJobStatus } from '@/lib/types';

interface AssignedJob {
  id: string;
  job_type: 'scanned_vehicle' | 'graphics_job';
  job_id: string;
  assigned_at: string;
  // Resolved job data
  title: string;
  subtitle: string;
  status: string;
  statusLabel: string;
  statusColors: { bg: string; border: string; text: string };
  customer: string;
  vin?: string;
  priority?: string;
  due_date?: string;
  taskProgress?: { completed: number; total: number };
}

type FilterType = 'all' | 'active' | 'complete';

export default function MyJobsPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<AssignedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('active');

  useEffect(() => {
    if (user) loadMyJobs();
  }, [user]);

  const loadMyJobs = async () => {
    setLoading(true);

    // Get all assignments for current user
    const { data: assignments } = await supabase
      .from('job_assignments')
      .select('id, job_type, job_id, assigned_at')
      .eq('user_id', user!.id)
      .order('assigned_at', { ascending: false });

    if (!assignments || assignments.length === 0) {
      setJobs([]);
      setLoading(false);
      return;
    }

    // Separate vehicle and graphics assignments
    const vehicleIds = assignments.filter(a => a.job_type === 'scanned_vehicle').map(a => a.job_id);
    const graphicsIds = assignments.filter(a => a.job_type === 'graphics_job').map(a => a.job_id);

    // Fetch vehicle jobs (try fleet_checkins first, then scanned_vehicles)
    let vehicleMap: Record<string, any> = {};
    if (vehicleIds.length > 0) {
      const { data: checkins } = await supabase
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, sales_order_number, notes')
        .in('id', vehicleIds);

      (checkins || []).forEach((v: any) => { vehicleMap[v.id] = v; });

      // For any IDs not in fleet_checkins, try scanned_vehicles
      const missingIds = vehicleIds.filter(id => !vehicleMap[id]);
      if (missingIds.length > 0) {
        const { data: scanned } = await supabase
          .from('scanned_vehicles')
          .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer, part_number, scanned_at')
          .in('id', missingIds);

        (scanned || []).forEach((v: any) => {
          vehicleMap[v.id] = {
            ...v,
            customer_name: v.customer,
            status: 'received',
          };
        });
      }
    }

    // Fetch graphics jobs
    let graphicsMap: Record<string, any> = {};
    if (graphicsIds.length > 0) {
      const { data: gJobs } = await supabase
        .from('graphics_jobs')
        .select('id, title, job_number, customer, part_number, status, priority, due_date, quantity')
        .in('id', graphicsIds);

      (gJobs || []).forEach((g: any) => { graphicsMap[g.id] = g; });
    }

    // Fetch task progress for all jobs
    const allJobIds = assignments.map(a => a.job_id);
    let taskMap: Record<string, { completed: number; total: number }> = {};
    if (allJobIds.length > 0) {
      const { data: taskData } = await supabase
        .from('job_tasks')
        .select('job_id, completed')
        .in('job_id', allJobIds);

      if (taskData) {
        const grouped: Record<string, { completed: number; total: number }> = {};
        taskData.forEach((t: any) => {
          if (!grouped[t.job_id]) grouped[t.job_id] = { completed: 0, total: 0 };
          grouped[t.job_id].total++;
          if (t.completed) grouped[t.job_id].completed++;
        });
        taskMap = grouped;
      }
    }

    // Build resolved job list
    const resolved: AssignedJob[] = assignments.map(a => {
      if (a.job_type === 'scanned_vehicle' && vehicleMap[a.job_id]) {
        const v = vehicleMap[a.job_id];
        const vehicleName = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Vehicle';
        const status = v.status as VehicleTrackingStatus;
        const colors = VEHICLE_STATUS_COLORS[status] || { bg: 'var(--subtle-bg)', border: 'var(--border)', text: 'var(--text-muted)' };
        return {
          id: a.id,
          job_type: a.job_type,
          job_id: a.job_id,
          assigned_at: a.assigned_at,
          title: vehicleName,
          subtitle: v.vin ? `VIN: ${v.vin.slice(-6)}` : '',
          status: v.status || 'received',
          statusLabel: VEHICLE_STATUS_LABELS[status] || v.status,
          statusColors: colors,
          customer: v.customer_name || '',
          vin: v.vin,
          taskProgress: taskMap[a.job_id],
        };
      } else if (a.job_type === 'graphics_job' && graphicsMap[a.job_id]) {
        const g = graphicsMap[a.job_id];
        const status = g.status as GraphicsJobStatus;
        const color = GRAPHICS_STATUS_COLORS[status] || '#666';
        return {
          id: a.id,
          job_type: a.job_type,
          job_id: a.job_id,
          assigned_at: a.assigned_at,
          title: g.title || `Job #${g.job_number}`,
          subtitle: g.part_number ? `Part: ${g.part_number}` : '',
          status: g.status,
          statusLabel: GRAPHICS_STATUS_LABELS[status] || g.status,
          statusColors: { bg: `${color}15`, border: `${color}40`, text: color },
          customer: g.customer || '',
          priority: g.priority,
          due_date: g.due_date,
          taskProgress: taskMap[a.job_id],
        };
      }
      return null;
    }).filter(Boolean) as AssignedJob[];

    setJobs(resolved);
    setLoading(false);
  };

  const isComplete = (j: AssignedJob) =>
    ['complete', 'shipped', 'installed', 'cancelled'].includes(j.status);

  const filtered = jobs.filter(j => {
    if (filter === 'active') return !isComplete(j);
    if (filter === 'complete') return isComplete(j);
    return true;
  });

  const activeCount = jobs.filter(j => !isComplete(j)).length;
  const completeCount = jobs.filter(j => isComplete(j)).length;

  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>
        My Jobs
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        {activeCount} active {completeCount > 0 ? `· ${completeCount} complete` : ''}
      </div>

      {/* Filter tabs */}
      <div style={{
        display: 'flex', gap: '4px', padding: '3px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '10px', marginBottom: '12px',
      }}>
        {([
          { id: 'active' as const, label: `Active (${activeCount})` },
          { id: 'complete' as const, label: `Done (${completeCount})` },
          { id: 'all' as const, label: 'All' },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            style={{
              flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: filter === tab.id ? 'var(--tab-active-bg)' : 'transparent',
              border: filter === tab.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: filter === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading your jobs...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '36px', marginBottom: '8px', opacity: 0.3 }}>
            {filter === 'active' ? '✅' : '📋'}
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            {filter === 'active' ? 'No active jobs' : 'No jobs found'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {filter === 'active' ? 'All caught up! Jobs will appear here when assigned to you.' : 'No completed jobs yet.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(job => {
            const progress = job.taskProgress;
            const progressPct = progress && progress.total > 0
              ? Math.round((progress.completed / progress.total) * 100)
              : null;

            return (
              <button
                key={job.id}
                onClick={() => router.push(`/jobs/${job.job_id}`)}
                style={{
                  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
                  padding: '14px', textAlign: 'left', cursor: 'pointer',
                  width: '100%', display: 'block', transition: 'border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '6px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.title}
                    </div>
                    {job.subtitle && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px', fontFamily: job.vin ? 'monospace' : 'inherit' }}>
                        {job.subtitle}
                      </div>
                    )}
                  </div>
                  <span style={{
                    padding: '3px 8px', borderRadius: '6px', fontSize: '9px', fontWeight: 700,
                    background: job.statusColors.bg, border: `1px solid ${job.statusColors.border}`,
                    color: job.statusColors.text, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: '8px',
                  }}>
                    {job.statusLabel}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {job.customer && (
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      {job.customer}
                    </span>
                  )}
                  {job.job_type === 'graphics_job' && (
                    <span style={{
                      padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                      background: 'rgba(192,132,252,0.1)', border: '1px solid rgba(192,132,252,0.2)',
                      color: '#c084fc',
                    }}>
                      Graphics
                    </span>
                  )}
                  {job.job_type === 'scanned_vehicle' && (
                    <span style={{
                      padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                      background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                      color: '#60a5fa',
                    }}>
                      Vehicle
                    </span>
                  )}
                  {job.priority && job.priority !== 'normal' && (
                    <span style={{
                      padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                      background: job.priority === 'rush' ? 'rgba(239,68,68,0.1)' : job.priority === 'high' ? 'rgba(251,191,36,0.1)' : 'var(--subtle-bg)',
                      border: `1px solid ${job.priority === 'rush' ? 'rgba(239,68,68,0.2)' : job.priority === 'high' ? 'rgba(251,191,36,0.2)' : 'var(--border)'}`,
                      color: job.priority === 'rush' ? '#ef4444' : job.priority === 'high' ? '#fbbf24' : 'var(--text-muted)',
                    }}>
                      {job.priority.toUpperCase()}
                    </span>
                  )}
                  {job.due_date && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      Due: {new Date(job.due_date).toLocaleDateString()}
                    </span>
                  )}
                </div>

                {/* Task progress bar */}
                {progressPct !== null && (
                  <div style={{ marginTop: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                      <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        Tasks
                      </span>
                      <span style={{ fontSize: '9px', fontWeight: 700, color: progressPct === 100 ? '#34d399' : 'var(--text-muted)' }}>
                        {progress!.completed}/{progress!.total}
                      </span>
                    </div>
                    <div style={{
                      height: '4px', borderRadius: '2px', background: 'var(--subtle-bg)', overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', borderRadius: '2px',
                        background: progressPct === 100 ? '#34d399' : 'var(--accent)',
                        width: `${progressPct}%`,
                      }} />
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
