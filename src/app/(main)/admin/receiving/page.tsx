'use client';

/**
 * Receiving (audit item 17C) — check arriving parts in against open vendor
 * POs. Every open synced PO with quantity still to receive is listed; the
 * dock enters what showed up and the API posts the NetSuite item receipt
 * in the same call (falling back to a "key it into NetSuite by hand"
 * worklist when the transform can't run). Posted receipts bump the mirror
 * immediately, so readiness cards and this page agree with NetSuite
 * without waiting for the 2-hourly sync.
 *
 * ?po=<mirror uuid> (deepLinks.receiving) expands and flashes one PO —
 * the landing for the "parts arrived" notification.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { fetchAllRows } from '@/lib/fetch-all';
import { isOpenPoStatus } from '@/lib/incoming-parts';
import { theme } from '@/lib/theme';

interface PoRow {
  id: string;
  netsuite_id: string | null;
  tranid: string | null;
  vendor_name: string | null;
  trandate: string | null;
  status: string | null;
  status_label: string | null;
  eta_date: string | null;
}

interface LineRow {
  po_id: string;
  line_id: string;
  item_netsuite_id: string | null;
  item_number: string;
  description: string | null;
  quantity: number;
  quantity_received: number;
}

interface ReceiptRow {
  id: string;
  po_id: string;
  item_number: string;
  quantity: number;
  ns_status: string;
  ns_receipt_number: string | null;
  note: string | null;
  received_at: string;
  po?: { tranid: string | null; vendor_name: string | null } | null;
  receiver?: { full_name: string | null } | null;
}

const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;

export default function ReceivingPage() {
  useRequireFeature('parts_ordering');
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const supabase = createClient();

  const [pos, setPos] = useState<PoRow[]>([]);
  const [linesByPo, setLinesByPo] = useState<Map<string, LineRow[]>>(new Map());
  const [localReceipts, setLocalReceipts] = useState<ReceiptRow[]>([]);
  const [manualRows, setManualRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyPo, setBusyPo] = useState<string | null>(null);
  const [busyReceipt, setBusyReceipt] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: 'green' | 'amber'; text: string } | null>(null);
  const [flashPo, setFlashPo] = useState<string | null>(null);
  const landedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [poRes, lineRes, manualRes] = await Promise.all([
        // Both mirror reads paginate past PostgREST's 1000-row cap — POs and
        // their lines are well past it and a truncated read would silently
        // hide arrivals.
        fetchAllRows<PoRow>((from, to) => supabase
          .from('netsuite_vendor_pos')
          .select('id, netsuite_id, tranid, vendor_name, trandate, status, status_label, eta_date')
          .order('trandate', { ascending: false })
          .order('id')
          .range(from, to)),
        fetchAllRows<LineRow>((from, to) => supabase
          .from('netsuite_vendor_po_lines')
          .select('po_id, line_id, item_netsuite_id, item_number, description, quantity, quantity_received')
          .order('id')
          .range(from, to)),
        fetch('/api/po-receipts?manual=1').then(r => r.json()).catch(() => ({})),
      ]);

      const open = (poRes.data || []).filter(p => isOpenPoStatus(p.status));
      const openIds = new Set(open.map(p => p.id));
      const byPo = new Map<string, LineRow[]>();
      for (const l of lineRes.data || []) {
        if (!openIds.has(l.po_id)) continue;
        byPo.set(l.po_id, [...(byPo.get(l.po_id) || []), l]);
      }
      // Only POs with something left to receive belong on the dock's list.
      const receivable = open.filter(p =>
        (byPo.get(p.id) || []).some(l => (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0) > 0));
      setPos(receivable);
      setLinesByPo(byPo);
      setManualRows(manualRes?.receipts || []);

      // Local receipt chips (recent window is plenty — display only).
      const { data: recent } = await supabase
        .from('po_receipts')
        .select('id, po_id, item_number, quantity, ns_status, ns_receipt_number, note, received_at')
        .order('received_at', { ascending: false })
        .limit(1000);
      setLocalReceipts((recent as any) || []);
    } catch { /* the empty state below says so */ }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  // ?po= — expand, scroll and flash the notified PO once loaded.
  useEffect(() => {
    if (loading || landedRef.current) return;
    const target = searchParams.get('po');
    if (!target) return;
    landedRef.current = true;
    setExpanded(prev => new Set(prev).add(target));
    setFlashPo(target);
    setTimeout(() => {
      document.getElementById(`po-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    setTimeout(() => setFlashPo(null), 3500);
  }, [loading, searchParams]);

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const receive = async (po: PoRow) => {
    const lines = linesByPo.get(po.id) || [];
    const asks = lines
      .map(l => ({ l, qty: parseFloat(inputs[`${po.id}:${l.line_id}`] || '') }))
      .filter(({ qty }) => Number.isFinite(qty) && qty > 0)
      .map(({ l, qty }) => ({ lineId: l.line_id, itemNumber: l.item_number, itemNetsuiteId: l.item_netsuite_id, quantity: qty }));
    if (asks.length === 0) return;
    const ok = await dialog.confirm(
      `Receive ${asks.length} line${asks.length !== 1 ? 's' : ''} against PO ${po.tranid || ''}? An item receipt will be posted to NetSuite.`,
      { confirmLabel: 'Receive' },
    );
    if (!ok) return;
    setBusyPo(po.id);
    try {
      const res = await fetch('/api/po-receipts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poId: po.id, lines: asks, note: notes[po.id]?.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setBanner(body.nsStatus === 'posted'
        ? { tone: 'green', text: `✓ Item receipt ${body.receiptNumber || body.receiptId || ''} posted to NetSuite for PO ${po.tranid || ''}.` }
        : { tone: 'amber', text: `Recorded here, but the NetSuite item receipt could not be posted (${body.nsError || 'unknown error'}). It's on the manual worklist below — key it into NetSuite, then mark it done.` });
      setInputs(prev => {
        const next = { ...prev };
        for (const l of lines) delete next[`${po.id}:${l.line_id}`];
        return next;
      });
      setNotes(prev => ({ ...prev, [po.id]: '' }));
      await load();
    } catch (e: any) {
      await dialog.alert(`Receiving failed: ${e?.message || 'unknown error'}`);
    }
    setBusyPo(null);
  };

  const markDone = async (r: ReceiptRow) => {
    setBusyReceipt(r.id);
    try {
      const res = await fetch('/api/po-receipts', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, markManualDone: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      await dialog.alert(`Update failed: ${e?.message || 'unknown error'}`);
    }
    setBusyReceipt(null);
  };

  const q = search.trim().toLowerCase();
  const visible = pos.filter(p => !q
    || (p.tranid || '').toLowerCase().includes(q)
    || (p.vendor_name || '').toLowerCase().includes(q)
    || (linesByPo.get(p.id) || []).some(l => l.item_number.toLowerCase().includes(q)));

  const localFor = (poId: string, item: string) => {
    let posted = 0, manual = 0;
    for (const r of localReceipts) {
      if (r.po_id !== poId || r.item_number !== item) continue;
      if (r.ns_status === 'posted') posted += Number(r.quantity) || 0;
      else if (r.ns_status === 'manual_needed') manual += Number(r.quantity) || 0;
    }
    return { posted, manual };
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Receiving</h1>
        {pos.length > 0 && (
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#60a5fa' }}>{pos.length} PO{pos.length !== 1 ? 's' : ''} awaiting parts</span>
        )}
      </div>
      <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '14px' }}>
        Check arriving parts in against the vendor PO. Receiving posts the NetSuite item receipt for you;
        if that fails it lands on a hand-entry worklist instead of blocking the dock.
      </div>

      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search PO #, vendor, or part…"
        style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)', marginBottom: '16px' }} />

      {banner && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px', marginBottom: '16px', borderRadius: '12px', background: banner.tone === 'green' ? 'rgba(74,222,128,0.08)' : 'rgba(251,191,36,0.08)', border: `1px solid ${banner.tone === 'green' ? 'rgba(74,222,128,0.3)' : 'rgba(251,191,36,0.35)'}` }}>
          <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-body)' }}>{banner.text}</div>
          <button onClick={() => setBanner(null)} title="Dismiss"
            style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '13px', padding: 0 }}>✕</button>
        </div>
      )}

      {manualRows.length > 0 && (
        <div style={{ marginBottom: '18px', background: theme.card, border: '1px solid rgba(251,191,36,0.4)', borderRadius: '14px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${theme.border}`, background: 'rgba(251,191,36,0.06)' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: '#f59e0b' }}>Needs NetSuite entry ({manualRows.length})</div>
            <div style={{ fontSize: '11px', color: theme.textMuted }}>
              These arrivals are recorded here but could not be posted as item receipts — key them into NetSuite by hand, then mark done.
            </div>
          </div>
          {manualRows.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px', borderTop: `1px solid ${theme.border}`, fontSize: '12px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ color: 'var(--text-primary)' }}>{r.quantity}× {r.item_number}</b>
                <span style={{ color: theme.textSecondary }}> · PO {r.po?.tranid || '?'}{r.po?.vendor_name ? ` (${r.po.vendor_name})` : ''}</span>
                <span style={{ color: theme.textMuted }}> · {fmtDate(r.received_at)}{r.receiver?.full_name ? ` · ${r.receiver.full_name}` : ''}</span>
                {r.note && <span style={{ color: theme.textMuted, fontStyle: 'italic' }}> · “{r.note}”</span>}
              </div>
              <button onClick={() => markDone(r)} disabled={busyReceipt === r.id}
                style={{ padding: '4px 10px', borderRadius: '6px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textSecondary, fontSize: '10px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                Done in NetSuite
              </button>
            </div>
          ))}
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ padding: '28px', textAlign: 'center', border: `1px dashed ${theme.border}`, borderRadius: '14px', color: theme.textMuted, fontSize: '13px' }}>
          {pos.length === 0 ? 'Nothing left to receive — every open vendor PO is fully received.' : 'No PO matches that search.'}
        </div>
      )}

      {visible.map(po => {
        const lines = linesByPo.get(po.id) || [];
        const isOpen = expanded.has(po.id);
        const openQty = lines.reduce((s, l) => s + Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0)), 0);
        const anyInput = lines.some(l => parseFloat(inputs[`${po.id}:${l.line_id}`] || '') > 0);
        return (
          <div key={po.id} id={`po-${po.id}`} style={{ marginBottom: '14px', background: theme.card, border: `1px solid ${flashPo === po.id ? 'rgba(96,165,250,0.6)' : theme.border}`, borderRadius: '14px', overflow: 'hidden', transition: 'border-color 0.6s' }}>
            <button onClick={() => toggle(po.id)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '11px 14px', background: flashPo === po.id ? 'rgba(96,165,250,0.08)' : 'var(--subtle-bg)', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>PO {po.tranid || '?'}</span>
              <span style={{ fontSize: '12px', color: theme.textSecondary }}>{po.vendor_name || 'Unknown vendor'}</span>
              {po.trandate && <span style={{ fontSize: '11px', color: theme.textMuted }}>{fmtDate(po.trandate)}</span>}
              {po.status_label && <span style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', border: '1px solid rgba(96,165,250,0.35)', borderRadius: '999px', padding: '1px 8px' }}>{po.status_label}</span>}
              {po.eta_date && <span style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa' }}>ETA {fmtDate(po.eta_date)}</span>}
              <span style={{ marginLeft: 'auto', fontSize: '11px', color: theme.textMuted }}>{openQty} to receive {isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ color: theme.textMuted, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.5px' }}>
                        <th style={{ textAlign: 'left', padding: '8px 14px' }}>Part</th>
                        <th style={{ textAlign: 'right', padding: '8px 10px' }}>Ordered</th>
                        <th style={{ textAlign: 'right', padding: '8px 10px' }}>Received</th>
                        <th style={{ textAlign: 'left', padding: '8px 10px' }}>Arrived here</th>
                        <th style={{ textAlign: 'right', padding: '8px 14px' }}>Receive now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map(l => {
                        const remaining = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0));
                        const chips = localFor(po.id, l.item_number);
                        const key = `${po.id}:${l.line_id}`;
                        return (
                          <tr key={l.line_id} style={{ borderTop: `1px solid ${theme.border}`, opacity: remaining > 0 ? 1 : 0.55 }}>
                            <td style={{ padding: '9px 14px' }}>
                              <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{l.item_number}</div>
                              {l.description && <div style={{ fontSize: '11px', color: theme.textSecondary }}>{l.description}</div>}
                            </td>
                            <td style={{ padding: '9px 10px', textAlign: 'right', color: 'var(--text-body)' }}>{l.quantity}</td>
                            <td style={{ padding: '9px 10px', textAlign: 'right', color: remaining > 0 ? 'var(--text-body)' : '#4ade80', fontWeight: remaining > 0 ? 400 : 700 }}>{l.quantity_received}</td>
                            <td style={{ padding: '9px 10px', fontSize: '10px', whiteSpace: 'nowrap' }}>
                              {chips.posted > 0 && <span style={{ color: '#4ade80', fontWeight: 700 }}>✓ {chips.posted}</span>}
                              {chips.manual > 0 && <span style={{ color: '#f59e0b', fontWeight: 700, marginLeft: chips.posted > 0 ? '6px' : 0 }}>⏳ {chips.manual} pending NS</span>}
                              {chips.posted === 0 && chips.manual === 0 && <span style={{ color: theme.textMuted }}>—</span>}
                            </td>
                            <td style={{ padding: '9px 14px', textAlign: 'right' }}>
                              {remaining > 0 ? (
                                <input type="number" min={0} max={remaining} step="any" value={inputs[key] || ''} placeholder={String(remaining)}
                                  onChange={e => setInputs(prev => ({ ...prev, [key]: e.target.value }))}
                                  style={{ width: '72px', padding: '5px 8px', borderRadius: '7px', fontSize: '12px', textAlign: 'right', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)' }} />
                              ) : <span style={{ fontSize: '10px', color: '#4ade80', fontWeight: 700 }}>complete</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', borderTop: `1px solid ${theme.border}`, background: 'var(--subtle-bg)' }}>
                  <button onClick={() => setInputs(prev => {
                    const next = { ...prev };
                    for (const l of lines) {
                      const remaining = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0));
                      if (remaining > 0) next[`${po.id}:${l.line_id}`] = String(remaining);
                    }
                    return next;
                  })}
                    style={{ padding: '5px 10px', borderRadius: '7px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textSecondary, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                    Everything arrived
                  </button>
                  <input value={notes[po.id] || ''} onChange={e => setNotes(prev => ({ ...prev, [po.id]: e.target.value }))}
                    placeholder="Note (packing slip #, damage, short ship…)"
                    style={{ flex: 1, minWidth: '180px', padding: '6px 10px', borderRadius: '7px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)' }} />
                  <button onClick={() => receive(po)} disabled={busyPo !== null || !anyInput}
                    style={{ padding: '6px 14px', borderRadius: '7px', background: anyInput ? 'rgba(74,222,128,0.12)' : 'var(--subtle-bg)', border: `1px solid ${anyInput ? 'rgba(74,222,128,0.4)' : theme.border}`, color: anyInput ? '#4ade80' : theme.textMuted, fontSize: '11px', fontWeight: 800, cursor: anyInput ? 'pointer' : 'not-allowed' }}>
                    {busyPo === po.id ? 'Receiving…' : '📬 Receive'}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
