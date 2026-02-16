'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { fmtTime, fmtClock, fmtDate } from '@/lib/utils';
import { theme } from '@/lib/theme';
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
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
            background: tab === t.id ? 'rgba(238,49,32,0.08)' : 'transparent',
            border: tab === t.id ? '1px solid rgba(238,49,32,0.2)' : `1px solid ${theme.border}`,
            color: tab === t.id ? theme.orange : theme.textMuted,
            transition: 'all 0.15s',
          }}>
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
        width: '150px', height: '150px', borderRadius: '50%', margin: '10px auto 24px',
        background: clockStatus === 'out' ? 'rgba(255,255,255,0.02)' : clockStatus === 'break' ? theme.warningBg : theme.successBg,
        border: `3px solid ${clockStatus === 'out' ? theme.border : clockStatus === 'break' ? theme.warningBorder : theme.successBorder}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        {clockStatus === 'out' ? (
          <div style={{ fontSize: '13px', color: theme.textMuted, fontWeight: 600 }}>Off the Clock</div>
        ) : (
          <>
            <div style={{ fontSize: '10px', color: clockStatus === 'break' ? theme.warning : theme.success, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              {clockStatus === 'break' ? 'On Break' : 'Working'}
            </div>
            <div style={{ fontSize: '30px', fontWeight: 800, color: theme.textPrimary, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
              {fmtTime(elapsed)}
            </div>
            {clockInTime && (
              <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>since {fmtClock(new Date(clockInTime))}</div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '320px', margin: '0 auto' }}>
        {clockStatus === 'out' && (
          <button onClick={doClockIn} style={{ ...bigBtnStyle('#059669'), padding: '20px', fontSize: '18px', boxShadow: '0 4px 16px rgba(5,150,105,0.25)' }}>🟢 Clock In</button>
        )}
        {clockStatus === 'in' && (<>
          <button onClick={doStartBreak} style={{ ...bigBtnStyle('#d97706'), padding: '16px', fontSize: '16px', boxShadow: '0 4px 16px rgba(217,119,6,0.25)' }}>🍔 Start Lunch Break</button>
          <button onClick={doClockOut} style={{ ...bigBtnStyle('#dc2626'), padding: '16px', fontSize: '16px', boxShadow: '0 4px 16px rgba(220,38,38,0.25)' }}>🔴 Clock Out</button>
        </>)}
        {clockStatus === 'break' && (<>
          <button onClick={doEndBreak} style={{ ...bigBtnStyle('#059669'), padding: '18px', fontSize: '17px', boxShadow: '0 4px 16px rgba(5,150,105,0.25)' }}>✅ End Break</button>
          {breakStartTime && <div style={{ fontSize: '12px', color: theme.warning, marginTop: '4px' }}>Break started at {fmtClock(new Date(breakStartTime))}</div>}
        </>)}
      </div>

      {clockStatus !== 'out' && currentBreaks.filter((b) => b.break_end).length > 0 && (
        <div style={{ marginTop: '20px', textAlign: 'left' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '6px' }}>Today&apos;s Breaks</div>
          {currentBreaks.filter((b) => b.break_end).map((b) => {
            const dur = new Date(b.break_end!).getTime() - new Date(b.break_start).getTime();
            return (
              <div key={b.id} style={{ fontSize: '13px', color: theme.textSecondary, padding: '4px 0' }}>
                {fmtClock(new Date(b.break_start))} – {fmtClock(new Date(b.break_end!))}
                <span style={{ color: theme.textMuted }}> ({fmtTime(dur)})</span>
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
      const { data } = await supabase.from('time_entries').select('*').eq('user_id', user.id).not('clock_out', 'is', null).order('clock_in', { ascending: false }).limit(14);
      setEntries(data || []);
      setLoading(false);
    };
    load();
  }, [user]);

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: theme.textMuted }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>Recent Time Entries</div>
      {entries.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: theme.textMuted }}>
          <div style={{ fontSize: '40px', marginBottom: '8px', opacity: 0.3 }}>⏰</div>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>No time entries yet</div>
        </div>
      )}
      {entries.map((e) => (
        <div key={e.id} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '14px 16px', marginBottom: '8px', boxShadow: theme.shadowSm }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, fontSize: '15px', color: theme.textPrimary, letterSpacing: '-0.2px' }}>{fmtDate(new Date(e.clock_in))}</div>
            <div style={{ fontWeight: 800, fontSize: '16px', color: theme.navy }}>{e.total_ms ? fmtTime(e.total_ms) : '—'}</div>
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>
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
      const { data } = await supabase.from('time_entries').select('*').eq('user_id', user.id).gte('clock_in', mon.toISOString()).order('clock_in', { ascending: true });
      setEntries(data || []);
      setLoading(false);
    };
    load();
  }, [user, clockStatus]);

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: theme.textMuted }}>Loading...</div>;

  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  mon.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
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
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>This Week</div>
      <div style={{
        background: theme.card, border: `1px solid ${theme.border}`,
        borderRadius: '14px', padding: '16px', marginBottom: '16px', boxShadow: theme.shadowSm,
      }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <StatBox label="Total" value={fmtTime(weekTotalMs)} color={theme.textPrimary} />
          <StatBox label="Regular" value={fmtTime(regularMs)} color={theme.success} />
          <StatBox label="OT" value={overtimeMs > 0 ? fmtTime(overtimeMs) : '—'} color={overtimeMs > 0 ? theme.error : theme.textMuted} />
        </div>
        <div style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
            <span style={{ color: theme.textMuted }}>Week Progress</span>
            <span style={{ color: weekTotalMs >= 40 * 3600000 ? theme.error : theme.navy, fontWeight: 700 }}>
              {(weekTotalMs / 3600000).toFixed(1)} / 40 hrs
            </span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.04)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${Math.min((weekTotalMs / (40 * 3600000)) * 100, 100)}%`,
              background: weekTotalMs >= 40 * 3600000 ? `linear-gradient(90deg, ${theme.success} 80%, ${theme.error})` : theme.navy,
              borderRadius: '3px',
            }} />
          </div>
        </div>
      </div>

      <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' }}>Daily Breakdown</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {days.map((d, i) => {
          const hrs = d.totalMs / 3600000;
          const isToday = d.date.toDateString() === now.toDateString();
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
              background: isToday ? 'rgba(238,49,32,0.04)' : theme.card,
              border: isToday ? '1px solid rgba(238,49,32,0.15)' : `1px solid ${theme.border}`,
              borderRadius: '10px',
            }}>
              <div style={{ width: '36px', fontSize: '12px', fontWeight: 700, color: isToday ? theme.orange : theme.textMuted }}>{d.dayName}</div>
              <div style={{ flex: 1 }}>
                <div style={{ height: '8px', background: 'rgba(255,255,255,0.04)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${Math.min((hrs / 10) * 100, 100)}%`,
                    background: hrs > 8 ? `linear-gradient(90deg, ${theme.navy} 80%, ${theme.warning})` : theme.navy,
                    borderRadius: '4px',
                  }} />
                </div>
              </div>
              <div style={{ width: '50px', textAlign: 'right', fontSize: '13px', fontWeight: 700, color: d.totalMs > 0 ? theme.textPrimary : theme.textMuted }}>
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
    <div style={{ background: theme.inputBg, borderRadius: '10px', padding: '8px 10px', textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: '9px', color: theme.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
    </div>
  );
}

function bigBtnStyle(bg: string): React.CSSProperties {
  return {
    width: '100%', borderRadius: '14px', border: 'none',
    background: bg, color: '#fff', fontWeight: 800, cursor: 'pointer',
    fontFamily: 'inherit', letterSpacing: '0.3px', transition: 'transform 0.1s',
  };
}
