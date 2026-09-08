'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

/**
 * Shop week planner (R5-16): the week as columns — what's arriving, what's
 * scheduled for upfit, what's promised back — with each day's sold labor
 * hours against crew capacity. Drag a vehicle to another day (or tap it,
 * then tap a day) and the REAL date moves: the same writes the inline date
 * editors make, so shop_inbound's auto-maintenance never fights the board.
 * Unknown sold hours stay visibly unknown — a day is never called "light"
 * just because its estimates aren't priced.
 */

interface WeekUnit {
  key: string;
  kind: 'arrival_project' | 'arrival_graphics' | 'arrival_manual' | 'upfit' | 'promised';
  id: string;
  label: string;
  customer: string | null;
  hours: number | null;
  needBack: string | null;
  vin: string | null;
}
interface WeekDay {
  day: string;
  units: WeekUnit[];
  demandHours: number;
  knownHours: number;
  totalUnits: number;
  capacityHours: number | null;
  overrideNote: string | null;
}
interface Week {
  start: string;
  days: WeekDay[];
  capacityConfigured: boolean;
  baseCapacityHours: number | null;
  inShopNow: number;
  coverage: { known: number; total: number };
}

const KIND_META: Record<WeekUnit['kind'], { label: string; color: string }> = {
  arrival_project: { label: 'Drop-off', color: '#60a5fa' },
  arrival_graphics: { label: 'Graphics', color: '#c084fc' },
  arrival_manual: { label: 'Arrival', color: '#f472b6' },
  upfit: { label: 'Upfit', color: '#fb923c' },
  promised: { label: 'Due back', color: '#4ade80' },
};

const TONE_COLORS: Record<string, string> = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444', none: 'var(--text-muted)' };

const toneOf = (demand: number, capacity: number | null): { tone: string; pct: number | null } => {
  if (capacity == null || capacity <= 0) return { tone: 'none', pct: null };
  const pct = Math.round((demand / capacity) * 100);
  if (demand === 0) return { tone: 'none', pct };
  return { tone: pct < 85 ? 'green' : pct <= 110 ? 'amber' : 'red', pct };
};

