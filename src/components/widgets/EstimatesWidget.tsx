'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function EstimatesWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, recent: 0 });
  const [recentEstimates, setRecentEstimates] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count } = await supabase
      .from('estimates')
      .select('id', { count: 'exact', head: true });

    const { data: estimates } = await supabase
      .from('estimates')
      .select('id, title, estimate_number, customer, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    const all = estimates || [];
    const recent = all.filter(e => e.created_at >= sevenDaysAgo).length;

    setStats({ total: count || 0, recent });
    setRecentEstimates(all.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="Estimates" icon="" loading={loading} onHeaderClick={() => router.push('/estimates')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.total}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.recent}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Last 7 Days</div>
          </div>
        </div>

        {recentEstimates.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentEstimates.map(estimate => (
              <button key={estimate.id} onClick={() => router.push('/estimates')} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                  {estimate.title || estimate.estimate_number || 'Untitled'}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 700,
                  color: theme.textMuted,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '35%',
                }}>{estimate.customer || ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
