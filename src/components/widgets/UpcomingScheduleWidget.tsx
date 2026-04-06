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
  type: 'schedule' | 'graphics';
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
      .select('id, title, customer, scheduled_install_date, quantity')
      .not('scheduled_install_date', 'is', null)
      .not('status', 'in', '("installed","cancelled")')
      .gte('scheduled_install_date', startStr)
      .lte('scheduled_install_date', endStr)
      .order('scheduled_install_date', { ascending: true })
      .limit(20);

    if (gfx) {
      for (const g of gfx) {
        combined.push({
          id: g.id,
          date: g.scheduled_install_date,
          title: g.title || 'Graphics Install',
          subtitle: `${g.customer || ''}${g.quantity > 1 ? ` · ${g.quantity} units` : ''}`.trim(),
          type: 'graphics',
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
            <div key={item.id} style={{
              display: 'flex', gap: '10px', alignItems: 'center',
              padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)',
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
              {item.type === 'graphics' && (
                <div style={{
                  fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px',
                  background: 'rgba(249,115,22,0.1)', color: '#f97316',
                }}>INSTALL</div>
              )}
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
