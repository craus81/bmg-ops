'use client';

/**
 * Shop Board — the one place to see what's headed to the shop and when it
 * has to leave. Feeds:
 *   - shop_inbound: expected arrivals (graphics jobs installing at our
 *     shop, upfit projects with a drop-off date, manual walk-ins)
 *   - fleet_checkins: vehicles currently on site + promised-back dates
 * List view for working the day; calendar view for the month at a glance.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

const IN_SHOP_STATUSES = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];

interface InboundRow {
  id: string;
  source_type: 'graphics_job' | 'upfit_project' | 'manual';
  source_id: string;
  vehicle_desc: string | null;
  customer_name: string | null;
  work_summary: string | null;
  expected_date: string | null;
  need_back_date: string | null;
  status: 'expected' | 'arrived' | 'cancelled';
  created_at: string;
}

interface CheckinRow {
  id: string;
  vin: string | null;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  customer_name: string | null;
  status: string;
  promised_back_date: string | null;
  created_at: string;
}

const SOURCE_BADGES: Record<InboundRow['source_type'], { label: string; color: string }> = {
  graphics_job: { label: 'Graphics', color: '#a78bfa' },
  upfit_project: { label: 'Upfit', color: '#fb923c' },
  manual: { label: 'Manual', color: '#94a3b8' },
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmt = (d: string | null) => {
  if (!d) return '—';
  const dt = new Date(`${d.slice(0, 10)}T12:00:00`);
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const weekday = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short' });

const checkinTitle = (v: CheckinRow) =>
  [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || v.vin || 'Vehicle';

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' };
const sectionTitle: React.CSSProperties = { fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' };
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' };

export default function ShopBoardPage() {
  const router = useRouter();
  const supabase = createClient();
  const { user } = useAuth();

  const [inbound, setInbound] = useState<InboundRow[]>([]);
  const [onSite, setOnSite] = useState<CheckinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });

  // Manual "expected vehicle" form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ vehicle_desc: '', customer_name: '', work_summary: '', expected_date: '', need_back_date: '' });
  const [addSaving, setAddSaving] = useState(false);

  const load = useCallback(async () => {
    const [inboundRes, checkinRes] = await Promise.all([
      supabase.from('shop_inbound').select('*').neq('status', 'cancelled').order('expected_date', { ascending: true, nullsFirst: false }),
      supabase.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, promised_back_date, created_at')
        .in('status', IN_SHOP_STATUSES)
        .order('created_at', { ascending: false }),
    ]);
    setInbound((inboundRes.data as InboundRow[]) || []);
    setOnSite((checkinRes.data as CheckinRow[]) || []);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => { load(); }, [load]);

  const today = todayStr();
  const weekOut = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  const expected = inbound.filter(r => r.status === 'expected');
  const overdue = expected.filter(r => r.expected_date && r.expected_date < today);
  const arrivingToday = expected.filter(r => r.expected_date === today);
  const thisWeek = expected.filter(r => r.expected_date && r.expected_date > today && r.expected_date <= weekOut);
  const later = expected.filter(r => !r.expected_date || r.expected_date > weekOut);

  const backOverdue = onSite.filter(v => v.promised_back_date && v.promised_back_date < today);
  const backThisWeek = onSite.filter(v => v.promised_back_date && v.promised_back_date >= today && v.promised_back_date <= weekOut);

  const markArrived = async (row: InboundRow) => {
    setInbound(prev => prev.map(r => r.id === row.id ? { ...r, status: 'arrived' } : r));
    await supabase.from('shop_inbound').update({ status: 'arrived', updated_at: new Date().toISOString() }).eq('id', row.id);
  };

  const cancelRow = async (row: InboundRow) => {
    setInbound(prev => prev.filter(r => r.id !== row.id));
    await supabase.from('shop_inbound').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', row.id);
  };

  const openSource = (row: InboundRow) => {
    if (row.source_type === 'graphics_job') router.push(`/graphics?id=${row.source_id}`);
    else if (row.source_type === 'upfit_project') router.push('/upfit');
  };

  const addManual = async () => {
    if (!addForm.vehicle_desc.trim() || addSaving) return;
    setAddSaving(true);
    const { error } = await supabase.from('shop_inbound').insert({
      source_type: 'manual',
      vehicle_desc: addForm.vehicle_desc.trim(),
      customer_name: addForm.customer_name.trim() || null,
      work_summary: addForm.work_summary.trim() || null,
      expected_date: addForm.expected_date || null,
      need_back_date: addForm.need_back_date || null,
      status: 'expected',
      created_by: user?.id || null,
    });
    if (!error) {
      setAddForm({ vehicle_desc: '', customer_name: '', work_summary: '', expected_date: '', need_back_date: '' });
      setShowAdd(false);
      load();
    }
    setAddSaving(false);
  };

  const InboundList = ({ rows, tone }: { rows: InboundRow[]; tone?: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map(r => {
        const badge = SOURCE_BADGES[r.source_type];
        return (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px', borderRadius: '10px', background: 'var(--input-bg)', border: `1px solid ${tone || 'var(--border)'}` }}>
            <div style={{ flex: 1, minWidth: 0, cursor: r.source_type !== 'manual' ? 'pointer' : 'default' }} onClick={() => openSource(r)}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {r.vehicle_desc || 'Vehicle'}
                <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: `${badge.color}20`, color: badge.color }}>{badge.label}</span>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {[r.customer_name, r.work_summary].filter(Boolean).join(' · ')}
              </div>
              <div style={{ fontSize: '10px', marginTop: '2px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ color: tone || 'var(--text-secondary)', fontWeight: 700 }}>
                  {r.expected_date ? `${weekday(r.expected_date)} ${fmt(r.expected_date)}` : 'No date yet'}
                </span>
                {r.need_back_date && <span style={{ color: '#fbbf24' }}>back by {fmt(r.need_back_date)}</span>}
              </div>
            </div>
            <button onClick={() => markArrived(r)} style={{ flexShrink: 0, padding: '6px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '10px', fontWeight: 800, cursor: 'pointer' }}>
              Arrived ✓
            </button>
            <button onClick={() => cancelRow(r)} title="Remove from schedule" style={{ flexShrink: 0, padding: '6px 8px', borderRadius: '8px', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );

  // ── Calendar view ──
  const calDays = (() => {
    const first = new Date(calMonth.y, calMonth.m, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay()); // back to Sunday
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  })();
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const arrivalsByDay = new Map<string, InboundRow[]>();
  for (const r of expected) {
    if (!r.expected_date) continue;
    const k = r.expected_date.slice(0, 10);
    if (!arrivalsByDay.has(k)) arrivalsByDay.set(k, []);
    arrivalsByDay.get(k)!.push(r);
  }
  const backsByDay = new Map<string, CheckinRow[]>();
  for (const v of onSite) {
    if (!v.promised_back_date) continue;
    const k = v.promised_back_date.slice(0, 10);
    if (!backsByDay.has(k)) backsByDay.set(k, []);
    backsByDay.get(k)!.push(v);
  }

  return (
    <div style={{ padding: '16px', maxWidth: '860px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Shop Board</h1>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>What&apos;s coming, what&apos;s here, what&apos;s going back</div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => setView(v => v === 'list' ? 'calendar' : 'list')} style={{ padding: '7px 12px', borderRadius: '8px', background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
            {view === 'list' ? '📅 Calendar' : '☰ List'}
          </button>
          <button onClick={() => setShowAdd(s => !s)} style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
            + Expected Vehicle
          </button>
        </div>
      </div>

      {/* Manual add */}
      {showAdd && (
        <div style={card}>
          <div style={sectionTitle}>Add Expected Vehicle</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', marginBottom: '8px' }}>
            <input style={inputStyle} placeholder="Vehicle (e.g. 2025 Transit 250)" value={addForm.vehicle_desc} onChange={e => setAddForm({ ...addForm, vehicle_desc: e.target.value })} />
            <input style={inputStyle} placeholder="Customer" value={addForm.customer_name} onChange={e => setAddForm({ ...addForm, customer_name: e.target.value })} />
            <input style={inputStyle} placeholder="Work (e.g. shelving + decals)" value={addForm.work_summary} onChange={e => setAddForm({ ...addForm, work_summary: e.target.value })} />
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>EXPECTED</div>
              <input type="date" style={inputStyle} value={addForm.expected_date} onChange={e => setAddForm({ ...addForm, expected_date: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>NEEDS IT BACK</div>
              <input type="date" style={inputStyle} value={addForm.need_back_date} onChange={e => setAddForm({ ...addForm, need_back_date: e.target.value })} />
            </div>
          </div>
          <button onClick={addManual} disabled={addSaving || !addForm.vehicle_desc.trim()} style={{ padding: '8px 16px', borderRadius: '8px', background: '#3b82f6', border: 'none', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: addSaving || !addForm.vehicle_desc.trim() ? 0.5 : 1 }}>
            {addSaving ? 'Adding…' : 'Add to Schedule'}
          </button>
        </div>
      )}

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '8px', marginBottom: '14px' }}>
        {[
          { label: 'Overdue In', value: overdue.length, color: overdue.length > 0 ? '#ef4444' : 'var(--text-muted)' },
          { label: 'Today', value: arrivingToday.length, color: arrivingToday.length > 0 ? '#38bdf8' : 'var(--text-muted)' },
          { label: 'This Week', value: thisWeek.length, color: thisWeek.length > 0 ? '#60a5fa' : 'var(--text-muted)' },
          { label: 'On Site', value: onSite.length, color: '#22c55e' },
          { label: 'Overdue Back', value: backOverdue.length, color: backOverdue.length > 0 ? '#ef4444' : 'var(--text-muted)' },
          { label: 'Back This Wk', value: backThisWeek.length, color: backThisWeek.length > 0 ? '#fbbf24' : 'var(--text-muted)' },
        ].map(t => (
          <div key={t.label} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 6px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, color: t.color }}>{t.value}</div>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{t.label}</div>
          </div>
        ))}
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>Loading…</div>}

      {!loading && view === 'calendar' && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button onClick={() => setCalMonth(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '16px', cursor: 'pointer' }}>‹</button>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {new Date(calMonth.y, calMonth.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </div>
            <button onClick={() => setCalMonth(({ y, m }) => m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 })} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '16px', cursor: 'pointer' }}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '3px' }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} style={{ fontSize: '9px', fontWeight: 800, color: 'var(--text-muted)', textAlign: 'center', padding: '2px 0' }}>{d}</div>
            ))}
            {calDays.map((d, i) => {
              const k = dayKey(d);
              const inMonth = d.getMonth() === calMonth.m;
              const isToday = k === today;
              const arr = arrivalsByDay.get(k) || [];
              const backs = backsByDay.get(k) || [];
              return (
                <div key={i} style={{
                  minHeight: '58px', borderRadius: '6px', padding: '3px',
                  background: isToday ? 'rgba(59,130,246,0.10)' : 'var(--input-bg)',
                  border: `1px solid ${isToday ? 'rgba(59,130,246,0.45)' : 'var(--border)'}`,
                  opacity: inMonth ? 1 : 0.35,
                }}>
                  <div style={{ fontSize: '9px', fontWeight: 800, color: isToday ? '#60a5fa' : 'var(--text-muted)' }}>{d.getDate()}</div>
                  {arr.map(r => (
                    <div key={r.id} title={`Arriving: ${r.vehicle_desc || 'vehicle'}${r.customer_name ? ` — ${r.customer_name}` : ''}`} style={{ fontSize: '8px', fontWeight: 700, color: '#38bdf8', background: 'rgba(56,189,248,0.12)', borderRadius: '3px', padding: '1px 3px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ↓ {r.vehicle_desc || 'Vehicle'}
                    </div>
                  ))}
                  {backs.map(v => (
                    <div key={v.id} title={`Promised back: ${checkinTitle(v)}${v.customer_name ? ` — ${v.customer_name}` : ''}`} style={{ fontSize: '8px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', borderRadius: '3px', padding: '1px 3px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ↑ {checkinTitle(v)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: '14px', marginTop: '8px', fontSize: '9px', fontWeight: 700 }}>
            <span style={{ color: '#38bdf8' }}>↓ arriving</span>
            <span style={{ color: '#fbbf24' }}>↑ promised back</span>
          </div>
        </div>
      )}

      {!loading && view === 'list' && (
        <>
          {overdue.length > 0 && (
            <div style={{ ...card, border: '1px solid rgba(239,68,68,0.4)' }}>
              <div style={{ ...sectionTitle, color: '#ef4444' }}>Overdue — expected but not arrived</div>
              <InboundList rows={overdue} tone="#ef4444" />
            </div>
          )}
          {arrivingToday.length > 0 && (
            <div style={card}>
              <div style={{ ...sectionTitle, color: '#38bdf8' }}>Arriving Today</div>
              <InboundList rows={arrivingToday} tone="#38bdf8" />
            </div>
          )}
          <div style={card}>
            <div style={sectionTitle}>Arriving This Week ({thisWeek.length})</div>
            {thisWeek.length === 0
              ? <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Nothing scheduled for the next 7 days.</div>
              : <InboundList rows={thisWeek} />}
          </div>
          {later.length > 0 && (
            <div style={card}>
              <div style={sectionTitle}>Further Out / No Date ({later.length})</div>
              <InboundList rows={later} />
            </div>
          )}

          {/* On site */}
          <div style={card}>
            <div style={sectionTitle}>On Site ({onSite.length})</div>
            {onSite.length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No vehicles in the shop.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {[...onSite].sort((a, b) => (a.promised_back_date || '9999') < (b.promised_back_date || '9999') ? -1 : 1).map(v => {
                const isLate = !!v.promised_back_date && v.promised_back_date < today;
                const soon = !!v.promised_back_date && !isLate && v.promised_back_date <= weekOut;
                return (
                  <div key={v.id} onClick={() => router.push('/tracking')} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px', borderRadius: '10px', background: 'var(--input-bg)', border: `1px solid ${isLate ? 'rgba(239,68,68,0.5)' : 'var(--border)'}`, cursor: 'pointer' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{checkinTitle(v)}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{v.customer_name || ''}</div>
                    </div>
                    {v.promised_back_date && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: isLate ? '#ef4444' : soon ? '#fbbf24' : 'var(--text-muted)', flexShrink: 0 }}>
                        {isLate ? `was due back ${fmt(v.promised_back_date)}` : `back by ${weekday(v.promised_back_date)} ${fmt(v.promised_back_date)}`}
                      </span>
                    )}
                    <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '5px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', flexShrink: 0 }}>
                      {v.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                );
              })}
            </div>
            <button onClick={() => router.push('/tracking?checkin=1')} style={{ marginTop: '10px', padding: '8px 14px', borderRadius: '8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
              Check In a Vehicle →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
