'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

interface ScheduleItem {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  type: 'schedule' | 'graphics' | 'upfit' | 'cni';
}

export default function UpcomingScheduleWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ScheduleItem[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const now = new Date();
    const twoWeeks = new Date(now);
    twoWeeks.setDate(twoWeeks.getDate() + 14);
    const startStr = now.toISOString().split('T')[0];
    const endStr = twoWeeks.toISOString().split('T')[0];

    const combined: ScheduleItem[] = [];

    // Load schedule entries
    const { data: entries } = await supabase
      .from('schedule_entries')
      .select('id, scheduled_date, catalog_id, installer_id, notes, quantity, profiles!schedule_entries_installer_id_fkey(full_name)')
      .gte('scheduled_date', startStr)
      .lte('scheduled_date', endStr)
      .order('scheduled_date', { ascending: true })
      .limit(20);

    if (entries) {
      for (const e of entries) {
        combined.push({
          id: e.id,
          date: e.scheduled_date,
          title: e.notes || 'Scheduled Job',
          subtitle: (e.profiles as any)?.full_name || 'Unassigned',
          type: 'schedule',
        });
      }
    }

    // Load graphics jobs with install dates
    const { data: gfx } = await supabase
      .from('graphics_jobs')
      .select('id, title, customer, status, scheduled_install_date, quantity')
      .not('scheduled_install_date', 'is', null)
      .gte('scheduled_install_date', startStr)
      .lte('scheduled_install_date', endStr)
      .order('scheduled_install_date', { ascending: true })
      .limit(20);

    if (gfx) {
      for (const g of gfx) {
        if (['installed', 'cancelled'].includes(g.status || '')) continue;
        combined.push({
          id: g.id,
          date: g.scheduled_install_date,
          title: g.title || 'Graphics Install',
          subtitle: `${g.customer || ''}${g.quantity > 1 ? ` · ${g.quantity} units` : ''}`.trim(),
          type: 'graphics',
        });
      }
    }

    // Load upfit vehicles with scheduled dates
    const { data: upfit } = await supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, scheduled_upfit_date')
      .not('scheduled_upfit_date', 'is', null)
      .gte('scheduled_upfit_date', startStr)
      .lte('scheduled_upfit_date', endStr)
      .order('scheduled_upfit_date', { ascending: true })
      .limit(20);

    if (upfit) {
      for (const u of upfit) {
        const vehicle = [u.vehicle_year, u.vehicle_make, u.vehicle_model].filter(Boolean).join(' ');
        combined.push({
          id: u.id,
          date: u.scheduled_upfit_date,
          title: vehicle || u.vin,
          subtitle: u.customer_name || '',
          type: 'upfit',
        });
      }
    }

    // Load CNI jobs with deadlines
    const { data: cni } = await supabase
      .from('cni_jobs')
      .select('id, title, customer_name, deadline')
      .not('deadline', 'is', null)
      .neq('status', 'cancelled')
      .gte('deadline', startStr)
      .lte('deadline', endStr)
      .order('deadline', { ascending: true })
      .limit(20);

    if (cni) {
      for (const c of cni) {
        combined.push({
          id: c.id,
          date: c.deadline,
          title: c.title || 'CNI Job',
          subtitle: c.customer_name || '',
          type: 'cni',
        });
      }
    }

    // Sort by date
    combined.sort((a, b) => a.date.localeCompare(b.date));
    setItems(combined.slice(0, 10));
    setLoading(false);
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <WidgetShell title="Upcoming Schedule" icon="" loading={loading} onHeaderClick={() => router.push('/admin/schedule')}>
      {items.length === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, fontSize: '12px', padding: '16px 0' }}>
          Nothing scheduled in the next 14 days
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {items.map(item => (
            <button key={item.id} onClick={() => {
              if (item.type === 'graphics') router.push('/graphics');
              else if (item.type === 'upfit') router.push('/tracking');
              else if (item.type === 'cni') router.push(`/admin/cni/jobs/${item.id}`);
              else router.push('/admin/schedule');
            }} style={{
              display: 'flex', gap: '10px', alignItems: 'center', width: '100%',
              padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)',
              border: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
              <div style={{
                minWidth: '52px', fontSize: '10px', fontWeight: 700,
                color: formatDate(item.date) === 'Today' ? 'var(--orange)' : theme.textMuted,
                textTransform: 'uppercase',
              }}>{formatDate(item.date)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '12px', fontWeight: 700, color: theme.textPrimary,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{item.title}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted }}>
                  {item.subtitle}
                </div>
              </div>
              {item.type !== 'schedule' && (
                <div style={{
                  fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px',
                  background: item.type === 'graphics' ? 'rgba(249,115,22,0.1)' : item.type === 'upfit' ? 'rgba(59,130,246,0.1)' : 'rgba(34,197,94,0.1)',
                  color: item.type === 'graphics' ? '#f97316' : item.type === 'upfit' ? '#3b82f6' : '#22c55e',
                }}>{item.type === 'graphics' ? 'GFX' : item.type === 'upfit' ? 'UPFIT' : 'CNI'}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
