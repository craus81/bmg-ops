'use client';

/**
 * Purchasing queue (audit item 17A) — every pending purchase request,
 * grouped by vendor, so "we're short, someone should order this" finally
 * has a place to land. Requests arrive from the parts-readiness card's
 * short rows (or the API); phase 17B adds "Create PO in NetSuite" per
 * vendor group. Until then the queue is the purchaser's worklist: fix the
 * vendor, adjust quantities, cancel noise — then place the PO in NetSuite
 * and mark the group ordered from the PO flow.
 *
 * ?req=<id> (deepLinks.purchaseRequests) scroll-flashes one row — the
 * landing for the "parts requested" notification.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';

interface RequestRow {
  id: string;
  item_number: string;
  netsuite_item_id: string | null;
  description: string | null;
  quantity: number;
  vendor_name: string | null;
  vendor_netsuite_id: string | null;
  source_project_id: string | null;
  needed_by: string | null;
  note: string | null;
  status: string;
  created_at: string;
  upfit_projects?: { id: string; project_name: string | null; netsuite_so_number: string | null } | null;
  requester?: { full_name: string | null } | null;
}

const UNASSIGNED = 'No vendor — assign one';

export default function PurchasingQueuePage() {
  useRequireFeature('parts_ordering');
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();

  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/purchase-requests?status=pending');
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) setRequests(body.requests || []);
    } catch { /* the empty state below says so */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ?req= — scroll-flash the notified row once loaded.
  useEffect(() => {
    if (loading || flashedRef.current) return;
    const req = searchParams.get('req');
    if (!req) return;
    flashedRef.current = true;
    setFlashId(req);
    setTimeout(() => {
      document.getElementById(`preq-${req}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    setTimeout(() => setFlashId(null), 3500);
  }, [loading, searchParams]);

  const patch = async (id: string, fields: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !(await dialog.confirm(confirmText, { destructive: true, confirmLabel: 'Cancel Request' }))) return;
    setBusyId(id);
    try {
      const res = await fetch('/api/purchase-requests', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      await dialog.alert(`Update failed: ${e?.message || 'unknown error'}`);
    }
    setBusyId(null);
  };

  const editQty = async (r: RequestRow) => {
    const raw = await dialog.prompt(`Quantity for ${r.item_number}:`, String(r.quantity));
    const qty = parseFloat(raw || '');
    if (!raw || !Number.isFinite(qty) || qty <= 0) return;
    await patch(r.id, { quantity: qty });
  };

  const editVendor = async (r: RequestRow) => {
    const name = await dialog.prompt(`Vendor for ${r.item_number} (as named in NetSuite):`, r.vendor_name || '');
    if (name === null) return;
    await patch(r.id, { vendorName: name });
  };

  // Group by vendor for the purchaser's eye — one group = one future PO.
  const groups = new Map<string, RequestRow[]>();
  for (const r of requests) {
    const key = r.vendor_name?.trim() || UNASSIGNED;
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  const groupNames = [...groups.keys()].sort((a, b) =>
    a === UNASSIGNED ? -1 : b === UNASSIGNED ? 1 : a.localeCompare(b));

  const age = (iso: string) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return days === 0 ? 'today' : `${days}d ago`;
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Purchasing</h1>
        {requests.length > 0 && (
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>{requests.length} pending</span>
        )}
      </div>
      <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '18px' }}>
        Parts requested from short readiness cards land here, grouped by vendor. Place the vendor PO in
        NetSuite; the 2-hourly sync mirrors it back and the readiness cards flip to “on order”.
      </div>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && requests.length === 0 && (
        <div style={{ padding: '28px', textAlign: 'center', border: `1px dashed ${theme.border}`, borderRadius: '14px', color: theme.textMuted, fontSize: '13px' }}>
          Nothing waiting to be ordered. Short parts on any upfit readiness card can be requested from there.
        </div>
      )}

      {groupNames.map(vendor => {
        const rows = groups.get(vendor)!;
        const unassigned = vendor === UNASSIGNED;
        return (
          <div key={vendor} style={{ marginBottom: '18px', background: theme.card, border: `1px solid ${unassigned ? 'rgba(251,191,36,0.4)' : theme.border}`, borderRadius: '14px', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px', borderBottom: `1px solid ${theme.border}`, background: unassigned ? 'rgba(251,191,36,0.06)' : 'var(--subtle-bg)' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: unassigned ? '#f59e0b' : 'var(--text-primary)' }}>{vendor}</div>
              <div style={{ fontSize: '11px', color: theme.textMuted }}>{rows.length} part{rows.length !== 1 ? 's' : ''}</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ color: theme.textMuted, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.5px' }}>
                    <th style={{ textAlign: 'left', padding: '8px 14px' }}>Part</th>
                    <th style={{ textAlign: 'right', padding: '8px 10px' }}>Qty</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>For</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>Needed by</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>Requested</th>
                    <th style={{ padding: '8px 14px' }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} id={`preq-${r.id}`} style={{
                      borderTop: `1px solid ${theme.border}`,
                      background: flashId === r.id ? 'rgba(96,165,250,0.12)' : 'transparent',
                      transition: 'background 0.6s',
                    }}>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.item_number}</div>
                        {r.description && <div style={{ fontSize: '11px', color: theme.textSecondary }}>{r.description}</div>}
                        {r.note && <div style={{ fontSize: '11px', color: theme.textMuted, fontStyle: 'italic' }}>“{r.note}”</div>}
                        {!r.netsuite_item_id && (
                          <div title="No NetSuite item id resolved — the PO line will need it" style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700 }}>⚠ no NetSuite item id</div>
                        )}
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                        <button onClick={() => editQty(r)} disabled={busyId === r.id} title="Edit quantity"
                          style={{ background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderRadius: '6px', padding: '4px 10px', fontWeight: 800, fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                          {r.quantity}
                        </button>
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {r.upfit_projects ? (
                          <button onClick={() => router.push(deepLinks.upfitProject(r.upfit_projects!.id))}
                            style={{ background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                            {r.upfit_projects.project_name || 'Upfit project'}
                            {r.upfit_projects.netsuite_so_number ? ` · SO ${r.upfit_projects.netsuite_so_number}` : ''}
                          </button>
                        ) : <span style={{ color: theme.textMuted }}>stock</span>}
                      </td>
                      <td style={{ padding: '9px 10px', color: r.needed_by ? 'var(--text-body)' : theme.textMuted }}>{r.needed_by || '—'}</td>
                      <td style={{ padding: '9px 10px', color: theme.textMuted }}>
                        {age(r.created_at)}{r.requester?.full_name ? ` · ${r.requester.full_name}` : ''}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => editVendor(r)} disabled={busyId === r.id} title="Set/change vendor"
                          style={{ marginRight: '6px', padding: '4px 9px', borderRadius: '6px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textSecondary, fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
                          Vendor
                        </button>
                        <button onClick={() => patch(r.id, { cancel: true }, `Cancel the request for ${r.quantity}× ${r.item_number}?`)} disabled={busyId === r.id}
                          style={{ padding: '4px 9px', borderRadius: '6px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
