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
 *
 * When the vendor has an open PO dated today or yesterday, the screen can
 * add the parts to it instead (po-add.ts, Craig 2026-10-30): a part already
 * on that PO raises its line's qty, the rest become new lines.
 */

import { useMemo, useState } from 'react';
import { theme } from '@/lib/theme';
import { closeOnEscape } from '@/lib/modal-escape';
import { cleanPoSuffix, suggestedPoSuffix } from '@/lib/po-number';
import { genericDescKey } from '@/lib/generic-lines';

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
  /** The job's customer: starts the PO number ending (PO453-ACME). */
  customerName?: string | null;
}

export interface CreatePoResult {
  number: string;
  url: string | null;
  /** NetSuite's internal id of the new PO — what its PDF is fetched by. */
  netsuiteId: string | null;
  mirrored: boolean;
  stamped: boolean;
  /** Set when NetSuite wouldn't take the customer ending on the number. */
  suffixError?: string | null;
  /** The parts went on an open PO instead of a new one. */
  addedToExisting?: boolean;
}

/** An open PO with this vendor that can still take parts (vendor-pos GET). */
export interface OpenPo {
  id: string;
  tranid: string | null;
  netsuite_id: string | null;
  trandate: string | null;
  status_label: string | null;
  total: number | null;
  url?: string | null;
  lines: { item_netsuite_id: string | null; item_number: string; quantity: number; quantity_received: number }[];
}

interface Props {
  vendor: { id: string; name: string };
  rows: ReviewRequest[];
  /** Rows ticked when the screen opens; empty = every orderable row. */
  initiallySelected: Set<string>;
  /** This vendor's open POs that can take more parts, newest first. */
  openPos?: OpenPo[];
  /** Open on "Add to" this PO (the queue's open-PO hint). */
  startPoId?: string | null;
  onClose: () => void;
  onDone: (po: CreatePoResult) => void;
}

const shortDate = (d: string | null) => (d ? `${d.slice(5, 7)}-${d.slice(8, 10)}` : '');

