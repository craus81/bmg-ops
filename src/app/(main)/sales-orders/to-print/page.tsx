'use client';

/**
 * To print (Sales menu; Craig, 2026-11-04, thread "Print new sales orders
 * for the board"). New sales orders land here by themselves; Jessie taps
 * Print (the Job Order: End user, vendor POs, no prices), hangs it on the
 * board, then Mark printed. A printed order comes back marked "Changed" or
 * "New PO" so the board copy can be swapped. See src/lib/so-print-queue.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { openJobOrder, openJobOrders } from '@/lib/job-order-pdf';

interface Row {
  id: string;
  soId: string;
  soNumber: string | null;
  customer: string | null;
  endUser: string | null;
  status: 'to_print' | 'printed';
  reason: 'new' | 'changed' | 'new_po';
  queuedAt: string;
  printedAt: string | null;
  printedBy: string | null;
}

const REASON_TAG: Record<Row['reason'], string | null> = { new: null, changed: 'Changed', new_po: 'New PO' };

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
};

export default function ToPrintPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'to_print' | 'printed'>('to_print');
  const [rows, setRows] = useState<Row[]>([]);
  const [toPrint, setToPrint] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Ticked rows (To print tab), by list entry id. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Rows just sent to the printer together, waiting on "Did they all print?". */
  const [justPrinted, setJustPrinted] = useState<Row[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/print-queue?status=${tab}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't load the list (${res.status}).`);
      const list: Row[] = body.rows || [];
      setRows(list);
      setToPrint(body.toPrint || 0);
      // Keep only ticks for rows still on the list.
      setSelected(prev => new Set(list.filter(r => prev.has(r.id)).map(r => r.id)));
    } catch (e: any) {
      setError(e?.message || "Couldn't load the list.");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const print = async (r: Row) => {
    setError(null);
    const out = await openJobOrder(r.soId);
    if (!out.ok) setError(out.error || "Couldn't open the sales order to print.");
  };

  const printSelected = async () => {
    const chosen = rows.filter(r => selected.has(r.id));
    if (chosen.length === 0) return;
    setError(null);
    setNote(null);
    setJustPrinted(null);
    const out = await openJobOrders(chosen.map(r => r.soId));
    const failedIds = new Set(out.failed.map(f => f.soId));
    const failedNames = chosen.filter(r => failedIds.has(r.soId)).map(r => r.soNumber || `SO ${r.soId}`);
    if (!out.ok) {
      setError(out.error || "Couldn't open the sales orders to print.");
      return;
    }
    if (failedNames.length > 0) {
      setError(`Left out because they couldn't be read from NetSuite: ${failedNames.join(', ')}. Try those again.`);
    }
    setJustPrinted(chosen.filter(r => !failedIds.has(r.soId)));
  };

  const markAllPrinted = async () => {
    if (!justPrinted || justPrinted.length === 0) return;
    setBusy('batch');
    setError(null);
    const results = await Promise.all(justPrinted.map(async r => {
      try {
        const res = await apiFetch(`/api/sales-orders/print-queue/${r.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'printed' }),
        });
        return res.ok ? null : (r.soNumber || `SO ${r.soId}`);
      } catch {
        return r.soNumber || `SO ${r.soId}`;
      }
    }));
    const missed = results.filter((x): x is string => !!x);
    const done = justPrinted.length - missed.length;
    if (missed.length > 0) setError(`Couldn't mark ${missed.join(', ')} printed. Try again.`);
    setNote(done > 0 ? `Marked ${done} printed.` : null);
    setJustPrinted(null);
    setBusy(null);
    await load();
  };

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allTicked = rows.length > 0 && rows.every(r => selected.has(r.id));

  const setStatus = async (r: Row, status: Row['status']) => {
    setBusy(r.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/print-queue/${r.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't update it (${res.status}).`);
      const num = r.soNumber || `SO ${r.soId}`;
      setNote(status === 'printed' ? `${num} marked printed.` : `${num} is back on the list.`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Couldn't update it.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '16px', display: 'grid', gap: '12px' }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>To print{toPrint > 0 ? ` (${toPrint})` : ''}</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>New sales orders for the board. Tick the ones to print, print them, hang them up, then mark them printed.</div>
      </div>

      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {(['to_print', 'printed'] as const).map(v => (
          <button key={v} onClick={() => { setTab(v); setNote(null); setSelected(new Set()); setJustPrinted(null); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: tab === v ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === v ? '1px solid var(--tab-active-border)' : `1px solid ${theme.border}`,
            color: tab === v ? 'var(--tab-active-color)' : theme.textMuted,
          }}>{v === 'to_print' ? 'To print' : 'Printed'}</button>
        ))}
      </div>

      {tab === 'to_print' && rows.length > 0 && (
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', background: theme.card,
          border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px 12px', color: theme.textPrimary,
        }}>
          <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 700, fontSize: '14px', cursor: 'pointer' }}>
            <input id="to-print-all" type="checkbox" checked={allTicked}
              onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())}
              style={{ width: '20px', height: '20px' }} />
            Select all
          </label>
          <span style={{ fontSize: '13px', color: theme.textMuted }}>{selected.size} selected</span>
          <span style={{ flex: 1 }} />
          <button onClick={printSelected} disabled={selected.size === 0 || busy !== null} style={{
            ...btn, background: selected.size ? '#2563eb' : theme.card, color: selected.size ? '#fff' : theme.textMuted,
            border: selected.size ? 'none' : `1px solid ${theme.border}`, cursor: selected.size ? 'pointer' : 'default',
          }}>{selected.size ? `Print ${selected.size} selected` : 'Print selected'}</button>
        </div>
      )}

      {justPrinted && justPrinted.length > 0 && (
        <div style={{ background: theme.card, border: '2px solid #16a34a', borderRadius: '10px', padding: '12px', display: 'grid', gap: '8px', color: theme.textPrimary }}>
          <div style={{ fontWeight: 800 }}>Did all {justPrinted.length} print?</div>
          <div style={{ fontSize: '13px', color: theme.textMuted }}>Check the printer. If one jammed, tap Not yet and print it again.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={markAllPrinted} disabled={busy !== null} style={{ ...btn, background: '#16a34a', border: 'none', color: '#fff' }}>
              {busy === 'batch' ? 'Marking…' : `Mark ${justPrinted.length} printed`}
            </button>
            <button onClick={() => { setJustPrinted(null); setNote('Nothing marked. They stay on the list.'); }} disabled={busy !== null} style={btn}>Not yet</button>
          </div>
        </div>
      )}

      {error && <div style={{ color: theme.error, fontWeight: 700, fontSize: '14px' }}>{error}</div>}
      {note && !error && <div style={{ color: theme.success, fontWeight: 700, fontSize: '14px' }}>{note}</div>}
      {loading && rows.length === 0 && <div style={{ color: theme.textMuted, fontSize: '13px' }}>Loading…</div>}
      {!loading && !error && rows.length === 0 && (
        <div style={{ color: theme.textMuted, fontSize: '13px' }}>
          {tab === 'to_print' ? 'All caught up. Nothing waiting to print.' : 'Nothing printed yet.'}
        </div>
      )}

      <div style={{ display: 'grid', gap: '8px', opacity: loading ? 0.6 : 1 }}>
        {rows.map(r => {
          const tag = r.status === 'to_print' ? REASON_TAG[r.reason] : null;
          return (
            <div key={r.id} style={{
              background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px',
              padding: '10px 12px', color: theme.textPrimary, display: 'grid', gap: '6px',
            }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                {r.status === 'to_print' && (
                  <input type="checkbox" id={`to-print-${r.id}`} aria-label={`Select ${r.soNumber || r.soId}`}
                    checked={selected.has(r.id)} onChange={() => toggle(r.id)} style={{ width: '20px', height: '20px' }} />
                )}
                <button onClick={() => router.push(deepLinks.salesOrder(r.soId))} style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: theme.textPrimary, fontWeight: 800, fontSize: '15px',
                }}>{r.soNumber || `SO ${r.soId}`}</button>
                {tag && <span style={{ padding: '1px 8px', borderRadius: '99px', background: theme.warningBg, color: theme.warning, fontWeight: 700, fontSize: '12px' }}>{tag}</span>}
                <span style={{ fontSize: '12px', color: theme.textMuted }}>
                  {r.status === 'printed' ? `Printed by ${r.printedBy || 'someone'}, ${when(r.printedAt)}` : when(r.queuedAt)}
                </span>
              </div>
              <div style={{ fontSize: '14px', minWidth: 0 }}>
                {r.customer || 'No customer'}
                <div style={{ fontSize: '13px', color: theme.textMuted }}>{r.endUser ? `End user: ${r.endUser}` : 'No end user'}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={() => print(r)} style={btn}>{r.status === 'printed' ? 'Print again' : 'Print'}</button>
                {r.status === 'to_print'
                  ? <button disabled={busy === r.id} onClick={() => setStatus(r, 'printed')} style={{ ...btn, background: '#16a34a', border: 'none', color: '#fff' }}>Mark printed</button>
                  : <button disabled={busy === r.id} onClick={() => setStatus(r, 'to_print')} style={btn}>Put back on the list</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '7px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '13px', fontWeight: 700, cursor: 'pointer',
};