const shiftDay = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export default function ShopWeekPage() {
  const router = useRouter();
  const { isAdmin, isShopTech } = useAuth();
  useRequireFeature('schedule');
  const dialog = useDialog();
  const supabase = createClient();
  const canMove = isAdmin || isShopTech;

  const [week, setWeek] = useState<Week | null>(null);
  const [numDays, setNumDays] = useState<7 | 14>(7);
  const [start, setStart] = useState<string | null>(null); // null = this week (server default)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null); // unit key being written
  const [movePick, setMovePick] = useState<WeekUnit | null>(null); // tap-to-move selection
  const [dragKey, setDragKey] = useState<string | null>(null);

  const load = useCallback(async (s: string | null, d: number) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(d) });
      if (s) qs.set('start', s);
      const res = await fetch(`/api/shop-week?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setWeek(body);
    } catch (e: any) {
      setError(e?.message || 'Failed to load the week');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(start, numDays); }, [start, numDays, load]);

  /** The one rule of this board: a move writes the SOURCE date through the
   *  same path its inline editor uses, so every derived view (shop_inbound,
   *  Google Calendar, the schedule) follows on its own. */
  const moveUnit = async (unit: WeekUnit, fromDay: string, toDay: string) => {
    if (fromDay === toDay || moving) return;
    setMoving(unit.key);
    setMovePick(null);
    try {
      const stamp = new Date().toISOString();
      if (unit.kind === 'upfit') {
        const { error: err } = await supabase.from('fleet_checkins')
          .update({ scheduled_upfit_date: toDay, updated_at: stamp }).eq('id', unit.id);
        if (err) throw new Error(err.message);
        fetch('/api/calendar/sync-upfit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkinId: unit.id }),
        }).catch(() => {});
      } else if (unit.kind === 'promised') {
        const { error: err } = await supabase.from('fleet_checkins')
          .update({ promised_back_date: toDay, updated_at: stamp }).eq('id', unit.id);
        if (err) throw new Error(err.message);
      } else if (unit.kind === 'arrival_project') {
        // The project's drop-off date owns the inbound row — the PUT resyncs
        // shop_inbound itself; writing the inbound row directly would be
        // overwritten by the next maintenance pass.
        const res = await apiFetch('/api/upfit-projects', {
          method: 'PUT',
          body: JSON.stringify({ id: unit.id, customer_dropoff_date: toDay }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      } else if (unit.kind === 'arrival_graphics') {
        const { error: err } = await supabase.from('graphics_jobs')
          .update({ scheduled_install_date: toDay, updated_at: stamp }).eq('id', unit.id);
        if (err) throw new Error(err.message);
        fetch('/api/calendar/sync-graphics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: unit.id }),
        }).catch(() => {});
        // Await the inbound resync so the reload below sees the new date.
        await fetch('/api/shop-inbound', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceType: 'graphics_job', sourceId: unit.id }),
        }).catch(() => {});
      } else {
        const { error: err } = await supabase.from('shop_inbound')
          .update({ expected_date: toDay, updated_at: stamp }).eq('id', unit.id);
        if (err) throw new Error(err.message);
      }
      await load(start, numDays);
    } catch (e: any) {
      await dialog.alert(`Move failed: ${e?.message || 'unknown error'}`);
      await load(start, numDays);
    } finally {
      setMoving(null);
    }
  };

  const openUnit = (unit: WeekUnit) => {
    if (unit.kind === 'upfit' || unit.kind === 'promised') router.push(deepLinks.vehicle(unit.id));
    else if (unit.kind === 'arrival_project') router.push(deepLinks.upfitProject(unit.id));
    else if (unit.kind === 'arrival_graphics') router.push(deepLinks.graphicsJob(unit.id));
    // Manual arrivals have no record page of their own — the chip is the record.
  };

  const dayLabel = (day: string) => {
    const d = new Date(day + 'T12:00:00');
    return { wd: d.toLocaleDateString([], { weekday: 'short' }), md: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), weekend: [0, 6].includes(d.getDay()) };
  };
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const weekLabel = week
    ? `${new Date(week.start + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${new Date(shiftDay(week.start, numDays - 1) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';

  const findUnitDay = (key: string): { unit: WeekUnit; day: string } | null => {
    for (const d of week?.days || []) {
      const u = d.units.find(x => x.key === key);
      if (u) return { unit: u, day: d.day };
    }
    return null;
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Shop Week</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {week ? `${week.inShopNow} vehicle${week.inShopNow !== 1 ? 's' : ''} in the shop now` : ' '}
            {week && ` · sold hours known for ${week.coverage.known} of ${week.coverage.total} incoming`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Link href="/admin/schedule" style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '8px' }}>Calendar view</Link>
          {isAdmin && (
            <Link href="/settings" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textDecoration: 'none', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '8px' }}>Capacity settings</Link>
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          {([7, 14] as const).map(n => (
            <button key={n} onClick={() => setNumDays(n)} style={{
              padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: numDays === n ? 'var(--tab-active-bg)' : 'transparent',
              border: numDays === n ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: numDays === n ? 'var(--tab-active-color)' : 'var(--text-muted)', cursor: 'pointer',
            }}>{n} days</button>
          ))}
        </div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{weekLabel}</div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => week && setStart(shiftDay(week.start, -7))} style={{ padding: '5px 10px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>‹</button>
          <button onClick={() => setStart(null)} style={{ padding: '5px 8px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '10px', fontWeight: 700 }}>This week</button>
          <button onClick={() => week && setStart(shiftDay(week.start, 7))} style={{ padding: '5px 10px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>›</button>
        </div>
      </div>

      {/* Capacity + move-mode banners */}
      {week && !week.capacityConfigured && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--subtle-bg)', border: '1px dashed var(--border)', borderRadius: '8px', padding: '7px 10px', marginBottom: '10px' }}>
          Crew capacity isn&apos;t configured, so days show demand hours without a load color.
          {isAdmin ? ' Set crew size × shift hours in Settings → Shop Crew Capacity.' : ''}
        </div>
      )}
      {movePick && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', fontWeight: 700, color: '#60a5fa', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '8px', padding: '7px 10px', marginBottom: '10px' }}>
          <span>Moving “{movePick.label}” — tap a day to place it.</span>
          <button onClick={() => setMovePick(null)} style={{ fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa', borderRadius: '5px', padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}
      {error && <div style={{ fontSize: '12px', color: '#ef4444', marginBottom: '10px' }}>{error}</div>}
      {loading && !week && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '20px 0' }}>Loading the week…</div>}

      {/* Day columns */}
      {week && (
        <div style={{ overflowX: 'auto', paddingBottom: '6px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${numDays}, minmax(160px, 1fr))`, gap: '6px', minWidth: `${numDays * 168}px` }}>
            {week.days.map(d => {
              const { wd, md, weekend } = dayLabel(d.day);
              const isToday = d.day === todayStr;
              const { tone, pct } = toneOf(d.demandHours, d.capacityHours);
              const unknownCount = d.totalUnits - d.knownHours;
              const droppable = canMove && (dragKey != null || movePick != null);
              return (
                <div
                  key={d.day}
                  onDragOver={e => { if (droppable) e.preventDefault(); }}
                  onDrop={e => {
                    if (!canMove) return;
                    e.preventDefault();
                    const key = e.dataTransfer.getData('text/plain') || dragKey;
                    setDragKey(null);
                    const found = key ? findUnitDay(key) : null;
                    if (found) moveUnit(found.unit, found.day, d.day);
                  }}
                  onClick={() => { if (movePick) { const found = findUnitDay(movePick.key); if (found) moveUnit(found.unit, found.day, d.day); } }}
                  style={{
                    background: isToday ? 'rgba(59,130,246,0.04)' : 'var(--card)',
                    border: `1px solid ${movePick ? 'rgba(59,130,246,0.35)' : isToday ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                    borderRadius: '10px', padding: '8px', minHeight: '120px',
                    opacity: weekend && d.units.length === 0 ? 0.6 : 1,
                    cursor: movePick ? 'copy' : 'default',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: isToday ? '#3b82f6' : 'var(--text-primary)', textTransform: 'uppercase' }}>{wd}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{md}</span>
                  </div>

                  {/* Load bar */}
                  <div title={d.overrideNote ? `Capacity override: ${d.overrideNote}` : undefined} style={{ marginBottom: '6px' }}>
                    <div style={{ height: '6px', borderRadius: '3px', background: 'var(--subtle-bg)', overflow: 'hidden' }}>
                      {pct != null && pct > 0 && (
                        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: TONE_COLORS[tone], borderRadius: '3px' }} />
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '3px' }}>
                      <span style={{ fontSize: '9px', fontWeight: 700, color: tone === 'none' ? 'var(--text-muted)' : TONE_COLORS[tone] }}>
                        {d.demandHours > 0 ? `${d.demandHours}h` : d.totalUnits > 0 ? '?h' : '—'}
                        {d.capacityHours != null ? ` / ${d.capacityHours}h` : ''}
                        {pct != null && d.demandHours > 0 ? ` · ${pct}%` : ''}
                      </span>
                      {unknownCount > 0 && (
                        <span title={`${unknownCount} vehicle${unknownCount !== 1 ? 's' : ''} with no priced estimate — real demand is higher than the bar`} style={{ fontSize: '9px', fontWeight: 700, color: '#f59e0b' }}>+{unknownCount} unpriced</span>
                      )}
                      {d.overrideNote && unknownCount === 0 && (
                        <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{d.overrideNote}</span>
                      )}
                    </div>
                  </div>

                  {/* Units */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {d.units.map(u => {
                      const meta = KIND_META[u.kind];
                      const busy = moving === u.key;
                      const picked = movePick?.key === u.key;
                      return (
                        <div
                          key={u.key}
                          draggable={canMove && !busy}
                          onDragStart={e => { e.dataTransfer.setData('text/plain', u.key); e.dataTransfer.effectAllowed = 'move'; setDragKey(u.key); }}
                          onDragEnd={() => setDragKey(null)}
                          onClick={e => {
                            e.stopPropagation();
                            if (!canMove) { openUnit(u); return; }
                            setMovePick(picked ? null : u);
                          }}
                          style={{
                            padding: '5px 7px', borderRadius: '6px',
                            background: `${meta.color}10`,
                            border: picked ? `1px solid ${meta.color}` : undefined,
                            borderLeft: `3px solid ${meta.color}`,
                            opacity: busy ? 0.5 : 1,
                            cursor: canMove ? 'grab' : 'pointer',
                            outline: u.kind === 'promised' ? `1px dashed ${meta.color}55` : undefined,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.label}</span>
                            <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 4px', borderRadius: '3px', background: `${meta.color}18`, color: meta.color, whiteSpace: 'nowrap' }}>{meta.label}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1px', gap: '4px' }}>
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.customer || ''}</span>
                            <span style={{ display: 'flex', gap: '5px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                              {u.kind !== 'promised' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, color: u.hours != null ? 'var(--text-body)' : '#f59e0b' }}>
                                  {u.hours != null ? `${u.hours}h` : 'no est'}
                                </span>
                              )}
                              {(u.kind === 'upfit' || u.kind === 'promised' || u.kind === 'arrival_project' || u.kind === 'arrival_graphics') && (
                                <button
                                  onClick={e => { e.stopPropagation(); openUnit(u); }}
                                  title="Open record"
                                  style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '10px', padding: 0, fontWeight: 700 }}
                                >↗</button>
                              )}
                            </span>
                          </div>
                          {u.needBack && u.kind !== 'promised' && (
                            <div style={{ fontSize: '8.5px', color: 'var(--text-muted)', marginTop: '1px' }}>
                              back {new Date(u.needBack + 'T12:00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric' })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {d.units.length === 0 && <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
        {(Object.keys(KIND_META) as WeekUnit['kind'][]).map(k => (
          <span key={k} style={{ fontSize: '9px', fontWeight: 700, color: KIND_META[k].color }}>■ {KIND_META[k].label}</span>
        ))}
        <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
          {canMove ? 'Drag a vehicle to another day, or tap it and tap a day. Due-back cards move the promise date.' : 'Read-only — ask a shop lead to move dates.'}
        </span>
      </div>
    </div>
  );
}
