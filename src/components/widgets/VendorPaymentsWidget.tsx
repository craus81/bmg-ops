'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function VendorPaymentsWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ submitted: 0, approved: 0, billed: 0 });
  const [recent, setRecent] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      const { data: jobs } = await supabase
        .from('cni_jobs')
        .select('id, job_number, title, invoice_status, invoice_approved_at, customer_name')
        .in('invoice_status', ['submitted', 'approved', 'billed_in_netsuite'])
        .order('invoice_approved_at', { ascending: false, nullsFirst: true })
        .limit(50);

      const all = jobs || [];
      setStats({
        submitted: all.filter((j: any) => j.invoice_status === 'submitted').length,
        approved: all.filter((j: any) => j.invoice_status === 'approved').length,
        billed: all.filter((j: any) => j.invoice_status === 'billed_in_netsuite').length,
      });
      setRecent(all.filter((j: any) => j.invoice_status === 'submitted').slice(0, 3));
    } catch {
      // cni_jobs table may not exist yet
    }
    setLoading(false);
  };

  return (
    <WidgetShell title="Vendor Payments" icon="" loading={loading} onHeaderClick={() => router.push('/admin/cni')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24' }}>{stats.submitted}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Submitted</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.approved}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Approved</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.billed}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Billed</div>
          </div>
        </div>

        {recent.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recent.map(job => (
              <button key={job.id} onClick={() => router.push(`/admin/cni/jobs/${job.id}`)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>
                  {job.title || job.job_number || job.customer_name || 'CNI Job'}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
                  color: '#fbbf24', padding: '2px 6px', borderRadius: '4px', background: '#fbbf2418',
                }}>Submitted</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
