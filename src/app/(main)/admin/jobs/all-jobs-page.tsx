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
  company_id: string | null;
  scanner_name?: string;
  company_name?: string;
  photo_count?: number;
}

interface Company {
  id: string;
  name: string;
}

export default function AllJobsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'denied' | 'not_submitted'>('all');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  }, [isAdmin]);

  const loadData = async () => {
    // Load companies
    const { data: companyData } = await supabase
      .from('companies')
      .select('*')
      .order('name');
    setCompanies(companyData || []);

    // Load all vehicles
    const { data } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .order('scanned_at', { ascending: false });

    if (!data) { setLoading(false); return; }

    // Enrich with scanner names, company names, photo counts
    const enriched: Job[] = await Promise.all(
      data.map(async (v: any) => {
        const { data: scannerProfile } = await supabase
          .from('profiles')
          .select('full_name, company_id')
          .eq('id', v.scanned_by)
          .maybeSingle();

        const companyId = v.company_id || scannerProfile?.company_id;
        const company = (companyData || []).find((c: Company) => c.id === companyId);

        const { count } = await supabase
          .from('vehicle_photos')
          .select('*', { count: 'exact', head: true })
          .eq('vehicle_id', v.id);

        return {
          ...v,
          company_id: companyId,
          scanner_name: scannerProfile?.full_name || 'Unknown',
          company_name: company?.name || 'Unassigned',
          photo_count: count || 0,
        };
      })
    );

    setJobs(enriched);
    setLoading(false);
  };

  const vehicleTitle = (v: Job) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const filtered = jobs.filter((j) => {
    if (companyFilter !== 'all' && j.company_id !== companyFilter) return false;
    if (statusFilter === 'pending') return j.review_status === 'pending' && j.submitted_for_review;
    if (statusFilter === 'approved') return j.review_status === 'approved';
    if (statusFilter === 'denied') return j.review_status === 'denied';
    if (statusFilter === 'not_submitted') return !j.submitted_for_review;
    return true;
  });

  // Group by company for display
  const grouped = filtered.reduce((acc: Record<string, Job[]>, job) => {
    const key = job.company_name || 'Unassigned';
    if (!acc[key]) acc[key] = [];
    acc[key].push(job);
    return acc;
  }, {});

  const statusBadge = (v: Job) => {
    if (!v.submitted_for_review) {
      return (
        <span style={{
          padding: '2px 7px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
          background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>Not Submitted</span>
      );
    }
    const isPending = v.review_status === 'pending';
    const isApproved = v.review_status === 'approved';
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

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        All Jobs ({filtered.length})
      </div>

      {/* Company filter */}
      <div style={{ marginBottom: '8px' }}>
        <select
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
          }}
        >
          <option value="all">All Companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value="unassigned">Unassigned</option>
        </select>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', overflowX: 'auto' }}>
        {([
          { id: 'all' as const, label: 'All' },
          { id: 'not_submitted' as const, label: 'Logged' },
          { id: 'pending' as const, label: 'Pending' },
          { id: 'approved' as const, label: 'Approved' },
          { id: 'denied' as const, label: 'Denied' },
        ]).map((f) => (
          <button key={f.id} onClick={() => setStatusFilter(f.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
            background: statusFilter === f.id ? 'var(--tab-active-bg)' : 'transparent',
            border: statusFilter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: statusFilter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No jobs match filters</div>
        </div>
      )}

      {/* Grouped by company */}
      {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([companyName, companyJobs]) => (
        <div key={companyName} style={{ marginBottom: '16px' }}>
          <div style={{
            fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)',
            padding: '8px 0', borderBottom: '1px solid var(--border)', marginBottom: '8px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>🏢 {companyName}</span>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>
              {companyJobs.length} job{companyJobs.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {companyJobs.map((job) => (
              <button
                key={job.id}
                onClick={() => router.push(`/photos?id=${job.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
                  padding: '12px', borderRadius: '12px', textAlign: 'left',
                  border: '1px solid var(--border)', background: 'var(--card)',
                  boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
                      {vehicleTitle(job)}
                    </div>
                    {statusBadge(job)}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                    {job.vin}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
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
      ))}

      <button onClick={() => router.push('/more')} style={{
        width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: '13px', fontWeight: 700,
      }}>
        ← Back
      </button>
    </div>
  );
}
