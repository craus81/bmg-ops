'use client';

/**
 * Adjust & invoice (Craig, 2026-11-05): from the In-Shop completion window,
 * change a sales order's quantities and prices or add lines (a removal that
 * ran long, more vinyl), save them to NetSuite, then hand back so the window
 * bills the order the usual way (fulfil every line, then invoice).
 *
 * Reads and saves through the sales order page's own routes
 * (GET/PATCH /api/sales-orders/[id], item search /api/sales-orders/items),
 * so the same rules apply: billed lines locked, no quantity under what
 * shipped or billed. Nothing is emailed from here.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { LEAVE_WITHOUT_SAVING } from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { closeOnEscape } from '@/lib/modal-escape';
import { lineAllows, isFullyBilled, type SoLine, type SoHeader } from '@/lib/sales-order-edit';
import {
  adjustLineProblem, buildAdjustEdit, qtyText, startDrafts,
  type AdjustLineDraft, type AdjustNewDraft,
} from '@/lib/so-adjust';

interface Props {
  salesOrderId: string;
  soLabel: string;
  onClose: () => void;
  /** Called after the changes are saved (or there were none): bill the order now. */
  onSaved: (changes: string[]) => void;
}

interface ItemHit { itemId: string; itemNumber: string; description: string; price: number | null }

