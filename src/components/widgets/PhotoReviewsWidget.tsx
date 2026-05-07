'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function PhotoReviewsWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ pending: 0, approved: 0, denied: 0 });
  const [recentPending, setRecentPending] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: vehicles } = await supabase
      .from('scanned_vehicles')
      .select('id, review_status, vehicle_year, vehicle_make, vehicle_model, created_at')
      .eq('submitted_for_review', true)
      .order('created_at', { ascending: false })
      .limit(500);

    const all = vehicles || [];
    const pending = all.filter((v: any) => v.review_status === 'pending');
    const approved = all.filter((v: any) => v.review_status === 'approved');
    const denied = all.filter((v: any) => v.review_status === 'denied');

    setStats({ pending: pending.length, approved: approved.length, denied: denied.length });
    setRecentPending(pending.slice(0, 3));
    setLoading(false);
  };

  return (
    <WidgetShell title="Photo Reviews" icon="" loading={loading} onHeaderClick={() => router.push('/admin/reviews')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24' }}>{stats.pending}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Pending</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.approved}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Approved</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#f87171' }}>{stats.denied}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Denied</div>
          </div>
        </div>

        {recentPending.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentPending.map(v => (
              <button key={v.id} onClick={() => router.push('/admin/reviews')} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                  {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle'}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
                  color: '#fbbf24', padding: '2px 6px', borderRadius: '4px', background: '#fbbf2418',
                }}>Pending</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
