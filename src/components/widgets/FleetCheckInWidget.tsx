'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePopout } from '@/components/Popout';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function FleetCheckInWidget() {
  const router = useRouter();
  const { open: openPopout } = usePopout();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ today: 0, week: 0, month: 0 });
  const [recentCheckins, setRecentCheckins] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: checkins } = await supabase
      .from('fleet_checkins')
      .select('id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, created_at')
      .gte('created_at', fourteenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(100);

    const all = checkins || [];
    const today = all.filter((c: any) => c.created_at >= todayStart).length;
    const week = all.filter((c: any) => c.created_at >= weekStart).length;
    const month = all.filter((c: any) => c.created_at >= monthStart).length;

    setStats({ today, week, month });
    setRecentCheckins(all.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="Fleet Check-In" icon="" loading={loading} onHeaderClick={() => router.push('/tracking')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.today}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Today</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{stats.week}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>This Week</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.month}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>This Month</div>
          </div>
        </div>

        {recentCheckins.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentCheckins.map(checkin => (
              <button key={checkin.id} onClick={() => openPopout('vehicles', checkin.id)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                    {[checkin.vehicle_year, checkin.vehicle_make, checkin.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle'}
                  </span>
                  <span style={{ fontSize: '9px', fontFamily: 'monospace', color: theme.textMuted, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {checkin.vin}
                    {checkin.customer_name ? ` · ${checkin.customer_name}` : ''}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
