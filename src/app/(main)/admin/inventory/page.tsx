'use client';

/**
 * Inventory at a glance: for every part with stock, reservations, or an
 * open vendor PO — on hand, available (NetSuite), allocated to jobs
 * (FleetSuite reservations, with the project names), free after
 * reservations, and on order (with ETAs). The complete
 * on-hand / allocated / waiting picture in one screen.
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { fetchAllRows } from '@/lib/fetch-all';

// Mirrors normalizeItemNumber in vendor-po-sync (server-only import there):
// NetSuite sub-items are "PARENT : CHILD" — compare on the last segment.
const normPart = (s: string | null | undefined) => {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
};

const CLOSED_PO_STATUSES = ['F', 'G', 'H'];

interface InvRow {
  item_number: string;
  display_name: string | null;
  on_hand: number;
  available: number;
  allocated: number;
  allocations: { project: string; qty: number }[];
  free: number;
  on_order: number;
  pos: { tranid: string | null; vendor: string | null; eta: string | null; remaining: number }[];
}

const fmt = (d: string | null) => d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;

export default function InventoryPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<InvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'allocated' | 'on_order'>('all');

  const load = useCallback(async () => {
    const [allocRes, poRes, partsRes] = await Promise.all([
      supabase.from('part_allocations')
        .select('item_number, quantity, upfit_projects(project_name)')
        .eq('status', 'reserved'),
      // Both paginated: PostgREST caps every response at 1000 rows no matter
      // the .limit(), silently dropping stocked parts / on-order lines.
      fetchAllRows<any>((from, to) =>
        supabase.from('netsuite_vendor_po_lines')
          .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, status, eta_date)')
          .order('id')
          .range(from, to)),
      fetchAllRows<any>((from, to) =>
        supabase.from('netsuite_parts')
          .select('item_number, display_name, quantity_on_hand, quantity_available')
          .eq('is_active', true)
          .gt('quantity_on_hand', 0)
          .order('id')
          .range(from, to)),
    ]);

    const map = new Map<string, InvRow>();
    const ensure = (key: string): InvRow => {
      if (!map.has(key)) {
        map.set(key, { item_number: key, display_name: null, on_hand: 0, available: 0, allocated: 0, allocations: [], free: 0, on_order: 0, pos: [] });
      }
      return map.get(key)!;
    };

    for (const p of partsRes.data || []) {
      const row = ensure(normPart(p.item_number));
      row.display_name = row.display_name || p.display_name;
      row.on_hand += Number(p.quantity_on_hand) || 0;
      row.available += Number(p.quantity_available) || 0;
    }
    for (const a of allocRes.data || []) {
      const row = ensure(normPart(a.item_number));
      const qty = Number(a.quantity) || 0;
      row.allocated += qty;
      row.allocations.push({ project: (a as any).upfit_projects?.project_name || 'Unknown project', qty });
    }
    for (const l of poRes.data || []) {
      const po = (l as any).netsuite_vendor_pos;
      if (CLOSED_PO_STATUSES.includes(String(po?.status || '').toUpperCase())) continue;
      const remaining = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0));
      if (remaining <= 0) continue;
      const row = ensure(normPart(l.item_number));
      row.on_order += remaining;
      row.pos.push({ tranid: po?.tranid || null, vendor: po?.vendor_name || null, eta: po?.eta_date || null, remaining });
    }

    const assembled = [...map.values()].map(r => ({ ...r, free: Math.max(0, r.available - r.allocated) }));
    // Busiest parts first: allocated, then on order, then stock depth.
    assembled.sort((a, b) => (b.allocated - a.allocated) || (b.on_order - a.on_order) || (b.on_hand - a.on_hand));
    setRows(assembled);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => { load(); }, [load]);

  const q = search.trim().toUpperCase();
  const visible = rows.filter(r => {
    if (filter === 'allocated' && r.allocated <= 0) return false;
    if (filter === 'on_order' && r.on_order <= 0) return false;
    if (q && !r.item_number.toUpperCase().includes(q) && !(r.display_name || '').toUpperCase().includes(q)) return false;
    return true;
  });

  const totals = {
    parts: visible.length,
    allocated: visible.filter(r => r.allocated > 0).length,
    onOrder: visible.filter(r => r.on_order > 0).length,
  };

  return (
    <div style={{ padding: '16px', maxWidth: '980px', margin: '0 auto' }}>
      <div style={{ marginBottom: '12px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Inventory</h1>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          On hand · allocated to jobs · free · on order — {totals.parts} parts shown, {totals.allocated} allocated, {totals.onOrder} on order
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search part # or name…"
          style={{ flex: 1, minWidth: '180px', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
        />
        {(['all', 'allocated', 'on_order'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: filter === f ? 'rgba(59,130,246,0.2)' : 'var(--card)',
            border: `1px solid ${filter === f ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
            color: filter === f ? '#60a5fa' : 'var(--text-muted)',
          }}>
            {f === 'all' ? 'All' : f === 'allocated' ? 'Allocated' : 'On Order'}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>No parts match.</div>
      )}

      {!loading && visible.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--input-bg)' }}>
                  <th style={{ padding: '8px 10px', fontWeight: 700 }}>Part</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }}>On Hand</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }} title="NetSuite available (on hand minus NetSuite commitments)">Avail</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }} title="Reserved to jobs in FleetSuite">Allocated</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }} title="Available minus reservations">Free</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }}>On Order</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 300).map(r => (
                  <tr key={r.item_number} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 10px' }}>
                      <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.item_number}</div>
                      {r.display_name && <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{r.display_name}</div>}
                      {(r.allocations.length > 0 || r.pos.length > 0) && (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '3px' }}>
                          {r.allocations.map((a, i) => (
                            <span key={`a${i}`} style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                              {a.qty} → {a.project}
                            </span>
                          ))}
                          {r.pos.map((p, i) => (
                            <span key={`p${i}`} style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}>
                              {p.remaining} on {p.tranid || 'PO'}{p.vendor ? ` · ${p.vendor}` : ''}{p.eta ? ` · ETA ${fmt(p.eta)}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>{r.on_hand}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>{r.available}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: r.allocated > 0 ? '#22c55e' : 'var(--text-muted)' }}>{r.allocated}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: r.free > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{r.free}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: r.on_order > 0 ? '#60a5fa' : 'var(--text-muted)', fontWeight: r.on_order > 0 ? 700 : 400 }}>{r.on_order}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length > 300 && (
            <div style={{ padding: '8px 12px', fontSize: '10px', color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              Showing 300 of {visible.length} — narrow with search.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
