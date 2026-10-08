'use client';

/**
 * Request parts off an estimate: the short lines (and lines not in the
 * catalog) from the estimate's stock check, each with a checkbox and an
 * editable quantity, sent into the Purchasing queue tagged with the
 * estimate. Opened from the stock banner, and offered once more right
 * after the estimate converts to a sales order.
 *
 * Nothing is sent until the person confirms, and every line can be
 * unticked or changed first. Lines not in the catalog go in with the part
 * number exactly as typed on the estimate; purchasing works out what it is
 * (Craig, 2026-10-01).
 */

import { useMemo, useState } from 'react';
import { theme } from '@/lib/theme';
import { closeOnEscape } from '@/lib/modal-escape';

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export interface RequestablePart {
  item_number: string;
  description: string | null;
  needed: number;
  short: number;
  on_order: number;
  requested: number;
  to_request: number;
  uncatalogued: boolean;
  netsuite_item_id?: string | null;
}

interface Props {
  estimateId: string;
  /** "Estimate 1234 — Customer" for the heading. */
  estimateLabel: string;
  /** False shows the "customer hasn't accepted yet" warning. */
  accepted: boolean;
  parts: RequestablePart[];
  /** Overrides the heading line, e.g. the post-conversion prompt. */
  title?: string;
  onClose: () => void;
  /** Fires after the requests land, with how many were created or raised. */
  onDone: (count: number) => void;
}

export default function EstimatePartsRequestModal({ estimateId, estimateLabel, accepted, parts, title, onClose, onDone }: Props) {
  const lines = useMemo(() => parts.filter(p => p.to_request > 0), [parts]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyFor = (p: RequestablePart): number => {
    const raw = edited[p.item_number];
    if (raw === undefined) return p.to_request;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const selected = lines
    .filter(p => !skipped.has(p.item_number))
    .map(p => ({ part: p, quantity: qtyFor(p) }))
    .filter(s => s.quantity > 0);

  const toggle = (item: string) => setSkipped(prev => {
    const next = new Set(prev);
    if (next.has(item)) next.delete(item); else next.add(item);
    return next;
  });

  const confirm = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/purchase-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          estimateId,
          items: selected.map(s => ({
            itemNumber: s.part.item_number,
            quantity: s.quantity,
            description: s.part.description,
            netsuiteItemId: s.part.netsuite_item_id || null,
          })),
          note: note.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      onDone((body.created || 0) + (body.raised || 0));
    } catch (e: any) {
      setError(`Could not send the request: ${e?.message || 'unknown error'}`);
      setBusy(false);
    }
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
          borderRadius: '14px', width: '100%', maxWidth: '620px',
          maxHeight: 'calc(88vh / var(--ts))',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>
            {title || 'Request parts for this estimate'}
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
            {estimateLabel}. These go to the Purchasing queue. Quantity is what’s short, less anything already requested.
          </div>
          {!accepted && (
            <div style={{
              marginTop: '8px', padding: '6px 9px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 700,
              background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24',
            }}>
              The customer hasn’t accepted this estimate yet. Only request parts now if you’re sure the job is going ahead.
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
          {lines.length === 0 && (
            <div style={{ fontSize: '12.5px', color: theme.textMuted, padding: '8px 0' }}>
              Nothing left to request. Every part is in stock, on order or already requested.
            </div>
          )}
          {lines.map(p => {
            const off = skipped.has(p.item_number);
            return (
              <div
                key={p.item_number}
                style={{
                  display: 'flex', alignItems: 'center', gap: '9px',
                  padding: '7px 8px', borderRadius: '8px', marginBottom: '3px',
                  background: off ? 'transparent' : 'rgba(96,165,250,0.05)',
                  opacity: off ? 0.45 : 1,
                }}
              >
                <input
                  type="checkbox" checked={!off} disabled={busy}
                  onChange={() => toggle(p.item_number)}
                  style={{ width: '16px', height: '16px', flexShrink: 0, cursor: 'pointer' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, color: theme.textPrimary }}>
                    {p.item_number}
                    {p.uncatalogued && (
                      <span title="Not in the parts catalog. It goes in with this part number as typed, and purchasing works out the rest." style={{ marginLeft: '6px', fontSize: '10px', color: '#f59e0b' }}>
                        not in catalog
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <div style={{ fontSize: '11px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.description}
                    </div>
                  )}
                  <div style={{ fontSize: '10.5px', color: theme.textMuted, marginTop: '2px' }}>
                    Needed {qtyText(p.needed)}
                    {!p.uncatalogued && ` · short ${qtyText(p.short)}`}
                    {p.on_order > 0 && ` · on order ${qtyText(p.on_order)}`}
                    {p.requested > 0 && ` · already requested ${qtyText(p.requested)}`}
                  </div>
                </div>
                <input
                  type="number" min="0" step="any" disabled={busy || off}
                  aria-label={`Quantity of ${p.item_number}`}
                  value={edited[p.item_number] ?? String(p.to_request)}
                  onChange={e => setEdited(prev => ({ ...prev, [p.item_number]: e.target.value }))}
                  style={{
                    width: '72px', flexShrink: 0, textAlign: 'right',
                    padding: '5px 7px', fontSize: '16px', fontWeight: 700,
                    background: theme.inputBg, color: theme.textPrimary,
                    border: `1px solid ${theme.border}`, borderRadius: '6px',
                  }}
                />
              </div>
            );
          })}
        </div>

        <div style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
          {lines.length > 0 && (
            <textarea
              value={note}
              onChange={e => { if (!busy) setNote(e.target.value.slice(0, 500)); }}
              placeholder="Note for purchasing (optional), e.g. needed by Friday"
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                padding: '7px 9px', fontSize: '16px', borderRadius: '8px',
                background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`,
                marginBottom: '10px',
              }}
            />
          )}
          {error && <div style={{ fontSize: '12px', fontWeight: 700, color: '#f87171', marginBottom: '8px' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button" onClick={onClose} disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                background: 'var(--card)', color: theme.textPrimary, border: `1px solid ${theme.border}`,
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              {lines.length === 0 ? 'Close' : 'Not now'}
            </button>
            {lines.length > 0 && (
              <button
                type="button" onClick={confirm} disabled={busy || selected.length === 0}
                style={{
                  padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
                  background: '#2563eb', color: '#fff', border: 'none',
                  cursor: busy ? 'wait' : 'pointer', opacity: selected.length === 0 ? 0.5 : 1,
                }}
              >
                {busy ? 'Sending…' : `Request ${selected.length} part${selected.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
