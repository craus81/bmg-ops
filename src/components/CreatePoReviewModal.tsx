'use client';

/**
 * Review a vendor group before it becomes a NetSuite purchase order: tick
 * the requests to order, change quantities and prices, pick the plant the
 * PO is for, add a memo, then push. Nothing reaches NetSuite until the
 * Create PO button here is pressed.
 *
 * A quantity below what was requested orders that much and leaves the rest
 * in the queue. Prices are per part (one PO line per part), starting at the
 * catalog's purchase price; a blank price lets NetSuite use the item's own.
 * The PO goes in final, Pending Receipt (Craig, 2026-10-07).
 */

import { useMemo, useState } from 'react';
import { theme } from '@/lib/theme';
import { closeOnEscape } from '@/lib/modal-escape';

const LOCATIONS = ["O'Fallon", 'Wentzville', 'Kansas City', 'Social Circle'] as const;
type LocationName = typeof LOCATIONS[number];

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export interface ReviewRequest {
  id: string;
  item_number: string;
  netsuite_item_id: string | null;
  description: string | null;
  quantity: number;
  catalog_cost?: number | null;
  /** "Project · SO 1234", "Estimate 55", or "stock". */
  forLabel: string;
}

export interface CreatePoResult {
  number: string;
  url: string | null;
  mirrored: boolean;
  stamped: boolean;
}

interface Props {
  vendor: { id: string; name: string };
  rows: ReviewRequest[];
  /** Rows ticked when the screen opens; empty = every orderable row. */
  initiallySelected: Set<string>;
  onClose: () => void;
  onDone: (po: CreatePoResult) => void;
}

