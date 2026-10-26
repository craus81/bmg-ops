'use client';

/**
 * Request parts off an estimate: every part line from the estimate's stock
 * check, each with a checkbox and an editable quantity, sent into the
 * Purchasing queue tagged with the estimate. Opened from the stock banner,
 * and offered once more right after the estimate converts to a sales order.
 *
 * Short lines (and lines not in the catalog) start ticked at what's still
 * needed. Lines already covered by stock or a PO sit underneath, unticked,
 * at the full estimate quantity, so any part on the order can be requested
 * (Craig, 2026-10-26, option A). Select all / Short parts only set the ticks
 * in one tap.
 *
 * Nothing is sent until the person confirms, and every line can be
 * unticked or changed first. Lines not in the catalog go in with the part
 * number exactly as typed on the estimate; purchasing works out what it is
 * (Craig, 2026-10-01).
 *
 * Print stock check turns the same list into a sheet for counting the
 * shelves against on hand (Craig, 2026-10-26; see stock-check-pdf.ts).
 */

import { useMemo, useState } from 'react';
import { theme } from '@/lib/theme';
import { closeOnEscape } from '@/lib/modal-escape';
import { startingRequestQty } from '@/lib/estimate-request-qty';
import { openStockCheckPdf, type StockCheckData } from '@/lib/stock-check-pdf';

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export interface RequestablePart {
  item_number: string;
  description: string | null;
  needed: number;
  short: number;
  /** NetSuite available, shown beside the part. */
  on_hand?: number;
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
  /** Header for the printed stock check sheet. */
  printInfo?: Omit<StockCheckData, 'lines' | 'accepted'>;
  onClose: () => void;
  /** Fires after the requests land, with how many were created or raised. */
  onDone: (count: number) => void;
}

export default function EstimatePartsRequestModal({ estimateId, estimateLabel, accepted, parts, title, printInfo, onClose, onDone }: Props) {
  // Needs ordering first, then everything already covered.
  const due = useMemo(() => parts.filter(p => p.to_request > 0), [parts]);
  const covered = useMemo(() => parts.filter(p => p.to_request <= 0), [parts]);
  const lines = useMemo(() => [...due, ...covered], [due, covered]);
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set(covered.map(p => p.item_number)));
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyFor = (p: RequestablePart): number => {
    const raw = edited[p.item_number];
    if (raw === undefined) return startingRequestQty(p);
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const selected = lines
    .filter(p => !skipped.has(p.item_number))
    .map(p => ({ part: p, quantity: qtyFor(p) }))
    .filter(s => s.quantity > 0);

  const allTicked = lines.length > 0 && skipped.size === 0;
  const selectAll = () => setSkipped(allTicked ? new Set(lines.map(p => p.item_number)) : new Set());
  const shortOnly = () => setSkipped(new Set(covered.map(p => p.item_number)));

  const toggle = (item: string) => setSkipped(prev => {
    const next = new Set(prev);
    if (next.has(item)) next.delete(item); else next.add(item);
    return next;
  });

  const printSheet = () => {
    setError(null);
    const ticked = new Map(selected.map(s => [s.part.item_number, s.quantity]));
    const result = openStockCheckPdf({
      estimateNumber: printInfo?.estimateNumber || estimateLabel,
      customer: printInfo?.customer ?? null,
      vehicle: printInfo?.vehicle ?? null,
      vin: printInfo?.vin ?? null,
      soNumber: printInfo?.soNumber ?? null,
      accepted,
      lines: lines.map(p => ({
        itemNumber: p.item_number,
        description: p.description,
        needed: p.needed,
        onHand: p.on_hand,
        onOrder: p.on_order,
        requesting: ticked.get(p.item_number) || 0,
        short: !p.uncatalogued && p.short > 0,
        uncatalogued: p.uncatalogued,
      })),
    });
    if (!result.ok) setError(`Could not make the stock check sheet: ${result.error}`);
  };

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
            {estimateLabel}. These go to the Purchasing queue. Short parts start at what’s short; in-stock parts start unticked at the full estimate quantity.
          </div>
          {lines.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '9px' }}>
              <button type="button" onClick={selectAll} disabled={busy} style={toolButton}>
                {allTicked ? 'Untick all' : 'Select all'}
              </button>
              {due.length > 0 && covered.length > 0 && (
                <button type="button" onClick={shortOnly} disabled={busy} style={toolButton}>
                  Short parts only
                </button>
              )}
              <button type="button" onClick={printSheet} disabled={busy} style={{ ...toolButton, marginLeft: 'auto' }}>
                🖨 Print stock check
              </button>
            </div>
          )}
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
              This estimate has no parts to request.
            </div>
          )}
          {lines.map((p, i) => {
            const off = skipped.has(p.item_number);
            const heading = i === 0 && due.length > 0 ? 'Needs ordering'
              : i === due.length && covered.length > 0 ? 'In stock or on order'
                : null;
            return (
              <div key={p.item_number}>
              {heading && (
                <div style={{
                  fontSize: '10.5px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase',
                  color: theme.textMuted, padding: '8px 2px 4px',
                }}>
                  {heading}
                </div>
              )}
              <div
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
                    {!p.uncatalogued && p.on_hand !== undefined && ` · on hand ${qtyText(p.on_hand)}`}
                    {!p.uncatalogued && p.short > 0 && ` · short ${qtyText(p.short)}`}
                    {p.on_order > 0 && ` · on order ${qtyText(p.on_order)}`}
                    {p.requested > 0 && ` · already requested ${qtyText(p.requested)}`}
                  </div>
                </div>
                <input
                  type="number" min="0" step="any" disabled={busy || off}
                  aria-label={`Quantity of ${p.item_number}`}
                  value={edited[p.item_number] ?? qtyText(startingRequestQty(p))}
                  onChange={e => setEdited(prev => ({ ...prev, [p.item_number]: e.target.value }))}
                  style={{
                    width: '72px', flexShrink: 0, textAlign: 'right',
                    padding: '5px 7px', fontSize: '16px', fontWeight: 700,
                    background: theme.inputBg, color: theme.textPrimary,
                    border: `1px solid ${theme.border}`, borderRadius: '6px',
                  }}
                />
              </div>
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

const toolButton: React.CSSProperties = {
  padding: '5px 10px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 700,
  border: `1px solid ${theme.border}`, background: 'var(--card)', color: theme.textPrimary,
  cursor: 'pointer',
};
