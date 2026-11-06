'use client';

/**
 * ✎ Edit PO on Purchasing → Vendor POs (Craig, 2026-11-06). Opens the PO as
 * NetSuite has it now and saves straight back to NetSuite: each line's
 * quantity and price, Remove, Move to another vendor (a new PO), new parts,
 * the memo, the expected date and the ship-to address. The rules (what's
 * locked, what goes back to the parts queue) are src/lib/po-edit.ts; the
 * save is PATCH /api/purchase-requests/vendor-pos/[id].
 *
 * Full screen on a phone. Nothing is focused on open, so the date picker
 * doesn't pop up by itself.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import { cleanPartQuery, partSearchFilter } from '@/lib/part-suggest';
import { canTakeOff, lineFloor, lineLock, SHOP_SHIP_TO, type PoEditHeader } from '@/lib/po-edit';
import { EMPTY_SHIP_TO, sameShipTo, shipToLines, type ShipTo } from '@/lib/drop-ship';
import NetsuiteVendorSearch from '@/components/NetsuiteVendorSearch';
import { useAuth } from '@/components/AuthProvider';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface ViewLine {
  line: number;
  itemId: string;
  itemNumber: string;
  quantity: number;
  quantityReceived: number;
  quantityBilled: number;
  isClosed: boolean;
  rate: number | null;
  description: string | null;
  jobs: { requestId: string; quantity: number; label: string }[];
}

interface View {
  po: { id: string; netsuiteId: string; tranid: string | null; vendorName: string | null };
  header: PoEditHeader;
  lastModified: string | null;
  lines: ViewLine[];
}

interface LineDraft { qty: string; rate: string; remove: boolean; move: boolean }

interface PartHit {
  item_number: string;
  netsuite_id: string | null;
  display_name: string | null;
  description: string | null;
  purchase_price: number | null;
}

interface AddDraft { key: number; part: PartHit; qty: string; rate: string }

export interface PoEditSaved {
  poNumber: string | null;
  vendorName: string | null;
  changes: string[];
  requeued: string[];
  movedTo: { id: string | null; number: string | null; vendorName: string | null } | null;
  warning?: string;
}

const num = (s: string): number | null => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const sameRate = (a: number | null, b: number | null) => (a == null || a === 0 ? b == null || b === 0 : b != null && Math.abs(a - b) < 0.005);

export default function EditVendorPoModal({ poId, emailedLine, onClose, onSaved }: {
  poId: string;
  /** "Emailed to … · Nov 4" when the PO already went to the vendor, else null. */
  emailedLine: string | null;
  onClose: () => void;
  onSaved: (saved: PoEditSaved) => void;
}) {
  const supabase = createClient();
  // Prices show (and change) only for people who may see money.
  const { canSeeMoney } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memo, setMemo] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [shipTo, setShipTo] = useState<ShipTo>(EMPTY_SHIP_TO);
  const [editingShipTo, setEditingShipTo] = useState(false);
  const [drafts, setDrafts] = useState<Map<number, LineDraft>>(new Map());
  const [adds, setAdds] = useState<AddDraft[]>([]);
  const nextKey = useRef(1);
  const [moveVendor, setMoveVendor] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PartHit[]>([]);
  const seq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/purchase-requests/vendor-pos/${poId}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
        if (cancelled) return;
        const v = body as View;
        setView(v);
        setMemo(v.header.memo || '');
        setDueDate(v.header.dueDate || '');
        setShipTo({ ...EMPTY_SHIP_TO, ...v.header.shipTo });
        setDrafts(new Map(v.lines.map(l => [l.line, { qty: String(l.quantity), rate: l.rate != null ? l.rate.toFixed(2) : '', remove: false, move: false }])));
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || 'unknown error');
      }
    })();
    return () => { cancelled = true; };
  }, [poId]);

  // Part search for + Add, debounced.
  useEffect(() => {
    const cleaned = cleanPartQuery(search);
    const mySeq = ++seq.current;
    if (!cleaned) { setHits([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('item_number, netsuite_id, display_name, description, purchase_price')
        .eq('is_active', true)
        .or(partSearchFilter(cleaned))
        .order('item_number')
        .limit(25);
      if (mySeq !== seq.current) return;
      const byItem = new Map<string, PartHit>();
      for (const p of (data || []) as PartHit[]) {
        const k = p.item_number.toUpperCase();
        const prev = byItem.get(k);
        if (!prev || (!prev.netsuite_id && p.netsuite_id)) byItem.set(k, p);
      }
      setHits([...byItem.values()].slice(0, 10));
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable
  }, [search]);

  const setDraft = (line: number, patch: Partial<LineDraft>) =>
    setDrafts(prev => new Map(prev).set(line, { ...prev.get(line)!, ...patch }));

  /** What the save would send, and the words for each change. */
  const pending = useMemo(() => {
    if (!view) return { changes: [] as string[], problem: null as string | null, lines: [] as any[], adds: [] as any[], header: {} as any };
    const changes: string[] = [];
    let problem: string | null = null;
    const lines: any[] = [];
    for (const l of view.lines) {
      const d = drafts.get(l.line);
      if (!d || lineLock(l)) continue;
      if (d.remove) { lines.push({ line: l.line, remove: true }); changes.push(`remove ${l.itemNumber}`); continue; }
      if (d.move) { lines.push({ line: l.line, move: true }); changes.push(`move ${l.itemNumber}`); continue; }
      const q = num(d.qty);
      const r = d.rate.trim() === '' ? null : num(d.rate);
      const e: any = { line: l.line };
      if (q == null || q <= 0) problem = problem || `${l.itemNumber} needs a quantity above 0. To take it off, use Remove.`;
      else if (q < lineFloor(l)) problem = problem || `${l.itemNumber} can’t go below ${l.quantityReceived}: that many came in.`;
      else if (q !== l.quantity) { e.quantity = q; changes.push(`${l.itemNumber} qty ${l.quantity} → ${q}`); }
      if (d.rate.trim() !== '' && (r == null || r < 0)) problem = problem || `${l.itemNumber} needs a price of 0 or more.`;
      else if (d.rate.trim() !== '' && !sameRate(l.rate, r)) { e.rate = r; changes.push(`${l.itemNumber} price`); }
      if ('quantity' in e || 'rate' in e) lines.push(e);
    }
    const addList = adds.map(a => {
      const q = num(a.qty);
      const r = a.rate.trim() === '' ? null : num(a.rate);
      if (!a.part.netsuite_id) problem = problem || `${a.part.item_number} isn’t in NetSuite yet, so it can’t go on a PO.`;
      if (q == null || q <= 0) problem = problem || `${a.part.item_number} needs a quantity above 0.`;
      changes.push(`add ${a.part.item_number}`);
      return { itemId: a.part.netsuite_id || '', itemNumber: a.part.item_number, quantity: q || 0, rate: r != null && r > 0 ? r : null, description: a.part.display_name || a.part.description || null };
    });
    const header: Partial<PoEditHeader> = {};
    if (memo.trim() !== (view.header.memo || '').trim()) { header.memo = memo; changes.push('memo'); }
    if ((dueDate || null) !== (view.header.dueDate || null)) { header.dueDate = dueDate || null; changes.push('expected date'); }
    if (!sameShipTo(shipTo, { ...EMPTY_SHIP_TO, ...view.header.shipTo })) { header.shipTo = shipTo; changes.push('ship-to'); }
    const moving = lines.some(l => l.move);
    if (moving && !moveVendor) problem = problem || 'Pick the vendor the moved parts go to.';
    const open = view.lines.filter(l => !l.isClosed && !drafts.get(l.line)?.remove && !drafts.get(l.line)?.move).length + adds.length;
    if (open === 0) problem = problem || 'A PO needs at least one part. To cancel the whole PO, close it in NetSuite.';
    return { changes, problem, lines, adds: addList, header };
  }, [view, drafts, adds, memo, dueDate, shipTo, moveVendor]);

  const dirty = pending.changes.length > 0;

  const leave = () => { if (!busy) onClose(); };

  const save = async () => {
    if (!view || busy || !dirty || pending.problem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/purchase-requests/vendor-pos/${poId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lastModified: view.lastModified,
          header: pending.header,
          lines: pending.lines,
          adds: pending.adds,
          moveTo: moveVendor && pending.lines.some(l => l.move) ? { vendorNetsuiteId: moveVendor.id, vendorName: moveVendor.name } : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(body as PoEditSaved);
    } catch (e: any) {
      setError(e?.message || 'Couldn’t save. Nothing was changed.');
      setBusy(false);
    }
  };

  const addPart = (part: PartHit) => {
    setSearch('');
    setHits([]);
    setAdds(prev => [...prev, {
      key: nextKey.current++, part, qty: '1',
      rate: canSeeMoney && part.purchase_price && part.purchase_price > 0 ? String(part.purchase_price) : '',
    }]);
  };

  const field = {
    padding: '7px 9px', fontSize: '16px', borderRadius: '8px', minWidth: 0,
    background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`,
  } as const;
  const label = { fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' } as const;
  const small = { fontSize: '11px', color: theme.textSecondary, lineHeight: 1.4 } as const;
  const amber = { ...small, color: '#f59e0b', fontWeight: 700 } as const;
  const link = { background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' } as const;
  const title = view ? `Edit PO ${view.po.tranid || ''}`.trim() : 'Edit PO';

  return (
    <div ref={closeOnEscape(leave)} className="po-edit-overlay"
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '16px' }}>
      <style>{`
        @media (max-width: 600px) {
          .po-edit-overlay { padding: 0 !important; }
          .po-edit-card { max-width: none !important; max-height: none !important; height: 100% !important; border-radius: 0 !important; border: none !important; padding-top: env(safe-area-inset-top, 0px); }
          .po-edit-foot { padding-bottom: max(12px, env(safe-area-inset-bottom, 0px)) !important; }
        }
      `}</style>
      <div className="po-edit-card" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()} style={{
        background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
        width: '100%', maxWidth: '720px', maxHeight: 'calc(90vh / var(--ts))',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}`, display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>{title}</div>
            <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>
              {[view?.po.vendorName, 'saves to NetSuite'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button type="button" onClick={leave} title="Leave without saving" aria-label="Leave without saving"
            style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '18px', cursor: 'pointer', padding: 0 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {!view && !loadError && <div style={{ color: theme.textMuted, fontSize: '13px' }}>Reading the PO from NetSuite…</div>}
          {loadError && <div style={{ color: '#f87171', fontSize: '13px', fontWeight: 700 }}>Couldn’t open this PO: {loadError}</div>}
          {view && (<>
            {emailedLine && (
              <div style={{ fontSize: '12px', padding: '9px 12px', borderRadius: '10px', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.4)', color: theme.textPrimary }}>
                {emailedLine}. After you save, you can email {view.po.vendorName || 'the vendor'} the change.
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', flex: '1 1 160px' }}>
                <span style={label}>Expected date</span>
                <input id="po-edit-due" type="date" value={dueDate} disabled={busy} onChange={e => setDueDate(e.target.value)} style={field} />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', flex: '2 1 240px', minWidth: 0 }}>
                <span style={label}>Ship to</span>
                {!editingShipTo ? (
                  <div style={{ fontSize: '13px', color: theme.textPrimary, lineHeight: 1.4 }}>
                    {shipToLines(shipTo).length ? shipToLines(shipTo).slice(0, 3).join(', ') : <span style={{ color: theme.textMuted }}>No address on the PO</span>}
                    <div style={{ display: 'flex', gap: '12px', marginTop: '3px' }}>
                      <button type="button" style={link} disabled={busy} onClick={() => setEditingShipTo(true)}>Change</button>
                      {!sameShipTo(shipTo, SHOP_SHIP_TO) && <button type="button" style={link} disabled={busy} onClick={() => setShipTo(SHOP_SHIP_TO)}>Ship to the shop</button>}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '6px' }}>
                    {([['name', 'Name'], ['attention', 'Attention'], ['address', 'Address'], ['address2', 'Address 2'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['phone', 'Phone']] as const).map(([k, ph]) => (
                      <input key={k} id={`po-edit-ship-${k}`} aria-label={ph} placeholder={ph} value={shipTo[k]} disabled={busy}
                        onChange={e => setShipTo(prev => ({ ...prev, [k]: e.target.value }))} style={field} />
                    ))}
                    <div style={{ display: 'flex', gap: '12px', gridColumn: '1 / -1' }}>
                      <button type="button" style={link} onClick={() => setEditingShipTo(false)}>Done</button>
                      <button type="button" style={link} onClick={() => setShipTo(SHOP_SHIP_TO)}>Ship to the shop</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={label}>Memo</span>
              <textarea id="po-edit-memo" value={memo} rows={2} disabled={busy} onChange={e => setMemo(e.target.value.slice(0, 999))}
                style={{ ...field, resize: 'vertical' }} />
            </label>

            <div>
              <div style={label}>Parts</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {view.lines.map(l => {
                  const d = drafts.get(l.line)!;
                  const lock = lineLock(l);
                  const jobs = l.jobs.filter(j => j.label !== 'stock');
                  const needed = l.jobs.reduce((s, j) => s + j.quantity, 0);
                  const q = num(d.qty) ?? l.quantity;
                  let note: { text: string; warn: boolean } | null = null;
                  if (lock) note = { text: `🔒 ${lock === 'billed' ? 'Billed' : 'Closed'} in NetSuite, so this line can’t change.`, warn: false };
                  else if (d.remove) note = { text: `Comes off the PO.${jobs.length ? ` Goes back to the parts queue for ${jobs.map(j => j.label).join(', ')}.` : ''}`, warn: true };
                  else if (d.move) note = { text: `Goes on a new PO with ${moveVendor?.name || 'the vendor you pick below'}.`, warn: true };
                  else if (jobs.length && q < needed) note = { text: `${+(needed - q).toFixed(2)} go back to the parts queue for ${jobs.map(j => j.label).join(', ')}.`, warn: true };
                  else if (l.quantityReceived > 0) note = { text: `${l.quantityReceived} already received, so it can’t go below ${l.quantityReceived} or come off.`, warn: false };
                  else if (jobs.length) note = { text: `For ${jobs.map(j => j.label).join(', ')}.`, warn: false };
                  const off = d.remove || d.move;
                  return (
                    <div key={l.line} style={{ border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '10px 12px', background: lock ? 'var(--subtle-bg)' : 'transparent', opacity: d.remove ? 0.6 : 1, display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' }}>
                      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary, textDecoration: d.remove ? 'line-through' : 'none' }}>{l.itemNumber}</div>
                        {l.description && <div style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</div>}
                      </div>
                      {lock ? (
                        <div style={{ fontSize: '12px', color: theme.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
                          {l.quantity}{canSeeMoney && l.rate != null ? ` · ${money(l.rate)}` : ''}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ ...label, fontSize: '10px' }}>Qty</span>
                            <input id={`po-edit-qty-${l.line}`} type="number" inputMode="decimal" min={Math.max(l.quantityReceived, 0)} step="any"
                              value={d.qty} disabled={busy || off} onChange={e => setDraft(l.line, { qty: e.target.value })}
                              style={{ ...field, width: '78px', textAlign: 'right', fontWeight: 700 }} />
                          </label>
                          {canSeeMoney && <label style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ ...label, fontSize: '10px' }}>Price</span>
                            <input id={`po-edit-rate-${l.line}`} type="number" inputMode="decimal" min="0" step="0.01" placeholder="NetSuite"
                              value={d.rate} disabled={busy || off} onChange={e => setDraft(l.line, { rate: e.target.value })}
                              style={{ ...field, width: '100px', textAlign: 'right', fontWeight: 700 }} />
                          </label>}
                          {canTakeOff(l) && (<>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 700, color: theme.textPrimary, paddingBottom: '8px' }}>
                              <input id={`po-edit-move-${l.line}`} type="checkbox" checked={d.move} disabled={busy || d.remove}
                                onChange={e => setDraft(l.line, { move: e.target.checked })} />
                              Move
                            </label>
                            <button type="button" disabled={busy} onClick={() => setDraft(l.line, { remove: !d.remove, move: false })}
                              style={{ padding: '7px 11px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'transparent', marginBottom: '1px', border: `1px solid ${d.remove ? theme.border : 'rgba(248,113,113,0.5)'}`, color: d.remove ? theme.textPrimary : '#f87171' }}>
                              {d.remove ? 'Keep' : 'Remove'}
                            </button>
                          </>)}
                        </div>
                      )}
                      {note && (
                        <div style={{ ...(note.warn ? amber : small), flex: '1 1 100%', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{note.text}</div>
                      )}
                    </div>
                  );
                })}

                {adds.map(a => (
                  <div key={a.key} style={{ border: `1px dashed ${theme.border}`, borderRadius: '12px', padding: '10px 12px', display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' }}>
                    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{a.part.item_number} <span style={{ ...small, fontWeight: 800 }}>NEW</span></div>
                      {(a.part.display_name || a.part.description) && <div style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.part.display_name || a.part.description}</div>}
                      {!a.part.netsuite_id && <div style={{ ...small, color: '#f87171', fontWeight: 700 }}>Not in NetSuite yet, so it can’t go on a PO.</div>}
                    </div>
                    <input type="number" inputMode="decimal" min="0" step="any" aria-label={`Quantity of ${a.part.item_number}`} value={a.qty} disabled={busy}
                      onChange={e => setAdds(prev => prev.map(x => (x.key === a.key ? { ...x, qty: e.target.value } : x)))}
                      style={{ ...field, width: '78px', textAlign: 'right', fontWeight: 700 }} />
                    {canSeeMoney && <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="NetSuite" aria-label={`Price of ${a.part.item_number}`} value={a.rate} disabled={busy}
                      onChange={e => setAdds(prev => prev.map(x => (x.key === a.key ? { ...x, rate: e.target.value } : x)))}
                      style={{ ...field, width: '100px', textAlign: 'right', fontWeight: 700 }} />}
                    <button type="button" disabled={busy} aria-label={`Don’t add ${a.part.item_number}`} onClick={() => setAdds(prev => prev.filter(x => x.key !== a.key))}
                      style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '15px', cursor: 'pointer' }}>✕</button>
                    <div style={{ ...small, flex: '1 1 100%' }}>New line, ordered as stock.</div>
                  </div>
                ))}
              </div>

              <input id="po-edit-part-search" value={search} onChange={e => setSearch(e.target.value)} disabled={busy}
                placeholder="+ Add a part: item # or name" style={{ ...field, width: '100%', boxSizing: 'border-box', marginTop: '8px' }} />
              {hits.length > 0 && (
                <div style={{ border: `1px solid ${theme.border}`, borderRadius: '8px', marginTop: '4px', overflow: 'hidden' }}>
                  {hits.map(h => (
                    <button key={h.item_number} type="button" onClick={() => addPart(h)}
                      style={{ display: 'flex', width: '100%', gap: '8px', alignItems: 'baseline', padding: '8px 10px', background: 'var(--card)', border: 'none', borderTop: `1px solid ${theme.border}`, cursor: 'pointer', textAlign: 'left', color: theme.textPrimary }}>
                      <span style={{ fontSize: '12px', fontWeight: 700 }}>{h.item_number}</span>
                      <span style={{ fontSize: '11px', color: theme.textMuted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.display_name || h.description || ''}</span>
                      {canSeeMoney && h.purchase_price ? <span style={{ fontSize: '11px', color: theme.textSecondary }}>{money(Number(h.purchase_price))}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {[...drafts.values()].some(d => d.move) && (
              <div style={{ border: `1px dashed ${theme.border}`, borderRadius: '12px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>Move the ticked parts to</div>
                <div style={small}>Saving makes a new PO with this vendor for them and takes them off this one.</div>
                {moveVendor ? (
                  <div style={{ fontSize: '13px', color: theme.textPrimary }}>
                    <b>{moveVendor.name}</b>
                    <button type="button" style={{ ...link, marginLeft: '8px' }} disabled={busy} onClick={() => setMoveVendor(null)}>change</button>
                  </div>
                ) : (
                  <NetsuiteVendorSearch onSelect={v => setMoveVendor({ id: v.id, name: v.companyName || v.entityId })} />
                )}
              </div>
            )}
          </>)}
        </div>

        <div className="po-edit-foot" style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
          {error && <div style={{ fontSize: '12px', fontWeight: 700, color: '#f87171', marginBottom: '8px' }}>{error}</div>}
          {!error && pending.problem && dirty && <div style={{ fontSize: '12px', fontWeight: 700, color: '#f87171', marginBottom: '8px' }}>{pending.problem}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '12px', color: theme.textSecondary, flex: '1 1 160px', minWidth: 0 }}>
              {dirty ? `${pending.changes.length} change${pending.changes.length === 1 ? '' : 's'}: ${pending.changes.join(', ')}` : 'No changes yet'}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
              <button type="button" onClick={leave} disabled={busy}
                style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: 'var(--card)', color: theme.textPrimary, border: `1px solid ${theme.border}`, cursor: busy ? 'default' : 'pointer' }}>
                Leave without saving
              </button>
              <button type="button" onClick={save} disabled={busy || !dirty || !!pending.problem}
                style={{ padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, background: '#16a34a', color: '#fff', border: 'none', cursor: busy ? 'wait' : 'pointer', opacity: !dirty || pending.problem ? 0.5 : 1 }}>
                {busy ? 'Saving…' : 'Save to NetSuite'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