export default function CreatePoReviewModal({ vendor, rows, initiallySelected, openPos = [], startPoId, onClose, onDone }: Props) {
  // null = a new PO; otherwise the open PO the parts go on.
  const [targetPoId, setTargetPoId] = useState<string | null>(
    () => (startPoId && openPos.some(p => p.id === startPoId) ? startPoId : openPos[0]?.id ?? null),
  );
  const [lastPoPick, setLastPoPick] = useState<string | null>(targetPoId);
  const targetPo = openPos.find(p => p.id === targetPoId) || null;
  const poLabel = (p: OpenPo) => p.tranid || `#${p.netsuite_id || ''}`;
  /** The untouched line a part already has on the target PO. */
  const onTarget = (r: ReviewRequest) => targetPo?.lines.find(l =>
    l.item_netsuite_id && l.item_netsuite_id === r.netsuite_item_id && !(Number(l.quantity_received) > 0));
  const orderable = useMemo(() => rows.filter(r => r.netsuite_item_id), [rows]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(
    orderable.filter(r => initiallySelected.size === 0 || initiallySelected.has(r.id)).map(r => r.id),
  ));
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({});
  // Keyed by part: two requests for one part share one PO line, so one price.
  // A generic part (Misc) is a line per request, told apart by description.
  const priceKey = (r: ReviewRequest) => `${r.item_number}::${genericDescKey(r.description)}`;
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [location, setLocation] = useState<LocationName>("O'Fallon");
  const [memo, setMemo] = useState('');
  const [suffix, setSuffix] = useState(() => suggestedPoSuffix(rows.map(r => r.customerName)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyFor = (r: ReviewRequest): number => {
    const raw = qtyEdits[r.id];
    if (raw === undefined) return r.quantity;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const priceText = (r: ReviewRequest): string =>
    priceEdits[priceKey(r)] ?? (r.catalog_cost && r.catalog_cost > 0 ? String(r.catalog_cost) : '');
  const priceFor = (r: ReviewRequest): number | null => {
    const n = parseFloat(priceText(r));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const chosen = orderable.filter(r => ticked.has(r.id));
  const badQty = chosen.some(r => qtyFor(r) <= 0);
  const unpriced = chosen.filter(r => priceFor(r) == null);
  const total = chosen.reduce((s, r) => s + qtyFor(r) * (priceFor(r) || 0), 0);
  const addCount = new Set(chosen.map(r => r.netsuite_item_id)).size;

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
          poSuffix: cleanPoSuffix(suffix) || null,
          lines: chosen.map(r => ({ requestId: r.id, quantity: qtyFor(r), rate: priceFor(r) })),
          existingPoId: targetPo?.id || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      onDone({
        number: body.poNumber || (body.poId ? `#${body.poId}` : '(number pending)'),
        url: body.netsuiteUrl || null,
        netsuiteId: body.poId ? String(body.poId) : null,
        mirrored: !!body.mirrored,
        stamped: !!body.stamped,
        suffixError: body.suffixError || null,
        addedToExisting: !!body.addedToExisting,
      });
    } catch (e: any) {
      setError(`${targetPo ? `Adding to PO ${poLabel(targetPo)}` : 'PO creation'} failed: ${e?.message || 'unknown error'}. Nothing was ordered, and the requests are still in the queue.`);
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
            {openPos.length > 0 ? 'Purchase order' : 'New purchase order'}: {vendor.name}
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
            {targetPo
              ? `NetSuite vendor #${vendor.id}. The parts go on PO ${poLabel(targetPo)}; a part already on it gets its qty raised. Ordering less than requested leaves the rest in the queue.`
              : `NetSuite vendor #${vendor.id}. The PO goes into NetSuite as Pending Receipt. Ordering less than requested leaves the rest in the queue.`}
          </div>
          {openPos.length > 0 && (
            <>
              <div role="group" aria-label="New or open PO" style={{ display: 'flex', marginTop: '10px', border: `1px solid ${theme.border}`, borderRadius: '9px', overflow: 'hidden', width: 'max-content', maxWidth: '100%' }}>
                {[
                  { on: !targetPo, label: 'New PO', pick: () => { setLastPoPick(targetPoId ?? lastPoPick); setTargetPoId(null); } },
                  { on: !!targetPo, label: `Add to open PO (${openPos.length})`, pick: () => setTargetPoId(lastPoPick ?? openPos[0].id) },
                ].map(b => (
                  <button key={b.label} type="button" disabled={busy} aria-pressed={b.on} onClick={b.pick}
                    style={{ padding: '7px 12px', fontSize: '12.5px', fontWeight: 800, border: 'none', cursor: 'pointer', background: b.on ? '#16a34a' : 'transparent', color: b.on ? '#fff' : theme.textSecondary }}>
                    {b.label}
                  </button>
                ))}
              </div>
              {targetPo && (
                <div role="radiogroup" aria-label="Which open PO" style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
                  {openPos.map(p => {
                    const on = p.id === targetPo.id;
                    return (
                      <button key={p.id} type="button" role="radio" aria-checked={on} disabled={busy}
                        onClick={() => { setTargetPoId(p.id); setLastPoPick(p.id); }}
                        style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', textAlign: 'left', padding: '8px 10px', borderRadius: '9px', cursor: 'pointer', border: `1px solid ${on ? '#16a34a' : theme.border}`, background: on ? 'rgba(74,222,128,0.08)' : 'transparent', color: theme.textSecondary, fontSize: '12.5px' }}>
                        <span style={{ width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0, marginTop: '2px', border: `2px solid ${on ? '#16a34a' : theme.textMuted}`, background: on ? '#16a34a' : 'transparent' }} />
                        <span>
                          <b style={{ color: theme.textPrimary }}>{poLabel(p)}</b> · {p.status_label || 'Open'} · {shortDate(p.trandate)}
                          <span style={{ display: 'block', fontSize: '11px', color: theme.textMuted }}>
                            {p.lines.length} line{p.lines.length !== 1 ? 's' : ''}{p.total != null ? ` · ${money(Number(p.total))}` : ''}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
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
                  <div style={{ fontSize: '12.5px', fontWeight: 700, color: theme.textPrimary }}>
                    {r.item_number}
                    {(() => {
                      const had = onTarget(r);
                      if (!had || off || !targetPo) return null;
                      // Two requests for one part share the raise; count every ticked one.
                      const adding = chosen.filter(c => c.netsuite_item_id === r.netsuite_item_id).reduce((s, c) => s + qtyFor(c), 0);
                      return (
                        <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 800, padding: '2px 6px', borderRadius: '6px', background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>
                          Already on {poLabel(targetPo)}: {qtyText(Number(had.quantity))} → {qtyText(Number(had.quantity) + adding)}
                        </span>
                      );
                    })()}
                  </div>
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
                  onChange={e => setPriceEdits(prev => ({ ...prev, [priceKey(r)]: e.target.value }))}
                  style={{ ...inputStyle, width: '92px', flexShrink: 0 }} />
              </div>
            );
          })}
        </div>

        <div style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
            {!targetPo && (<>
            <label style={{ fontSize: '12px', fontWeight: 700, color: theme.textSecondary, display: 'flex', alignItems: 'center', gap: '6px' }}>
              Location
              <select value={location} disabled={busy} onChange={e => setLocation(e.target.value as LocationName)}
                style={{ padding: '6px 8px', fontSize: '16px', borderRadius: '7px', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}` }}>
                {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '12px', fontWeight: 700, color: theme.textSecondary, display: 'flex', alignItems: 'center', gap: '6px' }}
              title="Added after NetSuite's own number. Blank leaves the number as NetSuite gives it.">
              PO # ending
              <input id="po-suffix" value={suffix} disabled={busy} maxLength={20} placeholder="ACME"
                onChange={e => setSuffix(e.target.value.toUpperCase())}
                style={{ width: '96px', padding: '6px 8px', fontSize: '16px', borderRadius: '7px', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`, textTransform: 'uppercase' }} />
              <span style={{ fontWeight: 400, color: theme.textMuted }}>{cleanPoSuffix(suffix) ? `PO###-${cleanPoSuffix(suffix)}` : 'NetSuite’s number'}</span>
            </label>
            </>)}
            <div style={{ marginLeft: 'auto', fontSize: '12px', color: theme.textSecondary }}>
              {chosen.length} line{chosen.length !== 1 ? 's' : ''} · <b style={{ color: theme.textPrimary }}>{money(total)}</b>
              {unpriced.length > 0 && <span style={{ color: theme.textMuted }}> + {unpriced.length} at NetSuite’s price</span>}
            </div>
          </div>
          {targetPo ? (
            <div style={{ fontSize: '12px', lineHeight: 1.45, color: theme.textMuted, marginBottom: '10px' }}>
              PO {poLabel(targetPo)} keeps its number, location and memo; any new sales order is added to the memo. {vendor.name} may already have this PO, so send them the updated PDF. FleetSuite won’t email them.
            </div>
          ) : (
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
          )}
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
              {targetPo
                ? (busy ? 'Adding…' : `Add ${addCount} part${addCount !== 1 ? 's' : ''} to ${poLabel(targetPo)}`)
                : (busy ? 'Creating PO…' : `Create PO in NetSuite (${chosen.length})`)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