const money = (n: number | null | undefined) =>
  n == null ? '' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const input: React.CSSProperties = {
  padding: '7px 9px', borderRadius: '7px', border: '1px solid var(--border)',
  background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box',
};
const th: React.CSSProperties = {
  padding: '6px', textAlign: 'left', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: '13px' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const btn: React.CSSProperties = {
  padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
};

export default function AdjustInvoiceModal({ salesOrderId, soLabel, onClose, onSaved }: Props) {
  const dialog = useDialog();
  const { canSeeMoney } = useAuth();

  const [data, setData] = useState<{ header: SoHeader; lines: SoLine[]; seeMoney: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, AdjustLineDraft>>({});
  const [added, setAdded] = useState<AdjustNewDraft[]>([]);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<ItemHit[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(salesOrderId)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setLoadError(body.error || `Couldn't open the sales order (${res.status}).`); return; }
        setData({ header: body.header, lines: body.lines || [], seeMoney: !!body.seeMoney });
        setDrafts(startDrafts(body.lines || []));
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || "Couldn't open the sales order.");
      }
    })();
    return () => { cancelled = true; };
  }, [salesOrderId]);

  const showMoney = !!data?.seeMoney && canSeeMoney;
  const edit = useMemo(
    () => (data ? buildAdjustEdit(data.lines, drafts, added, showMoney) : null),
    [data, drafts, added, showMoney],
  );

  useEffect(() => {
    if (!adding || search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const res = await apiFetch(`/api/sales-orders/items?q=${encodeURIComponent(search.trim())}`);
      const body = await res.json().catch(() => ({}));
      setHits(res.ok ? body.items || [] : []);
    }, 250);
    return () => clearTimeout(t);
  }, [search, adding]);

  const addItem = (it: ItemHit) => {
    setAdded(a => [...a, {
      key: Date.now() + Math.random(), itemId: it.itemId, itemNumber: it.itemNumber, description: it.description,
      quantityText: '1', rateText: it.price != null ? String(it.price) : '',
    }]);
    setSearch('');
    setHits([]);
    setAdding(false);
  };

  const leave = async () => {
    if (saving) return;
    if (edit && edit.count > 0) {
      const ok = await dialog.confirm('The sales order stays exactly as it is in NetSuite. Nothing is invoiced.', {
        title: 'Leave without saving your changes?', confirmLabel: LEAVE_WITHOUT_SAVING, cancelLabel: 'Keep editing', destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  const saveAndInvoice = async () => {
    if (!data || !edit || saving) return;
    if (edit.errors.length > 0) { setErrors(edit.errors); return; }
    if (edit.count === 0) { onSaved([]); return; }
    setSaving(true);
    setErrors([]);
    try {
      const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(salesOrderId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lastModified: data.header.lastModified,
          ...(edit.lines.length ? { lines: edit.lines } : {}),
          ...(edit.add.length ? { add: edit.add } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(Array.isArray(body.errors) && body.errors.length ? body.errors : [`${body.error || `Save failed (${res.status}).`} Nothing was invoiced.`]);
        return;
      }
      onSaved(Array.isArray(body.changes) ? body.changes : []);
    } catch (e: any) {
      setErrors([`${e?.message || 'Save failed.'} Nothing was invoiced.`]);
    } finally {
      setSaving(false);
    }
  };

  const hasRed = !!data && data.lines.some(l => adjustLineProblem(l, drafts[l.line]));

  return (
    <div ref={closeOnEscape(leave)} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start',
      justifyContent: 'center', zIndex: 1100, padding: '20px', overflowY: 'auto',
    }}>
      <div role="dialog" aria-label={`Adjust and invoice SO ${soLabel}`} style={{
        width: '100%', maxWidth: '760px', background: 'var(--card)', color: 'var(--text-primary)',
        border: '1px solid var(--border)', borderRadius: '14px', padding: '18px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>Adjust &amp; invoice SO {soLabel}</h2>
          <button onClick={leave} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Change what the job really took, then save. The sales order is updated in NetSuite, then fulfilled and invoiced.
        </div>

        {loadError && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px' }}>{loadError}</div>}
        {!data && !loadError && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Opening the sales order from NetSuite…</div>}

        {data && edit && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Item</th>
                    <th style={th}>Description</th>
                    <th style={{ ...th, ...num }}>Qty</th>
                    {showMoney && <th style={{ ...th, ...num }}>Price</th>}
                    {showMoney && <th style={{ ...th, ...num }}>Amount</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map(l => {
                    const d = drafts[l.line];
                    const can = lineAllows(l);
                    const billed = isFullyBilled(l);
                    const problem = adjustLineProblem(l, d);
                    const q = d && can.quantity ? parseFloat(d.quantity) : l.quantity;
                    const r = d && can.price && showMoney && d.rate.trim() !== '' ? parseFloat(d.rate) : l.rate;
                    const changed = d && ((can.quantity && Math.round(q * 100) !== Math.round(l.quantity * 100))
                      || (can.price && showMoney && r != null && (l.rate == null || Math.round(r * 100) !== Math.round(l.rate * 100))));
                    return (
                      <tr key={l.line} style={{ background: billed ? 'var(--subtle-bg)' : changed ? 'rgba(251,191,36,0.08)' : undefined }}>
                        <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'nowrap' }}>{l.itemNumber}</td>
                        <td style={td}>
                          {l.description}
                          {billed && <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>Billed</span>}
                          {l.isClosed && !billed && <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>Closed</span>}
                        </td>
                        <td style={{ ...td, ...num }}>
                          {can.quantity ? (
                            <>
                              <input aria-label={`Quantity for ${l.itemNumber}`} inputMode="decimal" value={d?.quantity ?? ''}
                                onChange={e => setDrafts(x => ({ ...x, [l.line]: { ...x[l.line], quantity: e.target.value } }))}
                                style={{ ...input, width: '76px', textAlign: 'right', borderColor: problem ? 'var(--danger, #ef4444)' : 'var(--border)' }} />
                              {problem && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '11px', marginTop: '2px' }}>{problem}</div>}
                            </>
                          ) : l.editable ? qtyText(l.quantity) : ''}
                        </td>
                        {showMoney && (
                          <td style={{ ...td, ...num }}>
                            {can.price ? (
                              <input aria-label={`Price for ${l.itemNumber}`} inputMode="decimal" value={d?.rate ?? ''}
                                onChange={e => setDrafts(x => ({ ...x, [l.line]: { ...x[l.line], rate: e.target.value } }))}
                                style={{ ...input, width: '96px', textAlign: 'right' }} />
                            ) : money(l.rate)}
                          </td>
                        )}
                        {showMoney && (
                          <td style={{ ...td, ...num }}>
                            {changed && Number.isFinite(q) ? money(q * (r ?? 0)) : money(l.amount)}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {added.map(n => (
                    <tr key={n.key} style={{ background: 'rgba(34,197,94,0.08)' }}>
                      <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace' }}>{n.itemNumber}</td>
                      <td style={td}>
                        {n.description} <span style={{ fontSize: '11px', fontWeight: 700, color: '#22c55e' }}>New</span>
                        <button onClick={() => setAdded(a => a.filter(x => x.key !== n.key))}
                          style={{ marginLeft: '6px', background: 'none', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', color: 'var(--danger, #ef4444)' }}>
                          Remove
                        </button>
                      </td>
                      <td style={{ ...td, ...num }}>
                        <input aria-label={`Quantity for ${n.itemNumber}`} inputMode="decimal" value={n.quantityText}
                          onChange={e => setAdded(a => a.map(x => x.key === n.key ? { ...x, quantityText: e.target.value } : x))}
                          style={{ ...input, width: '76px', textAlign: 'right' }} />
                      </td>
                      {showMoney && (
                        <td style={{ ...td, ...num }}>
                          <input aria-label={`Price for ${n.itemNumber}`} inputMode="decimal" value={n.rateText}
                            onChange={e => setAdded(a => a.map(x => x.key === n.key ? { ...x, rateText: e.target.value } : x))}
                            style={{ ...input, width: '96px', textAlign: 'right' }} />
                        </td>
                      )}
                      {showMoney && <td style={{ ...td, ...num }}>{money((parseFloat(n.quantityText) || 0) * (parseFloat(n.rateText) || 0))}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {showMoney && (
              <div style={{ marginTop: '10px' }}>
                {!adding ? (
                  <button style={btn} onClick={() => setAdding(true)}>+ Add line</button>
                ) : (
                  <div style={{ maxWidth: '520px' }}>
                    <input autoFocus aria-label="Find a part or labor item" style={{ ...input, width: '100%' }} value={search}
                      placeholder="Item number or description (labor, vinyl, removal…)" onChange={e => setSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setSearch(''); } }} />
                    {hits.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: '8px', marginTop: '4px', maxHeight: 'calc(40vh / var(--ts, 1))', overflowY: 'auto' }}>
                        {hits.map(it => (
                          <button key={it.itemId} onClick={() => addItem(it)}
                            style={{ display: 'flex', width: '100%', gap: '10px', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--card)', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left' }}>
                            <span style={{ minWidth: 0 }}><b style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{it.itemNumber}</b> <span style={{ color: 'var(--text-secondary)' }}>{it.description}</span></span>
                            <span style={{ whiteSpace: 'nowrap' }}>{money(it.price)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button style={{ background: 'none', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', color: 'var(--text-secondary)', marginTop: '6px' }}
                      onClick={() => { setAdding(false); setSearch(''); }}>Close search</button>
                  </div>
                )}
              </div>
            )}

            {showMoney && (
              <div style={{ textAlign: 'right', marginTop: '10px', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginRight: '8px' }}>
                  Subtotal{edit.count > 0 ? ' (estimated)' : ''}
                </span>
                <b>{money(edit.subtotal)}</b>
              </div>
            )}
            <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
              Billed lines are locked. NetSuite works out tax when you save. To remove or close a line, use the sales order page.
            </div>

            {errors.length > 0 && (
              <div style={{ marginTop: '10px', color: 'var(--danger, #ef4444)', fontSize: '13px' }}>
                {errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
              <button style={btn} onClick={leave} disabled={saving}>
                {edit.count > 0 ? LEAVE_WITHOUT_SAVING : 'Close'}
              </button>
              <button onClick={saveAndInvoice} disabled={saving || hasRed}
                style={{ ...btn, background: '#16a34a', borderColor: '#16a34a', color: '#fff', opacity: saving || hasRed ? 0.6 : 1 }}>
                {saving ? 'Saving…' : edit.count > 0 ? `Save ${edit.count} change${edit.count !== 1 ? 's' : ''} & invoice` : 'Invoice as is'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
