'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Assignment {
  id: string;
  job_type: string;
  job_id: string;
  assigned_at: string;
}

interface AvailableJob {
  id: string;
  label: string;
  sub: string;
  type: 'scanned_vehicle' | 'graphics_job';
}

export default function AssignmentsPage() {
  const router = useRouter();
  const params = useParams();
  const userId = params.userId as string;
  const { isAdmin } = useAuth();
  const supabase = createClient();

  const [customerName, setCustomerName] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [vehicles, setVehicles] = useState<AvailableJob[]>([]);
  const [graphicsJobs, setGraphicsJobs] = useState<AvailableJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addingType, setAddingType] = useState<'scanned_vehicle' | 'graphics_job'>('scanned_vehicle');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin, userId]);

  const loadData = async () => {
    // Load customer user info
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email, role')
      .eq('id', userId)
      .single();
    setCustomerName(profile?.full_name || 'Unknown User');

    // Load existing assignments
    const { data: assigns } = await supabase
      .from('customer_job_assignments')
      .select('*')
      .eq('customer_user_id', userId)
      .order('assigned_at', { ascending: false });
    setAssignments((assigns as Assignment[]) || []);

    // Load all vehicles (for assignment picker)
    const { data: vehicleData } = await supabase
      .from('scanned_vehicles')
      .select('id, vin, year, make, model, customer, po_number, status')
      .order('created_at', { ascending: false })
      .limit(500);

    setVehicles((vehicleData || []).map((v: any) => ({
      id: v.id,
      label: [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin,
      sub: `VIN: ${v.vin}${v.customer ? ` · ${v.customer}` : ''}${v.po_number ? ` · PO: ${v.po_number}` : ''} · ${v.status}`,
      type: 'scanned_vehicle' as const,
    })));

    // Load all graphics jobs
    const { data: gfxData } = await supabase
      .from('graphics_jobs')
      .select('id, title, status, customer_name, vehicle_info')
      .order('created_at', { ascending: false })
      .limit(500);

    setGraphicsJobs((gfxData || []).map((g: any) => ({
      id: g.id,
      label: g.title,
      sub: `${g.customer_name || 'No customer'}${g.vehicle_info ? ` · ${g.vehicle_info}` : ''} · ${g.status}`,
      type: 'graphics_job' as const,
    })));

    setLoading(false);
  };

  const assignedIds = new Set(assignments.map(a => a.job_id));

  const addAssignment = async (jobType: string, jobId: string) => {
    const { error } = await supabase
      .from('customer_job_assignments')
      .insert({
        customer_user_id: userId,
        job_type: jobType,
        job_id: jobId,
      });

    if (error) {
      alert('Failed to assign: ' + error.message);
    } else {
      loadData();
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    if (!confirm('Remove this job assignment?')) return;
    await supabase.from('customer_job_assignments').delete().eq('id', assignmentId);
    loadData();
  };

  const availableJobs = addingType === 'scanned_vehicle' ? vehicles : graphicsJobs;
  const filteredAvailable = availableJobs.filter(j => {
    if (assignedIds.has(j.id)) return false;
    if (!search) return true;
    const s = search.toLowerCase();
    return j.label.toLowerCase().includes(s) || j.sub.toLowerCase().includes(s);
  });

  // Enrich assignments with job details
  const enrichedAssignments = assignments.map(a => {
    const allJobs = [...vehicles, ...graphicsJobs];
    const job = allJobs.find(j => j.id === a.job_id);
    return { ...a, jobLabel: job?.label || 'Unknown', jobSub: job?.sub || a.job_id };
  });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '12px',
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Job Assignments</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Assign jobs for <strong style={{ color: 'var(--text-primary)' }}>{customerName}</strong> to see on their dashboard
        </div>
      </div>

      {/* Current assignments */}
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        Assigned Jobs ({assignments.length})
      </div>

      {assignments.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--card)', borderRadius: '12px', border: '1px solid var(--border)', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px' }}>No jobs assigned yet. Use the picker below to add jobs.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
          {enrichedAssignments.map(a => (
            <div key={a.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', borderRadius: '10px',
              background: 'var(--card)', border: '1px solid var(--border)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>{a.job_type === 'scanned_vehicle' ? 'VEH' : 'GFX'}</span>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.jobLabel}
                  </div>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px', marginLeft: '20px' }}>
                  {a.jobSub}
                </div>
              </div>
              <button
                onClick={() => removeAssignment(a.id)}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  background: 'var(--error-bg)', border: '1px solid var(--error-border)',
                  color: 'var(--error)', cursor: 'pointer', flexShrink: 0, marginLeft: '8px',
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add jobs section */}
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        Add Jobs
      </div>

      {/* Type toggle */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '10px', marginBottom: '8px',
      }}>
        <button
          onClick={() => { setAddingType('scanned_vehicle'); setSearch(''); }}
          style={{
            flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: addingType === 'scanned_vehicle' ? 'var(--tab-active-bg)' : 'transparent',
            border: addingType === 'scanned_vehicle' ? '1px solid var(--tab-active-border)' : '1px solid transparent',
            color: addingType === 'scanned_vehicle' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          Vehicles ({vehicles.filter(v => !assignedIds.has(v.id)).length})
        </button>
        <button
          onClick={() => { setAddingType('graphics_job'); setSearch(''); }}
          style={{
            flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: addingType === 'graphics_job' ? 'var(--tab-active-bg)' : 'transparent',
            border: addingType === 'graphics_job' ? '1px solid var(--tab-active-border)' : '1px solid transparent',
            color: addingType === 'graphics_job' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          Graphics ({graphicsJobs.filter(g => !assignedIds.has(g.id)).length})
        </button>
      </div>

      <input
        placeholder={`Search ${addingType === 'scanned_vehicle' ? 'vehicles' : 'graphics jobs'}...`}
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '8px' }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '300px', overflowY: 'auto' }}>
        {filteredAvailable.slice(0, 50).map(job => (
          <div key={job.id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', borderRadius: '8px',
            background: 'var(--card)', border: '1px solid var(--border)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.label}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.sub}
              </div>
            </div>
            <button
              onClick={() => addAssignment(job.type, job.id)}
              style={{
                padding: '4px 12px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                color: '#60a5fa', cursor: 'pointer', flexShrink: 0, marginLeft: '8px',
              }}
            >
              + Assign
            </button>
          </div>
        ))}
        {filteredAvailable.length === 0 && (
          <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '11px' }}>
            {search ? 'No matching jobs found' : 'All jobs are already assigned'}
          </div>
        )}
      </div>

      <button onClick={() => router.push('/admin/users')} style={{
        width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: '13px', fontWeight: 700,
      }}>
        ← Back to Users
      </button>
    </div>
  );
}
