'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function UpcomingScheduleWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const now = new Date();
    const weekOut = new Date(now);
    weekOut.setDate(weekOut.getDate() + 14);

    const { data } = await supabase
      .from('schedule_entries')
      .select('id, title, date, installer_id, location, notes, profiles!schedule_entries_installer_id_fkey(full_name)')
      .gte('date', now.toISOString().split('T')[0])
      .lte('date', weekOut.toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(10);

    setEntries(data || []);
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
      {entries.length === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, fontSize: '12px', padding: '16px 0' }}>
          Nothing scheduled in the next 14 days
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {entries.map(e => (
            <div key={e.id} style={{
              display: 'flex', gap: '10px', alignItems: 'center',
              padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)',
            }}>
              <div style={{
                minWidth: '52px', fontSize: '10px', fontWeight: 700,
                color: formatDate(e.date) === 'Today' ? 'var(--orange)' : theme.textMuted,
                textTransform: 'uppercase',
              }}>{formatDate(e.date)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '12px', fontWeight: 700, color: theme.textPrimary,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{e.title}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted }}>
                  {(e.profiles as any)?.full_name || 'Unassigned'}
                  {e.location ? ` • ${e.location}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
