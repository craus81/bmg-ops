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
import { openJobOrder } from '@/lib/job-order-pdf';

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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/print-queue?status=${tab}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't load the list (${res.status}).`);
      setRows(body.rows || []);
      setToPrint(body.toPrint || 0);
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
        <div style={{ fontSize: '13px', color: theme.textMuted }}>New sales orders for the board. Print, hang it up, then tap Mark printed.</div>
      </div>

      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {(['to_print', 'printed'] as const).map(v => (
          <button key={v} onClick={() => { setTab(v); setNote(null); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: tab === v ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === v ? '1px solid var(--tab-active-border)' : `1px solid ${theme.border}`,
            color: tab === v ? 'var(--tab-active-color)' : theme.textMuted,
          }}>{v === 'to_print' ? 'To print' : 'Printed'}</button>
        ))}
      </div>

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
