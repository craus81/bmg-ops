'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function CniOverviewWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Record<string, number>>({});

  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      const { data: jobs } = await supabase
        .from('cni_jobs')
        .select('id, status');

      const counts: Record<string, number> = {};
      for (const j of (jobs || [])) {
        counts[j.status] = (counts[j.status] || 0) + 1;
      }
      counts._total = (jobs || []).length;
      setStats(counts);
    } catch {
      // CNI tables might not exist yet
    }
    setLoading(false);
  };

  const statusGroups = [
    { label: 'Unassigned', keys: ['awaiting_assignment', 'bidding_open'], color: 'var(--warning)' },
    { label: 'Scheduled', keys: ['assigned_awaiting_scheduling', 'scheduling_proposed', 'scheduled_pending_confirmation', 'scheduled_confirmed'], color: 'var(--navy-light)' },
    { label: 'In Progress', keys: ['in_progress'], color: 'var(--orange)' },
    { label: 'Review', keys: ['completed_pending_review'], color: 'var(--error)' },
    { label: 'Closed', keys: ['approved_closed'], color: 'var(--success)' },
  ];

  return (
    <WidgetShell title="CNI Program" icon="🔧" loading={loading} onHeaderClick={() => router.push('/admin/cni')}>
      {stats._total === undefined || stats._total === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, fontSize: '12px', padding: '16px 0' }}>
          No CNI jobs yet
        </div>
      ) : (
        <div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: theme.textPrimary, letterSpacing: '-1px' }}>
            {stats._total}
          </div>
          <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '10px' }}>total jobs</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {statusGroups.map(g => {
              const count = g.keys.reduce((s, k) => s + (stats[k] || 0), 0);
              if (count === 0) return null;
              return (
                <div key={g.label} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '6px 8px', borderRadius: '6px', background: 'var(--subtle-bg)',
                }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: theme.textPrimary }}>{g.label}</span>
                  <span style={{ fontSize: '12px', fontWeight: 800, color: g.color }}>{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </WidgetShell>
  );
}
