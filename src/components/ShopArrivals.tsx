'use client';

/**
 * The arrival schedule, embedded at the top of the In-Shop page: what's
 * expected at the shop (from graphics jobs installing here, upfit drop-off
 * dates, and manual walk-ins), with a month-calendar view that also shows
 * promised-back dates. This used to be the separate Shop Board tab —
 * merged so the whole vehicle lifecycle lives on one screen.
 *
 * One row per van (arrival-groups.ts): a van's graphics job, sales order
 * and upfit show as tags on a single row dated by its drop-off, and
 * Arrived / ✕ close every one of them.
 *
 * Tapping "Arriving" folds the box down to its header (Craig, 2026-10-26),
 * saved per user like the customer page cards ('inshop:arriving'). The
 * overdue/today counts and red border stay visible while folded.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { deepLinks } from '@/lib/deep-links';
import { IN_SHOP_STATUSES } from '@/lib/types';
import { useAuth } from '@/components/AuthProvider';
import { useCollapsed } from '@/components/CollapsibleCard';
import { groupArrivals, loadArrivalLinks, rowsToClose, type ArrivalGroup, type ArrivalLinks } from '@/lib/arrival-groups';

interface InboundRow {
  id: string;
  source_type: 'graphics_job' | 'upfit_project' | 'manual' | 'sales_order';
  source_id: string | null;
  vehicle_desc: string | null;
  customer_name: string | null;
  work_summary: string | null;
  expected_date: string | null;
  need_back_date: string | null;
  status: 'expected' | 'arrived' | 'cancelled';
  netsuite_so_number?: string | null;
  vin?: string | null;
}

interface BackRow {
  id: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vin: string | null;
  customer_name: string | null;
  promised_back_date: string | null;
}

const SOURCE_BADGES: Record<InboundRow['source_type'], { label: string; color: string }> = {
  graphics_job: { label: 'Graphics', color: '#a78bfa' },
  upfit_project: { label: 'Upfit', color: '#fb923c' },
  manual: { label: 'Manual', color: '#94a3b8' },
  sales_order: { label: 'Sales Order', color: '#2dd4bf' },
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmt = (d: string | null) => {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const weekday = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short' });

const inputStyle: React.CSSProperties = { boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' };

export default function ShopArrivals() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useCollapsed('inshop', 'arriving');
  // A ping link (?arrival=) opens a folded box for this visit without
  // changing the saved choice.
  const [peek, setPeek] = useState(false);
  const folded = collapsed && !peek;

  const [inbound, setInbound] = useState<InboundRow[]>([]);
  const [links, setLinks] = useState<ArrivalLinks>({ graphicsEstimate: new Map(), upfitEstimate: new Map() });
  const [backs, setBacks] = useState<BackRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ vehicle_desc: '', customer_name: '', work_summary: '', expected_date: '', need_back_date: '' });
  const [addSaving, setAddSaving] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [arrivalNotice, setArrivalNotice] = useState<string | null>(null);
  const landedRef = useRef(false);

  const load = useCallback(async () => {
    const [inboundRes, backRes] = await Promise.all([
      supabase.from('shop_inbound').select('*').eq('status', 'expected').order('expected_date', { ascending: true, nullsFirst: false }),
      supabase.from('fleet_checkins')
        .select('id, vehicle_year, vehicle_make, vehicle_model, vin, customer_name, promised_back_date')
        .in('status', IN_SHOP_STATUSES)
        .not('promised_back_date', 'is', null),
    ]);
    const rows = (inboundRes.data as InboundRow[]) || [];
    // Which estimate each graphics job / upfit came from — how the list
    // knows two rows are the same van. Best-effort: without it rows just
    // stay separate, as before.
    try { setLinks(await loadArrivalLinks(supabase, rows)); } catch { /* keep rows separate */ }
    setInbound(rows);
    setBacks((backRes.data as BackRow[]) || []);
    setLoaded(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => { load(); }, [load]);

  // ?arrival= (deepLinks.shopArrival) — the landing for arrival pings. The
  // row has usually already flipped to 'arrived' by the time anyone clicks,
  // so it won't be in the expected list: fetch its fate and say so instead
  // of landing on nothing. Still-expected rows scroll-flash.
  useEffect(() => {
    if (!loaded || landedRef.current) return;
    const target = searchParams.get('arrival');
    if (!target) return;
    landedRef.current = true;
    // The row may be folded into its van's line — flash that line.
    const group = groupArrivals(inbound, links).find(g => g.rows.some(r => r.id === target));
    if (group) {
      setPeek(true);
      setFlashId(group.key);
      setTimeout(() => {
        document.getElementById(`arr-${group.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      setTimeout(() => setFlashId(null), 3500);
      return;
    }
    (async () => {
      try {
        const { data: row } = await supabase
          .from('shop_inbound')
          .select('vehicle_desc, customer_name, status, fleet_checkin_id')
          .eq('id', target)
          .maybeSingle();
        if (!row) { setArrivalNotice('That arrival row no longer exists.'); return; }
        const label = [row.vehicle_desc, row.customer_name].filter(Boolean).join(' — ') || 'That vehicle';
        if (row.fleet_checkin_id) {
          setArrivalNotice(`${label} arrived and is checked in — it's on the board below.`);
        } else if (row.status === 'arrived') {
          setArrivalNotice(`${label} arrived (marked on this board) — no formal check-in yet.`);
        } else if (row.status === 'cancelled') {
          setArrivalNotice(`${label}: that expected arrival was cancelled.`);
        }
      } catch { /* banner is best-effort */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot landing; supabase is a stable singleton
  }, [loaded, inbound, links, searchParams]);

  const today = todayStr();
  const weekOut = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  const groups = useMemo(() => groupArrivals(inbound, links), [inbound, links]);
  const overdue = groups.filter(g => g.arrivalDate && g.arrivalDate < today);
  const arrivingToday = groups.filter(g => g.arrivalDate === today);
  const thisWeek = groups.filter(g => g.arrivalDate && g.arrivalDate > today && g.arrivalDate <= weekOut);
  const later = groups.filter(g => !g.arrivalDate || g.arrivalDate > weekOut);

  const markArrived = async (group: ArrivalGroup<InboundRow>) => {
    const closing = rowsToClose(group, groups).map(r => r.id);
    setInbound(prev => prev.filter(r => !closing.includes(r.id)));
    // Through the arrival route (audit items 14+15): it back-links any
    // active check-in onto fleet_checkin_id, closes the van's other rows
    // and sends ONE arrival notification server-side. Optimistic removal
    // stands even if the call fails — the row can be re-marked from a
    // refreshed board.
    try {
      await fetch('/api/shop-inbound/arrival', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inboundId: group.lead.id }),
      });
    } catch {
      await supabase.from('shop_inbound').update({ status: 'arrived', updated_at: new Date().toISOString() }).in('id', closing).eq('status', 'expected');
    }
  };
  const cancelGroup = async (group: ArrivalGroup<InboundRow>) => {
    const closing = rowsToClose(group, groups).map(r => r.id);
    setInbound(prev => prev.filter(r => !closing.includes(r.id)));
    await supabase.from('shop_inbound').update({ status: 'cancelled', updated_at: new Date().toISOString() }).in('id', closing).eq('status', 'expected');
  };
  const openSource = (row: InboundRow) => {
    if (!row.source_id) return;
    if (row.source_type === 'graphics_job') router.push(deepLinks.graphicsJob(row.source_id));
    else if (row.source_type === 'upfit_project') router.push(deepLinks.upfitProject(row.source_id));
    else if (row.source_type === 'sales_order') router.push(deepLinks.estimate(row.source_id));
  };
  const tagLabel = (r: InboundRow) =>
    r.source_type === 'sales_order' && r.netsuite_so_number ? `SO #${r.netsuite_so_number}` : SOURCE_BADGES[r.source_type].label;

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

  const Group = ({ rows, tone }: { rows: ArrivalGroup<InboundRow>[]; tone?: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map(g => {
        const r = g.lead;
        const flashing = flashId === g.key;
        const work = g.rows.length === 1 ? r.work_summary : null;
        return (
          <div key={g.key} id={`arr-${g.key}`} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 11px', borderRadius: '10px', background: flashing ? 'rgba(96,165,250,0.14)' : 'var(--input-bg)', border: `1px solid ${flashing ? 'rgba(96,165,250,0.6)' : (tone || 'var(--border)')}`, transition: 'background 0.6s, border-color 0.6s' }}>
            <div style={{ flex: 1, minWidth: 0, cursor: g.rows.length === 1 && r.source_type !== 'manual' ? 'pointer' : 'default' }} onClick={() => { if (g.rows.length === 1) openSource(r); }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {r.vehicle_desc || 'Vehicle'}
                {g.rows.map(x => {
                  const badge = SOURCE_BADGES[x.source_type];
                  return (
                    <span key={x.id}
                      onClick={e => { e.stopPropagation(); openSource(x); }}
                      title={x.source_type === 'manual' ? undefined : `Open this ${badge.label.toLowerCase()}`}
                      style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: `${badge.color}20`, color: badge.color, cursor: x.source_type === 'manual' ? 'default' : 'pointer' }}>
                      {tagLabel(x)}
                    </span>
                  );
                })}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {[r.customer_name, work].filter(Boolean).join(' · ')}
              </div>
              <div style={{ fontSize: '10px', marginTop: '2px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ color: tone || 'var(--text-secondary)', fontWeight: 700 }}>
                  {g.arrivalDate
                    ? `${g.hasDropoff ? 'Drops off' : 'Graphics install'} ${weekday(g.arrivalDate)} ${fmt(g.arrivalDate)}`
                    : 'No date yet'}
                </span>
                {g.hasDropoff && g.installs.map(i => (
                  <span key={i.row.id} style={{ color: SOURCE_BADGES.graphics_job.color }}>Graphics install {weekday(i.date)} {fmt(i.date)}</span>
                ))}
                {g.needBack && <span style={{ color: '#fbbf24' }}>back by {fmt(g.needBack)}</span>}
              </div>
              {g.installBeforeArrival && g.arrivalDate && (
                <div style={{ fontSize: '10px', fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.10)', borderRadius: '6px', padding: '3px 7px', marginTop: '4px' }}>
                  Graphics install ({fmt(g.installs[0].date)}) is before the van arrives ({fmt(g.arrivalDate)})
                </div>
              )}
            </div>
            <button onClick={() => markArrived(g)} title={g.rows.length > 1 ? 'Mark this vehicle as arrived — clears every job for it off the arrival schedule' : 'Mark this vehicle as arrived — clears it off the arrival schedule'} style={{ flexShrink: 0, padding: '6px 10px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: '10px', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Mark Arrived
            </button>
            <button onClick={() => cancelGroup(g)} title="Remove from schedule" style={{ flexShrink: 0, padding: '6px 8px', borderRadius: '8px', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );

  // Calendar plumbing
  const calDays = (() => {
    const first = new Date(calMonth.y, calMonth.m, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  })();
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // A van shows as arriving once, on its arrival day; graphics installs on
  // other days show as work on that day, not a second arrival.
  const arrivalsByDay = new Map<string, ArrivalGroup<InboundRow>[]>();
  const installsByDay = new Map<string, ArrivalGroup<InboundRow>[]>();
  for (const g of groups) {
    if (g.arrivalDate) {
      if (!arrivalsByDay.has(g.arrivalDate)) arrivalsByDay.set(g.arrivalDate, []);
      arrivalsByDay.get(g.arrivalDate)!.push(g);
    }
    for (const i of g.installs) {
      if (i.date === g.arrivalDate) continue;
      if (!installsByDay.has(i.date)) installsByDay.set(i.date, []);
      installsByDay.get(i.date)!.push(g);
    }
  }
  const backsByDay = new Map<string, BackRow[]>();
  for (const v of backs) {
    if (!v.promised_back_date) continue;
    const k = v.promised_back_date.slice(0, 10);
    if (!backsByDay.has(k)) backsByDay.set(k, []);
    backsByDay.get(k)!.push(v);
  }
  const backTitle = (v: BackRow) => [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || v.vin || 'Vehicle';

  if (!loaded) return null;

  const counts = [
    overdue.length > 0 && `${overdue.length} overdue`,
    arrivingToday.length > 0 && `${arrivingToday.length} today`,
    thisWeek.length > 0 && `${thisWeek.length} this week`,
  ].filter(Boolean).join(' · ');

  return (
    <div style={{ background: 'var(--card)', border: `1px solid ${overdue.length > 0 ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`, borderRadius: '14px', marginBottom: '14px', padding: '12px 14px' }}>
      {arrivalNotice && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '9px 12px', marginBottom: '10px', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: '10px' }}>
          <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-body)' }}>{arrivalNotice}</div>
          <button onClick={() => setArrivalNotice(null)} title="Dismiss"
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '12px', padding: 0 }}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
        <button
          type="button"
          onClick={() => { setPeek(false); setCollapsed(!folded); }}
          aria-expanded={!folded}
          title={folded ? 'Show the arrival schedule' : 'Hide the arrival schedule — stays hidden next time'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', padding: '4px 0', margin: '-4px 0', cursor: 'pointer', textAlign: 'left', fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}
        >
          <span aria-hidden style={{ fontSize: '10px', width: '10px', display: 'inline-block', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: folded ? 'rotate(-90deg)' : 'none' }}>▾</span>
          <span>
            Arriving{counts ? <span style={{ color: overdue.length > 0 ? '#ef4444' : 'var(--text-muted)', fontWeight: 700 }}> — {counts}</span> : <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> — nothing scheduled</span>}
          </span>
        </button>
        {!folded && <span style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => setView(v => v === 'list' ? 'calendar' : 'list')} style={{ padding: '5px 10px', borderRadius: '7px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
            {view === 'list' ? 'Calendar' : 'List'}
          </button>
          <button onClick={() => setShowAdd(s => !s)} style={{ padding: '5px 10px', borderRadius: '7px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
            + Expected
          </button>
        </span>}
      </div>

      {!folded && showAdd && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginBottom: '8px' }}>
            <input style={inputStyle} placeholder="Vehicle (e.g. 2025 Transit 250)" value={addForm.vehicle_desc} onChange={e => setAddForm({ ...addForm, vehicle_desc: e.target.value })} />
            <input style={inputStyle} placeholder="Customer" value={addForm.customer_name} onChange={e => setAddForm({ ...addForm, customer_name: e.target.value })} />
            <input style={inputStyle} placeholder="Work (e.g. shelving + decals)" value={addForm.work_summary} onChange={e => setAddForm({ ...addForm, work_summary: e.target.value })} />
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>EXPECTED</div>
              <input type="date" style={{ ...inputStyle, width: '100%' }} value={addForm.expected_date} onChange={e => setAddForm({ ...addForm, expected_date: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>NEEDS IT BACK</div>
              <input type="date" style={{ ...inputStyle, width: '100%' }} value={addForm.need_back_date} onChange={e => setAddForm({ ...addForm, need_back_date: e.target.value })} />
            </div>
          </div>
          <button onClick={addManual} disabled={addSaving || !addForm.vehicle_desc.trim()} style={{ padding: '7px 14px', borderRadius: '8px', background: '#3b82f6', border: 'none', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: addSaving || !addForm.vehicle_desc.trim() ? 0.5 : 1 }}>
            {addSaving ? 'Adding…' : 'Add to Schedule'}
          </button>
        </div>
      )}

      {!folded && view === 'list' && groups.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
          {overdue.length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: 800, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px' }}>Overdue — expected but not arrived</div>
              <Group rows={overdue} tone="#ef4444" />
            </div>
          )}
          {arrivingToday.length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: 800, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px' }}>Today</div>
              <Group rows={arrivingToday} tone="#38bdf8" />
            </div>
          )}
          {thisWeek.length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px' }}>This Week</div>
              <Group rows={thisWeek} />
            </div>
          )}
          {later.length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px' }}>Further Out / No Date</div>
              <Group rows={later} />
            </div>
          )}
        </div>
      )}

      {!folded && view === 'calendar' && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <button onClick={() => setCalMonth(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '16px', cursor: 'pointer' }}>‹</button>
            <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>
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
              const inst = installsByDay.get(k) || [];
              const back = backsByDay.get(k) || [];
              return (
                <div key={i} style={{
                  minHeight: '54px', borderRadius: '6px', padding: '3px',
                  background: isToday ? 'rgba(59,130,246,0.10)' : 'var(--input-bg)',
                  border: `1px solid ${isToday ? 'rgba(59,130,246,0.45)' : 'var(--border)'}`,
                  opacity: inMonth ? 1 : 0.35,
                }}>
                  <div style={{ fontSize: '9px', fontWeight: 800, color: isToday ? '#60a5fa' : 'var(--text-muted)' }}>{d.getDate()}</div>
                  {arr.map(g => (
                    <div key={g.key} title={`Arriving: ${g.lead.vehicle_desc || 'vehicle'}${g.lead.customer_name ? ` — ${g.lead.customer_name}` : ''}`} style={{ fontSize: '8px', fontWeight: 700, color: '#38bdf8', background: 'rgba(56,189,248,0.12)', borderRadius: '3px', padding: '1px 3px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ↓ {g.lead.vehicle_desc || 'Vehicle'}
                    </div>
                  ))}
                  {inst.map(g => (
                    <div key={`gi-${g.key}`} title={`Graphics install: ${g.lead.vehicle_desc || 'vehicle'}${g.lead.customer_name ? ` — ${g.lead.customer_name}` : ''}`} style={{ fontSize: '8px', fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.14)', borderRadius: '3px', padding: '1px 3px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      Graphics install · {g.lead.vehicle_desc || 'Vehicle'}
                    </div>
                  ))}
                  {back.map(v => (
                    <div key={v.id} title={`Promised back: ${backTitle(v)}${v.customer_name ? ` — ${v.customer_name}` : ''}`} style={{ fontSize: '8px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', borderRadius: '3px', padding: '1px 3px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ↑ {backTitle(v)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: '14px', marginTop: '6px', fontSize: '9px', fontWeight: 700 }}>
            <span style={{ color: '#38bdf8' }}>↓ arriving</span>
            <span style={{ color: '#a78bfa' }}>Graphics install</span>
            <span style={{ color: '#fbbf24' }}>↑ promised back</span>
          </div>
        </div>
      )}
    </div>
  );
}
