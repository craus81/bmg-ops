'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import {
  VEHICLE_STATUS_LABELS,
  VEHICLE_STATUS_COLORS,
  GRAPHICS_STATUS_LABELS,
  GRAPHICS_STATUS_COLORS,
} from '@/lib/types';
import type { VehicleTrackingStatus, GraphicsJobStatus } from '@/lib/types';

interface JobAssignment {
  id: string;
  user_id: string;
  assigned_at: string;
  user_name?: string;
}

interface StatusHistory {
  id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  changed_by_name: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  label: string;
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
}

const DEFAULT_VEHICLE_TASKS: Omit<TaskItem, 'id'>[] = [
  { label: 'Vehicle received & inspected', completed: false },
  { label: 'Parts confirmed in stock', completed: false },
  { label: 'Graphics printed & ready', completed: false },
  { label: 'Prep work complete', completed: false },
  { label: 'Install in progress', completed: false },
  { label: 'Install complete', completed: false },
  { label: 'QC check passed', completed: false },
  { label: 'Final photos uploaded', completed: false },
  { label: 'Ready for pickup/delivery', completed: false },
];

const DEFAULT_GRAPHICS_TASKS: Omit<TaskItem, 'id'>[] = [
  { label: 'Design file received', completed: false },
  { label: 'Design reviewed & approved', completed: false },
  { label: 'Print complete', completed: false },
  { label: 'Outgassing done', completed: false },
  { label: 'Cut & weeded', completed: false },
  { label: 'Premask applied', completed: false },
  { label: 'Packed & labeled', completed: false },
  { label: 'Ready for install/ship', completed: false },
];

