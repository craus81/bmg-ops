'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { fmtTime, fmtClock, fmtDate } from '@/lib/utils';
import type { TimeEntry, TimeBreak } from '@/lib/types';

export default function TimePage() {
  const [tab, setTab] = useState<'clock' | 'history' | 'week'>('clock');

  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        {[
          { id: 'clock' as const, label: 'Clock' },
          { id: 'history' as const, label: 'History' },
          { id: 'week' as const, label: 'Week' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: tab === t.id ? 'rgba(59,130,246,0.12)' : 'transparent',
              border: tab === t.id ? '1px solid rgba(59,130,246,0.3)' : '1px solid #1e2d3d',
              color: tab === t.id ? '#60a5fa' : '#4a5f78',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'clock' && <ClockScreen />}
      {tab === 'history' && <HistoryScreen />}
      {tab === 'week' && <WeekScreen />}
    </div>
  );
}

function ClockScreen() {
  const { clockStatus, elapsed, clockInTime, breakStartTime, currentBreaks, doClockIn, doStartBreak, doEndBreak, doClockOut } = useApp();

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        width: '140px', height: '140px', borderRadius: '50%', margin: '10px auto 20px',
        background: clockStatus === 'out' ? 'rgba(255,255,255,0.03)' : clockStatus === 'break' ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
        border: `3px solid ${clockStatus === 'out' ? '#1e2d3d' : clockStatus === 'break' ? 'rgba(245,158,11,0.3)' : 'rgba(34,197,94,0.3)'}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        {clockStatus === 'out' ? (
          <div style={{ fontSize: '13px', color: '#4a5f78', fontWeight: 600 }}>Off the Clock</div>
        ) : (
          <>
            <div style={{ fontSize: '10px', color: clockStatus === 'break' ? '#fbbf24' : '#4ade80', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {clockStatus === 'break' ? 'On Break' : 'Working'}
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#e8ecf1', marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
              {fmtTime(elapsed)}
            </div>
            {clockInTime && (
              <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
                since {fmtClock(new Date(clockInTime))}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '320px', margin: '0 auto' }}>
        {clockStatus === 'out' && (
          <button onClick={doClockIn} style={{ ...btnStyle('#22c55e'), padding: '20px', fontSize: '18px' }}>🟢 Clock In</button>
        )}
        {clockStatus === 'in' && (
          <>
            <button onClick={doStartBreak} style={{ ...btnStyle('#f59e0b'), padding: '16px', fontSize: '16px' }}>🍔 Start Lunch Break</button>
            <button onClick={doClockOut} style={{ ...btnStyle('#ef4444'), padding: '16px', fontSize: '16px' }}>🔴 Clock Out</button>
          </>
        )}
        {clockStatus === 'break' && (
          <>
            <button onClick={doEndBreak} style={{ ...btnStyle('#22c55e'), padding: '18px', fontSize: '17px' }}>✅ End Break</button>
            {breakStartTime && (
              <div style={{ fontSize: '12px', color: '#fbbf24', marginTop: '4px' }}>
                Break started at {fmtClock(new Date(breakStartTime))}
              </div>
            )}
          </>
        )}
      </div>

      {clockStatus !== 'out' && currentBreaks.filter((b) => b.break_end).length > 0 && (
        <div style={{ marginTop: '20px', textAlign: 'left' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
            Today&apos;s Breaks
          </div>
          {currentBreaks.filter((b) => b.break_end).map((b) => {
            const dur = new Date(b.break_end!).getTime() - new Date(b.break_start).getTime();
            return (
              <div key={b.id} style={{ fontSize: '13px', color: '#6b7a8d', padding: '4px 0' }}>
                {fmtClock(new Date(b.break_start))} – {fmtClock(new Date(b.break_end!))}
                <span style={{ color: '#4a5f78' }}> ({fmtTime(dur)})</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HistoryScreen() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data } = await supabase
        .from('time_entries')
        .select('*')
        .eq('user_id', user.id)
        .not('clock_out', 'is', null)
        .order('clock_in', { ascending: false })
        .limit(14);
      setEntries(data || []);
      setLoading(false);
    };
    load();
  }, [user]);

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        Recent Time Entries
      </div>
      {entries.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#4a5f78' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>⏰</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No time entries yet</div>
        </div>
      )}
      {entries.map((e) => (
        <div key={e.id} style={{
          background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px',
          padding: '12px', marginBottom: '6px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, fontSize: '14px' }}>{fmtDate(new Date(e.clock_in))}</div>
            <div style={{ fontWeight: 800, fontSize: '15px', color: '#60a5fa' }}>{e.total_ms ? fmtTime(e.total_ms) : '—'}</div>
          </div>
          <div style={{ fontSize: '12px', color: '#4a5f78', marginTop: '3px' }}>
            {fmtClock(new Date(e.clock_in))} – {e.clock_out ? fmtClock(new Date(e.clock_out)) : 'active'}
          </div>
        </div>
      ))}
    </div>
  );
}

function WeekScreen() {
  const { user } = useAuth();
  const { clockStatus, elapsed } = useApp();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const now = new Date();
      const mon = new Date(now);
      mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      mon.setHours(0, 0, 0, 0);

      const { data } = await supabase
        .from('time_entries')
        .select('*')
        .eq('user_id', user.id)
        .gte('clock_in', mon.toISOString())
        .order('clock_in', { ascending: true });

      setEntries(data || []);
      setLoading(false);
    };
    load();
  }, [user, clockStatus]);

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  mon.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    const dayEntries = entries.filter((e) => new Date(e.clock_in).toDateString() === d.toDateString());
    let ms = dayEntries.reduce((s, e) => s + (e.total_ms || 0), 0);
    if (d.toDateString() === now.toDateString() && clockStatus !== 'out') ms += elapsed;
    return { date: d, dayName: d.toLocaleDateString([], { weekday: 'short' }), totalMs: ms };
  });

  const weekTotalMs = days.reduce((s, d) => s + d.totalMs, 0);
  const regularMs = Math.min(weekTotalMs, 40 * 3600000);
  const overtimeMs = Math.max(0, weekTotalMs - 40 * 3600000);

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        This Week
      </div>
      <div style={{
        background: 'linear-gradient(135deg, rgba(59,130,246,0.10), rgba(59,130,246,0.03))',
        border: '1px solid rgba(59,130,246,0.25)', borderRadius: '14px',
        padding: '16px', marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <StatBox label="Total" value={fmtTime(weekTotalMs)} color="#e8ecf1" />
          <StatBox label="Regular" value={fmtTime(regularMs)} color="#4ade80" />
          <StatBox label="OT" value={overtimeMs > 0 ? fmtTime(overtimeMs) : '—'} color={overtimeMs > 0 ? '#f87171' : '#4a5f78'} />
        </div>
        <div style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
            <span style={{ color: '#4a5f78' }}>Week Progress</span>
            <span style={{ color: weekTotalMs >= 40 * 3600000 ? '#f87171' : '#60a5fa', fontWeight: 700 }}>
              {(weekTotalMs / 3600000).toFixed(1)} / 40 hrs
            </span>
          </div>
          <div style={{ height: '8px', background: '#1e2d3d', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${Math.min((weekTotalMs / (40 * 3600000)) * 100, 100)}%`,
              background: weekTotalMs >= 40 * 3600000 ? 'linear-gradient(90deg, #22c55e 80%, #ef4444)' : '#3b82f6',
              borderRadius: '4px',
            }} />
          </div>
        </div>
      </div>

      <div style={{ fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        Daily Breakdown
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {days.map((d, i) => {
          const hrs = d.totalMs / 3600000;
          const isToday = d.date.toDateString() === now.toDateString();
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
              background: isToday ? 'rgba(59,130,246,0.06)' : '#141e2b',
              border: isToday ? '1px solid rgba(59,130,246,0.2)' : '1px solid #1e2d3d',
              borderRadius: '8px',
            }}>
              <div style={{ width: '36px', fontSize: '12px', fontWeight: 700, color: isToday ? '#60a5fa' : '#6b7a8d' }}>{d.dayName}</div>
              <div style={{ flex: 1 }}>
                <div style={{ height: '10px', background: '#1e2d3d', borderRadius: '5px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${Math.min((hrs / 10) * 100, 100)}%`,
                    background: hrs > 8 ? 'linear-gradient(90deg, #3b82f6 80%, #f59e0b)' : '#3b82f6',
                    borderRadius: '5px',
                  }} />
                </div>
              </div>
              <div style={{ width: '50px', textAlign: 'right', fontSize: '13px', fontWeight: 700, color: d.totalMs > 0 ? '#e8ecf1' : '#2a3a4f' }}>
                {d.totalMs > 0 ? fmtTime(d.totalMs) : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: '#141e2b', borderRadius: '8px', padding: '6px 10px', textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: '9px', color: '#4a5f78', fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '17px', fontWeight: 800, color, marginTop: '1px' }}>{value}</div>
    </div>
  );
}

function btnStyle(bg: string) {
  return {
    width: '100%', padding: '10px', borderRadius: '10px', border: 'none',
    background: bg, color: '#fff', fontWeight: 700 as const, cursor: 'pointer',
    fontFamily: '-apple-system, sans-serif',
  };
}
