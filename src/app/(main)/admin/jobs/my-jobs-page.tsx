'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Job {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  end_customer: string | null;
  review_status: string;
  submitted_for_review: boolean;
  scanned_at: string;
  scanned_by: string;
  scanner_name?: string;
  photo_count?: number;
}

export default function MyJobsPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'mine' | 'review'>('all');

  useEffect(() => {
    if (!user || !profile) return;
    loadJobs();
  }, [user, profile]);

  const loadJobs = async () => {
    if (!profile?.company_id) {
      setLoading(false);
      return;
    }

    const { data } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('scanned_at', { ascending: false });

    if (!data) { setLoading(false); return; }

    // Get scanner names and photo counts
    const enriched: Job[] = await Promise.all(
      data.map(async (v: any) => {
        const { data: scannerProfile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', v.scanned_by)
          .maybeSingle();

        const { count } = await supabase
          .from('vehicle_photos')
          .select('*', { count: 'exact', head: true })
          .eq('vehicle_id', v.id);

        return {
          ...v,
          scanner_name: scannerProfile?.full_name || 'Unknown',
          photo_count: count || 0,
        };
      })
    );

    setJobs(enriched);
    setLoading(false);
  };

  const vehicleTitle = (v: Job) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const filtered = filter === 'mine'
    ? jobs.filter((j) => j.scanned_by === user?.id)
    : filter === 'review'
    ? jobs.filter((j) => j.submitted_for_review)
    : jobs;

  const statusBadge = (v: Job) => {
    if (!v.submitted_for_review) return null;
    const isPending = v.review_status === 'pending';
    const isApproved = v.review_status === 'approved';
    const isDenied = v.review_status === 'denied';
    const color = isPending ? 'var(--warning)' : isApproved ? 'var(--success)' : 'var(--error)';
    const bg = isPending ? 'var(--warning-bg)' : isApproved ? 'var(--success-bg)' : 'var(--error-bg)';
    const border = isPending ? 'var(--warning-border)' : isApproved ? 'var(--success-border)' : 'var(--error-border)';
    const label = isPending ? '⏳ Pending' : isApproved ? '✅ Approved' : '❌ Rework';
    return (
      <span style={{
        padding: '2px 7px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
        background: bg, border: `1px solid ${border}`, color,
      }}>{label}</span>
    );
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  if (!profile?.company_id) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: '36px', marginBottom: '8px', opacity: 0.4 }}>🏢</div>
        <div style={{ fontWeight: 600, fontSize: '14px' }}>No company assigned</div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>Ask an admin to assign you to a company.</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        My Jobs
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          { id: 'all' as const, label: `All (${jobs.length})` },
          { id: 'mine' as const, label: 'My Scans' },
          { id: 'review' as const, label: 'Submitted' },
        ]).map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: filter === f.id ? 'var(--tab-active-bg)' : 'transparent',
            border: filter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: filter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No jobs found</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {filtered.map((job) => (
          <button
            key={job.id}
            onClick={() => router.push(`/photos?id=${job.id}`)}
            style={{
              display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
              padding: '14px', borderRadius: '14px', textAlign: 'left',
              border: '1px solid var(--border)', background: 'var(--card)',
              boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s',
            }}
          >
            <div style={{
              width: '44px', height: '44px', borderRadius: '12px',
              background: 'var(--subtle-bg)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0,
            }}>🚐</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>
                  {vehicleTitle(job)}
                </div>
                {statusBadge(job)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                {job.vin}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {job.scanner_name}
                {job.photo_count ? ` • ${job.photo_count} photo${job.photo_count !== 1 ? 's' : ''}` : ''}
                {job.end_customer ? ` • ${job.end_customer}` : ''}
                {' • '}{new Date(job.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
