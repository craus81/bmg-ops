'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface AssignedJob {
  id: string;
  job_type: 'scanned_vehicle' | 'graphics_job' | 'purchase_order';
  job_id: string;
  assigned_at: string;
}

interface VehicleJob {
  id: string;
  vin: string;
  year: string | null;
  make: string | null;
  model: string | null;
  color: string | null;
  status: string;
  customer: string | null;
  po_number: string | null;
  customer_approved: boolean;
  customer_approved_at: string | null;
  created_at: string;
}

interface GraphicsJob {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  vehicle_info: string | null;
  scheduled_install_date: string | null;
  customer_name: string | null;
  customer_approved: boolean;
  customer_approved_at: string | null;
  created_at: string;
}

const VEHICLE_STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  checked_in: { label: 'Checked In', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  in_progress: { label: 'In Progress', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  stuck_parts: { label: 'Waiting on Parts', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  stuck_graphics: { label: 'Waiting on Graphics', color: '#c084fc', bg: 'rgba(192,132,252,0.1)' },
  completed: { label: 'Completed', color: '#34d399', bg: 'rgba(16,185,129,0.1)' },
  delivered: { label: 'Delivered', color: 'var(--text-body)', bg: 'rgba(107,122,141,0.1)' },
};

const GRAPHICS_STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'Pending', color: 'var(--text-body)', bg: 'rgba(107,122,141,0.1)' },
  in_design: { label: 'In Design', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  proof_sent: { label: 'Proof Sent', color: '#c084fc', bg: 'rgba(192,132,252,0.1)' },
  approved: { label: 'Approved', color: '#34d399', bg: 'rgba(16,185,129,0.1)' },
  in_production: { label: 'In Production', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  ready_to_install: { label: 'Ready to Install', color: '#fb923c', bg: 'rgba(251,146,60,0.1)' },
  installing: { label: 'Installing', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  completed: { label: 'Completed', color: '#34d399', bg: 'rgba(16,185,129,0.1)' },
};

export default function CustomerDashboard() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const supabase = createClient();

  const [vehicleJobs, setVehicleJobs] = useState<VehicleJob[]>([]);
  const [graphicsJobs, setGraphicsJobs] = useState<GraphicsJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'upfit' | 'graphics'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    if (profile && profile.role !== 'customer') {
      router.push('/home');
      return;
    }
    loadJobs();
  }, [user, profile]);

  const loadJobs = async () => {
    if (!user) return;

    // Get assignments for this customer user
    const { data: assignments } = await supabase
      .from('customer_job_assignments')
      .select('*')
      .eq('customer_user_id', user.id);

    if (!assignments || assignments.length === 0) {
      setLoading(false);
      return;
    }

    // Separate by type
    const vehicleIds = assignments.filter(a => a.job_type === 'scanned_vehicle').map(a => a.job_id);
    const graphicsIds = assignments.filter(a => a.job_type === 'graphics_job').map(a => a.job_id);

    // Load vehicle jobs
    if (vehicleIds.length > 0) {
      const { data } = await supabase
        .from('scanned_vehicles')
        .select('id, vin, year, make, model, color, status, customer, po_number, customer_approved, customer_approved_at, created_at')
        .in('id', vehicleIds)
        .order('created_at', { ascending: false });
      setVehicleJobs((data as VehicleJob[]) || []);
    }

    // Load graphics jobs
    if (graphicsIds.length > 0) {
      const { data } = await supabase
        .from('graphics_jobs')
        .select('id, title, status, priority, vehicle_info, scheduled_install_date, customer_name, customer_approved, customer_approved_at, created_at')
        .in('id', graphicsIds)
        .order('created_at', { ascending: false });
      setGraphicsJobs((data as GraphicsJob[]) || []);
    }

    setLoading(false);
  };

  const handleApprove = async (type: 'vehicle' | 'graphics', jobId: string) => {
    if (!confirm('Approve this completed work?')) return;

    const table = type === 'vehicle' ? 'scanned_vehicles' : 'graphics_jobs';
    const { error } = await supabase
      .from(table)
      .update({
        customer_approved: true,
        customer_approved_at: new Date().toISOString(),
        customer_approved_by: user?.id,
      })
      .eq('id', jobId);

    if (!error) {
      if (type === 'vehicle') {
        setVehicleJobs(prev => prev.map(j => j.id === jobId ? { ...j, customer_approved: true, customer_approved_at: new Date().toISOString() } : j));
      } else {
        setGraphicsJobs(prev => prev.map(j => j.id === jobId ? { ...j, customer_approved: true, customer_approved_at: new Date().toISOString() } : j));
      }
    }
  };

  const totalJobs = vehicleJobs.length + graphicsJobs.length;
  const activeJobs = vehicleJobs.filter(j => !['completed', 'delivered'].includes(j.status)).length +
    graphicsJobs.filter(j => j.status !== 'completed').length;
  const completedJobs = totalJobs - activeJobs;

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading your jobs...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>My Jobs</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {profile?.full_name} — {totalJobs} total jobs
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '14px' }}>
        <div style={{ padding: '12px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)', textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>{totalJobs}</div>
          <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>Total</div>
        </div>
        <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)', textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#f59e0b' }}>{activeJobs}</div>
          <div style={{ fontSize: '9px', color: '#f59e0b', fontWeight: 700, textTransform: 'uppercase' }}>Active</div>
        </div>
        <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)', textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#34d399' }}>{completedJobs}</div>
          <div style={{ fontSize: '9px', color: '#34d399', fontWeight: 700, textTransform: 'uppercase' }}>Complete</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '12px', marginBottom: '10px',
      }}>
        {([
          { id: 'all' as const, label: 'All Jobs', count: totalJobs },
          { id: 'upfit' as const, label: 'Upfit', count: vehicleJobs.length },
          { id: 'graphics' as const, label: 'Graphics', count: graphicsJobs.length },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '8px', borderRadius: '10px',
              fontSize: '12px', fontWeight: 700, textAlign: 'center',
              background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
              border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {/* Empty state */}
      {totalJobs === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '12px' }}>--</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>No jobs assigned yet</div>
          <div style={{ fontSize: '12px', marginTop: '6px' }}>Your BMG Fleet team will assign jobs here as they come in.</div>
        </div>
      )}

      {/* Vehicle / Upfit Jobs */}
      {(tab === 'all' || tab === 'upfit') && vehicleJobs.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          {tab === 'all' && (
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              Upfit / Parts Install ({vehicleJobs.length})
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {vehicleJobs.map(job => {
              const status = VEHICLE_STATUS_MAP[job.status] || { label: job.status, color: 'var(--text-body)', bg: 'rgba(107,122,141,0.1)' };
              const isExpanded = expandedId === `v-${job.id}`;
              const isComplete = ['completed', 'delivered'].includes(job.status);

              return (
                <div key={job.id} style={{
                  borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden',
                }}>
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : `v-${job.id}`)}
                    style={{ padding: '12px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {[job.year, job.make, job.model].filter(Boolean).join(' ') || job.vin}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                          VIN: {job.vin} {job.po_number && `· PO: ${job.po_number}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {job.customer_approved && (
                          <span style={{ fontSize: '14px' }} title="Customer Approved">✅</span>
                        )}
                        <span style={{
                          padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: status.bg, color: status.color,
                        }}>
                          {status.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
                        {job.color && <DetailItem label="Color" value={job.color} />}
                        <DetailItem label="Status" value={status.label} />
                        <DetailItem label="Added" value={new Date(job.created_at).toLocaleDateString()} />
                      </div>

                      {isComplete && !job.customer_approved && (
                        <button
                          onClick={() => handleApprove('vehicle', job.id)}
                          style={{
                            width: '100%', padding: '12px', borderRadius: '10px', marginTop: '12px',
                            background: '#34d399', color: '#fff', fontWeight: 800, fontSize: '13px',
                            border: 'none', cursor: 'pointer',
                          }}
                        >
                          ✓ Approve Completed Work
                        </button>
                      )}
                      {job.customer_approved && (
                        <div style={{
                          padding: '8px', borderRadius: '8px', marginTop: '10px', textAlign: 'center',
                          background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)',
                          fontSize: '11px', color: '#34d399', fontWeight: 700,
                        }}>
                          ✅ Approved {job.customer_approved_at ? `on ${new Date(job.customer_approved_at).toLocaleDateString()}` : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Graphics Jobs */}
      {(tab === 'all' || tab === 'graphics') && graphicsJobs.length > 0 && (
        <div>
          {tab === 'all' && (
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              🎨 Graphics Install ({graphicsJobs.length})
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {graphicsJobs.map(job => {
              const status = GRAPHICS_STATUS_MAP[job.status] || { label: job.status, color: 'var(--text-body)', bg: 'rgba(107,122,141,0.1)' };
              const isExpanded = expandedId === `g-${job.id}`;
              const isComplete = job.status === 'completed';

              return (
                <div key={job.id} style={{
                  borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden',
                }}>
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : `g-${job.id}`)}
                    style={{ padding: '12px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {job.title}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {job.vehicle_info || 'Graphics job'}
                          {job.scheduled_install_date && ` · Install: ${new Date(job.scheduled_install_date + 'T00:00:00').toLocaleDateString()}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {job.customer_approved && (
                          <span style={{ fontSize: '14px' }} title="Customer Approved">✅</span>
                        )}
                        <span style={{
                          padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: status.bg, color: status.color,
                        }}>
                          {status.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
                        <DetailItem label="Status" value={status.label} />
                        {job.priority && <DetailItem label="Priority" value={job.priority} />}
                        {job.scheduled_install_date && <DetailItem label="Install Date" value={new Date(job.scheduled_install_date + 'T00:00:00').toLocaleDateString()} />}
                        <DetailItem label="Created" value={new Date(job.created_at).toLocaleDateString()} />
                      </div>

                      {isComplete && !job.customer_approved && (
                        <button
                          onClick={() => handleApprove('graphics', job.id)}
                          style={{
                            width: '100%', padding: '12px', borderRadius: '10px', marginTop: '12px',
                            background: '#34d399', color: '#fff', fontWeight: 800, fontSize: '13px',
                            border: 'none', cursor: 'pointer',
                          }}
                        >
                          ✓ Approve Completed Work
                        </button>
                      )}
                      {job.customer_approved && (
                        <div style={{
                          padding: '8px', borderRadius: '8px', marginTop: '10px', textAlign: 'center',
                          background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)',
                          fontSize: '11px', color: '#34d399', fontWeight: 700,
                        }}>
                          ✅ Approved {job.customer_approved_at ? `on ${new Date(job.customer_approved_at).toLocaleDateString()}` : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '1px' }}>{value}</div>
    </div>
  );
}
