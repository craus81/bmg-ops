'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function TimeClockWidget() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [clockedIn, setClockedIn] = useState<{ name: string; since: string }[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      // Get today's time entries that have clock_in but no clock_out
      const today = new Date().toISOString().split('T')[0];
      const { data: entries } = await supabase
        .from('time_entries')
        .select('id, user_id, clock_in, clock_out, profiles!time_entries_user_id_fkey(full_name)')
        .is('clock_out', null)
        .gte('clock_in', today)
        .order('clock_in', { ascending: true });

      setClockedIn((entries || []).map(e => ({
        name: (e.profiles as any)?.full_name || 'Unknown',
        since: e.clock_in,
      })));
    } catch {
      // time_entries table might not exist
    }
    setLoading(false);
  };

  const formatTime = (d: string) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <WidgetShell title="Time Clock" icon="" loading={loading}>
      <div>
        <div style={{ fontSize: '28px', fontWeight: 800, color: clockedIn.length > 0 ? 'var(--success)' : theme.textMuted, letterSpacing: '-1px' }}>
          {clockedIn.length}
        </div>
        <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '10px' }}>
          {clockedIn.length === 0 ? 'Nobody clocked in' : `clocked in now`}
        </div>

        {clockedIn.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {clockedIn.map((p, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 8px', borderRadius: '6px', background: 'var(--success-bg)',
              }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: theme.textPrimary }}>{p.name}</span>
                <span style={{ fontSize: '10px', color: 'var(--success)', fontWeight: 600 }}>since {formatTime(p.since)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
