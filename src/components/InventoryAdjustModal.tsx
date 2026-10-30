'use client';

import { useEffect, useState } from 'react';
import { closeOnEscape } from '@/lib/modal-escape';
import { theme } from '@/lib/theme';
import { ADJUST_REASONS, adjustmentChange, type AdjustMode } from '@/lib/inventory-adjust-shared';

export interface AdjustPart {
  netsuiteId: string;
  itemNumber: string;
  displayName?: string | null;
}

interface HistoryRow {
  id: string;
  change: number;
  reason: string;
  note: string | null;
  netsuite_adjustment_number: string | null;
  created_by_name: string | null;
  created_at: string;
}

const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/**
 * The Adjust pop-up (Inventory page rows, Parts list details): add/remove a
 * number or type the shelf count, pick a reason, and FleetSuite posts a
 * NetSuite Inventory Adjustment at O'Fallon. Numbers shown are NetSuite's
 * live O'Fallon count, read when the pop-up opens. Full screen on phones.
 */
export default function InventoryAdjustModal({ part, onClose, onPosted }: {
  part: AdjustPart;
  onClose: () => void;
  /** After a successful post, with NetSuite's new O'Fallon numbers. */
  onPosted?: (r: { onHand: number; available: number; change: number }) => void;
}) {
  const [stock, setStock] = useState<{ onHand: number; available: number } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [mode, setMode] = useState<AdjustMode>('delta');
  const [qty, setQty] = useState('-1');
  const [reason, setReason] = useState<string>(ADJUST_REASONS[0]);
  const [note, setNote] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string>('');

  useEffect(() => {
    let alive = true;
    fetch(`/api/inventory/adjust?netsuiteId=${encodeURIComponent(part.netsuiteId)}`)
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        setHistory(data.history || []);
        if (!res.ok) { setLoadErr(data.error || "Couldn't read the count from NetSuite."); return; }
        setStock({ onHand: Number(data.onHand) || 0, available: Number(data.available) || 0 });
      })
      .catch(() => { if (alive) setLoadErr("Couldn't reach FleetSuite. Check your connection."); });
    return () => { alive = false; };
  }, [part.netsuiteId]);

  const switchMode = (m: AdjustMode) => {
    setMode(m);
    setQty(m === 'delta' ? '-1' : String(stock?.onHand ?? 0));
    setError('');
  };
  const step = (by: number) => setQty(q => String((parseInt(q, 10) || 0) + by));

  const parsed = qty.trim() === '' ? NaN : Number(qty);
  const calc = stock ? adjustmentChange(mode, parsed, stock.onHand) : null;
  const ready = !!calc && !('error' in calc) && !posting && !done;

  const post = async () => {
    if (!ready) return;
    setPosting(true);
    setError('');
    try {
      const res = await fetch('/api/inventory/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netsuiteId: part.netsuiteId, mode, qty: parsed, reason, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'NetSuite refused the adjustment.'); return; }
      setStock({ onHand: data.onHand, available: data.available });
      setDone(`Posted ${data.adjustmentNumber || 'the adjustment'} in NetSuite. ${part.itemNumber} now shows ${data.onHand} on hand at O'Fallon.${data.warning ? ` ${data.warning}` : ''}`);
      onPosted?.({ onHand: data.onHand, available: data.available, change: data.change });
    } catch {
      setError("Couldn't reach FleetSuite. Nothing was posted. Check your connection and try again.");
    } finally {
      setPosting(false);
    }
  };

  const field: React.CSSProperties = {
    width: '100%', padding: '10px 12px', fontSize: '16px', background: theme.inputBg, color: theme.textPrimary,
    border: `1px solid ${theme.border}`, borderRadius: '9px', boxSizing: 'border-box', fontFamily: 'inherit',
  };
  const label: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: theme.textMuted, display: 'grid', gap: '4px' };
  const segBtn = (on: boolean): React.CSSProperties => ({
    padding: '9px', fontSize: '12px', fontWeight: 700, border: 'none', cursor: 'pointer',
    background: on ? 'rgba(59,130,246,0.18)' : theme.card, color: on ? '#60a5fa' : theme.textMuted,
  });
  const stepBtn: React.CSSProperties = {
    borderRadius: '9px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary,
    fontSize: '20px', fontWeight: 700, cursor: 'pointer',
  };

  return (
    <div ref={closeOnEscape(onClose)} className="inv-adjust-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '16px' }}>
      <style>{`
        @media (max-width: 520px) {
          .inv-adjust-backdrop { padding: 0 !important; align-items: stretch !important; }
          .inv-adjust-window { max-width: none !important; border-radius: 0 !important; border: none !important;
            padding-top: calc(16px + env(safe-area-inset-top, 0px)) !important; padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important; }
        }
      `}</style>
      <div className="inv-adjust-window" role="dialog" aria-modal="true" aria-label={`Adjust inventory for ${part.itemNumber}`}
        style={{ width: '100%', maxWidth: '420px', maxHeight: '100%', overflowY: 'auto', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px', display: 'grid', gap: '12px', alignContent: 'start', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Adjust inventory</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
              {part.itemNumber}{part.displayName ? ` · ${part.displayName}` : ''}
              {stock && ` · On hand ${stock.onHand}, available ${stock.available} (after open sales orders)`}
            </div>
          </div>
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '14px', padding: 0 }}>✕</button>
        </div>

        {!stock && !loadErr && <div style={{ fontSize: '12px', color: theme.textMuted }}>Reading the count from NetSuite…</div>}
        {loadErr && <div style={{ color: theme.error, fontSize: '12px', fontWeight: 700, background: theme.errorBg, padding: '8px 10px', borderRadius: '8px' }}>{loadErr}</div>}

        {stock && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: `1px solid ${theme.border}`, borderRadius: '10px', overflow: 'hidden' }}>
              <button onClick={() => switchMode('delta')} aria-pressed={mode === 'delta'} style={segBtn(mode === 'delta')} disabled={!!done}>Add or remove</button>
              <button onClick={() => switchMode('count')} aria-pressed={mode === 'count'} style={segBtn(mode === 'count')} disabled={!!done}>Shelf count</button>
            </div>
            <label style={label}>
              {mode === 'delta' ? 'Change' : 'Count on the shelf'}
              <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 44px', gap: '6px' }}>
                <button type="button" onClick={() => step(-1)} aria-label="Minus one" style={stepBtn} disabled={!!done}>−</button>
                <input type="number" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value)} disabled={!!done}
                  style={{ ...field, textAlign: 'center', fontWeight: 800 }} />
                <button type="button" onClick={() => step(1)} aria-label="Plus one" style={stepBtn} disabled={!!done}>+</button>
              </div>
            </label>
            {!done && calc && !('error' in calc) && (
              <div style={{ fontSize: '13px', padding: '10px 12px', borderRadius: '10px', background: theme.inputBg, color: theme.textSecondary }}>
                On hand {stock.onHand} <b style={{ color: theme.textPrimary }}>{signed(calc.change)}</b> = <b style={{ color: theme.textPrimary }}>{calc.after}</b><br />
                Available {stock.available} → <b style={{ color: theme.textPrimary }}>{stock.available + calc.change}</b>
              </div>
            )}
            {!done && calc && 'error' in calc && qty.trim() !== '' && (
              <div style={{ color: theme.error, fontSize: '12px', fontWeight: 700, background: theme.errorBg, padding: '8px 10px', borderRadius: '8px' }}>{calc.error}</div>
            )}
            <label style={label}>
              Reason
              <select value={reason} onChange={e => setReason(e.target.value)} style={field} disabled={!!done}>
                {ADJUST_REASONS.map(r => <option key={r}>{r}</option>)}
              </select>
            </label>
            <label style={label}>
              Note (optional)
              <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={500} disabled={!!done}
                placeholder="e.g. Box crushed on delivery" style={{ ...field, resize: 'vertical' }} />
            </label>
            <div style={{ fontSize: '11px', color: theme.textMuted }}>
              Posts an Inventory Adjustment in NetSuite at O&apos;Fallon, account 52000 Inventory Adjustment. Added units use the part&apos;s average cost.
            </div>
          </>
        )}

        {error && <div style={{ color: theme.error, fontSize: '12px', fontWeight: 700, background: theme.errorBg, padding: '8px 10px', borderRadius: '8px' }}>{error}</div>}
        {done && <div style={{ color: theme.success, fontSize: '13px', fontWeight: 700, background: theme.successBg, padding: '10px 12px', borderRadius: '10px' }}>{done}</div>}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 16px', borderRadius: '9px', fontSize: '13px', fontWeight: 800, border: `1px solid ${theme.border}`, background: theme.card, color: theme.textSecondary, cursor: 'pointer' }}>
            {done ? 'Done' : 'Cancel'}
          </button>
          {!done && (
            <button onClick={post} disabled={!ready}
              style={{ padding: '10px 16px', borderRadius: '9px', fontSize: '13px', fontWeight: 800, border: 'none', background: theme.success, color: '#fff', cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.45 }}>
              {posting ? 'Posting…' : 'Post to NetSuite'}
            </button>
          )}
        </div>

        {history.length > 0 && (
          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Recent adjustments</div>
            {history.map(h => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '11px', color: theme.textSecondary, padding: '3px 0' }}>
                <span>{day(h.created_at)} · {signed(Number(h.change))} · {h.reason}{h.created_by_name ? ` · ${h.created_by_name}` : ''}</span>
                <span style={{ color: theme.textMuted }}>{h.netsuite_adjustment_number || ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
