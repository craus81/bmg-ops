'use client';

/**
 * One-click buy list (R6-7): preview every uncovered demand row grouped by
 * vendor, adjust or uncheck lines, then raise them all as purchase requests
 * in one confirm.
 *
 * Nothing here decides what to buy on its own. The suggestion is the same
 * arithmetic the per-row button already shows (needed − on order − in
 * queue), every line is visible and editable before anything is written,
 * and a line the buyer unchecks is simply not sent. The button is a
 * shortcut through the typing, not through the judgement.
 */

import { useCallback, useMemo, useState } from 'react';
import { theme } from '@/lib/theme';
import { buildBuyList, chunkItems, type BuyListInputRow } from '@/lib/buy-list';

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

interface Props {
  rows: BuyListInputRow[];
  onClose: () => void;
  /** Fires with the new request ids once every chunk has landed. */
  onDone: (createdIds: string[]) => void;
}

export default function BuyListModal({ rows, onClose, onDone }: Props) {
  const list = useMemo(() => buildBuyList(rows), [rows]);

  // Keyed by item number: unchecked lines and edited quantities. A missing
  // entry means "as suggested" — no state to keep in sync on first render.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const qtyFor = useCallback((itemNumber: string, suggested: number): number => {
    const raw = edited[itemNumber];
    if (raw === undefined) return suggested;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [edited]);

  const selected = useMemo(() => {
    const out: { itemNumber: string; quantity: number; description: string | null; netsuiteItemId: string | null; vendor: string | null }[] = [];
    for (const g of list.groups) {
      for (const l of g.lines) {
        if (skipped.has(l.itemNumber)) continue;
        const quantity = qtyFor(l.itemNumber, l.suggested);
        if (quantity <= 0) continue;
        out.push({
          itemNumber: l.itemNumber, quantity,
          description: l.description, netsuiteItemId: l.netsuiteItemId,
          vendor: g.vendor,
        });
      }
    }
    return out;
  }, [list, skipped, qtyFor]);

  const toggle = (itemNumber: string) => {
    setSkipped(prev => {
      const next = new Set(prev);
      if (next.has(itemNumber)) next.delete(itemNumber); else next.add(itemNumber);
      return next;
    });
  };

  const toggleGroup = (vendorLines: { itemNumber: string }[], allOn: boolean) => {
    setSkipped(prev => {
      const next = new Set(prev);
      for (const l of vendorLines) {
        if (allOn) next.add(l.itemNumber); else next.delete(l.itemNumber);
      }
      return next;
    });
  };

  const confirm = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    const created: string[] = [];
    // The API caps a call at 100 items, so a full sweep goes in chunks. A
    // chunk that fails stops the run and reports what DID land — silently
    // half-ordering is the one outcome nobody could reconstruct later.
    const chunks = chunkItems(selected);
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (chunks.length > 1) setProgress(`Sending ${i + 1} of ${chunks.length}…`);
        const res = await fetch('/api/purchase-requests', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: chunks[i].map(s => ({
              itemNumber: s.itemNumber, quantity: s.quantity,
              description: s.description, netsuiteItemId: s.netsuiteItemId,
            })),
            // No project id: this demand spans jobs, so pinning it to one
            // would misattribute it. Same rule as the per-row button.
            note: note.trim() || 'Raised from the demand tab buy list',
                      }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
        if (Array.isArray(body.createdIds)) created.push(...body.createdIds);
      }
      onDone(created);
    } catch (e: any) {
      setError(
        `${e?.message || 'unknown error'}`
        + (created.length > 0 ? ` — ${created.length} request${created.length !== 1 ? 's' : ''} were already created before this failed.` : ''),
      );
      setBusy(false);
      setProgress(null);
      return;
    }
    setBusy(false);
    setProgress(null);
  };

  const totalUnits = selected.reduce((n, s) => n + s.quantity, 0);

  return (
    <div
      onClick={() => { if (!busy) onClose(); }}
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
          borderRadius: '14px', width: '100%', maxWidth: '780px',
          // Text size scales the app with CSS zoom, which multiplies
          // viewport units too — divide by --ts so 88vh means 88vh.
          maxHeight: 'calc(88vh / var(--ts))',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Queue all uncovered parts</div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
            {list.lineCount === 0
              ? 'Nothing to queue — every part on the demand list is already on order or in the queue.'
              : `${list.lineCount} part${list.lineCount !== 1 ? 's' : ''} across ${list.groups.length} vendor${list.groups.length !== 1 ? 's' : ''}. Quantity is what's needed less what's already on order or queued.`}
          </div>
          {(list.coveredSkipped > 0 || list.dismissedSkipped > 0) && (
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '5px' }}>
              Left out: {list.coveredSkipped > 0 && `${list.coveredSkipped} already covered`}
              {list.coveredSkipped > 0 && list.dismissedSkipped > 0 && ' · '}
              {list.dismissedSkipped > 0 && `${list.dismissedSkipped} dismissed`}.
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {list.groups.map(group => {
            const allSkipped = group.lines.every(l => skipped.has(l.itemNumber));
            return (
              <div key={group.vendor || '__none__'} style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: group.vendor ? theme.textPrimary : '#f59e0b' }}>
                    {group.vendor || 'No vendor on file'}
                    <span style={{ fontWeight: 500, color: theme.textMuted, marginLeft: '7px', fontSize: '11px' }}>
                      {group.lines.length} part{group.lines.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <button
                    onClick={() => toggleGroup(group.lines, !allSkipped)}
                    disabled={busy}
                    style={{
                      background: 'none', border: 'none', color: '#60a5fa',
                      fontSize: '11px', cursor: busy ? 'default' : 'pointer', padding: '2px 4px',
                    }}
                  >
                    {allSkipped ? 'Select all' : 'Clear all'}
                  </button>
                </div>
                {!group.vendor && (
                  <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '6px' }}>
                    These still get raised — purchasing picks the vendor when the PO is placed.
                  </div>
                )}
                {group.lines.map(line => {
                  const off = skipped.has(line.itemNumber);
                  return (
                    <div
                      key={line.itemNumber}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '9px',
                        padding: '7px 8px', borderRadius: '8px',
                        background: off ? 'transparent' : 'rgba(96,165,250,0.05)',
                        opacity: off ? 0.45 : 1, marginBottom: '3px',
                      }}
                    >
                      <input
                        type="checkbox" checked={!off} disabled={busy}
                        onChange={() => toggle(line.itemNumber)}
                        style={{ width: '16px', height: '16px', flexShrink: 0, cursor: 'pointer' }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12.5px', fontWeight: 700, color: theme.textPrimary }}>
                          {line.itemNumber}
                          {!line.in_catalog && (
                            <span title="No catalog row matched this item number" style={{ marginLeft: '6px', fontSize: '10px', color: '#f59e0b' }}>not in catalog</span>
                          )}
                        </div>
                        <div style={{ fontSize: '11px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {line.description || '—'}
                        </div>
                        <div style={{ fontSize: '10.5px', color: theme.textMuted, marginTop: '2px' }}>
                          Needed {qty(line.needed)}
                          {line.onOrder > 0 && ` · on order ${qty(line.onOrder)}`}
                          {line.requested > 0 && ` · queued ${qty(line.requested)}`}
                          {line.sourceSummary && ` · ${line.sourceSummary}`}
                        </div>
                      </div>
                      <input
                        type="number" min="0" step="any" disabled={busy || off}
                        value={edited[line.itemNumber] ?? String(line.suggested)}
                        onChange={e => setEdited(prev => ({ ...prev, [line.itemNumber]: e.target.value }))}
                        style={{
                          width: '72px', flexShrink: 0, textAlign: 'right',
                          padding: '5px 7px', fontSize: '13px', fontWeight: 700,
                          background: theme.inputBg, color: theme.textPrimary,
                          border: `1px solid ${theme.border}`, borderRadius: '6px',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
          {list.lineCount > 0 && (
            <input
              value={note} onChange={e => setNote(e.target.value)} disabled={busy}
              placeholder="Note on every request (optional)" maxLength={200}
              style={{
                width: '100%', padding: '7px 9px', fontSize: '12px', marginBottom: '9px',
                background: theme.inputBg, color: theme.textPrimary,
                border: `1px solid ${theme.border}`, borderRadius: '7px',
              }}
            />
          )}
          {error && (
            <div style={{ fontSize: '12px', color: '#f87171', marginBottom: '8px' }}>Could not queue: {error}</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <div style={{ fontSize: '12px', color: theme.textMuted }}>
              {progress || `${selected.length} request${selected.length !== 1 ? 's' : ''} · ${qty(totalUnits)} unit${totalUnits !== 1 ? 's' : ''}`}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={onClose} disabled={busy}
                style={{
                  padding: '8px 14px', fontSize: '13px', borderRadius: '8px',
                  background: 'transparent', color: theme.textSecondary,
                  border: `1px solid ${theme.border}`, cursor: busy ? 'default' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirm} disabled={busy || selected.length === 0}
                style={{
                  padding: '8px 16px', fontSize: '13px', fontWeight: 700, borderRadius: '8px',
                  background: selected.length === 0 ? 'rgba(148,163,184,0.25)' : '#2563eb',
                  color: '#fff', border: 'none',
                  cursor: busy || selected.length === 0 ? 'default' : 'pointer',
                }}
              >
                {busy ? 'Queueing…' : `Queue ${selected.length}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