export default function JobDetailPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { user, profile } = useAuth();
  const supabase = createClient();

  const [jobType, setJobType] = useState<'scanned_vehicle' | 'graphics_job' | null>(null);
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState<JobAssignment[]>([]);
  const [statusHistory, setStatusHistory] = useState<StatusHistory[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [photos, setPhotos] = useState<any[]>([]);

  useEffect(() => {
    loadJob();
  }, [jobId]);

  const loadJob = async () => {
    setLoading(true);

    // Try fleet_checkins first (vehicle tracking)
    const { data: vehicle } = await supabase
      .from('fleet_checkins')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (vehicle) {
      setJobType('scanned_vehicle');
      setJob(vehicle);
      await Promise.all([
        loadAssignments('scanned_vehicle', jobId),
        loadVehicleHistory(jobId),
        loadVehiclePhotos(jobId),
        loadTasks(jobId, 'scanned_vehicle'),
      ]);
      setLoading(false);
      return;
    }

    // Try scanned_vehicles
    const { data: scanned } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (scanned) {
      setJobType('scanned_vehicle');
      setJob(scanned);
      await Promise.all([
        loadAssignments('scanned_vehicle', jobId),
        loadTasks(jobId, 'scanned_vehicle'),
      ]);
      setLoading(false);
      return;
    }

    // Try graphics_jobs
    const { data: graphics } = await supabase
      .from('graphics_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (graphics) {
      setJobType('graphics_job');
      setJob(graphics);
      await Promise.all([
        loadAssignments('graphics_job', jobId),
        loadGraphicsHistory(jobId),
        loadTasks(jobId, 'graphics_job'),
      ]);
      setLoading(false);
      return;
    }

    setLoading(false);
  };

  const loadAssignments = async (type: string, id: string) => {
    const { data } = await supabase
      .from('job_assignments')
      .select('id, user_id, assigned_at')
      .eq('job_type', type)
      .eq('job_id', id);

    if (data && data.length > 0) {
      // Get user names
      const userIds = data.map((a: any) => a.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);

      const nameMap: Record<string, string> = {};
      (profiles || []).forEach((p: any) => { nameMap[p.id] = p.full_name; });

      setAssignments(data.map((a: any) => ({
        ...a,
        user_name: nameMap[a.user_id] || 'Unknown',
      })));
    }
  };

  const loadVehicleHistory = async (id: string) => {
    const { data } = await supabase
      .from('vehicle_status_history')
      .select('*')
      .eq('vehicle_id', id)
      .order('created_at', { ascending: false });
    setStatusHistory(data || []);
  };

  const loadGraphicsHistory = async (id: string) => {
    const { data } = await supabase
      .from('graphics_status_history')
      .select('*')
      .eq('job_id', id)
      .order('created_at', { ascending: false });
    setStatusHistory(data || []);
  };

  const loadVehiclePhotos = async (id: string) => {
    const { data } = await supabase
      .from('vehicle_photos')
      .select('*')
      .eq('vehicle_id', id)
      .order('taken_at', { ascending: false });
    setPhotos(data || []);
  };

  const loadTasks = async (id: string, type: string) => {
    // Try to load saved tasks from job_tasks table
    const { data: savedTasks } = await supabase
      .from('job_tasks')
      .select('*')
      .eq('job_id', id)
      .order('sort_order', { ascending: true });

    if (savedTasks && savedTasks.length > 0) {
      setTasks(savedTasks.map((t: any) => ({
        id: t.id,
        label: t.label,
        completed: t.completed,
        completedAt: t.completed_at,
        completedBy: t.completed_by_name,
      })));
    } else {
      // Use defaults
      const defaults = type === 'graphics_job' ? DEFAULT_GRAPHICS_TASKS : DEFAULT_VEHICLE_TASKS;
      setTasks(defaults.map((t, i) => ({ ...t, id: `default-${i}` })));
    }
  };

  const toggleTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const newCompleted = !task.completed;
    const now = new Date().toISOString();

    // If task is from defaults (not saved yet), create it
    if (taskId.startsWith('default-')) {
      // Save all tasks to DB
      const taskData = tasks.map((t, i) => ({
        job_id: jobId,
        label: t.label,
        completed: t.id === taskId ? newCompleted : t.completed,
        completed_at: t.id === taskId && newCompleted ? now : (t.completedAt || null),
        completed_by: t.id === taskId && newCompleted ? user?.id : null,
        completed_by_name: t.id === taskId && newCompleted ? (profile?.full_name || null) : (t.completedBy || null),
        sort_order: i,
      }));

      const { data: saved } = await supabase
        .from('job_tasks')
        .insert(taskData)
        .select();

      if (saved) {
        setTasks(saved.map((t: any) => ({
          id: t.id,
          label: t.label,
          completed: t.completed,
          completedAt: t.completed_at,
          completedBy: t.completed_by_name,
        })));
      }
      return;
    }

    // Update existing task
    await supabase
      .from('job_tasks')
      .update({
        completed: newCompleted,
        completed_at: newCompleted ? now : null,
        completed_by: newCompleted ? user?.id : null,
        completed_by_name: newCompleted ? (profile?.full_name || null) : null,
      })
      .eq('id', taskId);

    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, completed: newCompleted, completedAt: newCompleted ? now : undefined, completedBy: newCompleted ? (profile?.full_name || undefined) : undefined }
        : t
    ));
  };

  const completedCount = tasks.filter(t => t.completed).length;
  const progressPct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>Loading job...</div>;
  }

  if (!job) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <div style={{ fontSize: '36px', marginBottom: '8px', opacity: 0.3 }}>🔍</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Job Not Found</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>This job may have been removed or you don't have access.</div>
        <button onClick={() => router.back()} style={{
          padding: '10px 20px', borderRadius: '10px', background: 'var(--accent)', color: '#fff',
          fontWeight: 700, fontSize: '13px', border: 'none', cursor: 'pointer',
        }}>Go Back</button>
      </div>
    );
  }

  // Vehicle job rendering
  const isVehicle = jobType === 'scanned_vehicle';
  const vehicleName = isVehicle
    ? [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle'
    : job.title || 'Graphics Job';

  const status = isVehicle ? (job.status as VehicleTrackingStatus) : (job.status as GraphicsJobStatus);
  const statusLabel = isVehicle
    ? (VEHICLE_STATUS_LABELS[status as VehicleTrackingStatus] || status)
    : (GRAPHICS_STATUS_LABELS[status as GraphicsJobStatus] || status);
  const statusColors = isVehicle
    ? (VEHICLE_STATUS_COLORS[status as VehicleTrackingStatus] || { bg: 'var(--subtle-bg)', border: 'var(--border)', text: 'var(--text-muted)' })
    : { bg: `${GRAPHICS_STATUS_COLORS[status as GraphicsJobStatus] || '#666'}15`, border: `${GRAPHICS_STATUS_COLORS[status as GraphicsJobStatus] || '#666'}40`, text: GRAPHICS_STATUS_COLORS[status as GraphicsJobStatus] || '#666' };

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto' }}>
      {/* Back button */}
      <button onClick={() => router.back()} style={{
        background: 'none', border: 'none', color: 'var(--text-muted)',
        fontSize: '13px', fontWeight: 600, cursor: 'pointer', padding: '0 0 12px',
        display: 'flex', alignItems: 'center', gap: '4px',
      }}>
        ← Back
      </button>

      {/* Job Header */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
        padding: '16px', marginBottom: '10px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>
              {vehicleName}
            </div>
            {isVehicle && job.vin && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'monospace' }}>
                VIN: {job.vin}
              </div>
            )}
            {!isVehicle && job.job_number && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Job #{job.job_number}
              </div>
            )}
          </div>
          <span style={{
            padding: '4px 10px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
            background: statusColors.bg, border: `1px solid ${statusColors.border}`, color: statusColors.text,
          }}>
            {statusLabel}
          </span>
        </div>

        {/* Key info grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '14px' }}>
          {isVehicle ? (
            <>
              {job.customer_name && <InfoField label="Customer" value={job.customer_name} />}
              {job.sales_order_number && <InfoField label="Sales Order" value={`#${job.sales_order_number}`} />}
              {job.body_class && <InfoField label="Body Class" value={job.body_class} />}
              {job.sales_order_total != null && <InfoField label="SO Total" value={`$${Number(job.sales_order_total).toLocaleString()}`} />}
            </>
          ) : (
            <>
              {job.customer && <InfoField label="Customer" value={job.customer} />}
              {job.part_number && <InfoField label="Part #" value={job.part_number} />}
              {job.quantity > 0 && <InfoField label="Quantity" value={String(job.quantity)} />}
              {job.priority && <InfoField label="Priority" value={job.priority.charAt(0).toUpperCase() + job.priority.slice(1)} />}
              {job.due_date && <InfoField label="Due Date" value={new Date(job.due_date).toLocaleDateString()} />}
              {job.vinyl_type && <InfoField label="Vinyl" value={job.vinyl_type} />}
              {job.print_method && <InfoField label="Print Method" value={job.print_method} />}
              {job.scheduled_install_date && <InfoField label="Install Date" value={new Date(job.scheduled_install_date).toLocaleDateString()} />}
            </>
          )}
        </div>

        {/* Assigned team */}
        {assignments.length > 0 && (
          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
              Assigned To
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {assignments.map(a => (
                <span key={a.id} style={{
                  padding: '3px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                  color: '#60a5fa',
                }}>
                  {a.user_name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {(job.notes || job.sales_order_memo || job.content) && (
          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
              Notes
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {job.notes || job.sales_order_memo || job.content}
            </div>
          </div>
        )}
      </div>

      {/* Progress & Task Checklist */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
        padding: '16px', marginBottom: '10px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Task Checklist
          </div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: progressPct === 100 ? '#34d399' : 'var(--text-muted)' }}>
            {completedCount}/{tasks.length} ({progressPct}%)
          </div>
        </div>

        {/* Progress bar */}
        <div style={{
          height: '6px', borderRadius: '3px', background: 'var(--subtle-bg)',
          marginBottom: '14px', overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: '3px',
            background: progressPct === 100 ? '#34d399' : 'var(--accent)',
            width: `${progressPct}%`, transition: 'width 0.3s ease',
          }} />
        </div>

        {/* Tasks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {tasks.map((task) => (
            <button
              key={task.id}
              onClick={() => toggleTask(task.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 8px', borderRadius: '8px',
                background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'left', width: '100%',
                transition: 'background 0.1s',
              }}
            >
              <div style={{
                width: '22px', height: '22px', borderRadius: '6px', flexShrink: 0,
                background: task.completed ? '#34d399' : 'transparent',
                border: task.completed ? '2px solid #34d399' : '2px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}>
                {task.completed && (
                  <span style={{ color: '#fff', fontSize: '12px', fontWeight: 800 }}>✓</span>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: '13px', fontWeight: 600,
                  color: task.completed ? 'var(--text-muted)' : 'var(--text-primary)',
                  textDecoration: task.completed ? 'line-through' : 'none',
                }}>
                  {task.label}
                </div>
                {task.completed && task.completedBy && (
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
                    {task.completedBy} {task.completedAt ? `· ${new Date(task.completedAt).toLocaleString()}` : ''}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Photos */}
      {photos.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
          padding: '16px', marginBottom: '10px',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
            Photos ({photos.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
            {photos.slice(0, 9).map((photo: any) => (
              <div key={photo.id} style={{
                aspectRatio: '1', borderRadius: '8px', overflow: 'hidden',
                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
              }}>
                <img
                  src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/vehicle-photos/${photo.storage_path}`}
                  alt={photo.photo_type}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status History */}
      {statusHistory.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
          padding: '16px', marginBottom: '10px',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
            Status History
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {statusHistory.map((h) => (
              <div key={h.id} style={{
                display: 'flex', gap: '10px', alignItems: 'start',
                padding: '8px 0', borderBottom: '1px solid var(--border)',
              }}>
                <div style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: 'var(--accent)', marginTop: '5px', flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {h.from_status ? `${h.from_status} → ${h.to_status}` : h.to_status}
                  </div>
                  {h.note && (
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{h.note}</div>
                  )}
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {h.changed_by_name || 'System'} · {new Date(h.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
        {label}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}
