'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

const STATUS_COLORS: Record<string, { text: string }> = {
  received: { text: '#818cf8' },
  in_progress: { text: '#60a5fa' },
  stuck_parts: { text: '#fbbf24' },
  stuck_graphics: { text: '#fb923c' },
};

const STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  in_progress: 'In Progress',
  stuck_parts: 'Stuck (Parts)',
  stuck_graphics: 'Stuck (Graphics)',
};

export default function InShopTrackingWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ received: 0, in_progress: 0, stuck_parts: 0, stuck_graphics: 0 });
  const [recentItems, setRecentItems] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: checkins } = await supabase
      .from('fleet_checkins')
      .select('id, customer_name, vehicle_year, vehicle_make, vehicle_model, status, updated_at')
      .neq('status', 'shipped')
      .neq('status', 'complete')
      .neq('status', 'archived')
      .order('updated_at', { ascending: false })
      .limit(100);

    const all = (checkins || []).map(c => ({
      ...c,
      status: c.status === 'checked_in' ? 'received' : c.status,
    }));
    setStats({
      received: all.filter(c => c.status === 'received').length,
      in_progress: all.filter(c => c.status === 'in_progress').length,
      stuck_parts: all.filter(c => c.status === 'stuck_parts').length,
      stuck_graphics: all.filter(c => c.status === 'stuck_graphics').length,
    });
    setRecentItems(all.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="In-Shop" icon="" loading={loading} onHeaderClick={() => router.push('/tracking')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          {(['received', 'in_progress', 'stuck_parts', 'stuck_graphics'] as const).map(key => {
            const color = STATUS_COLORS[key]?.text || 'var(--text-muted)';
            return (
              <div key={key} style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
                <div style={{ fontSize: '18px', fontWeight: 800, color }}>{stats[key]}</div>
                <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>{STATUS_LABELS[key]}</div>
              </div>
            );
          })}
        </div>

        {recentItems.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentItems.map(item => {
              const statusColor = STATUS_COLORS[item.status]?.text || 'var(--text-muted)';
              const statusLabel = STATUS_LABELS[item.status] || item.status;
              return (
                <button key={item.id} onClick={() => router.push('/tracking')} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                  padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                  background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
                }}>
                  <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>
                    {[item.vehicle_year, item.vehicle_make, item.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle'}
                  </span>
                  <span style={{
                    fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
                    color: statusColor,
                    padding: '2px 6px', borderRadius: '4px',
                    background: `${statusColor}18`,
                  }}>{statusLabel}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