export default function CreatePoReviewModal({ vendor, rows, initiallySelected, onClose, onDone }: Props) {
  const orderable = useMemo(() => rows.filter(r => r.netsuite_item_id), [rows]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(
    orderable.filter(r => initiallySelected.size === 0 || initiallySelected.has(r.id)).map(r => r.id),
  ));
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({});
  // Keyed by part: two requests for one part share one PO line, so one price.
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [location, setLocation] = useState<LocationName>("O'Fallon");
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyFor = (r: ReviewRequest): number => {
    const raw = qtyEdits[r.id];
    if (raw === undefined) return r.quantity;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const priceText = (r: ReviewRequest): string =>
    priceEdits[r.item_number] ?? (r.catalog_cost && r.catalog_cost > 0 ? String(r.catalog_cost) : '');
  const priceFor = (r: ReviewRequest): number | null => {
    const n = parseFloat(priceText(r));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const chosen = orderable.filter(r => ticked.has(r.id));
  const badQty = chosen.some(r => qtyFor(r) <= 0);
  const unpriced = chosen.filter(r => priceFor(r) == null);
  const total = chosen.reduce((s, r) => s + qtyFor(r) * (priceFor(r) || 0), 0);

  const toggle = (id: string) => setTicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    if (busy || chosen.length === 0 || badQty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/purchase-requests/create-po', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestIds: chosen.map(r => r.id),
          vendorNetsuiteId: vendor.id,
          vendorName: vendor.name,
          memo: memo.trim() || null,
          locationName: location,
          lines: chosen.map(r => ({ requestId: r.id, quantity: qtyFor(r), rate: priceFor(r) })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      onDone({
        number: body.poNumber || (body.poId ? `#${body.poId}` : '(number pending)'),
        url: body.netsuiteUrl || null,
        mirrored: !!body.mirrored,
        stamped: !!body.stamped,
      });
    } catch (e: any) {
      setError(`PO creation failed: ${e?.message || 'unknown error'}. Nothing was ordered, and the requests are still in the queue.`);
      setBusy(false);
    }
  };

  const inputStyle = {
    padding: '5px 7px', fontSize: '16px', fontWeight: 700, textAlign: 'right' as const,
    background: theme.inputBg, color: theme.textPrimary,
    border: `1px solid ${theme.border}`, borderRadius: '6px',
  };

  return (
    <div
      ref={closeOnEscape(() => { if (!busy) onClose(); })}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300, padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: theme.card, border: `1px solid ${theme.border}`,
          borderRadius: '14px', width: '100%', maxWidth: '720px',
          maxHeight: 'calc(88vh / var(--ts))',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>
            New purchase order: {vendor.name}
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
            NetSuite vendor #{vendor.id}. The PO goes into NetSuite as Pending Receipt. Ordering less than requested leaves the rest in the queue.
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
          {rows.length > orderable.length && (
            <div style={{ fontSize: '11.5px', color: '#f59e0b', fontWeight: 700, marginBottom: '8px' }}>
              {rows.length - orderable.length} request{rows.length - orderable.length !== 1 ? 's' : ''} can’t go on a PO yet (no NetSuite item id). Match {rows.length - orderable.length !== 1 ? 'them' : 'it'} in the parts catalog first.
            </div>
          )}
          <div style={{ display: 'flex', gap: '9px', padding: '0 8px 4px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: theme.textMuted }}>
            <span style={{ width: '16px' }} />
            <span style={{ flex: 1 }}>Part</span>
            <span style={{ width: '72px', textAlign: 'right' }}>Qty</span>
            <span style={{ width: '92px', textAlign: 'right' }}>Unit price</span>
          </div>
          {orderable.map(r => {
            const off = !ticked.has(r.id);
            const qty = qtyFor(r);
            return (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: '9px',
                padding: '7px 8px', borderRadius: '8px', marginBottom: '3px',
                background: off ? 'transparent' : 'rgba(74,222,128,0.05)',
                opacity: off ? 0.45 : 1,
              }}>
                <input type="checkbox" checked={!off} disabled={busy} onChange={() => toggle(r.id)}
                  aria-label={`Order ${r.item_number}`}
                  style={{ width: '16px', height: '16px', flexShrink: 0, cursor: 'pointer' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, color: theme.textPrimary }}>{r.item_number}</div>
                  {r.description && (
                    <div style={{ fontSize: '11px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</div>
                  )}
                  <div style={{ fontSize: '10.5px', color: theme.textMuted, marginTop: '2px' }}>
                    For {r.forLabel} · requested {qtyText(r.quantity)}
                    {!off && qty > 0 && qty < r.quantity && ` · ${qtyText(r.quantity - qty)} stays in the queue`}
                  </div>
                </div>
                <input type="number" min="0" step="any" disabled={busy || off}
                  aria-label={`Quantity of ${r.item_number}`}
                  value={qtyEdits[r.id] ?? String(r.quantity)}
                  onChange={e => setQtyEdits(prev => ({ ...prev, [r.id]: e.target.value }))}
                  style={{ ...inputStyle, width: '72px', flexShrink: 0 }} />
                <input type="number" min="0" step="any" disabled={busy || off}
                  aria-label={`Unit price of ${r.item_number}`}
                  placeholder="NetSuite"
                  value={priceText(r)}
                  onChange={e => setPriceEdits(prev => ({ ...prev, [r.item_number]: e.target.value }))}
                  style={{ ...inputStyle, width: '92px', flexShrink: 0 }} />
              </div>
            );
          })}
        </div>

        <div style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 700, color: theme.textSecondary, display: 'flex', alignItems: 'center', gap: '6px' }}>
              Location
              <select value={location} disabled={busy} onChange={e => setLocation(e.target.value as LocationName)}
                style={{ padding: '6px 8px', fontSize: '16px', borderRadius: '7px', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}` }}>
                {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <div style={{ marginLeft: 'auto', fontSize: '12px', color: theme.textSecondary }}>
              {chosen.length} line{chosen.length !== 1 ? 's' : ''} · <b style={{ color: theme.textPrimary }}>{money(total)}</b>
              {unpriced.length > 0 && <span style={{ color: theme.textMuted }}> + {unpriced.length} at NetSuite’s price</span>}
            </div>
          </div>
          <textarea
            value={memo}
            onChange={e => { if (!busy) setMemo(e.target.value.slice(0, 500)); }}
            placeholder="Memo (optional). Left blank, it lists the sales orders these parts are for."
            rows={2}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              padding: '7px 9px', fontSize: '16px', borderRadius: '8px',
              background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`,
              marginBottom: '10px',
            }}
          />
          {error && <div style={{ fontSize: '12px', fontWeight: 700, color: '#f87171', marginBottom: '8px' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" onClick={onClose} disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                background: 'var(--card)', color: theme.textPrimary, border: `1px solid ${theme.border}`,
                cursor: busy ? 'default' : 'pointer',
              }}>
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={busy || chosen.length === 0 || badQty}
              title={badQty ? 'Every ticked line needs a quantity above 0' : undefined}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
                background: '#16a34a', color: '#fff', border: 'none',
                cursor: busy ? 'wait' : 'pointer', opacity: chosen.length === 0 || badQty ? 0.5 : 1,
              }}>
              {busy ? 'Creating PO…' : `Create PO in NetSuite (${chosen.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
