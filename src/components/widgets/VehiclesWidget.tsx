'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function VehiclesWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, today: 0, week: 0 });
  const [recentVehicles, setRecentVehicles] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();

    const { count } = await supabase
      .from('scanned_vehicles')
      .select('id', { count: 'exact', head: true });

    const { data: vehicles } = await supabase
      .from('scanned_vehicles')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, part_number, scanned_at')
      .order('scanned_at', { ascending: false })
      .limit(100);

    const all = vehicles || [];
    const today = all.filter(v => v.scanned_at >= todayStart).length;
    const week = all.filter(v => v.scanned_at >= weekStart).length;

    setStats({ total: count || 0, today, week });
    setRecentVehicles(all.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="Vehicles" icon="" loading={loading} onHeaderClick={() => router.push('/vehicles')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.total}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{stats.today}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Today</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.week}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>This Week</div>
          </div>
        </div>

        {recentVehicles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentVehicles.map(vehicle => (
              <button key={vehicle.id} onClick={() => router.push('/vehicles')} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>
                  {[vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(' ') || (vehicle.vin ? vehicle.vin.slice(0, 11) + '...' : 'Unknown')}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 700,
                  color: theme.textMuted,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%',
                }}>{vehicle.part_number || (vehicle.vin ? vehicle.vin.slice(0, 11) + '...' : '')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
