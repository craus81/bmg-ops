'use client';

/**
 * Every purchase order a part appears on — opened by clicking the parts
 * catalog's "Open on POs" / "On All POs" counters (field ask, 2026-08-21:
 * "we should be able to click the 'on all PO's' or 'on open PO's' and show
 * the list of PO's that this part number is on"). Grouped one row per PO
 * with ordered / installed / remaining, status, and a link to the PO
 * record.
 */

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { fetchAllRows } from '@/lib/fetch-all';
import { deepLinks } from '@/lib/deep-links';

interface PoRow {
  poId: string;
  poNumber: string | null;
  customer: string | null;
  status: string | null;
  createdAt: string | null;
  ordered: number;
  installed: number;
}

interface Props {
  partNumber: string;
  initialMode: 'open' | 'all';
  onClose: () => void;
}

export default function PartPosModal({ partNumber, initialMode, onClose }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<'open' | 'all'>(initialMode);
  const [rows, setRows] = useState<PoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Case-insensitive exact match — PO imports carry hand-typed casing.
      const escaped = partNumber.replace(/[\\%_]/g, '\\$&');
      const { data, error: qErr } = await fetchAllRows<any>((from, to) =>
        supabase
          .from('po_line_items')
          .select('id, quantity, installed, po_id, purchase_orders(id, po_number, customer, status, created_at)')
          .ilike('part_number', escaped)
          .order('id')
          .range(from, to));
      if (cancelled) return;
      if (qErr) { setError(qErr.message); setLoading(false); return; }
      const byPo = new Map<string, PoRow>();
      for (const l of data || []) {
        const po = l.purchase_orders;
        if (!po) continue;
        const row = byPo.get(po.id) || {
          poId: po.id, poNumber: po.po_number, customer: po.customer,
          status: po.status, createdAt: po.created_at, ordered: 0, installed: 0,
        };
        row.ordered += l.quantity || 0;
        row.installed += l.installed || 0;
        byPo.set(po.id, row);
      }
      setRows([...byPo.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [partNumber]);

  const visible = useMemo(
    () => (mode === 'open' ? rows.filter(r => r.status === 'open') : rows),
    [rows, mode],
  );

  const fmtDate = (s: string | null) => {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Part purchase orders"
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: 'min(680px, 100%)', maxHeight: 'calc(100vh / var(--ts) - 40px)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>POs — {partNumber}</div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {(['open', 'all'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '4px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                background: mode === m ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                border: `1px solid ${mode === m ? 'var(--tab-active-border)' : 'var(--border)'}`,
                color: mode === m ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{m === 'open' ? 'Open POs' : 'All POs'}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0 }}>✕</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '12px' }}>
            {mode === 'open' ? 'This part is not on any open PO.' : 'This part has not appeared on any PO.'}
          </div>
        ) : (
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {visible.map(r => {
              const remaining = Math.max(0, r.ordered - r.installed);
              return (
                <div key={r.poId} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', borderBottom: '1px solid var(--border)', fontSize: '12px', flexWrap: 'wrap' }}>
                  <button onClick={() => router.push(deepLinks.po(r.poId))} title="Open the PO record"
                    style={{ fontWeight: 800, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '12px' }}>
                    {r.poNumber || 'PO'}
                  </button>
                  <span style={{ flex: 1, minWidth: '120px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.customer || '—'}</span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{fmtDate(r.createdAt)}</span>
                  <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }} title="Ordered · installed · remaining">
                    {r.ordered} ordered · {r.installed} installed{remaining > 0 ? ` · ${remaining} left` : ''}
                  </span>
                  <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase', flexShrink: 0,
                    background: r.status === 'open' ? 'rgba(34,197,94,0.12)' : 'var(--subtle-bg)',
                    color: r.status === 'open' ? '#22c55e' : 'var(--text-muted)' }}>
                    {r.status || '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {error && <div style={{ fontSize: '11px', color: 'var(--error, #ef4444)' }}>{error}</div>}
      </div>
    </div>
  );
}
