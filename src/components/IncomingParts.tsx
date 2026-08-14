'use client';

/**
 * Incoming Parts — the payoff view for the parts-email pipeline. Every part
 * still on order (open vendor POs synced from NetSuite), laid out as an
 * arrival timeline using the ship/ETA dates the email scan writes onto each
 * PO, and cross-referenced against on-hand stock and what's reserved to
 * other jobs. Parts where stock + what's coming still won't cover job
 * reservations are flagged short and surfaced in the summary + a filter.
 *
 * All three inputs are Supabase tables read here client-side (staff RLS),
 * the same join the Inventory page runs — reoriented around "what's arriving
 * and when, and does it cover what we've promised."
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  assembleIncomingParts,
  type IncomingPartRow,
  type IncomingSummary,
  type RawPoLine,
  type RawPart,
} from '@/lib/incoming-parts';

type Bucket = 'overdue' | 'week' | 'month' | 'later' | 'none';
const BUCKET_ORDER: Bucket[] = ['overdue', 'week', 'month', 'later', 'none'];
const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'Past ETA',
  week: 'This week',
  month: 'This month',
  later: 'Later',
  none: 'No ETA yet',
};

const STATE_PILL: Record<IncomingPartRow['state'], { bg: string; color: string; border: string }> = {
  short: { bg: 'rgba(239,68,68,0.14)', color: '#ef4444', border: 'rgba(239,68,68,0.4)' },
  incoming_covers: { bg: 'rgba(96,165,250,0.14)', color: '#60a5fa', border: 'rgba(96,165,250,0.4)' },
  stocked: { bg: 'rgba(34,197,94,0.14)', color: '#22c55e', border: 'rgba(34,197,94,0.35)' },
};

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;

function bucketOf(eta: string | null, todayMs: number): Bucket {
  if (!eta) return 'none';
  const etaMs = new Date(`${eta.slice(0, 10)}T12:00:00`).getTime();
  const days = Math.floor((etaMs - todayMs) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'later';
}

export default function IncomingParts({ refreshKey = 0 }: { refreshKey?: number }) {
  const supabase = createClient();
  const [rows, setRows] = useState<IncomingPartRow[]>([]);
  const [summary, setSummary] = useState<IncomingSummary>({ parts: 0, shipments: 0, short: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'week'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    // All three paginate past PostgREST's 1000-row cap — po lines and parts
    // are both well past it, and a truncated read would silently hide
    // incoming parts or understate stock.
    const [poRes, partsRes, allocRes] = await Promise.all([
      fetchAllRows<RawPoLine>((from, to) =>
        supabase.from('netsuite_vendor_po_lines')
          .select('item_number, description, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, status, eta_date, tracking_number, carrier, trandate)')
          .order('id')
          .range(from, to)),
      fetchAllRows<RawPart>((from, to) =>
        supabase.from('netsuite_parts')
          .select('item_number, display_name, quantity_on_hand, quantity_available')
          .eq('is_active', true)
          .gt('quantity_on_hand', 0)
          .order('id')
          .range(from, to)),
      fetchAllRows<any>((from, to) =>
        supabase.from('part_allocations')
          .select('item_number, quantity, upfit_projects(project_name)')
          .eq('status', 'reserved')
          .order('id')
          .range(from, to)),
    ]);

    // Bail on ANY read failure. A truncated stock or allocation read would
    // read as zero stock and paint parts as falsely "short" — worse than
    // showing an error, so don't render half the picture.
    if (poRes.error || partsRes.error || allocRes.error) {
      setErr('Could not load the full picture. Try refreshing.');
      setLoading(false);
      return;
    }
    const allocations = (allocRes.data || []).map(a => ({
      item_number: a.item_number,
      quantity: a.quantity,
      project_name: (a as any).upfit_projects?.project_name || null,
    }));
    const { rows: assembled, summary: sum } = assembleIncomingParts({
      poLines: poRes.data,
      parts: partsRes.data,
      allocations,
    });
    setRows(assembled);
    setSummary(sum);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const todayMs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const q = search.trim().toUpperCase();
  const visible = rows.filter(r => {
    if (filter === 'attention' && r.state !== 'short') return false;
    if (filter === 'week') {
      const b = bucketOf(r.soonest_eta, todayMs);
      if (b !== 'overdue' && b !== 'week') return false;
    }
    if (q) {
      const hay = `${r.item_number} ${r.display_name || ''} ${r.shipments.map(s => `${s.vendor || ''} ${s.tranid || ''}`).join(' ')}`.toUpperCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const arrivingThisWeek = rows.filter(r => {
    const b = bucketOf(r.soonest_eta, todayMs);
    return b === 'overdue' || b === 'week';
  }).length;

  // Group the visible rows by arrival bucket, preserving the ETA-ascending order.
  const grouped = BUCKET_ORDER
    .map(b => ({ bucket: b, items: visible.filter(r => bucketOf(r.soonest_eta, todayMs) === b) }))
    .filter(g => g.items.length > 0);

  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Incoming Parts</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            What&rsquo;s on order and when it lands, checked against stock and what&rsquo;s reserved to jobs
          </div>
        </div>
        <button onClick={load} disabled={loading} style={{ padding: '5px 11px', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginTop: '12px' }}>
        <Tile label="Parts incoming" value={summary.parts} />
        <Tile label="Open shipments" value={summary.shipments} />
        <Tile label="Arriving this week" value={arrivingThisWeek} color={arrivingThisWeek > 0 ? '#60a5fa' : undefined} />
        <Tile label="Short after arrival" value={summary.short} color={summary.short > 0 ? '#ef4444' : undefined} />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search part #, name, or vendor…"
          style={{ flex: 1, minWidth: '160px', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
        />
        {([
          ['all', `All (${rows.length})`],
          ['attention', `⚠ Needs attention (${summary.short})`],
          ['week', `This week (${arrivingThisWeek})`],
        ] as const).map(([f, label]) => {
          const active = filter === f;
          const color = f === 'attention' ? '#ef4444' : '#60a5fa';
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '7px 11px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
              background: active ? `${color}22` : 'var(--card)',
              border: `1px solid ${active ? color : 'var(--border)'}`,
              color: active ? color : 'var(--text-muted)',
            }}>
              {label}
            </button>
          );
        })}
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '24px 0' }}>Loading…</div>}
      {err && !loading && <div style={{ textAlign: 'center', color: '#ef4444', fontSize: '12px', padding: '24px 0' }}>{err}</div>}
      {!loading && !err && rows.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '24px 0' }}>
          Nothing on order right now. Open vendor POs sync from NetSuite every 2 hours, and ETAs fill in from vendor email.
        </div>
      )}
      {!loading && !err && rows.length > 0 && visible.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '24px 0' }}>No incoming parts match.</div>
      )}

      {!loading && !err && grouped.map(g => (
        <div key={g.bucket} style={{ marginTop: '14px' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, color: g.bucket === 'overdue' ? '#f59e0b' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
            {BUCKET_LABEL[g.bucket]} · {g.items.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {g.items.map(r => <PartCard key={r.item_number} r={r} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 10px' }}>
      <div style={{ fontSize: '18px', fontWeight: 800, color: color || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
    </div>
  );
}

function Stat({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <span title={title} style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
      {label} <b style={{ color: color || 'var(--text-secondary)' }}>{value}</b>
    </span>
  );
}

function PartCard({ r }: { r: IncomingPartRow }) {
  const pill = STATE_PILL[r.state];
  const pillLabel =
    r.state === 'short' ? `Short ${qty(r.shortfall)}`
      : r.state === 'incoming_covers' ? (r.soonest_eta ? `Covered on arrival` : 'Covered when it lands')
        : 'In stock';
  return (
    <div style={{
      padding: '10px 12px', borderRadius: '10px', background: 'var(--input-bg)',
      border: `1px solid ${r.state === 'short' ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
      borderLeft: `3px solid ${pill.color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>{r.item_number}</div>
          {r.display_name && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{r.display_name}</div>}
        </div>
        <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '6px', whiteSpace: 'nowrap', background: pill.bg, color: pill.color, border: `1px solid ${pill.border}` }}>
          {pillLabel}
        </span>
      </div>

      {/* Numbers: stock vs reserved vs incoming */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
        <Stat label="In stock" value={qty(r.on_hand)} />
        {r.available !== r.on_hand && <Stat label="Avail" value={qty(r.available)} title="NetSuite available — on hand minus NetSuite-side commitments" />}
        <Stat label="Allocated" value={qty(r.allocated)} color={r.allocated > 0 ? '#22c55e' : undefined} title="Reserved to jobs in FleetSuite" />
        <Stat label="Incoming" value={qty(r.incoming)} color="#60a5fa" />
        <Stat label="Free" value={qty(r.free)} title="Available minus job reservations — what a new job could take right now" />
      </div>

      {/* Who the stock is spoken for by */}
      {r.allocations.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
          {r.allocations.map((a, i) => (
            <span key={i} style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
              {qty(a.qty)} &rarr; {a.project}
            </span>
          ))}
        </div>
      )}

      {/* The shipments themselves — PO, vendor, ETA, tracking */}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
        {r.shipments.map((s, i) => (
          <span key={i} style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}>
            {qty(s.remaining)} on {s.tranid || 'PO'}{s.vendor ? ` · ${s.vendor}` : ''}
            {s.eta ? ` · ETA ${fmtDate(s.eta)}` : ' · ETA —'}
            {s.tracking ? ` · ${s.carrier ? `${s.carrier} ` : ''}${s.tracking}` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
